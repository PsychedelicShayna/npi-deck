import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { NpiConfigPatchResponse, NpiConfigResponse } from "@npi-deck/protocol";
import { loadBackend, resolveBackendSelection, sdk } from "./backend/runtime.ts";
import { buildNpiConfigRouter } from "./routes-npi-config.ts";
import type { AgentBridge } from "./bridge/types.ts";
import type { Config } from "./config.ts";

const root = await mkdtemp(path.join(tmpdir(), "deck-npi-config-test-"));
const project = path.join(root, "project");
await mkdir(path.join(root, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
await mkdir(project);
process.env.OMP_DECK_INSTALL_STARTER_SKILLS = "0";
process.env.OMP_DECK_INSTALL_STARTER_EXTENSIONS = "0";
const backend = resolveBackendSelection();
if (!backend) throw new Error("NeoPi config tests require a configured NeoPi backend");
await loadBackend(backend);
// NeoPi fixes its agent dir when first loaded; another test file may have loaded it first.
// Either way it must be a temp dir: these tests rewrite config.yml.
const agentDir = sdk().getAgentDir();
if (!agentDir.startsWith(tmpdir())) throw new Error(`refusing to edit a non-temporary agent dir: ${agentDir}`);
await mkdir(agentDir, { recursive: true });
const configFile = path.join(agentDir, "config.yml");
const priorConfig = await Bun.file(configFile).exists() ? await readFile(configFile, "utf8") : null;
const config: Config = { defaultCwd: project, extraWorkspaces: [], host: "127.0.0.1", port: 0, devMode: true, idleTimeoutMs: 0, dbPath: path.join(root, "db"), uploadsRoot: path.join(root, "uploads") };

// A live chat's settings: an isolated persisted instance, reloaded like the bridge reloads a session's.
let live = await sdk().Settings.loadIsolated({ cwd: project, agentDir });
const bridge = {
	reloadLiveSettings: async () => {
		await live.reloadFromDisk();
		return [{ sessionId: "live", cwd: project, settings: live }];
	},
} as unknown as AgentBridge;
const app = buildNpiConfigRouter(bridge, config);
const request = (url: string, init?: RequestInit) => app.request(`http://127.0.0.1${url}`, init);
const patch = (body: unknown) => request("/npi-config", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const list = async () => await (await request("/npi-config")).json() as NpiConfigResponse;

beforeEach(async () => {
	await writeFile(configFile, "theme:\n  dark: titanium\n");
	live = await sdk().Settings.loadIsolated({ cwd: project, agentDir });
});
afterEach(() => {
	delete process.env.PI_EDIT_FUZZY_THRESHOLD;
});
afterAll(async () => {
	if (priorConfig === null) await rm(configFile, { force: true });
	else await writeFile(configFile, priorConfig);
	await rm(root, { recursive: true, force: true });
});

test("every registered setting is listed once; settings without panel metadata land in Other", async () => {
	const body = await list();
	const ids = body.settings.map(s => s.id);
	expect(new Set(ids).size).toBe(ids.length);
	expect(ids).toContain("statusLine.leftSegments");
	expect(body.settings.find(s => s.id === "modelRoles")?.tab).toBe("other");
	expect(body.tabs.at(-1)?.id).toBe("other");
	for (const setting of body.settings) {
		const tab = body.tabs.find(t => t.id === setting.tab);
		expect(tab?.groups).toContain(setting.group);
	}
});

test("a saved record reaches config.yml and the live session; reset removes the key", async () => {
	const chains = { "anthropic/claude-opus-5-5": ["openai-codex/gpt-6-sol:medium"] };
	const saved = await patch({ id: "retry.fallbackChains", value: chains });
	expect(saved.status).toBe(200);
	const result = await saved.json() as NpiConfigPatchResponse;
	const text = await readFile(configFile, "utf8");
	expect(text).toContain("dark: titanium");
	expect(text).toContain("openai-codex/gpt-6-sol:medium");
	expect(result.setting).toMatchObject({ provenance: "global", inGlobalConfig: true, value: chains });
	expect(result.live).toEqual([{ sessionId: "live", cwd: project, provenance: "global", effectiveValue: chains }]);
	expect((await list()).settings.find(s => s.id === "retry.fallbackChains")).toMatchObject({ provenance: "global", effectiveValue: chains });

	const reset = await (await patch({ id: "retry.fallbackChains", unset: true })).json() as NpiConfigPatchResponse;
	expect(await readFile(configFile, "utf8")).not.toContain("fallbackChains");
	expect(reset.setting).toMatchObject({ provenance: "default", inGlobalConfig: false });
	expect(reset.live[0]).toMatchObject({ provenance: "default", effectiveValue: {} });
});

test("invalid values fail with the setting's own message and leave config.yml untouched", async () => {
	const before = await readFile(configFile, "utf8");
	const cases: Array<[string, unknown, string]> = [
		["edit.fuzzyThreshold", "abc", "Invalid number: abc"],
		["edit.mode", "bogus", "Valid values:"],
		["providers.maxInFlightRequests", { openai: -1 }, "Provider request limits must be positive numbers: openai"],
		["retry.fallbackChains", ["not", "a", "record"], "expected a record"],
		["statusLine.leftSegments", ["no-such-segment"], "Unknown status line segment"],
	];
	for (const [id, value, message] of cases) {
		const response = await patch({ id, value });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain(message);
	}
	expect((await patch({ id: "no.such.setting", value: 1 })).status).toBe(404);
	expect(await readFile(configFile, "utf8")).toBe(before);
});

test("credentials are write-only: configured and saved secrets never appear in responses", async () => {
	await writeFile(configFile, "searxng:\n  token: s3cret-configured\n");
	const response = await request("/npi-config");
	expect(await response.clone().text()).not.toContain("s3cret-configured");
	const token = ((await response.json()) as NpiConfigResponse).settings.find(s => s.id === "searxng.token");
	expect(token).toMatchObject({ secret: true, configured: true, provenance: "global", value: null, effectiveValue: null });

	const saved = await patch({ id: "searxng.token", value: "s3cret-saved" });
	expect(saved.status).toBe(200);
	expect(await saved.text()).not.toContain("s3cret-saved");
	expect(await readFile(configFile, "utf8")).toContain("s3cret-saved");
});

test("a malformed config.yml fails with a generic error, never quotes the file, and stays in place", async () => {
	// NeoPi's load error embeds the parser's message, which can quote the offending line.
	const broken = "searxng:\n  token: s3cret-in-broken-line: [\n";
	await writeFile(configFile, broken);
	for (const response of [await request("/npi-config"), await patch({ id: "edit.mode", value: "replace" })]) {
		expect(response.status).toBe(500);
		const text = await response.text();
		expect(text).not.toContain("s3cret");
		expect(JSON.parse(text).error).toContain("server log");
	}
	expect(await readFile(configFile, "utf8")).toBe(broken);
});

test("rejected credential values are not echoed back", async () => {
	for (const [id, value] of [["images.urls.credentials", "s3cret-not-json"], ["searxng.token", { token: "s3cret-wrong-type" }]] as const) {
		const response = await patch({ id, value });
		expect(response.status).toBe(400);
		const text = await response.text();
		expect(text).not.toContain("s3cret");
		expect(JSON.parse(text).error).toContain(id);
	}
});

test("credential record entries merge field-wise and keep the hidden others", async () => {
	await writeFile(configFile, [
		"images:", "  urls:", "    credentials:",
		"      alpha:", "        clientId: s3cret-alpha-id", "        accessToken: s3cret-alpha-old", "        refreshToken: s3cret-alpha-refresh",
		"      beta:", "        token: s3cret-beta", "",
	].join("\n"));
	const listed = (await list()).settings.find(s => s.id === "images.urls.credentials");
	expect(listed).toMatchObject({
		secret: true,
		value: null,
		secretEntries: [{ key: "alpha", fields: ["clientId", "accessToken", "refreshToken"] }, { key: "beta", fields: ["token"] }],
	});
	const response = await patch({
		id: "images.urls.credentials",
		entries: { alpha: { accessToken: "s3cret-alpha-new", refreshToken: null }, beta: null, gamma: { token: "s3cret-gamma" } },
	});
	expect(response.status).toBe(200);
	const text = await response.text();
	expect(text).not.toContain("s3cret");
	expect((JSON.parse(text) as NpiConfigPatchResponse).setting.secretEntries).toEqual([
		{ key: "alpha", fields: ["clientId", "accessToken"] },
		{ key: "gamma", fields: ["token"] },
	]);
	const saved = Bun.YAML.parse(await readFile(configFile, "utf8")) as { images: { urls: { credentials: unknown } } };
	expect(saved.images.urls.credentials).toEqual({
		alpha: { clientId: "s3cret-alpha-id", accessToken: "s3cret-alpha-new" },
		gamma: { token: "s3cret-gamma" },
	});
});

test("with only config.yaml, NeoPi's file is reported and saves update it in place", async () => {
	const yamlFile = path.join(agentDir, "config.yaml");
	await rm(configFile);
	await writeFile(yamlFile, "theme:\n  dark: titanium\nedit:\n  mode: patch\n");
	try {
		const body = await list();
		expect(body.configPath).toBe(yamlFile);
		expect(body.settings.find(s => s.id === "edit.mode")).toMatchObject({ provenance: "global", value: "patch" });
		const response = await patch({ id: "edit.mode", value: "replace" });
		expect(response.status).toBe(200);
		expect(((await response.json()) as NpiConfigPatchResponse).setting).toMatchObject({ provenance: "global", value: "replace" });
		const text = await readFile(yamlFile, "utf8");
		expect(text).toContain("mode: replace");
		expect(text).toContain("dark: titanium");
		expect(await Bun.file(configFile).exists()).toBe(false);
	} finally {
		await rm(yamlFile, { force: true });
	}
});

test("an environment override locks its key with the reason and refuses writes", async () => {
	process.env.PI_EDIT_FUZZY_THRESHOLD = "0.7";
	const setting = (await list()).settings.find(s => s.id === "edit.fuzzyThreshold");
	expect(setting).toMatchObject({ provenance: "env", effectiveValue: 0.7, env: { name: "PI_EDIT_FUZZY_THRESHOLD", fallback: false, active: true } });
	expect(setting?.lockedReason).toContain("$PI_EDIT_FUZZY_THRESHOLD");
	const before = await readFile(configFile, "utf8");
	const response = await patch({ id: "edit.fuzzyThreshold", value: 0.9 });
	expect(response.status).toBe(409);
	expect(((await response.json()) as { error: string }).error).toContain("$PI_EDIT_FUZZY_THRESHOLD");
	expect(await readFile(configFile, "utf8")).toBe(before);
});
