import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadBackend, resolveBackendSelection } from "../backend/runtime.ts";
import type { Config } from "../config.ts";
import { spawnOwnedSync } from "../owned-process.ts";
import { buildAdvisorsRouter } from "../routes-advisors.ts";
import { InProcessAgentBridge } from "./in-process.ts";

// NeoPi captures HOME at load, so real sessions run in a child `bun test`
// with an isolated home, agent dir and dummy OpenRouter key (no network is
// used: advisors only build their runtimes here).
const fixtureRoot = process.env.NPI_DECK_ADVISOR_SELECTION_ROOT;

if (!fixtureRoot) {
	test("per-session advisor selection against a real NeoPi session", () => {
		const selection = resolveBackendSelection();
		if (!selection) throw new Error("advisor selection test requires a configured NeoPi backend");
		const root = mkdtempSync(path.join(os.tmpdir(), "deck-advisor-selection-"));
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
				OPENROUTER_API_KEY: "sk-or-advisor-selection-dummy",
				OMP_DECK_INSTALL_STARTER_SKILLS: "0",
				OMP_DECK_INSTALL_STARTER_EXTENSIONS: "0",
				NPI_DECK_BACKEND: selection.path,
				NPI_DECK_ADVISOR_SELECTION_ROOT: root,
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
	test("a chat runs exactly its chosen advisors and keeps them across WATCHDOG saves", async () => {
		const agentDir = process.env.PI_CODING_AGENT_DIR!;
		const project = path.join(fixtureRoot, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(project, { recursive: true });
		const watchdog = path.join(agentDir, "WATCHDOG.yml");
		const model = "openrouter/openai/gpt-4o-mini";
		const roster = `advisors:\n  - name: Velvet\n    model: ${model}\n  - name: Rook\n    model: ${model}\n    enabled: true\n  - name: Moth\n    model: ${model}\n    enabled: false\n`;
		await writeFile(watchdog, roster);
		await loadBackend(resolveBackendSelection()!);
		const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
		try {
			const handle = await bridge.createSession({ cwd: project, model: { provider: "openrouter", id: "openai/gpt-4o-mini" }, mcpServersAllowed: [] });
			const config: Config = { defaultCwd: project, extraWorkspaces: [], host: "127.0.0.1", port: 0, devMode: true, idleTimeoutMs: 0, dbPath: path.join(fixtureRoot, "db"), uploadsRoot: path.join(fixtureRoot, "uploads") };
			const app = buildAdvisorsRouter(bridge, config);
			const request = (url: string, init?: RequestInit) => app.request(`http://127.0.0.1${url}`, init);
			const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			type Status = { overview: { configured: boolean; advisors: Array<{ name: string; status: string }> }; selection: string[] | null };
			const status = async (response?: Response) => {
				const res = response ?? await request(`/sessions/${handle.sessionId}/advisors`);
				expect(res.status).toBe(200);
				const body = await res.json() as Status;
				return { configured: body.overview.configured, running: body.overview.advisors.filter(a => a.status === "running").map(a => a.name), selection: body.selection };
			};
			const select = (advisors: string[]) => request(`/sessions/${handle.sessionId}/advisors`, json("PUT", { advisors }));
			const saveUser = async (update: (advisors: unknown[]) => unknown[]) => {
				const snapshot = await (await request(`/advisors?cwd=${encodeURIComponent(project)}`)).json() as { user: { hash: string; doc: { advisors: unknown[] } } };
				const doc = { advisors: update(snapshot.user.doc.advisors) };
				const saved = await request("/advisors/watchdog", json("PUT", { cwd: project, scope: "user", hash: snapshot.user.hash, doc }));
				expect(saved.status).toBe(200);
			};

			// Global advisor.enabled defaults off: a fresh chat runs nothing.
			expect(await status()).toEqual({ configured: false, running: [], selection: null });

			// Choosing one advisor runs only it, including over a roster-disabled one; WATCHDOG is untouched.
			expect(await status(await select(["Velvet"]))).toEqual({ configured: true, running: ["Velvet"], selection: ["Velvet"] });
			expect(await status(await select(["Moth"]))).toEqual({ configured: true, running: ["Moth"], selection: ["Moth"] });
			expect(await readFile(watchdog, "utf8")).toBe(roster);

			// A WATCHDOG save re-applies the roster to live sessions but keeps the chat's choice.
			await saveUser(advisors => [...advisors, { name: "Newt", model }]);
			expect(await status()).toEqual({ configured: true, running: ["Moth"], selection: ["Moth"] });

			// Removing every chosen advisor stops the chat instead of starting NeoPi's legacy default advisor.
			await saveUser(() => [{ name: "Velvet", model }]);
			expect(await status()).toEqual({ configured: false, running: [], selection: ["Moth"] });

			expect((await select(["Ghost"])).status).toBe(400);
			expect(await status(await select(["Velvet"]))).toEqual({ configured: true, running: ["Velvet"], selection: ["Velvet"] });
			expect(await status(await select([]))).toEqual({ configured: false, running: [], selection: [] });
		} finally {
			await bridge.dispose();
		}
	}, 120_000);
}
