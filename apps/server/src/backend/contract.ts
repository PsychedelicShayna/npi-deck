#!/usr/bin/env bun
/**
 * Backend contract fixture: exercises every manifest operation against a NeoPi
 * tree in an isolated process and prints a report. Exit 0 means every check
 * passed.
 *
 *   bun apps/server/src/backend/contract.ts [--json]
 *
 * The tree is chosen the way the server chooses it (NPI_DECK_BACKEND, else
 * activeBackend in config.yml). The checks run in a child process whose HOME,
 * XDG dirs, cwd and PI_CODING_AGENT_DIR point into a fresh temp dir, with
 * credential and PI_/OMP_/NPI_DECK_ env vars dropped and a dummy openrouter
 * key so model resolution works without a real account. No check makes a
 * provider request.
 *
 * Besides per-operation checks it records two facts the plan depends on:
 *   - settings-isolation (C1): does a Settings.loadIsolated instance passed to
 *     createAgentSession stay scoped to its session?
 *   - advisor-role-hot-apply (C9): does changing modelRoles.advisor through a
 *     session's settings retarget its live advisor?
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentSession, CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent";

import { MANIFEST, manifestRows, type FeatureSpec, type ModuleSpecifier } from "./manifest.ts";
import { InProcessAgentBridge } from "../bridge/in-process.ts";
import { spawnOwnedSync } from "../owned-process.ts";
import { feature, formatDiagnostic, loadBackend, resolveBackendSelection, resolveManifest, sdk } from "./runtime.ts";

// HOME and friends must be set before the process starts: NeoPi (and
// os.homedir()) capture them at load. The parent picks the tree, prepares a
// temp root and re-runs this file as a child with the controlled env.
if (!process.env.NPI_DECK_CONTRACT_ROOT) {
	const selection = resolveBackendSelection();
	if (!selection) throw new Error("no backend configured for contract fixture");
	const root = mkdtempSync(path.join(os.tmpdir(), "npi-deck-contract-"));
	const home = path.join(root, "home");
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
		OPENROUTER_API_KEY: "sk-or-contract-fixture-dummy",
		ANTHROPIC_API_KEY: "sk-ant-contract-fixture-dummy",
		NPI_DECK_BACKEND: selection.path,
		NPI_DECK_CONTRACT_ROOT: root,
	});
	mkdirSync(home, { recursive: true });
	mkdirSync(env.PI_CODING_AGENT_DIR!, { recursive: true });
	const child = spawnOwnedSync([process.execPath, import.meta.path, ...process.argv.slice(2)], {
		cwd: root,
		env,
		stdio: ["ignore", "inherit", "inherit"],
	}, { replaceEnv: true });
	rmSync(root, { recursive: true, force: true });
	process.exit(child.exitCode ?? 1);
}

const tmp = process.env.NPI_DECK_CONTRACT_ROOT;
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const selection = resolveBackendSelection();

interface Check {
	name: string;
	ok: boolean;
	detail: string;
}
const checks: Check[] = [];
const facts: Record<string, { value: string; evidence: string }> = {};
/** Manifest keys a check has actually called. */
const exercised = new Set<string>();

async function check(name: string, keys: string[], fn: () => Promise<string> | string): Promise<void> {
	try {
		const detail = await fn();
		checks.push({ name, ok: true, detail });
		for (const k of keys) exercised.add(k);
	} catch (err) {
		checks.push({ name, ok: false, detail: err instanceof Error ? (err.stack ?? err.message) : String(err) });
	}
}

function assert(cond: unknown, message: string): asserts cond {
	if (!cond) throw new Error(message);
}

