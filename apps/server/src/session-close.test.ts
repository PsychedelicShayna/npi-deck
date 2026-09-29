/**
 * Closing a live chat answers at once even while NeoPi's dispose is slow. On a
 * large resumed session the chronicler drains model work for up to 20 s,
 * longer than Bun's 10 s idle timeout, so a DELETE that waited got an empty
 * reply (#110). Its subscribers hear `session_disposed` when the close ends.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerFrame } from "@npi-deck/protocol";

import { loadBackend, resolveBackendSelection } from "./backend/runtime.ts";
import { InProcessAgentBridge } from "./bridge/in-process.ts";
import type { Config } from "./config.ts";
import { spawnOwnedSync } from "./owned-process.ts";
import { buildRouter } from "./routes.ts";
import { WsHub } from "./ws.ts";

// NeoPi captures HOME at load, so the chat runs in a child `bun test` with an
// isolated home and agent dir.
const fixtureRoot = process.env.NPI_DECK_SESSION_CLOSE_ROOT;

/** Shared with the fixture extension, which runs in this process. */
type ShutdownGate = { entered: () => void; release: Promise<void> };
const GATE = "__npiDeckSessionCloseGate";

if (!fixtureRoot) {
	test("closing a chat answers before its slow dispose ends and tells its subscribers", () => {
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
			expect(output).toContain("1 pass");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 180_000);
} else {
	test("DELETE answers 202 while dispose runs; session_disposed reaches only subscribers when it ends", async () => {
		const agentDir = process.env.PI_CODING_AGENT_DIR!;
		const project = path.join(fixtureRoot, "project");
		mkdirSync(project, { recursive: true });
		// Stands in for any slow part of NeoPi's dispose: holds `session_shutdown`
		// until the test lets it go.
		const extensionDir = path.join(agentDir, "extensions", "hold-shutdown");
		mkdirSync(extensionDir, { recursive: true });
		writeFileSync(path.join(extensionDir, "index.ts"), `export default function (pi) {
	pi.on("session_shutdown", async () => {
		const gate = globalThis.${GATE};
		if (!gate) return;
		gate.entered();
		await gate.release;
	});
}
`);
		const sessionDir = path.join(agentDir, "sessions", "--project--");
		mkdirSync(sessionDir, { recursive: true });
		const id = "01a0ea00-0000-7000-8000-000000000110";
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
		const hub = new WsHub(bridge, "session-close-test");
		try {
			const config: Config = { defaultCwd: project, extraWorkspaces: [], host: "127.0.0.1", port: 0, devMode: true, idleTimeoutMs: 0, dbPath: path.join(fixtureRoot, "db"), uploadsRoot: path.join(fixtureRoot, "uploads") };
			const app = buildRouter(bridge, config, {} as never, {} as never, {} as never, {} as never, {} as never);
			const request = (method: string, url: string) => app.request(`http://127.0.0.1${url}`, { method });
			const connect = () => {
				const frames: ServerFrame[] = [];
				const ws = { data: hub.createConnectionData(), send: (raw: string) => frames.push(JSON.parse(raw) as ServerFrame) } as unknown as Parameters<WsHub["onOpen"]>[0];
				hub.onOpen(ws);
				return { ws, frames, disposed: () => frames.filter((f) => f.type === "session_disposed") };
			};

			const first = await bridge.resumeSession({ sessionPath: file });
			expect(first.sessionId).toBe(id);
			const subscriber = connect();
			const bystander = connect();
			await hub.onMessage(subscriber.ws, JSON.stringify({ type: "subscribe", sessionId: id }));
			expect(subscriber.frames.map((f) => f.type)).toContain("subscribed");

			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			(globalThis as Record<string, unknown>)[GATE] = { entered: entered.resolve, release: release.promise } satisfies ShutdownGate;

			const closed = await request("DELETE", `/sessions/${id}`);
			expect(closed.status).toBe(202);
			expect(await closed.json()).toEqual({ ok: true });
			// The answer came while NeoPi's dispose is still held in session_shutdown.
			await entered.promise;

			// Closing: no longer live, a repeated close is the same close, nobody told yet.
			expect(bridge.getSession(id)).toBeUndefined();
			expect((await request("POST", `/sessions/${id}/abort`)).status).toBe(404);
			expect((await request("DELETE", `/sessions/${id}`)).status).toBe(202);
			expect(subscriber.disposed()).toEqual([]);

			// Resuming the same file waits for the close instead of returning the closing chat.
			const reopening = bridge.resumeSession({ sessionPath: file });
			release.resolve();
			const deadline = Date.now() + 30_000;
			while (subscriber.disposed().length === 0 && Date.now() < deadline) await Bun.sleep(20);
			expect(subscriber.disposed()).toEqual([{ type: "session_disposed", sessionId: id }]);
			expect(subscriber.ws.data.subscriptions.has(id)).toBe(false);
			expect(bystander.disposed()).toEqual([]);

			const reopened = await reopening;
			expect(reopened).not.toBe(first);
			expect(bridge.getSession(id)).toBe(reopened);
			expect(reopened.snapshot().messages.length).toBe(2);
			// The dropped subscription does not swallow a fresh subscribe to the reopened chat.
			await hub.onMessage(subscriber.ws, JSON.stringify({ type: "subscribe", sessionId: id }));
			expect(subscriber.frames.at(-1)?.type).toBe("subscribed");

			expect((await request("DELETE", "/sessions/01a0ea00-0000-7000-8000-00000000dead")).status).toBe(404);
		} finally {
			hub.dispose();
			await bridge.dispose();
		}
	}, 120_000);
}
