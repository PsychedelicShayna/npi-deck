import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServerMutationResponse, McpServersResponse } from "@npi-deck/protocol";
import { loadBackend, resolveBackendSelection } from "../backend/runtime.ts";
import type { Config } from "../config.ts";
import { spawnOwnedSync } from "../owned-process.ts";
import { buildMcpServersRouter } from "../routes-mcp-servers.ts";
import { InProcessAgentBridge } from "./in-process.ts";

// NeoPi captures HOME at load, so real sessions run in a child `bun test`
// with an isolated home, agent dir and dummy OpenRouter key. No model call is
// made: only the chats' MCP runtimes run, against NeoPi's marker fixture.
const fixtureRoot = process.env.NPI_DECK_MCP_LIVE_APPLY_ROOT;

if (!fixtureRoot) {
	test("MCP removals re-resolve in each live chat's own workspace", () => {
		const selection = resolveBackendSelection();
		if (!selection) throw new Error("MCP live-apply test requires a configured NeoPi backend");
		const root = mkdtempSync(path.join(os.tmpdir(), "deck-mcp-live-apply-"));
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
				OPENROUTER_API_KEY: "sk-or-mcp-live-apply-dummy",
				NPI_DECK_BACKEND: selection.path,
				NPI_DECK_MCP_LIVE_APPLY_ROOT: root,
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
	test("removing the user copy keeps a chat whose workspace defines its own and drops one that relied on it", async () => {
		const agentDir = process.env.PI_CODING_AGENT_DIR!;
		const withOwn = path.join(fixtureRoot, "with-own");
		const withoutOwn = path.join(fixtureRoot, "without-own");
		mkdirSync(path.join(withOwn, ".omp"), { recursive: true });
		mkdirSync(withoutOwn, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const backend = await loadBackend(resolveBackendSelection()!);
		const server = path.join(backend.identity.path, "packages/coding-agent/test/fixtures/mcp-marker-server.ts");
		const marker = (name: string) => path.join(fixtureRoot, `ran-${name}`);
		const entry = (name: string) => ({ type: "stdio", command: process.execPath, args: [server, name, marker(name)] });
		writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { shared: entry("user-copy") } }));
		writeFileSync(path.join(withOwn, ".omp", "mcp.json"), JSON.stringify({ mcpServers: { shared: entry("project-copy") } }));

		const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
		try {
			const model = { provider: "openrouter", id: "openai/gpt-4o-mini" };
			const own = await bridge.createSession({ cwd: withOwn, model });
			const relied = await bridge.createSession({ cwd: withoutOwn, model });
			const status = (sessionId: string) => bridge.liveMcpSessions().find(live => live.sessionId === sessionId)?.status("shared");
			const settle = async (sessionId: string, want: string) => {
				for (let i = 0; i < 200 && status(sessionId) !== want; i++) await Bun.sleep(50);
				return status(sessionId);
			};
			expect(await settle(own.sessionId, "connected")).toBe("connected");
			expect(await settle(relied.sessionId, "connected")).toBe("connected");
			expect(existsSync(marker("project-copy")) && existsSync(marker("user-copy"))).toBe(true);
			rmSync(marker("project-copy"));
			rmSync(marker("user-copy"));

			// The deck's default workspace is the one without its own copy: judged
			// from there alone, the removal would leave nothing to run anywhere.
			const config: Config = { defaultCwd: withoutOwn, extraWorkspaces: [], host: "127.0.0.1", port: 0, devMode: true, idleTimeoutMs: 0, dbPath: path.join(fixtureRoot, "db"), uploadsRoot: path.join(fixtureRoot, "uploads") };
			const app = buildMcpServersRouter(bridge, config);
			const request = (url: string, init?: RequestInit) => app.request(`http://127.0.0.1${url}`, init);
			const listed = await (await request("/mcp-servers")).json() as McpServersResponse;
			const revision = listed.servers.find(row => row.name === "shared" && row.scope === "user")!.revision;
			const response = await request("/mcp-servers/shared", {
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ scope: "user", revision }),
			});
			expect(response.status).toBe(200);
			const body = await response.json() as McpServerMutationResponse;
			expect(body.server).toBeNull();

			const byChat = Object.fromEntries(body.live.map(live => [live.sessionId, live]));
			expect(byChat[own.sessionId]).toMatchObject({ outcome: "applied" });
			expect(byChat[relied.sessionId]).toMatchObject({ outcome: "applied", status: "disconnected" });
			// The chat with its own definition reconnected it (a fresh process), the other did not.
			expect(await settle(own.sessionId, "connected")).toBe("connected");
			for (let i = 0; i < 100 && !existsSync(marker("project-copy")); i++) await Bun.sleep(50);
			expect(existsSync(marker("project-copy"))).toBe(true);
			expect(status(relied.sessionId)).toBe("disconnected");
			await Bun.sleep(300);
			expect(existsSync(marker("user-copy"))).toBe(false);
			expect(body.applyNote).toContain("dropped it");
		} finally {
			await bridge.dispose();
		}
	}, 120_000);
}