function mkdir(...parts: string[]): string {
	const dir = path.join(tmp, ...parts);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function importFromTree<T>(specifier: string): Promise<T> {
	return (await import(Bun.resolveSync(specifier, backendPath))) as T;
}

const backend = await loadBackend(selection);
const backendPath = backend.identity.path;
const core = sdk();
const planMode = feature("plan-mode");
const subagents = feature("subagent-tree");
const advisors = feature("advisors");
const mixtures = feature("mixtures");
const mixtureConfig = feature("mixture-config");
const mcp = feature("mcp-allowlist");
const multiRoot = feature("multi-root");
const build = feature("build-identity");
const npiConfig = feature("npi-config");
const models = feature("models-config");

await check("manifest: every feature available", [], () => {
	const missing = Object.entries(backend.features).flatMap(([, f]) => f.diagnostics);
	assert(missing.length === 0, missing.map(formatDiagnostic).join("; "));
	return `${manifestRows().length} exports across ${Object.keys(MANIFEST).length} features; routine-agent-step files present`;
});

await check("manifest: missing export/module produce named diagnostics", [], async () => {
	const broken: Record<string, FeatureSpec> = {
		probe: {
			tier: "required",
			consumers: [],
			exports: {
				gone: { module: "@oh-my-pi/pi-coding-agent", export: "definitelyNotExported" },
				nowhere: { module: "@oh-my-pi/pi-coding-agent/no-such-module" as ModuleSpecifier, export: "x" },
			},
			files: ["packages/coding-agent/src/no-such-file.ts"],
		},
	};
	const { features } = await resolveManifest(backendPath, broken);
	const lines = (features as Record<string, { diagnostics: Parameters<typeof formatDiagnostic>[0][] }>).probe!.diagnostics.map(
		formatDiagnostic,
	);
	assert(lines.length === 3, `expected 3 diagnostics, got ${lines.length}: ${lines.join(" | ")}`);
	assert(lines[0]!.includes("@oh-my-pi/pi-coding-agent → definitelyNotExported") && lines[0]!.includes("export missing"), lines[0]);
	assert(lines[1]!.includes("@oh-my-pi/pi-coding-agent/no-such-module → x") && lines[1]!.includes("cannot resolve"), lines[1]);
	assert(lines[2]!.includes("no-such-file.ts") && lines[2]!.includes("file missing"), lines[2]);
	return lines.join("\n    ");
});

await check("identity: VERSION, agent dir isolation", ["VERSION", "getAgentDir"], () => {
	assert(core.getAgentDir() === agentDir, `getAgentDir() = ${core.getAgentDir()}, expected ${agentDir}`);
	return `VERSION ${core.VERSION}, commit ${backend.identity.commit}, agentDir isolated`;
});
await check("identity: BUILD_INFO snapshots the source tree", ["BUILD_INFO"], () => {
	const info = build.BUILD_INFO;
	assert(info.gitSha === backend.identity.commit, `BUILD_INFO gitSha ${info.gitSha} != ${backend.identity.commit}`);
	assert(info.version === core.VERSION && info.dirty === false, `unexpected BUILD_INFO ${JSON.stringify(info)}`);
	return `${info.version} ${info.gitSha} dirty=${info.dirty}`;
});

await check("npi-config: registry handles enumerate, parse, persist and report provenance", [
	"orderedSettings", "allSettings", "SETTING_TABS", "TAB_METADATA", "TAB_GROUPS", "MAIN_CONFIG_FILENAMES",
], async () => {
	const all = npiConfig.allSettings();
	const ordered = new Set(npiConfig.orderedSettings());
	assert(all.length > 0 && all.every(s => ordered.has(s)), `orderedSettings omits ${all.filter(s => !ordered.has(s)).map(s => s.id).join(", ")}`);
	const tabs = npiConfig.SETTING_TABS as string[];
	const groups = npiConfig.TAB_GROUPS as Record<string, readonly string[]>;
	const labels = npiConfig.TAB_METADATA as Record<string, { label: string }>;
	const misplaced = all.filter(s => s.ui && (!tabs.includes(s.ui.tab) || !labels[s.ui.tab]?.label || (s.ui.group !== undefined && !groups[s.ui.tab]?.includes(s.ui.group))));
	assert(misplaced.length === 0, `settings outside declared tabs/groups: ${misplaced.map(s => s.id).join(", ")}`);
	const handle = all.find(s => s.id === "edit.fuzzyThreshold");
	assert(handle?.type === "number", "edit.fuzzyThreshold number handle missing");
	let rejected = "";
	try { handle.parse("not-a-number"); } catch (err) { rejected = (err as Error).message; }
	assert(rejected.includes("Invalid number"), `parse did not reject: ${rejected}`);
	const writable = await core.Settings.loadIsolated({ cwd: agentDir, agentDir });
	handle.set(writable, handle.parse("0.9"));
	await writable.flush();
	const read = await core.Settings.loadReadOnly({ cwd: agentDir, agentDir });
	assert(handle.get(read) === 0.9 && handle.provenance(read) === "global", `persisted ${String(handle.get(read))} via ${handle.provenance(read)}`);
	handle.unset(writable);
	await writable.flush();
	// The deck reports the first existing of these names as the file NeoPi reads and saves.
	const [primary] = npiConfig.MAIN_CONFIG_FILENAMES;
	assert(primary === "config.yml" && await Bun.file(path.join(agentDir, primary)).exists(), `NeoPi saved to a file other than ${primary}`);
	const cleared = await core.Settings.loadReadOnly({ cwd: agentDir, agentDir });
	assert(handle.provenance(cleared) === "default", `unset left provenance ${handle.provenance(cleared)}`);
	return `${all.length} settings (${all.filter(s => !s.ui).length} config-file only) across ${tabs.length} tabs; parse rejects "${rejected}"; set/unset round-trips global↔default`;
});

await check("theme: pi-tui instance initialized for ask", ["getThemeByName", "setThemeInstance"], async () => {
	const dark = await core.getThemeByName("dark");
	assert(dark, "dark theme missing");
	core.setThemeInstance(dark);
	const { theme } = await importFromTree<{ theme: { status: { success: string } } }>("@oh-my-pi/pi-tui/theme/theme");
	assert(typeof theme.status.success === "string" && theme.status.success.length > 0, "theme.status.success unset");
	return `theme.status.success = ${JSON.stringify(theme.status.success)}`;
});

const registry = await (async () => {
	const auth = await core.discoverAuthStorage();
	const r = new core.ModelRegistry(auth);
	await r.refresh("offline");
	return r;
})();
const cheapModel = registry.find("openrouter", "openai/gpt-4o-mini");

await check("auth: storage, registry, env key, oauth providers", ["discoverAuthStorage", "ModelRegistry", "getEnvApiKey", "getOAuthProviders"], () => {
	const providers = core.getOAuthProviders();
	assert(providers.length > 0, "no OAuth providers");
	assert(core.getEnvApiKey("openrouter") === process.env.OPENROUTER_API_KEY, "getEnvApiKey(openrouter) mismatch");
	assert(cheapModel, "openrouter/openai/gpt-4o-mini not in registry");
	const stored = registry.authStorage.credentials.all();
	assert(Object.keys(stored).length === 0, `isolated auth store not empty: ${Object.keys(stored).join(",")}`);
	return `${providers.length} OAuth providers; credentials.all() empty; model registry resolves ${cheapModel.provider}/${cheapModel.id}`;
});

await check("models-config: NeoPi validates a models.yml copy and a registry reload lists its new model", ["ModelsConfigFile"], async () => {
	const file = path.join(mkdir("models-config"), "models.yml");
	const provider = (models: string) => `providers:\n  contract-local:\n    baseUrl: http://127.0.0.1:9/v1\n    api: openai-completions\n    auth: none\n    models:\n${models}`;
	writeFileSync(file, provider("      - id: first\n"));
	const loaded = models.ModelsConfigFile.relocate(file).tryLoad();
	assert(loaded.status === "ok" && loaded.value.providers?.["contract-local"]?.models?.[0]?.id === "first", `valid copy rejected: ${loaded.error}`);
	const local = new core.ModelRegistry(registry.authStorage, file);
	await local.refresh("offline");
	assert(local.find("contract-local", "first") && !local.find("contract-local", "second"), "custom model not listed after first load");
	writeFileSync(file, provider("      - id: first\n      - id: second\n"));
	await local.reapplyModelPolicies();
	assert(local.find("contract-local", "second") && !local.getError(), `reapplyModelPolicies did not list the added model: ${local.getError()?.message}`);
	writeFileSync(file, provider("      - id: first\n        contextWindow: -1\n"));
	const rejected = models.ModelsConfigFile.relocate(file).tryLoad();
	assert(rejected.status === "error" && rejected.error.message.includes("invalid contextWindow"), `invalid copy accepted: ${rejected.status}`);
	return `relocated load ok; reload lists added model; rejects with "${rejected.error.message.split("\n")[0]}"`;
});

await check("mixtures: workspaces register only their own MIXTURES.toml models", ["MixtureWorkspace"], async () => {
	const mixture = (name: string, prompt: string) => [
		"[[mixtures]]",
		`name = "${name}"`,
		'entry = "writer"',
		"[[mixtures.members]]",
		'id = "writer"',
		'model = "openrouter/openai/gpt-4o-mini"',
		`system_prompt = "${prompt}"`,
		"tools = false",
		"",
	].join("\n");
	const a = mkdir("moa-a");
	const b = mkdir("moa-b");
	await Bun.write(path.join(a, "MIXTURES.toml"), mixture("deck-contract-a", "Draft A."));
	await Bun.write(path.join(b, "MIXTURES.toml"), mixture("deck-contract-b", "Draft B."));
	const hold = async (cwd: string) => mixtures.MixtureWorkspace.retain(`contract:${cwd}`, { cwd, agentDir, registry, settings: await core.Settings.loadIsolated({ cwd, agentDir }) });
	const wa = await hold(a);
	const wb = await hold(b);
	try {
		assert(registry.find("mixture", "deck-contract-a")?.api === "mixture", "mixture/deck-contract-a not registered");
		assert(registry.find("mixture", "deck-contract-b")?.api === "mixture", "mixture/deck-contract-b not registered");
		assert(wa.scope.find("deck-contract-a") && !wa.scope.find("deck-contract-b"), "workspace A scope sees B's mixture");
		assert(wb.scope.find("deck-contract-b") && !wb.scope.find("deck-contract-a"), "workspace B scope sees A's mixture");
	} finally {
		wa.release();
		wb.release();
	}
	assert(!registry.find("mixture", "deck-contract-a") && !registry.find("mixture", "deck-contract-b"), "mixtures still registered after the last release");
	return "two workspaces register their own mixture, each scope finds only its own, both unregister on release";
});

await check(
	"mixture-config: search path, parse, serialize, resolve, validate, lock and rediscover a MIXTURES.toml",
	["configCandidatePaths", "parseMixturesDoc", "serializeMixturesConfig", "MAX_FILE_BYTES", "resolveMixture", "validateMixture", "discoverRegistrableMixtures", "withFileLock"],
	async () => {
		const cwd = mkdir("mixture-config", "nested");
		const file = path.join(cwd, ".omp", "MIXTURES.toml");
		const { candidates } = mixtureConfig.configCandidatePaths(cwd, agentDir, ["MIXTURES.toml"]);
		assert(candidates.includes(file) && candidates.includes(path.join(agentDir, "MIXTURES.toml")), `search path = ${candidates.join(", ")}`);
		assert(Number.isInteger(mixtureConfig.MAX_FILE_BYTES) && mixtureConfig.MAX_FILE_BYTES > 0, `MAX_FILE_BYTES = ${mixtureConfig.MAX_FILE_BYTES}`);
		const member = (id: string) => ({ id, model: "openrouter/openai/gpt-4o-mini", systemPrompt: "Answer.", tools: false });
		const chain = { name: "deck-chain", entry: "writer", members: [member("writer"), member("editor")], edges: [{ from: "writer", to: "editor", x: { output: true as const } }], limits: { maxHops: 4 } };
		const gated = { ...chain, name: "deck-gated", limits: { maxHops: 4, budgetUsd: 1 } };
		const text = mixtureConfig.serializeMixturesConfig({ mixtures: [chain, gated] });
		const roundTrip = mixtureConfig.parseMixturesDoc(Bun.TOML.parse(text), "contract draft");
		assert(!roundTrip.warnings?.length, `round-trip warnings: ${roundTrip.warnings?.join("; ")}`);
		assert(roundTrip.mixtures[1]?.limits?.budgetUsd === 1, "serialize/parse dropped limits.budget_usd");
		const settings = await core.Settings.loadIsolated({ cwd, agentDir });
		const names = roundTrip.mixtures.map(mixture => mixture.name);
		const [ok, refused] = roundTrip.mixtures.map(definition =>
			mixtureConfig.validateMixture(mixtureConfig.resolveMixture(definition, { registry, settings }), { settings, names }),
		);
		assert(ok && ok.errors.length === 0, `linear chain refused: ${ok?.errors.map(issue => issue.code).join(",")}`);
		const gate = refused?.errors.find(issue => issue.code === "unsupported.feature");
		assert(gate?.path === "limits.budget_usd", `budget gate = ${JSON.stringify(refused?.errors)}`);
		mkdirSync(path.dirname(file), { recursive: true });
		// The lock is exclusive across holders: a second acquisition fails while the first holds it.
		await mixtureConfig.withFileLock(file, async () => {
			const second = await mixtureConfig.withFileLock(file, async () => "acquired", { retries: 1 }).catch(() => "refused");
			assert(second === "refused", "withFileLock granted a second holder");
			await Bun.write(file, text);
		});
		const registrable = await mixtureConfig.discoverRegistrableMixtures({ cwd, agentDir, registry, settings });
		assert(registrable.map(mixture => mixture.definition.name).join(",") === "deck-chain", `registrable = ${registrable.map(mixture => mixture.definition.name)}`);
		return `.omp/MIXTURES.toml is on the search path; ${gate.message}; lock excludes a second holder; discovery registers mixture/deck-chain only`;
	},
);

async function newSession(cwd: string, extra: Partial<CreateAgentSessionOptions> = {}) {
	return core.createAgentSession({
		cwd,
		agentDir,
		sessionManager: core.SessionManager.create(cwd),
		modelRegistry: registry,
		authStorage: registry.authStorage,
		skipPythonPreflight: true,
		agentId: `Contract-${path.basename(cwd)}`,
		hasUI: false,
		...(cheapModel ? { model: cheapModel } : {}),
		...extra,
	});
}

const rootB = mkdir("root-b");
let sessionB: AgentSession | undefined;
await check("sessions: create, list", ["createAgentSession", "SessionManager"], async () => {
	sessionB = (await newSession(rootB)).session;
	sessionB.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "contract" }], timestamp: Date.now() });
	sessionB.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-completions",
		provider: "openrouter",
		model: "openai/gpt-4o-mini",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never);
	await sessionB.sessionManager.flush();
	const listed = await core.SessionManager.list(rootB);
	const all = await core.SessionManager.listAll();
	assert(listed.some((s) => s.path === sessionB!.sessionFile), "SessionManager.list misses the session");
	assert(all.length >= 1, "SessionManager.listAll empty");
	return `session ${sessionB.sessionId} persisted and listed`;
});

