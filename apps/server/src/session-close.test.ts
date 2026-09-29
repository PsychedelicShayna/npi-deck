/**
 * Closing a live chat answers at once even while NeoPi's dispose is slow. On a
 * large resumed session the chronicler drains model work for up to 20 s,
 * longer than Bun's 10 s idle timeout, so a DELETE that waited got an empty
 * reply (#110). Its subscribers hear `session_disposed` when the close ends,
 * and resumes and closes of one chat racing each other leave one outcome.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerFrame } from "@npi-deck/protocol";

import { loadBackend, resolveBackendSelection, sdk } from "./backend/runtime.ts";
import { InProcessAgentBridge } from "./bridge/in-process.ts";
import type { Config } from "./config.ts";
import { spawnOwnedSync } from "./owned-process.ts";
import { buildRouter } from "./routes.ts";
import { WsHub } from "./ws.ts";

// NeoPi captures HOME at load, so the chat runs in a child `bun test` with an
// isolated home and agent dir.
const fixtureRoot = process.env.NPI_DECK_SESSION_CLOSE_ROOT;

/**
 * The fixture extension, which runs in this process, holds the named session
 * event until the test releases it. It stands in for a slow part of NeoPi's
 * dispose (`session_shutdown`) or of opening a chat (`session_start`).
 */
const GATES = "__npiDeckSessionCloseGates";
type Gate = { entered: () => void; release: Promise<void> };
function hold(event: "session_shutdown" | "session_start") {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const gates = ((globalThis as Record<string, unknown>)[GATES] ??= {}) as Record<string, Gate | undefined>;
	gates[event] = { entered: entered.resolve, release: release.promise };
	return {
		entered: entered.promise,
		release: () => {
			gates[event] = undefined;
			release.resolve();
		},
	};
}

