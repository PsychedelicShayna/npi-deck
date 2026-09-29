import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadBackend, resolveBackendSelection, sdk } from "../backend/runtime.ts";
import { spawnOwnedSync } from "../owned-process.ts";
import { InProcessAgentBridge } from "./in-process.ts";

// NeoPi captures HOME at load, so the transcript is read in a child `bun
// test` with an isolated home and agent dir. A second NeoPi process then has
// to be able to take the session, as the CLI does on `npi --resume`.
const fixtureRoot = process.env.NPI_DECK_TRANSCRIPT_READ_ROOT;
const probePath = process.env.NPI_DECK_TRANSCRIPT_READ_PROBE;

function run(env: Record<string, string>): void {
	const child = spawnOwnedSync([process.execPath, "test", import.meta.path], { cwd: env.NPI_DECK_TRANSCRIPT_READ_ROOT, env, stdout: "pipe", stderr: "pipe" }, { replaceEnv: true });
	const output = `${child.stdout.toString()}${child.stderr.toString()}`;
	if (child.exitCode !== 0) console.error(output);
	expect(child.exitCode).toBe(0);
	expect(output).toContain("1 pass");
}

function message(role: "user" | "assistant", n: number) {
	const content = [{ type: "text", text: `${role} ${n}` }];
	if (role === "user") return { role, content, timestamp: n };
	const usage = { input: n, output: n, cacheRead: 0, cacheWrite: 0, totalTokens: 2 * n, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	return { role, content, api: "openai-completions", provider: "openrouter", model: "openai/gpt-4o-mini", usage, stopReason: "stop", timestamp: n };
}

if (!fixtureRoot) {
	test("reading a transcript leaves the session free for another NeoPi process", () => {
		const selection = resolveBackendSelection();
		if (!selection) throw new Error("transcript read test requires a configured NeoPi backend");
		const root = mkdtempSync(path.join(os.tmpdir(), "deck-transcript-read-"));
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
				NPI_DECK_BACKEND: selection.path,
				NPI_DECK_TRANSCRIPT_READ_ROOT: root,
			});
			run(env);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 180_000);
} else if (!probePath) {
	test("a limited read returns the newest messages and frees the file", async () => {
		const project = path.join(fixtureRoot, "project");
		const sessionDir = path.join(process.env.PI_CODING_AGENT_DIR!, "sessions", "--project--");
		mkdirSync(project, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		const id = "01a0e55c-0000-7000-8000-000000000001";
		const file = path.join(sessionDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
		const messages = [message("user", 1), message("assistant", 1), message("user", 2), message("assistant", 2)];
		const lines = [{ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: project }];
		messages.forEach((m, i) => lines.push({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: "2026-01-01T00:00:01.000Z", message: m } as never));
		writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

		await loadBackend(resolveBackendSelection()!);
		const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
		try {
			const transcript = await bridge.readTranscript(file, { limit: 2 });
			expect(transcript?.messages.map((m) => (m as { content: Array<{ text: string }> }).content[0]!.text)).toEqual(["user 2", "assistant 2"]);
			expect(transcript?.omitted?.count).toBe(2);
			expect(transcript?.omitted?.usage.map((u) => (u as { totalTokens: number }).totalTokens)).toEqual([2]);
			// While this deck process is still alive, another process can take the session.
			run({ ...(process.env as Record<string, string>), NPI_DECK_TRANSCRIPT_READ_PROBE: file });
		} finally {
			await bridge.dispose();
		}
	}, 120_000);
} else {
	test("another process finds the session free and can open it", async () => {
		await loadBackend(resolveBackendSelection()!);
		const listed = (await sdk().SessionManager.listAll()).find((s) => s.path === probePath);
		expect(listed).toBeDefined();
		expect(listed?.inUse).toBeUndefined();
		const manager = await sdk().SessionManager.open(probePath);
		await manager.close();
	}, 60_000);
}