await check("multi-root: duplicate root identity leaves original registered", ["AgentIdConflictError"], async () => {
	assert(sessionB, "no root session");
	const existing = subagents.AgentRegistry.global().get("Contract-root-b");
	assert(existing?.session === sessionB, "first root missing from registry");
	const conflict = await newSession(mkdir("conflict"), { agentId: "Contract-root-b" }).then(
		() => undefined, (error: unknown) => error,
	);
	assert(conflict instanceof multiRoot.AgentIdConflictError, `duplicate root did not throw AgentIdConflictError: ${String(conflict)}`);
	assert(conflict.agentId === "Contract-root-b", `wrong conflicting ID: ${conflict.agentId}`);
	assert(subagents.AgentRegistry.global().get("Contract-root-b") === existing, "conflict displaced original root");
	return "duplicate root rejected; original registry ref unchanged";
});

await check("MCP: per-session override rejects unknown and shadowed names", [
	"cfgMcpIncludeServers", "MCPUnknownServerError", "loadAllMCPConfigs",
], async () => {
	const cwd = mkdir("root-mcp");
	mkdirSync(path.join(cwd, ".omp"), { recursive: true });
	const server = path.join(backendPath, "packages/coding-agent/test/fixtures/mcp-marker-server.ts");
	const markers = ["admitted", "excluded", "disabled-project", "shadowed-user"].map(name => path.join(cwd, `ran-${name}`));
	writeFileSync(path.join(cwd, ".omp", "mcp.json"), JSON.stringify({
		mcpServers: {
			...Object.fromEntries(["admitted", "excluded"].map((name, i) => [
				name, { command: process.execPath, args: [server, name, markers[i]] },
			])),
			shared: { command: process.execPath, args: [server, "disabled-project", markers[2]], enabled: false },
		},
	}));
	writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({
		mcpServers: { shared: { command: process.execPath, args: [server, "shadowed-user", markers[3]] } },
	}));
	const discovered = await mcp.loadAllMCPConfigs(cwd, { includeServers: ["admitted"] });
	assert(Object.keys(discovered.configs).join(",") === "admitted", "MCP discovery admitted the wrong servers");
	const settings = await core.Settings.loadIsolated({ cwd, agentDir });
	const configPath = path.join(agentDir, "config.yml");
	const before = await Bun.file(configPath).exists() ? await Bun.file(configPath).text() : undefined;
	mcp.cfgMcpIncludeServers.override(settings, ["admitted"]);
	assert(mcp.cfgMcpIncludeServers.get(settings).join(",") === "admitted", "override did not take");
	const allowed = (await newSession(cwd, { settings })).session;
	try {
		const deadline = Date.now() + 10_000;
		while (!(await Bun.file(markers[0]!).exists()) && Date.now() < deadline) await Bun.sleep(50);
		assert(await Bun.file(markers[0]!).exists(), "allowed MCP server was not spawned");
		assert(!(await Bun.file(markers[1]!).exists()), "excluded MCP server was spawned");
	} finally { await allowed.dispose(); }
	const after = await Bun.file(configPath).exists() ? await Bun.file(configPath).text() : undefined;
	assert(before === after, "MCP override persisted to shared config.yml");
	const unknownSettings = await core.Settings.loadIsolated({ cwd, agentDir });
	mcp.cfgMcpIncludeServers.override(unknownSettings, ["unknown"]);
	const failure = await newSession(cwd, { agentId: "Contract-unknown", settings: unknownSettings }).then(
		() => undefined, (error: unknown) => error,
	);
	assert(failure instanceof mcp.MCPUnknownServerError, `unknown MCP name was not typed: ${String(failure)}`);
	assert(failure.serverNames.join(",") === "unknown", `unexpected unknown names: ${failure.serverNames}`);
	assert(!(await Bun.file(markers[1]!).exists()), "unknown allowlist spawned excluded server");
	const shadowedLookup = await mcp.loadAllMCPConfigs(cwd, { includeServers: ["shared"] });
	assert(shadowedLookup.unmatchedIncludes?.join(",") === "shared", "disabled project server was rescued by a shadowed user name");
	const shadowedSettings = await core.Settings.loadIsolated({ cwd, agentDir });
	mcp.cfgMcpIncludeServers.override(shadowedSettings, ["shared"]);
	const shadowedFailure = await newSession(cwd, { agentId: "Contract-shadowed", settings: shadowedSettings }).then(
		async result => { await result.session.dispose(); return undefined; }, (error: unknown) => error,
	);
	assert(shadowedFailure instanceof mcp.MCPUnknownServerError, `shadowed MCP name did not fail before session startup: ${String(shadowedFailure)}`);
	assert(!(await Bun.file(markers[2]!).exists()) && !(await Bun.file(markers[3]!).exists()), "disabled or shadowed MCP server was spawned");
	return "allowed fixture spawned; excluded never spawned; config unchanged; unknown and shadowed IDs rejected before startup";
});