if (!fixtureRoot) {
	test("closing a chat answers before its slow dispose ends and races resumes cleanly", () => {
		const selection = resolveBackendSelection();
		if (!selection) throw new Error("session close test requires a configured NeoPi backend");
		const root = mkdtempSync(path.join(os.tmpdir(), "deck-session-close-"));
		try {
			const home = path.join(root, "home");
			mkdirSync(home, { recursive: true });
			const env: Record<string, string> = {};
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined && !/(_API_KEY|_TOKEN|_SECRET)$/.test(key) && !/^(PI_|OMP_|NPI_DECK_)/.test(key)) env[key] = value;
			}
			Object.assign(env, {
				HOME: home,
				XDG_CONFIG_HOME: path.join(home, ".config"),
				XDG_DATA_HOME: path.join(home, ".local/share"),
				XDG_STATE_HOME: path.join(home, ".local/state"),
				XDG_CACHE_HOME: path.join(home, ".cache"),
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
				OMP_DECK_INSTALL_STARTER_SKILLS: "0",
				OMP_DECK_INSTALL_STARTER_EXTENSIONS: "0",
				NPI_DECK_HOME: path.join(root, "deck"),
				NPI_DECK_BACKEND: selection.path,
				NPI_DECK_SESSION_CLOSE_ROOT: root,
			});
			const child = spawnOwnedSync([process.execPath, "test", import.meta.path], { cwd: root, env, stdout: "pipe", stderr: "pipe" }, { replaceEnv: true });
			const output = `${child.stdout.toString()}${child.stderr.toString()}`;
			if (child.exitCode !== 0) console.error(output);
			expect(child.exitCode).toBe(0);
			expect(output).toContain("4 pass");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 240_000);
} else {
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const project = path.join(fixtureRoot, "project");
	const extensionDir = path.join(agentDir, "extensions", "hold-events");
	mkdirSync(project, { recursive: true });
	mkdirSync(extensionDir, { recursive: true });
	writeFileSync(path.join(extensionDir, "index.ts"), `export default function (pi) {
	for (const event of ["session_shutdown", "session_start"]) {
		pi.on(event, async () => {
			const gate = globalThis.${GATES}?.[event];
			if (!gate) return;
			gate.entered();
			await gate.release;
		});
	}
}
`);

	/** A persisted two-message chat, a bridge, a hub and the router around them. */
	async function fixture(id: string) {
		const sessionDir = path.join(agentDir, "sessions", "--project--");
		mkdirSync(sessionDir, { recursive: true });
		const file = path.join(sessionDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
		const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const lines = [
			{ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: project },
			{ type: "message", id: "e0", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } },
			{ type: "message", id: "e1", parentId: "e0", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }], api: "openai-completions", provider: "openrouter", model: "openai/gpt-4o-mini", usage, stopReason: "stop", timestamp: 2 } },
		];
		writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

		await loadBackend(resolveBackendSelection()!);
		const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
		const hub = new WsHub(bridge, `session-close-${id}`);
		const config: Config = { defaultCwd: project, extraWorkspaces: [], host: "127.0.0.1", port: 0, devMode: true, idleTimeoutMs: 0, dbPath: path.join(fixtureRoot!, "db"), uploadsRoot: path.join(fixtureRoot!, "uploads") };
		const app = buildRouter(bridge, config, {} as never, {} as never, {} as never, {} as never, {} as never);
		return {
			file,
			bridge,
			hub,
			request: (method: string, url: string, body?: unknown) =>
				app.request(`http://127.0.0.1${url}`, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
			connect: () => {
				const frames: ServerFrame[] = [];
				const ws = { data: hub.createConnectionData(), send: (raw: string) => frames.push(JSON.parse(raw) as ServerFrame) } as unknown as Parameters<WsHub["onOpen"]>[0];
				hub.onOpen(ws);
				return { ws, frames, disposed: () => frames.filter((f) => f.type === "session_disposed") };
			},
			close: async () => {
				hub.dispose();
				await bridge.dispose();
			},
		};
	}

	test("DELETE answers 202 while dispose runs; session_disposed reaches only subscribers when it ends", async () => {
		const id = "01a0ea00-0000-7000-8000-000000000110";
		const { file, bridge, hub, request, connect, close } = await fixture(id);
		try {
			const first = await bridge.resumeSession({ sessionPath: file });
			expect(first.sessionId).toBe(id);
			const subscriber = connect();
			const bystander = connect();
			await hub.onMessage(subscriber.ws, JSON.stringify({ type: "subscribe", sessionId: id }));
			expect(subscriber.frames.map((f) => f.type)).toContain("subscribed");

			const shutdown = hold("session_shutdown");
			const closed = await request("DELETE", `/sessions/${id}`);
			expect(closed.status).toBe(202);
			expect(await closed.json()).toEqual({ ok: true });
			// The answer came while NeoPi's dispose is still held in session_shutdown.
			await shutdown.entered;

			// Closing: no longer live, a repeated close is the same close, nobody told yet.
			expect(bridge.getSession(id)).toBeUndefined();
			expect((await request("POST", `/sessions/${id}/abort`)).status).toBe(404);
			expect((await request("DELETE", `/sessions/${id}`)).status).toBe(202);
			expect(subscriber.disposed()).toEqual([]);

			// Resuming the same file waits for the close instead of returning the
			// closing chat, and two resumes at once open it once.
			const reopening = [bridge.resumeSession({ sessionPath: file }), bridge.resumeSession({ sessionPath: file })];
			shutdown.release();
			const deadline = Date.now() + 30_000;
			while (subscriber.disposed().length === 0 && Date.now() < deadline) await Bun.sleep(20);
			expect(subscriber.disposed()).toEqual([{ type: "session_disposed", sessionId: id }]);
			expect(subscriber.ws.data.subscriptions.has(id)).toBe(false);
			expect(bystander.disposed()).toEqual([]);

			const [reopened, again] = await Promise.all(reopening);
			expect(reopened).not.toBe(first);
			expect(again).toBe(reopened!);
			expect(bridge.getSession(id)).toBe(reopened);
			expect(reopened!.snapshot().messages.length).toBe(2);
			// The dropped subscription does not swallow a fresh subscribe to the reopened chat.
			await hub.onMessage(subscriber.ws, JSON.stringify({ type: "subscribe", sessionId: id }));
			expect(subscriber.frames.at(-1)?.type).toBe("subscribed");

			expect((await request("DELETE", "/sessions/01a0ea00-0000-7000-8000-00000000dead")).status).toBe(404);
		} finally {
			await close();
		}
	}, 90_000);

	test("a close sent while the chat is still opening wins: the resume answers 409 and the chat never goes live", async () => {
		const id = "01a0ea00-0000-7000-8000-000000000111";
		const { file, bridge, request, close } = await fixture(id);
		try {
			const start = hold("session_start");
			const resuming = request("POST", "/sessions", { resumeFromPath: file });
			await start.entered;

			const closed = await request("DELETE", `/sessions/${id}`);
			expect(closed.status).toBe(202);
			start.release();
			const refused = await resuming;
			expect(refused.status).toBe(409);
			expect(bridge.getSession(id)).toBeUndefined();

			// A resume after that opens the file afresh once the refused chat is disposed.
			const reopened = await bridge.resumeSession({ sessionPath: file });
			expect(bridge.getSession(id)).toBe(reopened);
			expect(reopened.snapshot().messages.length).toBe(2);
		} finally {
			await close();
		}
	}, 90_000);

	test("a close sent while the chat's file is still being read answers 202 and the resume 409", async () => {
		const id = "01a0ea00-0000-7000-8000-000000000112";
		const { file, bridge, request, close } = await fixture(id);
		// Stands in for a long transcript: NeoPi's file read waits for the test.
		const manager = sdk().SessionManager as { open: (...args: unknown[]) => Promise<unknown> };
		const read = manager.open;
		const reading = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		manager.open = async (...args) => {
			reading.resolve();
			await finish.promise;
			return read.apply(manager, args);
		};
		try {
			const resuming = request("POST", "/sessions", { resumeFromPath: file });
			await reading.promise;
			expect((await request("DELETE", `/sessions/${id}`)).status).toBe(202);
			manager.open = read;
			finish.resolve();
			expect((await resuming).status).toBe(409);
			expect(bridge.getSession(id)).toBeUndefined();

			const reopened = await bridge.resumeSession({ sessionPath: file });
			expect(bridge.getSession(id)).toBe(reopened);
		} finally {
			manager.open = read;
			finish.resolve();
			await close();
		}
	}, 90_000);

	test("a shutdown while a chat opens never makes it live and waits for its teardown", async () => {
		const id = "01a0ea00-0000-7000-8000-000000000113";
		const { file, bridge, close } = await fixture(id);
		try {
			const start = hold("session_start");
			const resuming = bridge.resumeSession({ sessionPath: file }).then(() => "opened", (err: Error) => err.name);
			await start.entered;

			const shutdown = hold("session_shutdown");
			let stopped = false;
			const stopping = bridge.dispose().then(() => { stopped = true; });
			start.release();
			// The opened chat is torn down rather than published, and shutdown waits for it.
			await shutdown.entered;
			expect(bridge.getSession(id)).toBeUndefined();
			expect(stopped).toBe(false);
			shutdown.release();
			await stopping;
			expect(await resuming).toBe("SessionClosedError");
			expect(bridge.getSession(id)).toBeUndefined();
		} finally {
			await close();
		}
	}, 90_000);
}
