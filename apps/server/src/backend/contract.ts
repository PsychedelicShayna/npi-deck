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
import { feature, formatDiagnostic, loadBackend, resolveBackendSelection, resolveManifest, sdk } from "./runtime.ts";

// HOME and friends must be set before the process starts: NeoPi (and
// os.homedir()) capture them at load. The parent picks the tree, prepares a
// temp root and re-runs this file as a child with the controlled env.
if (!process.env.NPI_DECK_CONTRACT_ROOT) {
	const selection = resolveBackendSelection();
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
		NPI_DECK_BACKEND: selection.path,
		NPI_DECK_CONTRACT_ROOT: root,
	});
	mkdirSync(home, { recursive: true });
	mkdirSync(env.PI_CODING_AGENT_DIR!, { recursive: true });
	const child = Bun.spawnSync([process.execPath, import.meta.path, ...process.argv.slice(2)], {
		cwd: root,
		env,
		stdio: ["ignore", "inherit", "inherit"],
	});
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

async function newSession(cwd: string, extra: Partial<CreateAgentSessionOptions> = {}) {
	return core.createAgentSession({
		cwd,
		agentDir,
		sessionManager: core.SessionManager.create(cwd),
		modelRegistry: registry,
		authStorage: registry.authStorage,
		skipPythonPreflight: true,
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

	const childId = "ContractChild";
	const child = (await newSession(mkdir("child"), { agentId: childId, agentDisplayName: "Contract child" })).session;
	const ref = subagents.AgentRegistry.global().get(childId);
	assert(ref && ref.session === child, "child not registered under its agentId");
	const lifecycle = subagents.AgentLifecycleManager.global();
	lifecycle.adopt(childId, { idleTtlMs: 0 }, ref);
	assert(lifecycle.has(childId, ref), "adopt did not take");
	const released = await lifecycle.release(childId, ref, { tombstone: true });
	const after = subagents.AgentRegistry.global().get(childId);
	assert(released && after?.status === "aborted" && after.session === null, `after release: ${after?.status}`);
	assert(child.isDisposed, "released child session not disposed");
	return `transcript: ${transcript.messages.length} messages (user, assistant); child ${childId} released → aborted, detached, disposed`;
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
	isolated.setModelRole("advisor", altModel);
	await isolated.flush();
	await Bun.sleep(10);
	const after = { a: advisorModel(sessionA), b: advisorModel(sessionB), global: core.settings.getModelRole("advisor") };
	// A fresh load from disk shows whether the isolated write reached the shared user config.
	const persisted = (await core.Settings.loadIsolated({ cwd: rootB, agentDir })).getModelRole("advisor");
	sessionA.setAdvisorEnabled(false);
	sessionB.setAdvisorEnabled(false);
	await sessionA.dispose();
	const liveIsolated = sameInstance && after.a === altModel && after.b === before.b && after.global === before.global;
	facts["settings-isolation"] = {
		value: liveIsolated
			? `composes: the session uses the isolated instance and a change on it reaches only that session${persisted === altModel ? "; writes still persist to the shared user config.yml, so the next load of any root sees them" : ""}`
			: "does not compose",
		evidence: `session.settings === isolated: ${sameInstance}; advisor A ${before.a} → ${after.a}; advisor B ${before.b} → ${after.b}; global role ${before.global} → ${after.global}; fresh load: ${persisted}`,
	};
	return facts["settings-isolation"]!.evidence;
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