await check("MCP servers: list every source, write one scope, toggle, apply live", [
	"getMCPConfigPath", "mcpCapability", "isProviderEnabled", "isUserSourceEnabled", "cfgDisabledExtensions",
	"cfgMcpEnableProjectConfig", "readMCPConfigFile", "getMCPServer", "addMCPServer",
	"setServerDisabled", "setServerForceEnabled", "readDisabledServers", "readEnabledServers", "validateServerName",
	"validateServerConfig", "applyMcpToggleRuntime", "clearFsCache", "writeMCPConfigFile", "withFileLock",
], async () => {
	const servers = feature("mcp-servers");
	const cwd = mkdir("root-mcp-edit");
	const userPath = servers.getMCPConfigPath("user", cwd);
	const projectPath = servers.getMCPConfigPath("project", cwd);
	assert(userPath === path.join(agentDir, "mcp.json"), `user MCP config resolved to ${userPath}`);
	assert(projectPath.startsWith(cwd) && projectPath.endsWith("mcp.json"), `project MCP config resolved to ${projectPath}`);
	assert(servers.validateServerName("bad name!") !== undefined, "an invalid server name was accepted");
	assert(servers.validateServerName("contract-live") === undefined, "a valid server name was rejected");
	assert(
		servers.validateServerConfig("contract-live", { type: "stdio" } as never).length === 1,
		"a stdio entry without a command passed validation",
	);

	// A live chat that starts before the server exists: its manager is the one
	// the deck reconciles against after the write.
	const live = await newSession(cwd, { agentId: "Contract-mcp-live" });
	const manager = live.mcpManager;
	assert(manager, "session exposes no MCP manager");
	try {
		const fixture = path.join(backendPath, "packages/coding-agent/test/fixtures/mcp-marker-server.ts");
		const marker = path.join(cwd, "ran-contract-live");
		await servers.addMCPServer(projectPath, "contract-live", {
			type: "stdio", command: process.execPath, args: [fixture, "contract-live", marker],
		});
		const duplicate = await servers.addMCPServer(projectPath, "contract-live", { type: "stdio", command: "true" })
			.then(() => undefined, (error: unknown) => error);
		assert(duplicate instanceof Error, "a duplicate server name was accepted");
		// The deck's edit: read, merge and write under NeoPi's lock with the lock-free writer.
		await servers.withFileLock(projectPath, async () => {
			const current = await servers.readMCPConfigFile(projectPath);
			await servers.writeMCPConfigFile(projectPath, {
				...current,
				mcpServers: { ...current.mcpServers, "contract-live": { ...current.mcpServers!["contract-live"]!, timeout: 20_000 } },
			});
		});
		const stored = await servers.getMCPServer(projectPath, "contract-live");
		assert(stored?.type === "stdio" && stored.timeout === 20_000, `update did not land: ${JSON.stringify(stored?.type)}`);
		const file = await servers.readMCPConfigFile(projectPath);
		assert(Object.keys(file.mcpServers ?? {}).join(",") === "contract-live", "project config holds the wrong servers");

		const settings = await core.Settings.loadReadOnly({ cwd, agentDir });
		assert(typeof servers.cfgMcpEnableProjectConfig.get(settings) === "boolean", "project-config setting unavailable");
		const discovered = await core.loadCapability<{ name: string; _source: { path: string; level: string; provider: string } }>(
			servers.mcpCapability.id,
			{ cwd, includeDisabled: true, disabledExtensions: [...servers.cfgDisabledExtensions.get(settings)] },
		);
		const row = discovered.all.find(item => item.name === "contract-live");
		assert(row?._source.path === projectPath && row._source.level === "project" && row._source.provider === "native",
			`discovery reported ${JSON.stringify(row?._source)}`);
		assert(servers.isProviderEnabled("native"), "the native provider is switched off");
		assert(servers.isUserSourceEnabled("native"), "the native user source is opt-in");

		// Live apply: connect the new server into the running chat, then drop it.
		const apply = (enabled: boolean) => servers.applyMcpToggleRuntime({
			name: "contract-live", enabled, cwd, manager, session: live.session,
			discovery: { enableProjectConfig: true, filterExa: true, filterBrowser: false },
		});
		await apply(true);
		assert(await Bun.file(marker).exists(), "live apply did not spawn the server");
		assert(manager.getConnectionStatus("contract-live") === "connected", `live apply left it ${manager.getConnectionStatus("contract-live")}`);
		const bound = manager.getTools().filter(tool => tool.mcpServerName === "contract-live");
		assert(bound.length > 0, "the manager exposes no tools for the connected server");
		assert(bound.every(tool => live.session.getAllToolNames().includes(tool.name)), "session tools missed the connected server");
		await apply(false);
		assert(manager.getConnectionStatus("contract-live") === "disconnected", "live disable left the server connected");
		assert(!live.session.getAllToolNames().some(name => bound.some(tool => tool.name === name)), "live disable left the server's tools bound");

		// A server NeoPi cannot rewrite is toggled through the user deny and force-enable lists.
		await servers.setServerDisabled(userPath, "contract-foreign", true);
		assert((await servers.readDisabledServers(userPath)).includes("contract-foreign"), "foreign disable did not reach the denylist");
		await servers.setServerDisabled(userPath, "contract-foreign", false);
		await servers.setServerForceEnabled(userPath, "contract-foreign", true);
		assert(!(await servers.readDisabledServers(userPath)).includes("contract-foreign"), "re-enable left the denylist entry");
		assert((await servers.readEnabledServers(userPath)).includes("contract-foreign"), "foreign enable did not reach the allowlist");
		await servers.setServerForceEnabled(userPath, "contract-foreign", false);
		assert(!(await servers.readEnabledServers(userPath)).includes("contract-foreign"), "the allowlist entry stayed");

		await servers.withFileLock(projectPath, async () => {
			const { "contract-live": _removed, ...remaining } = (await servers.readMCPConfigFile(projectPath)).mcpServers ?? {};
			await servers.writeMCPConfigFile(projectPath, { mcpServers: remaining });
		});
		assert(await servers.getMCPServer(projectPath, "contract-live") === undefined, "remove left the entry behind");
		// After a removal the deck asks each chat to reconnect; NeoPi must connect
		// nothing when the chat's own workspace no longer resolves the name.
		rmSync(marker, { force: true });
		await apply(true);
		assert(manager.getConnectionStatus("contract-live") === "disconnected", "a removed server reconnected");
		await Bun.sleep(200);
		assert(!(await Bun.file(marker).exists()), "a removed server was spawned again");

		// The deck merges an edit inside this lock and writes with the lock-free
		// writer; NeoPi's own writers must queue behind it rather than interleave.
		const order: string[] = [];
		const held = servers.withFileLock(projectPath, async () => {
			order.push("lock-enter");
			await Bun.sleep(120);
			const stored = await servers.readMCPConfigFile(projectPath);
			await servers.writeMCPConfigFile(projectPath, {
				...stored, mcpServers: { ...stored.mcpServers, locked: { type: "stdio", command: "true" } },
			});
			order.push("lock-exit");
		});
		await Bun.sleep(20);
		const contender = servers.addMCPServer(projectPath, "contender", { type: "stdio", command: "true" })
			.then(() => order.push("contender"));
		await Promise.all([held, contender]);
		assert(order.join(",") === "lock-enter,lock-exit,contender", `writers interleaved: ${order.join(",")}`);
		const both = await servers.readMCPConfigFile(projectPath);
		assert(both.mcpServers?.locked !== undefined && both.mcpServers?.contender !== undefined, "a locked write lost the contender's entry");
		// (the next step overwrites the file, dropping both entries)
		// An edit made outside NeoPi's writer (a terminal, another tool) is only
		// visible once the capability file cache is dropped.
		await Bun.write(projectPath, JSON.stringify({ mcpServers: { "contract-external": { type: "stdio", command: "true" } } }));
		servers.clearFsCache();
		const external = await core.loadCapability<{ name: string }>(servers.mcpCapability.id, { cwd, includeDisabled: true });
		assert(external.all.some(item => item.name === "contract-external"), "an external mcp.json edit stayed invisible after clearing the cache");
		return `wrote, discovered and removed ${path.relative(tmp, projectPath)}; live connect/disconnect through applyMcpToggleRuntime; external edit seen after cache clear`;
	} finally {
		await live.session.dispose();
	}
});

