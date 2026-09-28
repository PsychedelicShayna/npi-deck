/**
 * Backend adapter manifest: every NeoPi SDK value the deck reads, as
 * `{module, export}` grouped into capability features with a tier.
 *
 * - `required`: the deck cannot run without it. A backend missing any of these
 *   is rejected with a diagnostic naming each missing module/export.
 * - `optional-feature`: a missing export disables only that feature, and the
 *   feature reports which exports are missing. Consumers go through
 *   `feature(name)` in runtime.ts, which throws that diagnostic.
 *
 * Modules are package specifiers, resolved against the backend tree's own
 * `node_modules` (so subpaths such as `pi-coding-agent/internal-urls` are
 * allowed, per plan C2). The type of each module comes from the pinned tree via
 * `typeof import(...)`; `op()` rejects an export name the module doesn't have
 * at compile time. `files` lists tree-relative files a feature needs that are
 * not imported (the CLI a routine agent step spawns).
 *
 * This file and runtime.ts are the only places allowed to reach SDK values;
 * scripts/check-sdk-imports.ts enforces it.
 */

export type ModuleTypes = {
	"@oh-my-pi/pi-ai": typeof import("@oh-my-pi/pi-ai");
	"@oh-my-pi/pi-coding-agent": typeof import("@oh-my-pi/pi-coding-agent");
	"@oh-my-pi/pi-coding-agent/advisor/config": typeof import("@oh-my-pi/pi-coding-agent/advisor/config");
	"@oh-my-pi/pi-coding-agent/advisor/settings": typeof import("@oh-my-pi/pi-coding-agent/advisor/settings");
	"@oh-my-pi/pi-coding-agent/advisor/watchdog": typeof import("@oh-my-pi/pi-coding-agent/advisor/watchdog");
	"@oh-my-pi/pi-coding-agent/capability": typeof import("@oh-my-pi/pi-coding-agent/capability");
	"@oh-my-pi/pi-coding-agent/capability/skill": typeof import("@oh-my-pi/pi-coding-agent/capability/skill");
	"@oh-my-pi/pi-coding-agent/config/model-settings": typeof import("@oh-my-pi/pi-coding-agent/config/model-settings");
	"@oh-my-pi/pi-coding-agent/extensibility/extensions/compact-handler": typeof import("@oh-my-pi/pi-coding-agent/extensibility/extensions/compact-handler");
	"@oh-my-pi/pi-coding-agent/extensibility/extensions/get-commands-handler": typeof import("@oh-my-pi/pi-coding-agent/extensibility/extensions/get-commands-handler");
	"@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace": typeof import("@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace");
	"@oh-my-pi/pi-coding-agent/internal-urls": typeof import("@oh-my-pi/pi-coding-agent/internal-urls");
	"@oh-my-pi/pi-coding-agent/mcp/config": typeof import("@oh-my-pi/pi-coding-agent/mcp/config");
	"@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents": typeof import("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents");
	"@oh-my-pi/pi-coding-agent/moa/registration": typeof import("@oh-my-pi/pi-coding-agent/moa/registration");
	"@oh-my-pi/pi-coding-agent/plan-mode/approved-plan": typeof import("@oh-my-pi/pi-coding-agent/plan-mode/approved-plan");
	"@oh-my-pi/pi-coding-agent/registry/agent-lifecycle": typeof import("@oh-my-pi/pi-coding-agent/registry/agent-lifecycle");
	"@oh-my-pi/pi-coding-agent/registry/agent-registry": typeof import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
	"@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins": typeof import("@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins");
	"@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry": typeof import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry");
	"@oh-my-pi/pi-coding-agent/tools/resolve": typeof import("@oh-my-pi/pi-coding-agent/tools/resolve");
	"@oh-my-pi/pi-tui/theme/theme": typeof import("@oh-my-pi/pi-tui/theme/theme");
	"@oh-my-pi/pi-tui/tools/tool-errors": typeof import("@oh-my-pi/pi-tui/tools/tool-errors");
};

export type ModuleSpecifier = keyof ModuleTypes;
export type Tier = "required" | "optional-feature";

export interface ExportRef<M extends ModuleSpecifier = ModuleSpecifier, E extends string = string> {
	readonly module: M;
	readonly export: E;
}

export interface FeatureSpec {
	readonly tier: Tier;
	/** Workstream or deck file that consumes the feature. */
	readonly consumers: readonly string[];
	readonly exports: Readonly<Record<string, ExportRef>>;
	/** Tree-relative files the feature needs on disk (not imported). */
	readonly files?: readonly string[];
}

function op<M extends ModuleSpecifier, E extends keyof ModuleTypes[M] & string>(module: M, name: E): ExportRef<M, E> {
	return { module, export: name };
}

