import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { McpServerMutationResponse, McpServersResponse } from "@npi-deck/protocol";
import { loadBackend, resolveBackendSelection, sdk } from "./backend/runtime.ts";
import { buildMcpServersRouter } from "./routes-mcp-servers.ts";
import type { AgentBridge, LiveMcpSession } from "./bridge/types.ts";
import type { Config } from "./config.ts";

const root = await mkdtemp(path.join(tmpdir(), "deck-mcp-servers-test-"));
const project = path.join(root, "project");
await mkdir(path.join(root, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
await mkdir(path.join(project, ".omp"), { recursive: true });
process.env.OMP_DECK_INSTALL_STARTER_SKILLS = "0";
process.env.OMP_DECK_INSTALL_STARTER_EXTENSIONS = "0";
const backend = resolveBackendSelection();
if (!backend) throw new Error("MCP server tests require a configured NeoPi backend");
await loadBackend(backend);
// NeoPi fixes its agent dir when first loaded; another test file may have loaded it first.
// Either way it must be a temp dir: these tests rewrite the user mcp.json.
const agentDir = sdk().getAgentDir();
if (!agentDir.startsWith(tmpdir())) throw new Error(`refusing to edit a non-temporary agent dir: ${agentDir}`);
await mkdir(agentDir, { recursive: true });
const userFile = path.join(agentDir, "mcp.json");
const projectFile = path.join(project, ".omp", "mcp.json");
const priorUser = await Bun.file(userFile).exists() ? await readFile(userFile, "utf8") : null;
const config: Config = { defaultCwd: project, extraWorkspaces: [], host: "127.0.0.1", port: 0, devMode: true, idleTimeoutMs: 0, dbPath: path.join(root, "db"), uploadsRoot: path.join(root, "uploads") };

/** What the fake live chats report; each test sets what it needs. */
let live: LiveMcpSession[] = [];
const applied: Array<{ name: string; enabled: boolean }> = [];
const bridge = { liveMcpSessions: () => live } as unknown as AgentBridge;
const app = buildMcpServersRouter(bridge, config);
const request = (url: string, init?: RequestInit) => app.request(`http://127.0.0.1${url}`, init);
const send = (method: string, url: string, body: unknown) =>
	request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const list = async () => await (await request("/mcp-servers")).json() as McpServersResponse;
const rowOf = async (name: string) => (await list()).servers.find(server => server.name === name);

/** A chat whose MCP runtime accepts the reconcile and reports the server connected. */
function connectedChat(sessionId: string): LiveMcpSession {
	const connected = new Set<string>();
	return {
		sessionId,
		cwd: project,
		apply: async (name, enabled) => {
			applied.push({ name, enabled });
			if (enabled) connected.add(name);
			else connected.delete(name);
			return "applied";
		},
		status: name => connected.has(name) ? "connected" : "disconnected",
	};
}

beforeEach(async () => {
	await writeFile(userFile, JSON.stringify({
		mcpServers: {
			"user-secretive": {
				type: "stdio",
				command: "bun",
				args: ["serve.ts"],
				env: { API_KEY: "s3cret-user-key", LOG_LEVEL: "debug" },
			},
		},
	}, null, 2));
	await writeFile(projectFile, JSON.stringify({
		mcpServers: {
			"project-http": { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer s3cret-header" } },
			"project-off": { type: "stdio", command: "true", enabled: false },
		},
	}, null, 2));
	live = [];
	applied.length = 0;
});

afterAll(async () => {
	if (priorUser === null) await rm(userFile, { force: true });
	else await writeFile(userFile, priorUser);
	await rm(root, { recursive: true, force: true });
});

test("lists every scope with its source file, transport and enabled state", async () => {
	const response = await list();
	expect(response.userConfigPath).toBe(userFile);
	expect(response.projectConfigPath).toBe(projectFile);
	// The listing spans every source NeoPi reads, so assert on this test's own files.
	const names = response.servers.filter(server => server.sourcePath === userFile || server.sourcePath === projectFile).map(server => server.name);
	expect(names).toEqual(["project-http", "project-off", "user-secretive"]);

	expect(response.servers.find(s => s.name === "user-secretive")).toMatchObject({
		transport: "stdio", command: "bun", args: ["serve.ts"], sourcePath: userFile, level: "user", scope: "user", editable: true, state: "enabled",
	});
	expect(response.servers.find(s => s.name === "project-http")).toMatchObject({
		transport: "http", url: "https://example.test/mcp", sourcePath: projectFile, level: "project", scope: "project", state: "enabled",
	});
	expect(response.servers.find(s => s.name === "project-off")).toMatchObject({ state: "disabled", disabledReason: "config-flag" });
});

test("secret-looking env and header values never leave the server; their keys do", async () => {
	const raw = await (await request("/mcp-servers")).text();
	expect(raw).not.toContain("s3cret-user-key");
	expect(raw).not.toContain("s3cret-header");

	expect((await rowOf("user-secretive"))?.env).toEqual([
		{ key: "API_KEY", value: null, masked: true },
		{ key: "LOG_LEVEL", value: "debug", masked: false },
	]);
	expect((await rowOf("project-http"))?.headers).toEqual([{ key: "Authorization", value: null, masked: true }]);
});

test("an edit keeps a masked secret it was never shown", async () => {
	const response = await send("PUT", "/mcp-servers/user-secretive", {
		scope: "user",
		sourcePath: userFile,
		transport: "stdio",
		command: "bun",
		args: ["serve.ts", "--verbose"],
		env: [{ key: "API_KEY", value: null }, { key: "LOG_LEVEL", value: "info" }],
	});
	expect(response.status).toBe(200);
	const body = await response.json() as McpServerMutationResponse;
	expect(body.path).toBe(userFile);
	expect(body.server).toMatchObject({ args: ["serve.ts", "--verbose"] });

	const saved = JSON.parse(await readFile(userFile, "utf8")) as { mcpServers: Record<string, { env: Record<string, string> }> };
	expect(saved.mcpServers["user-secretive"]!.env).toEqual({ API_KEY: "s3cret-user-key", LOG_LEVEL: "info" });
});

test("a rejected definition leaves the config file byte-identical", async () => {
	const before = await readFile(projectFile, "utf8");
	const cases: Array<[unknown, string]> = [
		[{ scope: "project", transport: "stdio" }, 'requires "command" field'],
		[{ scope: "project", transport: "http" }, 'requires "url" field'],
		[{ scope: "project", transport: "carrier-pigeon", command: "true" }, "transport must be"],
		[{ scope: "project", transport: "stdio", command: "true", env: [{ key: "A B", value: "x" }] }, "contains a space"],
		[{ scope: "project", transport: "stdio", command: "true", env: [{ key: "NEW_KEY", value: null }] }, "no stored value"],
		[{ scope: "project", transport: "stdio", command: "true", timeout: -5 }, "timeout must be"],
	];
	for (const [body, message] of cases) {
		const response = await send("PUT", "/mcp-servers/project-off", body);
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain(message);
	}
	expect(await readFile(projectFile, "utf8")).toBe(before);
	expect(await readFile(userFile, "utf8")).not.toContain("project-off");
});

test("writes land in the requested scope and touch no other file", async () => {
	const userBefore = await readFile(userFile, "utf8");
	const created = await send("POST", "/mcp-servers", {
		scope: "project", name: "added-here", transport: "stdio", command: "bun", args: ["x.ts"],
	});
	expect(created.status).toBe(200);
	expect((await created.json() as McpServerMutationResponse).path).toBe(projectFile);
	expect(await readFile(userFile, "utf8")).toBe(userBefore);
	expect(JSON.parse(await readFile(projectFile, "utf8")).mcpServers["added-here"]).toMatchObject({ type: "stdio", command: "bun" });
	expect(await rowOf("added-here")).toMatchObject({ scope: "project", sourcePath: projectFile, state: "enabled" });

	const duplicate = await send("POST", "/mcp-servers", { scope: "project", name: "added-here", transport: "stdio", command: "bun" });
	expect(duplicate.status).toBe(409);

	const removed = await send("DELETE", "/mcp-servers/added-here", { scope: "project" });
	expect(removed.status).toBe(200);
	expect(JSON.parse(await readFile(projectFile, "utf8")).mcpServers["added-here"]).toBeUndefined();
	expect(await readFile(userFile, "utf8")).toBe(userBefore);
	expect((await send("DELETE", "/mcp-servers/added-here", { scope: "project" })).status).toBe(404);
});

test("a write refuses a file NeoPi's writer does not own", async () => {
	const foreign = path.join(root, "elsewhere", "mcp.json");
	const response = await send("POST", "/mcp-servers", {
		scope: "user", sourcePath: foreign, name: "sneaky", transport: "stdio", command: "true",
	});
	expect(response.status).toBe(400);
	expect(await Bun.file(foreign).exists()).toBe(false);
	// The project file is writable, but not at user scope.
	const crossed = await send("POST", "/mcp-servers", {
		scope: "user", sourcePath: projectFile, name: "sneaky", transport: "stdio", command: "true",
	});
	expect(crossed.status).toBe(400);
	expect(JSON.parse(await readFile(projectFile, "utf8")).mcpServers["sneaky"]).toBeUndefined();
});

test("enable writes the flag in the owning file; a server NeoPi cannot rewrite uses the user lists", async () => {
	const enabled = await send("POST", "/mcp-servers/project-off/enabled", { scope: "project", sourcePath: projectFile, enabled: true });
	expect(enabled.status).toBe(200);
	expect(JSON.parse(await readFile(projectFile, "utf8")).mcpServers["project-off"].enabled).toBe(true);
	expect(JSON.parse(await readFile(userFile, "utf8")).disabledServers).toBeUndefined();
	expect(await rowOf("project-off")).toMatchObject({ state: "enabled" });

	const disabled = await send("POST", "/mcp-servers/project-off/enabled", { scope: "project", sourcePath: projectFile, enabled: false });
	expect(disabled.status).toBe(200);
	expect(await rowOf("project-off")).toMatchObject({ state: "disabled", disabledReason: "config-flag" });

	// No writable definition: the denylist is the only honest place to record it.
	const ghost = await send("POST", "/mcp-servers/ghost-server/enabled", { scope: "user", enabled: false });
	expect(ghost.status).toBe(200);
	expect(JSON.parse(await readFile(userFile, "utf8")).disabledServers).toEqual(["ghost-server"]);
});

test("apply reporting states exactly what reached live chats", async () => {
	const noChats = await send("POST", "/mcp-servers", { scope: "project", name: "quiet", transport: "stdio", command: "true" });
	expect((await noChats.json() as McpServerMutationResponse).applyNote).toContain("No chat is running");

	live = [
		connectedChat("with-mcp"),
		{ sessionId: "without-mcp", cwd: project, apply: async () => "no-mcp-runtime", status: () => undefined },
		{ sessionId: "broken", cwd: project, apply: async () => { throw new Error("mcp exploded"); }, status: () => undefined },
	];
	const response = await send("POST", "/mcp-servers", { scope: "project", name: "loud", transport: "stdio", command: "true" });
	const body = await response.json() as McpServerMutationResponse;
	expect(body.live).toEqual([
		{ sessionId: "with-mcp", cwd: project, outcome: "applied", status: "connected" },
		{ sessionId: "without-mcp", cwd: project, outcome: "no-mcp-runtime" },
		{ sessionId: "broken", cwd: project, outcome: "failed" },
	]);
	expect(body.applyNote).toContain("1 of 3 live chats reloaded this server");
	expect(body.applyNote).toContain("1 runs without MCP");
	expect(body.applyNote).toContain("1 failed");
	expect(body.applyNote).toContain("New chats read it when they start");
	// The chat with a runtime sees the stale connection dropped before the new definition connects.
	expect(applied.filter(entry => entry.name === "loud")).toEqual([
		{ name: "loud", enabled: false },
		{ name: "loud", enabled: true },
	]);

	const removed = await send("DELETE", "/mcp-servers/loud", { scope: "project" });
	expect((await removed.json() as McpServerMutationResponse).applyNote).not.toContain("connected");
});

test("a malformed mcp.json fails with a generic error that never quotes it, and stays in place", async () => {
	const broken = '{ "mcpServers": { "x": { "env": { "API_KEY": "s3cret-in-broken-file" } }, }\n';
	await writeFile(projectFile, broken);
	const listed = await request("/mcp-servers");
	// Discovery skips an unparsable source rather than failing; a write to it must not.
	expect(listed.status).toBe(200);
	expect(await listed.text()).not.toContain("s3cret-in-broken-file");

	const write = await send("POST", "/mcp-servers", { scope: "project", name: "after-break", transport: "stdio", command: "true" });
	expect(write.status).toBe(500);
	const text = await write.text();
	expect(text).not.toContain("s3cret-in-broken-file");
	expect(JSON.parse(text).error).toContain("server log");
	expect(await readFile(projectFile, "utf8")).toBe(broken);
});