await check("commands: builtin registry, ACP dispatch, session commands", [
	"BUILTIN_SLASH_COMMAND_DEFS",
	"ACP_BUILTIN_SLASH_COMMANDS",
	"executeAcpBuiltinSlashCommand",
	"getSessionSlashCommands",
], async () => {
	assert(sessionB, "no session");
	const defs = core.BUILTIN_SLASH_COMMAND_DEFS;
	const acp = core.ACP_BUILTIN_SLASH_COMMANDS;
	assert(defs.length > 0 && acp.length > 0, "empty command registries");
	const defNames = new Set(defs.map((d) => d.name));
	assert(acp.every((c) => defNames.has(c.name)), "ACP command missing from builtin defs");
	const output: string[] = [];
	const runtime = {
		session: sessionB,
		sessionManager: sessionB.sessionManager,
		settings: core.settings,
		cwd: rootB,
		output: (line: string) => output.push(line),
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
	const run = (text: string) =>
		core.executeAcpBuiltinSlashCommand(text, runtime as unknown as Parameters<typeof core.executeAcpBuiltinSlashCommand>[1]);
	const tools = await run("/tools");
	assert(tools !== false && output.join("\n").length > 0, "/tools produced no output");
	assert((await run("/definitely-not-a-command")) === false, "unknown command was consumed");
	const sessionCommands = core.getSessionSlashCommands(sessionB);
	return `${defs.length} builtin defs, ${acp.length} ACP-dispatchable; /tools output ${output.join(" ").length} chars; ${sessionCommands.length} session commands`;
});

await check("extension handlers: set model; compact present", ["runExtensionSetModel", "runExtensionCompact"], async () => {
	assert(sessionB && cheapModel, "no session/model");
	const ok = await core.runExtensionSetModel(sessionB, cheapModel);
	assert(ok === true, `runExtensionSetModel returned ${ok}`);
	// Compaction needs a model call, so only its shape is checked.
	assert(typeof core.runExtensionCompact === "function" && core.runExtensionCompact.length === 2, "runExtensionCompact shape");
	return "runExtensionSetModel → true; runExtensionCompact(session, options) present (needs a provider call to exercise)";
});

await check("internal URLs: kb:// handler through the router", ["InternalUrlRouter"], async () => {
	const kbRoot = mkdir("kb");
	writeFileSync(path.join(kbRoot, "note.md"), "# contract\n");
	process.env.NPI_DECK_KB_ROOT = kbRoot;
	const { KbProtocolHandler } = await import("../kb-protocol.ts");
	core.InternalUrlRouter.instance().register(new KbProtocolHandler());
	const res = await core.InternalUrlRouter.instance().resolve("kb://note.md");
	assert(res.content.includes("# contract") && res.immutable === true, "kb:// resolve wrong");
	return "kb://note.md resolved, immutable";
});

await check("skills: capability loader finds a user skill", ["loadCapability", "skillCapability"], async () => {
	const skillDir = path.join(agentDir, "skills", "contract-skill");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: contract-skill\ndescription: Contract fixture skill.\n---\nBody.\n");
	const result = await core.loadCapability<{ name: string }>(core.skillCapability.id, { cwd: rootB });
	assert(result.items.some((s) => s.name === "contract-skill"), `skills: ${result.items.map((s) => s.name).join(",")}`);
	return `${result.items.length} skill(s), contract-skill found`;
});

await check("marketplace: registry paths isolated, manager lists", [
	"MarketplaceManager",
	"getInstalledPluginsRegistryPath",
	"getMarketplacesCacheDir",
	"getMarketplacesRegistryPath",
	"getPluginsCacheDir",
	"parsePluginId",
], async () => {
	const paths = {
		marketplacesRegistryPath: core.getMarketplacesRegistryPath(),
		installedRegistryPath: core.getInstalledPluginsRegistryPath(),
		marketplacesCacheDir: core.getMarketplacesCacheDir(),
		pluginsCacheDir: core.getPluginsCacheDir(),
	};
	for (const [k, v] of Object.entries(paths)) assert(v.startsWith(tmp), `${k} escapes isolation: ${v}`);
	const manager = new core.MarketplaceManager(paths);
	const markets = await manager.listMarketplaces();
	const parsed = core.parsePluginId("tool@market");
	assert(parsed?.name === "tool" && parsed.marketplace === "market", `parsePluginId: ${JSON.stringify(parsed)}`);
	return `${markets.length} marketplaces; paths under the temp home`;
});

await check("plan mode: xd://propose round trip to resolveApprovedPlan", [
	"dispatchResolutionDevice",
	"resolveApprovedPlan",
	"planFileUrlForSlug",
	"resolveLocalUrlToPath",
	"ToolError",
], async () => {
	assert(sessionB, "no session");
	const session = sessionB;
	const planUrl = planMode.planFileUrlForSlug("contract");
	const localOptions = {
		getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
		getSessionId: () => session.sessionManager.getSessionId(),
	};
	const planPath = planMode.resolveLocalUrlToPath(planUrl, localOptions);
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Contract plan\n\n1. Do the thing.\n");

	const toolSession = session as unknown as Parameters<typeof planMode.dispatchResolutionDevice>[0];
	let refused = "";
	try {
		await planMode.dispatchResolutionDevice(toolSession, "propose", "contract");
	} catch (err) {
		assert(err instanceof planMode.ToolError, `unexpected error type ${String(err)}`);
		refused = (err as Error).message;
	}
	assert(refused.includes("plan mode is active"), `propose without handler: ${refused || "not refused"}`);

	let proposed = "";
	session.setPlanProposalHandler(async (title) => {
		proposed = title;
		const plan = await planMode.resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: planUrl,
			readPlan: async (url) => {
				const file = Bun.file(planMode.resolveLocalUrlToPath(url, localOptions));
				return (await file.exists()) ? file.text() : null;
			},
		});
		return { content: [{ type: "text", text: `approved ${plan.title}` }], details: plan };
	});
	const { result } = await planMode.dispatchResolutionDevice(toolSession, "propose", "contract");
	session.setPlanProposalHandler(null);
	const details = result.details as { planFilePath: string; planContent: string; title: string };
	assert(proposed === "contract", `handler got ${JSON.stringify(proposed)}`);
	assert(details.planFilePath === planUrl && details.planContent.includes("Do the thing"), JSON.stringify(details));
	return `propose refused without a handler; with one, handler got "contract" and resolveApprovedPlan returned ${details.planFilePath} (title ${details.title})`;
});

