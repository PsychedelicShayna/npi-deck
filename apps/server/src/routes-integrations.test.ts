import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { McpIntegrationsResponse } from "@npi-deck/protocol";

import { loadBackend, resolveBackendSelection, sdk } from "./backend/runtime.ts";
import type { Config } from "./config.ts";
import { buildIntegrationsRouter } from "./routes-integrations.ts";

const root = mkdtempSync(path.join(tmpdir(), "deck-integrations-test-"));
if (!process.env.PI_CODING_AGENT_DIR) process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const selection = resolveBackendSelection();
if (!selection) throw new Error("integrations tests require a configured NeoPi backend");
await loadBackend(selection);
if (!sdk().getAgentDir().startsWith(tmpdir())) throw new Error(`refusing to run against a non-temporary agent dir: ${sdk().getAgentDir()}`);

const project = path.join(root, "project");
const events = path.join(root, "events.jsonl");
const fixture = path.join(import.meta.dir, "routines", "steps", "mcp-test-server.ts");
const secrets = ["env-secret-value-1", "sk-arg-secret-2", "url-secret-query-3", "hostsecret4"];
mkdirSync(path.join(project, ".omp"), { recursive: true });
writeFileSync(path.join(project, ".omp", "mcp.json"), JSON.stringify({
	mcpServers: {
		fake: {
			type: "stdio",
			command: process.execPath,
			args: [fixture, events, "--token", secrets[1]],
			env: { FAKE_TOKEN: secrets[0] },
		},
		// Nothing listens on port 9, so NeoPi's connection error can quote the URL.
		unreachable: { type: "http", url: `http://127.0.0.1:9/${secrets[3]}/mcp?token=${secrets[2]}`, timeout: 2_000 },
		off: { type: "stdio", command: process.execPath, args: [fixture], enabled: false },
	},
}));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const config: Config = {
	defaultCwd: project, extraWorkspaces: [], host: "127.0.0.1", port: 0, devMode: true, idleTimeoutMs: 0,
	dbPath: path.join(root, "db"), uploadsRoot: path.join(root, "uploads"),
};
const app = buildIntegrationsRouter(config);

test("lists each enabled server with its tools or its scrubbed failure, then closes what it started", async () => {
	const response = await app.request("http://127.0.0.1/integrations/mcp");
	expect(response.status).toBe(200);
	const raw = await response.text();
	for (const secret of secrets) expect(raw).not.toContain(secret);

	const body = JSON.parse(raw) as McpIntegrationsResponse;
	expect(body.cwd).toBe(project);
	expect(body.servers.map(server => server.name)).toEqual(["fake", "unreachable"]);

	const [fake, unreachable] = body.servers;
	expect(fake).toMatchObject({
		transport: "stdio",
		status: "connected",
		level: "project",
		sourcePath: path.join(project, ".omp", "mcp.json"),
		serverInfo: { name: "fake-mcp", version: "1.2.3" },
	});
	expect(fake!.tools.map(tool => tool.name)).toEqual(["echo", "leak", "fail", "hang", "picture", "odd-schema"]);
	expect(fake!.tools[0]).toMatchObject({ description: "Repeat text", inputSchema: { required: ["text"] } });

	expect(unreachable).toMatchObject({ transport: "http", status: "failed", tools: [] });
	expect(unreachable!.error).toBeTruthy();

	// The probe spawned the fake server once and closed it.
	const started = readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line) as { event: string; pid: number });
	expect(started.filter(event => event.event === "start")).toHaveLength(1);
	const pid = started[0]!.pid;
	const deadline = Date.now() + 5_000;
	const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
	while (alive() && Date.now() < deadline) await Bun.sleep(25);
	expect(alive()).toBe(false);
});