const CODING_AGENT = "@oh-my-pi/pi-coding-agent";

export const MANIFEST = {
	/** Sessions, auth, commands, skills, marketplace, internal URLs, theme: the deck's baseline. */
	core: {
		tier: "required",
		consumers: [
			"bridge/in-process.ts",
			"auth-singleton.ts",
			"routes-auth-oauth.ts",
			"routes-slash-commands.ts",
			"skills-service.ts",
			"skills-watcher.ts",
			"marketplace-service.ts",
			"index.ts",
		],
		exports: {
			createAgentSession: op(CODING_AGENT, "createAgentSession"),
			SessionManager: op(CODING_AGENT, "SessionManager"),
			ModelRegistry: op(CODING_AGENT, "ModelRegistry"),
			discoverAuthStorage: op(CODING_AGENT, "discoverAuthStorage"),
			settings: op(CODING_AGENT, "settings"),
			Settings: op(CODING_AGENT, "Settings"),
			getAgentDir: op(CODING_AGENT, "getAgentDir"),
			VERSION: op(CODING_AGENT, "VERSION"),
			getEnvApiKey: op("@oh-my-pi/pi-ai", "getEnvApiKey"),
			getOAuthProviders: op("@oh-my-pi/pi-ai", "getOAuthProviders"),
			runExtensionCompact: op("@oh-my-pi/pi-coding-agent/extensibility/extensions/compact-handler", "runExtensionCompact"),
			runExtensionSetModel: op("@oh-my-pi/pi-coding-agent/extensibility/extensions/compact-handler", "runExtensionSetModel"),
			getSessionSlashCommands: op(
				"@oh-my-pi/pi-coding-agent/extensibility/extensions/get-commands-handler",
				"getSessionSlashCommands",
			),
			executeAcpBuiltinSlashCommand: op(
				"@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins",
				"executeAcpBuiltinSlashCommand",
			),
			ACP_BUILTIN_SLASH_COMMANDS: op("@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins", "ACP_BUILTIN_SLASH_COMMANDS"),
			BUILTIN_SLASH_COMMAND_DEFS: op(
				"@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry",
				"BUILTIN_SLASH_COMMAND_DEFS",
			),
			InternalUrlRouter: op("@oh-my-pi/pi-coding-agent/internal-urls", "InternalUrlRouter"),
			loadCapability: op("@oh-my-pi/pi-coding-agent/capability", "loadCapability"),
			skillCapability: op("@oh-my-pi/pi-coding-agent/capability/skill", "skillCapability"),
			MarketplaceManager: op("@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace", "MarketplaceManager"),
			getInstalledPluginsRegistryPath: op(
				"@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace",
				"getInstalledPluginsRegistryPath",
			),
			getMarketplacesCacheDir: op("@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace", "getMarketplacesCacheDir"),
			getMarketplacesRegistryPath: op(
				"@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace",
				"getMarketplacesRegistryPath",
			),
			getPluginsCacheDir: op("@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace", "getPluginsCacheDir"),
			parsePluginId: op("@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace", "parsePluginId"),
			// The ask tool reads pi-tui's module-level `theme`; the deck must set it at boot.
			getThemeByName: op("@oh-my-pi/pi-tui/theme/theme", "getThemeByName"),
			setThemeInstance: op("@oh-my-pi/pi-tui/theme/theme", "setThemeInstance"),
		},
	},
	/** W4: plan proposals through `xd://propose` + `setPlanProposalHandler`. */
	"plan-mode": {
		tier: "optional-feature",
		consumers: ["W4 bridge/plan-mode-bridge.ts"],
		exports: {
			dispatchResolutionDevice: op("@oh-my-pi/pi-coding-agent/tools/resolve", "dispatchResolutionDevice"),
			resolveApprovedPlan: op("@oh-my-pi/pi-coding-agent/plan-mode/approved-plan", "resolveApprovedPlan"),
			planFileUrlForSlug: op("@oh-my-pi/pi-coding-agent/plan-mode/approved-plan", "planFileUrlForSlug"),
			resolveLocalUrlToPath: op("@oh-my-pi/pi-coding-agent/internal-urls", "resolveLocalUrlToPath"),
			ToolError: op("@oh-my-pi/pi-tui/tools/tool-errors", "ToolError"),
		},
	},
	/** W10: subagent tree view, transcript and abort through the global registry. */
	"subagent-tree": {
		tier: "optional-feature",
		consumers: ["W10"],
		exports: {
			AgentRegistry: op("@oh-my-pi/pi-coding-agent/registry/agent-registry", "AgentRegistry"),
			AgentLifecycleManager: op("@oh-my-pi/pi-coding-agent/registry/agent-lifecycle", "AgentLifecycleManager"),
			readRpcSubagentTranscript: op("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents", "readRpcSubagentTranscript"),
		},
	},
	/** W11: WATCHDOG.yml editing, rediscovery and hot apply (`applyAdvisorConfigs` is a session method). */
	advisors: {
		tier: "optional-feature",
		consumers: ["W11"],
		exports: {
			discoverAdvisorConfigs: op("@oh-my-pi/pi-coding-agent/advisor/config", "discoverAdvisorConfigs"),
			resolveAdvisorConfigEditPath: op("@oh-my-pi/pi-coding-agent/advisor/config", "resolveAdvisorConfigEditPath"),
			loadWatchdogConfigFile: op("@oh-my-pi/pi-coding-agent/advisor/config", "loadWatchdogConfigFile"),
			saveWatchdogConfigFile: op("@oh-my-pi/pi-coding-agent/advisor/config", "saveWatchdogConfigFile"),
			slugifyAdvisorName: op("@oh-my-pi/pi-coding-agent/advisor/config", "slugifyAdvisorName"),
			collectConfigCandidates: op("@oh-my-pi/pi-coding-agent/advisor/watchdog", "collectConfigCandidates"),
			cfgAdvisorEnabled: op("@oh-my-pi/pi-coding-agent/advisor/settings", "cfgAdvisorEnabled"),
			cfgAdvisorSyncBacklog: op("@oh-my-pi/pi-coding-agent/advisor/settings", "cfgAdvisorSyncBacklog"),
			cfgAdvisorMaxNotesPerUpdate: op("@oh-my-pi/pi-coding-agent/advisor/settings", "cfgAdvisorMaxNotesPerUpdate"),
			cfgAdvisorEvictStaleResults: op("@oh-my-pi/pi-coding-agent/advisor/settings", "cfgAdvisorEvictStaleResults"),
			cfgModelRoles: op("@oh-my-pi/pi-coding-agent/config/model-settings", "cfgModelRoles"),
		},
	},
	/** W3: mixture-of-agents models (`mixture/<name>`) listed in the model picker without a live session. */
	mixtures: {
		tier: "optional-feature",
		consumers: ["bridge/in-process.ts"],
		exports: {
			retainMixtureCatalog: op("@oh-my-pi/pi-coding-agent/moa/registration", "retainMixtureCatalog"),
		},
	},
	/** neopi#120: per-session MCP filtering and typed unknown-server errors. */
	"mcp-allowlist": {
		tier: "optional-feature",
		consumers: ["bridge/in-process.ts", "routines/steps/agent.ts"],
		exports: {
			cfgMcpIncludeServers: op(CODING_AGENT, "cfgMcpIncludeServers"),
			MCPUnknownServerError: op(CODING_AGENT, "MCPUnknownServerError"),
			loadAllMCPConfigs: op("@oh-my-pi/pi-coding-agent/mcp/config", "loadAllMCPConfigs"),
		},
	},
	/** neopi#121: independent async-job domains and collision-safe root identities. */
	"multi-root": {
		tier: "optional-feature",
		consumers: ["bridge/in-process.ts"],
		exports: {
			AgentIdConflictError: op(CODING_AGENT, "AgentIdConflictError"),
		},
	},
	/** W7c: routine agent steps spawn the tree's CLI in `--mode json`. */
	"routine-agent-step": {
		tier: "optional-feature",
		consumers: ["W7c routines/steps/agent.ts"],
		exports: {},
		files: ["packages/coding-agent/src/cli.ts"],
	},
} as const satisfies Record<string, FeatureSpec>;

export type Manifest = typeof MANIFEST;
export type FeatureName = keyof Manifest;
export type OptionalFeatureName = {
	[F in FeatureName]: Manifest[F]["tier"] extends "optional-feature" ? F : never;
}[FeatureName];

type ExportValue<R> = R extends ExportRef<infer M, infer E> ? (E extends keyof ModuleTypes[M] ? ModuleTypes[M][E] : never) : never;

/** The loaded values of one feature, typed from the pinned tree. */
export type FeatureExports<F extends FeatureName> = {
	-readonly [K in keyof Manifest[F]["exports"]]: ExportValue<Manifest[F]["exports"][K]>;
};

/** One flat row per manifest export, for probes, diagnostics and the contract fixture. */
export interface ManifestRow {
	feature: FeatureName;
	tier: Tier;
	key: string;
	module: ModuleSpecifier;
	export: string;
}

export function manifestRows(): ManifestRow[] {
	const rows: ManifestRow[] = [];
	for (const [feature, spec] of Object.entries(MANIFEST) as [FeatureName, FeatureSpec][]) {
		for (const [key, ref] of Object.entries(spec.exports)) {
			rows.push({ feature, tier: spec.tier, key, module: ref.module, export: ref.export });
		}
	}
	return rows;
}