await check("subagents: transcript read and lifecycle release", [
	"readRpcSubagentTranscript",
	"AgentRegistry",
	"AgentLifecycleManager",
], async () => {
	assert(sessionB?.sessionFile, "no session file");
	const transcript = await subagents.readRpcSubagentTranscript(sessionB.sessionFile);
	const roles = transcript.messages.map((m) => (m as { role: string }).role);
	assert(roles.join(",") === "user,assistant", `transcript roles: ${roles.join(",")}`);

	const rootId = "ContractChild";
	const root = (await newSession(mkdir("child"), { agentId: rootId, agentDisplayName: "Contract root" })).session;
	const ref = subagents.AgentRegistry.global().get(rootId);
	assert(ref && ref.session === root, "root not registered under its agentId");
	const lifecycle = subagents.AgentLifecycleManager.global();
	assert(lifecycle.adopt(rootId, { idleTtlMs: 0 }, ref) === false, "top-level root was adopted as a child");
	const released = await lifecycle.release(rootId, ref);
	const after = subagents.AgentRegistry.global().get(rootId);
	assert(released && !after, "released root still registered");
	assert(root.isDisposed, "released root session not disposed");
	return `transcript: ${transcript.messages.length} messages (user, assistant); top-level adoption refused; ${rootId} released and disposed`;
});

