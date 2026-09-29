/**
 * Closing a live chat answers at once even while NeoPi's dispose is slow. On a
 * large resumed session the chronicler drains model work for up to 20 s,
 * longer than Bun's 10 s idle timeout, so a DELETE that waited got an empty
 * reply (#110). Its subscribers hear `session_disposed` when the close ends,
 * and resumes and closes of one chat racing each other leave one outcome.
 * Resuming a chat that is already live reuses its session (#2), and a socket
 * that resubscribes after a close and resume streams the reopened chat (#11).
 */
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** NeoPi sessions started in this process, counted by the fixture extension. */
const STARTS = "__npiDeckSessionStarts";
const sessionStarts = () => ((globalThis as Record<string, unknown>)[STARTS] as number | undefined) ?? 0;

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
			expect(output).toContain("6 pass");
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
			if (event === "session_start") globalThis.${STARTS} = (globalThis.${STARTS} ?? 0) + 1;
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
			/**
			 * Send a prompt the deck answers itself (a `/task` usage error) from
			 * `from`, and return the message events each client received for it
			 * (NeoPi's own background events, such as advisor costs, are left out).
			 */
			prompt: async (from: { ws: Parameters<WsHub["onOpen"]>[0]; frames: ServerFrame[] }, clients: Array<{ frames: ServerFrame[] }>) => {
				const marks = clients.map((c) => c.frames.length);
				const mark = from.frames.length;
				await hub.onMessage(from.ws, JSON.stringify({ type: "prompt", sessionId: id, text: "/task add" }));
				const deadline = Date.now() + 30_000;
				while (!from.frames.slice(mark).some((f) => f.type === "prompt_consumed") && Date.now() < deadline) await Bun.sleep(10);
				return clients.map((c, i) => c.frames.slice(marks[i]).filter((f) => f.type === "session_event" && /^message_/.test(f.event.type)));
			},
			close: async () => {
				hub.dispose();
				await bridge.dispose();
			},
		};
	}

	test("DELETE answers 202 while dispose runs; session_disposed reaches only subscribers when it ends", async () => {
		const id = "01a0ea00-0000-7000-8000-000000000110";
		const { file, bridge, hub, request, connect, prompt, close } = await fixture(id);
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
			// The dropped subscription does not swallow a fresh subscribe to the reopened chat.
			await hub.onMessage(subscriber.ws, JSON.stringify({ type: "subscribe", sessionId: id }));
			expect(subscriber.frames.at(-1)?.type).toBe("subscribed");
			// Without reconnecting, the socket streams the reopened chat's prompt events.
			const [events] = await prompt(subscriber, [subscriber]);
			expect(events!.map((f) => f.type === "session_event" && `${f.event.type}:${(f.event as { message?: { role?: string } }).message?.role}`)).toEqual(["message_start:user", "message_start:assistant", "message_end:assistant"]);

			expect((await request("DELETE", "/sessions/01a0ea00-0000-7000-8000-00000000dead")).status).toBe(404);
		} finally {
			await close();
		}
	}, 90_000);

	test("resuming a live chat, twice at once or again later, reuses its one session and stream", async () => {
		const id = "01a0ea00-0000-7000-8000-000000000002";
		const { file, bridge, hub, request, connect, prompt, close } = await fixture(id);
		try {
			const before = sessionStarts();
			const resume = () => request("POST", "/sessions", { resumeFromPath: file });
			const [one, two] = await Promise.all([resume(), resume()]);
			expect([one.status, two.status]).toEqual([200, 200]);
			const sessionIdOf = async (r: Response) => ((await r.json()) as { sessionId: string }).sessionId;
			expect([await sessionIdOf(one), await sessionIdOf(two)]).toEqual([id, id]);
			const live = bridge.getSession(id)!;
			expect(sessionStarts() - before).toBe(1);

			// Two tabs subscribe; a resume from either reuses the session they watch.
			const tabA = connect();
			const tabB = connect();
			await hub.onMessage(tabA.ws, JSON.stringify({ type: "subscribe", sessionId: id }));
			await hub.onMessage(tabB.ws, JSON.stringify({ type: "subscribe", sessionId: id }));
			expect((await resume()).status).toBe(200);
			expect(await bridge.resumeSession({ sessionPath: file })).toBe(live);
			expect(bridge.getSession(id)).toBe(live);
			expect(sessionStarts() - before).toBe(1);

			// One stream: both tabs see the same events for a prompt from either.
			const [seenByA, seenByB] = await prompt(tabA, [tabA, tabB]);
			expect(seenByA!.length).toBe(3);
			expect(seenByB).toEqual(seenByA!);
		} finally {
			await close();
		}
	}, 90_000);

	test("a symlink and a copy of a chat's file resumed at once open one session with one stream", async () => {
		const id = "01a0ea00-0000-7000-8000-000000000202";
		const { file, bridge, hub, request, connect, prompt, close } = await fixture(id);
		const aliases = path.join(fixtureRoot!, `aliases-${id}`);
		mkdirSync(aliases, { recursive: true });
		const link = path.join(aliases, "link.jsonl");
		const copy = path.join(aliases, "copy.jsonl");
		symlinkSync(file, link);
		copyFileSync(file, copy);
		try {
			const before = sessionStarts();
			const resume = (from: string) => request("POST", "/sessions", { resumeFromPath: from });
			const answers = await Promise.all([resume(file), resume(link), resume(copy), resume(link), resume(copy)]);
			expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
			expect(sessionStarts() - before).toBe(1);
			const live = bridge.getSession(id)!;

			// Two tabs watch it; resuming either alias again reuses what they watch.
			const tabA = connect();
			const tabB = connect();
			await hub.onMessage(tabA.ws, JSON.stringify({ type: "subscribe", sessionId: id }));
			await hub.onMessage(tabB.ws, JSON.stringify({ type: "subscribe", sessionId: id }));
			expect(await bridge.resumeSession({ sessionPath: link })).toBe(live);
			expect(await bridge.resumeSession({ sessionPath: copy })).toBe(live);
			expect(bridge.getSession(id)).toBe(live);
			expect(sessionStarts() - before).toBe(1);
			expect(tabA.disposed()).toEqual([]);

			const [seenByA, seenByB] = await prompt(tabA, [tabA, tabB]);
			expect(seenByA!.length).toBe(3);
			expect(seenByB).toEqual(seenByA!);
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