async function advisorStatus(session: AgentSession): Promise<string> {
	await Bun.sleep(0);
	const overview = session.getAdvisorStatusOverview();
	return overview.advisors.map((a) => `${a.name}:${a.status}`).join(",") || "(none)";
}

await check("advisors: save WATCHDOG.yml, rediscover, apply live", [
	"resolveAdvisorConfigEditPath",
	"loadWatchdogConfigFile",
	"saveWatchdogConfigFile",
	"discoverAdvisorConfigs",
	"slugifyAdvisorName",
	"collectConfigCandidates",
	"cfgAdvisorEnabled",
	"cfgAdvisorSyncBacklog",
	"cfgAdvisorMaxNotesPerUpdate",
	"cfgAdvisorEvictStaleResults",
], async () => {
	assert(sessionB, "no session");
	const file = await advisors.resolveAdvisorConfigEditPath("user", { projectDir: rootB, agentDir });
	assert(file === path.join(agentDir, "WATCHDOG.yml"), `user edit path ${file}`);
	const doc: Parameters<typeof advisors.saveWatchdogConfigFile>[1] = {
		advisors: [{ name: "Contract", model: "openrouter/openai/gpt-4o-mini", instructions: "Watch the contract." }],
	};
	await advisors.saveWatchdogConfigFile(file, doc);
	const reloaded = await advisors.loadWatchdogConfigFile(file);
	assert(reloaded.advisors[0]?.name === "Contract", "saved doc did not round-trip");
	const discovered = await advisors.discoverAdvisorConfigs(rootB, agentDir);
	assert(discovered.advisors.some((a) => a.name === "Contract"), "discovery missed the saved advisor");
	assert(advisors.slugifyAdvisorName("Contract") === "contract", "advisor name normalization changed");
	const candidates = await advisors.collectConfigCandidates(rootB, agentDir, ["WATCHDOG.yml", "WATCHDOG.yaml"]);
	assert(candidates.some((candidate) => candidate.path === file), "candidate walk missed user WATCHDOG");
	const settings = await core.Settings.loadIsolated({ cwd: rootB, agentDir });
	assert(typeof advisors.cfgAdvisorEnabled.get(settings) === "boolean", "advisor enabled setting unavailable");
	assert(advisors.cfgAdvisorSyncBacklog.get(settings) !== undefined, "advisor backlog setting unavailable");
	assert(typeof advisors.cfgAdvisorMaxNotesPerUpdate.get(settings) === "number", "advisor notes limit unavailable");
	assert(typeof advisors.cfgAdvisorEvictStaleResults.get(settings) === "boolean", "advisor eviction setting unavailable");
	assert(typeof core.cfgModelRoles.get(settings) === "object", "model role setting unavailable");
	sessionB.setAdvisorEnabled(true);
	const count = sessionB.applyAdvisorConfigs(discovered.advisors, discovered.sharedInstructions, discovered.sharedMaxNotesPerUpdate);
	const status = await advisorStatus(sessionB);
	assert(count === 1 && status === "Contract:running", `applied ${count}, status ${status}`);
	sessionB.setAdvisorEnabled(false);
	return `saved ${path.relative(tmp, file)}, rediscovered, applied → ${count} active (${status})`;
});

// ── Facts ────────────────────────────────────────────────────────────────

const altModel = registry
	.getAll()
	.filter((m) => m.provider === "openrouter" && m.id !== cheapModel?.id)
	.map((m) => `${m.provider}/${m.id}`)
	.sort()[0];

function advisorModel(session: AgentSession): string {
	const model = session.getAdvisorAgent()?.state.model;
	return model ? `${model.provider}/${model.id}` : "(no advisor)";
}

/** Enable one advisor with no model of its own, so it runs on the `advisor` role. */
function bindRoleAdvisor(session: AgentSession): void {
	session.setAdvisorEnabled(true);
	session.applyAdvisorConfigs([{ name: "RoleBound" }], undefined);
}

await check("fact: advisor role hot-apply (modelRoles.advisor)", [], async () => {
	assert(altModel, "no second openrouter model to switch the role to");
	const session = (await newSession(mkdir("root-roles"))).session;
	bindRoleAdvisor(session);
	const before = advisorModel(session);
	session.settings.setModelRole("advisor", altModel);
	await Bun.sleep(10);
	const afterSet = advisorModel(session);
	session.settings.setModelRole("advisor", undefined);
	await Bun.sleep(10);
	const afterClear = advisorModel(session);
	session.setAdvisorEnabled(false);
	await session.dispose();
	const hot = afterSet === altModel && before !== altModel && afterClear === before;
	facts["advisor-role-hot-apply"] = {
		value: hot ? "yes: session.settings.setModelRole(\"advisor\", …) retargets the live advisor" : "no",
		evidence: `advisor model: role unset → ${before}; setModelRole(advisor, ${altModel}) → ${afterSet}; unset → ${afterClear}`,
	};
	return facts["advisor-role-hot-apply"]!.evidence;
});

await check("fact: per-root settings isolation (Settings.loadIsolated)", ["Settings", "settings"], async () => {
	assert(sessionB && altModel, "no session / second model");
	const rootA = mkdir("root-a");
	const isolated = await core.Settings.loadIsolated({ cwd: rootA, agentDir });
	const sessionA = (await newSession(rootA, { settings: isolated })).session;
	bindRoleAdvisor(sessionA);
	bindRoleAdvisor(sessionB);
	const sameInstance = sessionA.settings === isolated;
	const before = { a: advisorModel(sessionA), b: advisorModel(sessionB), global: core.settings.getModelRole("advisor") };
	const configPath = path.join(agentDir, "config.yml");
	const configBefore = await Bun.file(configPath).exists() ? await Bun.file(configPath).text() : undefined;
	core.cfgModelRoles.override(isolated, { ...core.cfgModelRoles.get(isolated), advisor: altModel });
	await Bun.sleep(10);
	const after = { a: advisorModel(sessionA), b: advisorModel(sessionB), global: core.settings.getModelRole("advisor") };
	const persisted = (await core.Settings.loadIsolated({ cwd: rootB, agentDir })).getModelRole("advisor");
	const configAfter = await Bun.file(configPath).exists() ? await Bun.file(configPath).text() : undefined;
	sessionA.setAdvisorEnabled(false);
	sessionB.setAdvisorEnabled(false);
	await sessionA.dispose();
	const liveIsolated = sameInstance && after.a === altModel && after.b === before.b && after.global === before.global
		&& persisted === before.global && configBefore === configAfter;
	facts["settings-isolation"] = {
		value: liveIsolated ? "composes: non-persisting modelRoles override reaches only this root" : "does not compose",
		evidence: `session.settings === isolated: ${sameInstance}; advisor A ${before.a} → ${after.a}; advisor B ${before.b} → ${after.b}; global role ${before.global} → ${after.global}; fresh load: ${persisted}; config.yml byte-identical: ${configBefore === configAfter}`,
	};
	return facts["settings-isolation"]!.evidence;
});
await check("models: new chats select Opus medium with one exact Sol fallback", [
	"cfgModelRoles", "cfgRetryEnabled", "cfgRetryModelFallback", "cfgRetryFallbackChains",
], async () => {
	const cwd = mkdir("root-default");
	const configPath = path.join(agentDir, "config.yml");
	const before = await Bun.file(configPath).exists() ? await Bun.file(configPath).text() : undefined;
	const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
	try {
		const handle = await bridge.createSession({ cwd, mcpServersAllowed: [] });
		const snapshot = handle.snapshot();
		const primary = "anthropic/claude-opus-5-5:medium";
		const fallback = "openrouter/openai/gpt-6-sol:medium"; // Only OpenRouter is authenticated in this fixture.
		assert(snapshot.model?.provider === "anthropic" && snapshot.model.id === "claude-opus-5-5"
			&& snapshot.thinkingLevel === "medium", `new chat selected ${JSON.stringify(snapshot.model)}:${snapshot.thinkingLevel}`);
		const settings = (handle as unknown as { session: AgentSession }).session.settings;
		assert(core.cfgModelRoles.get(settings).default === primary, "new chat role does not match selected model");
		assert(core.cfgRetryEnabled.get(settings) && core.cfgRetryModelFallback.get(settings), "model fallback disabled");
		const model = registry.find("anthropic", "claude-opus-5-5");
		assert(model, "primary absent from NeoPi model catalog");
		const { resolveRetryFallbackChainKey, findRetryFallbackCandidates } = await importFromTree<
			typeof import("@oh-my-pi/pi-coding-agent/session/retry-fallback-chains")
		>("@oh-my-pi/pi-coding-agent/session/retry-fallback-chains");
		const context = {
			chains: core.cfgRetryFallbackChains.get(settings),
			getModelRole: (role: string) => settings.getModelRole(role),
			modelLookup: registry,
		};
		const key = resolveRetryFallbackChainKey(context, primary, model);
		assert(key === primary, `expected exact fallback chain, got ${key}`);
		const candidates = findRetryFallbackCandidates(context, key, primary, model);
		assert(candidates.length === 1 && candidates[0]?.raw === fallback, `unexpected fallback: ${JSON.stringify(candidates)}`);
		const manual = await bridge.createSession({
			cwd: mkdir("root-explicit"), model: { provider: cheapModel!.provider, id: cheapModel!.id }, mcpServersAllowed: [],
		});
		assert(manual.snapshot().model?.id === cheapModel!.id, "explicit model replaced by deck default");
		const fresh = await core.Settings.loadIsolated({ cwd, agentDir });
		const after = await Bun.file(configPath).exists() ? await Bun.file(configPath).text() : undefined;
		assert(fresh.getModelRole("default") !== primary && before === after, "deck model policy persisted to user config");
		return `${primary} → ${candidates[0]!.raw}; explicit model preserved; config unchanged`;
	} finally {
		await bridge.dispose();
	}
});


await sessionB?.dispose();

const unexercised = manifestRows().filter((r) => !exercised.has(r.key));
checks.push({
	name: "coverage: every manifest export exercised",
	ok: unexercised.length === 0,
	detail: unexercised.length === 0 ? `${manifestRows().length}/${manifestRows().length}` : `not exercised: ${unexercised.map((r) => r.key).join(", ")}`,
});

const ok = checks.every((c) => c.ok);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ ok, backend: backend.identity, checks, facts }, null, 2));
} else {
	console.log(`backend ${backend.identity.path} (${backend.identity.version}, ${backend.identity.commit})`);
	for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}\n    ${c.detail}`);
	for (const [k, f] of Object.entries(facts)) console.log(`FACT ${k}: ${f.value}\n    ${f.evidence}`);
	console.log(ok ? "contract: ok" : "contract: FAILED");
}
process.exit(ok ? 0 : 1);
