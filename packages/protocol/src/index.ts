/**
 * Shared transport types between npi-deck server and web.
 *
 * The server embeds @oh-my-pi/pi-coding-agent SDK and re-emits its
 * AgentSessionEvent stream into ServerFrames. To avoid type drift,
 * we keep payloads structurally typed via `unknown`-ish records on the
 * web side and import the real SDK types on the server side.
 *
 * This package is dep-free on purpose — it's the contract. Note: V1 added
 * `ajv` + `ajv-formats` as runtime deps so the validator (re-exported below)
 * can compile the JSON schemas. The schemas under `src/schemas/` remain the
 * single source of truth for both runtime validation and the visual builder.
 */

// Re-export the V1 routine spec validator. JSON Schemas live in src/schemas/.
export { compileStructuredOutputSchema, validateRoutineSpec } from "./validate";
export type { ValidationError, ValidationResult } from "./validate";
// MIXTURES.toml document, validation report and mixture trace projections (#80).
export * from "./mixtures";

// ─────────────────────────────────────────────────────────────────────────────
// REST shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelRef {
	provider: string;
	id: string;
}

export interface SessionSummary {
	id: string;
	path: string;
	cwd: string;
	title?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	backendLastRan?: { path: string; commit: string | null; version: string | null };
}

export interface WorkspaceEntry {
	cwd: string;
	label: string;
	sessionCount: number;
}

export interface CreateSessionRequest {
	cwd: string;
	resumeFromPath?: string;
	model?: ModelRef;
	/** Per-session literal MCP server names; absent inherits backend settings, [] disables MCP. */
	mcpServersAllowed?: string[];
}

export interface CreateSessionResponse {
	sessionId: string;
	sessionFile?: string;
	cwd: string;
}

export interface ListSessionsQuery {
	cwd?: string;
}

export interface ListSessionsResponse {
	sessions: SessionSummary[];
}

export interface ListWorkspacesResponse {
	workspaces: WorkspaceEntry[];
	defaultCwd: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings / managed environment
// ─────────────────────────────────────────────────────────────────────────────

export type EnvValueType = "string" | "int" | "path" | "enum" | "boolean";
export type EnvValueSource = "process-env" | "env-file" | "default" | "unset";
export type EnvRestartTarget = "server" | "telegram-bridge";

export interface EnvEntry {
	key: string;
	masked: string;
	isSet: boolean;
	source: EnvValueSource;
	defaultValue?: string;
	valueType: EnvValueType;
	sensitive: boolean;
	restartRequired: boolean;
	hotApply: boolean;
	description: string;
	options?: string[];
	restartTarget?: EnvRestartTarget;
}

export interface ListEnvSettingsResponse {
	entries: EnvEntry[];
	envFilePath: string;
	dataDir: string;
	restartRequired: boolean;
}

export interface PatchEnvSettingsRequest {
	updates: Record<string, string | null>;
}

export interface PatchEnvSettingsResponse extends ListEnvSettingsResponse {
	appliedHot: string[];
}

export interface RevealEnvValueResponse {
	key: string;
	value: string;
	masked: string;
	isSet: boolean;
	source: EnvValueSource;
}

export interface RestartServerResponse {
	ok: boolean;
	pid?: number;
	message: string;
}

/**
 * Whether the deck can change an env-backed setting. A value the launching
 * shell exported wins over the managed .env, so saving would have no effect:
 * those settings are reported with `editable: false`.
 */
export interface EnvBackedSetting {
	key: string;
	source: EnvValueSource;
	editable: boolean;
}

/** `GET /api/settings/workspaces`: the roots pinned into the session picker. */
export interface WorkspaceSettingsResponse {
	/** Where new sessions start (`NPI_DECK_DEFAULT_CWD`); always listed in the picker. */
	defaultCwd: string;
	/** Extra roots from `NPI_DECK_WORKSPACES`, in saved order. */
	pinned: Array<{ cwd: string; label: string; exists: boolean }>;
	setting: EnvBackedSetting;
}

/** `PUT /api/settings/workspaces`: the full pinned list; paths must be existing directories. */
export interface UpdateWorkspaceSettingsRequest {
	pinned: string[];
}

/** `GET /api/settings/notifications`: every notification the server can emit. */
export interface NotificationSettingsResponse {
	sources: Array<{
		kind: NotificationKind;
		label: string;
		/** What makes the server emit it, in plain language. */
		trigger: string;
		level: NotificationLevel;
		enabled: boolean;
	}>;
	setting: EnvBackedSetting;
}

/** `PUT /api/settings/notifications`: kinds to switch off; every other kind is on. */
export interface UpdateNotificationSettingsRequest {
	disabled: NotificationKind[];
}

// ─────────────────────────────────────────────────────────────────────────────
// NeoPi configuration registry (`~/.omp/agent/config.yml`)
// ─────────────────────────────────────────────────────────────────────────────

export type NpiConfigValueType = "boolean" | "string" | "number" | "enum" | "array" | "record";
/** Layer supplying a setting's effective value, highest precedence first. */
export type NpiConfigProvenance = "env" | "runtime" | "overlay" | "project" | "global" | "default";

export interface NpiConfigOption {
	value: string;
	label: string;
	description?: string;
}

/** One registered NeoPi setting. Secret values are never sent: `value`, `defaultValue` and `effectiveValue` are null. */
export interface NpiConfigSetting {
	id: string;
	type: NpiConfigValueType;
	/** Registry `ui.tab`, or `"other"` for settings without panel metadata. */
	tab: string;
	/** Registry `ui.group`; settings without panel metadata group by their id's first segment. */
	group: string;
	label: string;
	description: string;
	/** Risk note from the registry (rate limits, bans). */
	warning?: string;
	defaultValue: unknown;
	/** Value the editor starts from: the global config.yml value, else the default. */
	value: unknown;
	/** Value NeoPi resolves for the deck's default workspace, environment included. */
	effectiveValue: unknown;
	provenance: NpiConfigProvenance;
	/** The global config.yml sets this key; reset-to-default removes it. */
	inGlobalConfig: boolean;
	/** config.yml holds a value the setting rejects; NeoPi ignores it and uses the default. */
	invalidGlobalValue: boolean;
	/** Credential: the value is write-only here. */
	secret: boolean;
	/** The environment or any settings layer configures a value. */
	configured: boolean;
	enumValues?: string[];
	/** Registry choices (submenu options, or array membership choices). */
	options?: NpiConfigOption[];
	/** NeoPi fills the choices at runtime (themes, shapes); the value is free text. */
	runtimeOptions?: boolean;
	/** Closed vocabulary of array entries; writes naming another entry are rejected. */
	items?: string[];
	/** Array entry order is meaningful. */
	ordered?: boolean;
	/** Entries may be path-scoped objects (`{ path(s), values }`) rather than plain strings. */
	pathScoped?: boolean;
	env?: { name: string; fallback: boolean; active: boolean };
	/** Credential records: entry and field names config.yml holds (never their values). Edit them with `entries`. */
	secretEntries?: Array<{ key: string; fields: string[] }>;
	/** Why this setting cannot be edited here; absent when editable. */
	lockedReason?: string;
}

export interface NpiConfigTab {
	id: string;
	label: string;
	/** Group order within the tab, as the registry declares it. */
	groups: string[];
}

export interface NpiConfigResponse {
	/** Workspace whose project layer the provenance reflects. */
	cwd: string;
	/** Global config file NeoPi reads and saves: the first existing of config.yml, config.yaml. */
	configPath: string;
	tabs: NpiConfigTab[];
	settings: NpiConfigSetting[];
}

/** The model a role resolves to among the models the deck has credentials for. */
export interface NpiModelRoleResolution {
	provider: string;
	modelId: string;
	thinkingLevel?: string;
}

/**
 * One NeoPi model role: every built-in role in NeoPi's display order, then any
 * role `cycleOrder`, `modelRoles` or `modelTags` introduces. Edit a role with
 * `PATCH /api/npi-config { id: "modelRoles", entries: { [role]: selector | null } }`,
 * which keeps every other role, including ones this list does not know.
 */
export interface NpiModelRole {
	id: string;
	/** NeoPi's display name (`smol` is "Fast"); `modelTags` can rename a role. */
	name: string;
	/** Built-in short tag such as `SMOL`; absent for custom roles. */
	tag?: string;
	/** `chat` roles take chat models; `kind` roles take image, search, speech, dictation or judge models. */
	section: "chat" | "kind";
	builtin: boolean;
	/** `modelTags` hides the role from NeoPi's role carousel. */
	hidden: boolean;
	/** Selector the global config file assigns; null when it does not assign one. A list is joined with commas. */
	value: string | null;
	/** Selector NeoPi uses for the deck's default workspace, any layer; null when no layer assigns one. */
	effectiveValue: string | null;
	/** Layer supplying `effectiveValue`; `default` means unset, so NeoPi's built-in chain applies. */
	provenance: NpiConfigProvenance;
	/** Effective pattern chain `@<id>` expands to, built-in fallbacks included. */
	patterns: string[];
	/** First pattern that matches an available model; absent when none does. */
	resolved?: NpiModelRoleResolution;
	/** Index into `NpiModelRolesResponse.pools`. */
	pool: number;
}

/** Models one or more roles accept, judged by NeoPi's own per-role filter. */
export interface NpiModelRolePool {
	/** `provider/id` of every model NeoPi counts as available that the roles accept, keyless runners (`local/…`, `web/…`) included. */
	models: string[];
	/** The roles also accept mixture-of-agents models (`mixture/<name>`), which exist per workspace. */
	mixtures: boolean;
}

export interface NpiModelRolesResponse {
	/** Workspace whose project layer the provenance reflects. */
	cwd: string;
	configPath: string;
	/** The `modelRoles` setting itself: lock and invalid-value state. */
	setting: NpiConfigSetting;
	roles: NpiModelRole[];
	pools: NpiModelRolePool[];
	/** Thinking suffixes a chat role's selector may end with (`provider/model:high`), in NeoPi's display order. */
	thinkingLevels: string[];
}

/**
 * Exactly one of: `value` to set (strings go through the setting's own text parser),
 * `unset: true` to remove the key from the config file, or `entries` to edit single
 * keys of a record while keeping the others: null deletes an entry, an object merges
 * its fields into the existing entry (a null field deletes that field), and any other
 * value replaces the entry.
 */
export interface NpiConfigPatchRequest {
	id: string;
	value?: unknown;
	unset?: boolean;
	entries?: Record<string, unknown>;
}

/** What one live chat's settings resolve for the patched key after the reload. */
export interface NpiConfigLiveApply {
	sessionId: string;
	cwd: string;
	provenance: NpiConfigProvenance;
	/** Null for secrets. */
	effectiveValue: unknown;
	/** The reload failed (details are in the server log); the chat keeps its previous settings. */
	reloadFailed?: true;
}

export interface NpiConfigPatchResponse {
	setting: NpiConfigSetting;
	live: NpiConfigLiveApply[];
}

/**
 * `GET /api/sessions/:id/fallback-chain`: how NeoPi's `retry.fallbackChains`
 * covers the chat's active model. The picker edits `key` through
 * `PATCH /api/npi-config` with `entries`.
 */
export interface SessionFallbackChainResponse {
	/** The active model as `provider/id`. */
	model: string;
	/**
	 * The chain key that belongs to the active model: a configured model key
	 * the chat resolves for it (it may carry an effort suffix), else `model`.
	 */
	key: string;
	/** The chain key the chat resolves for its active model now, and that chain. Absent when no chain covers the model. */
	resolved?: {
		key: string;
		chain: string[];
		/** The deck's own fallback for new chats, which applies until the configuration gives this model a chain. */
		deckDefault?: true;
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom providers and models (`~/.omp/agent/models.yml`)
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelsConfigModelSummary {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: string[];
}

/** One provider, read from the masked document: credentials are at most placeholders, and reduced to whether they are set. */
export interface ModelsConfigProviderSummary {
	name: string;
	/** Never the URL: at most its `http://` or `https://` scheme followed by `••••••`. */
	baseUrl?: string;
	api?: string;
	auth: "apiKey" | "none" | "oauth";
	/** `apiKey` is set (a literal key, an environment variable name, or a `!command`); never its value. */
	apiKeySet: boolean;
	/** Header names only; values can carry credentials. */
	headers: string[];
	/** Discovery type (`ollama`, `openai-models-list`, ...) when the provider discovers models. */
	discovery?: string;
	transport?: string;
	models: ModelsConfigModelSummary[];
	/** Model ids this provider overrides. */
	modelOverrides: string[];
}

export interface ModelsConfigResponse {
	/** File NeoPi reads: models.yml, or models.yaml when only that exists. */
	path: string;
	exists: boolean;
	/**
	 * Opaque, server-keyed identifier of the exact file contents (it cannot be checked
	 * against a guessed credential); saves must send it back. It changes when the deck restarts.
	 */
	revision: string;
	/**
	 * The document with every credential replaced by a `<npi-deck-masked:…>` placeholder:
	 * apiKey, every header and requestMetadata value, every baseUrl (provider, model, model
	 * override) whatever its shape, values under credential-like keys and their other
	 * occurrences. A placeholder saved as the whole value of an apiKey, header or requestMetadata
	 * entry, or a baseUrl placeholder saved as a whole baseUrl, keeps the value on disk;
	 * anywhere else the save is refused (400).
	 * Every comment is replaced by `# <npi-deck-comment:…>`, restored verbatim when saved as
	 * that unchanged whole comment and refused (400) anywhere else. Null when the credentials
	 * cannot be masked unambiguously; `rawUnavailable` says why.
	 */
	raw: string | null;
	rawUnavailable?: string;
	/** Distinct credentials masked in `raw`. */
	maskedSecrets: number;
	/** NeoPi's load error for this document (NeoPi ignores an invalid file), as it reads the masked text; withheld when it could quote a credential. */
	error?: string;
	/** Empty when `error` is set or `raw` is withheld. */
	providers: ModelsConfigProviderSummary[];
}

/** Validate (POST /models-config/validate) or save (PUT /models-config) a whole document. */
export interface ModelsConfigDocumentRequest {
	raw: string;
	/** Required for saves: the `revision` the edit started from. A mismatch is refused with 409. */
	revision?: string;
}

/** Summary of the submitted document as sent (placeholders unrestored). */
export interface ModelsConfigValidateResponse {
	providers: ModelsConfigProviderSummary[];
}

/** What the deck's shared model registry did after the save. */
export interface ModelsConfigRegistryApply {
	/** The registry re-read the file; false means the picker still shows the previous models. */
	refreshed: boolean;
	/** Why the refresh failed, or NeoPi's error for the reloaded file. */
	error?: string;
	/** `provider/id` of defined models the refreshed registry does not list. */
	missingModels: string[];
	/** Providers whose model discovery was started; their models arrive when it finishes. */
	discovering: string[];
}

export interface ModelsConfigSaveResponse extends ModelsConfigResponse {
	/** Copy of the replaced file, or null when there was none. */
	backupPath: string | null;
	registry: ModelsConfigRegistryApply;
}

export interface BackendStatusResponse {
	workerGeneration: string;
	running: { id: string | null; path: string; source: "env" | "config"; version: string | null; commit: string | null } | null;
	desired: string | null;
	validated: { id: string | null; path: string; commit: string | null; version: string | null; pinned: boolean } | null;
	pinned: boolean;
	reason?: string;
	backends: Array<{ id: string; kind: "source" | "gateway"; path: string }>;
}
export interface BackendSwitchResponse { ok: boolean; message: string; busy?: Array<{ kind: string; id: string }> }

// ─────────────────────────────────────────────────────────────────────────────
// Starters (bundled skills and extensions; the maintenance gate's knobs)
// ─────────────────────────────────────────────────────────────────────────────

export type GateValueSource = "process-env" | "env-file" | "default" | "unset";

/** One tunable knob for the maintenance-gate extension. */
export interface GateKnob {
	/** Effective integer value the extension would observe right now. */
	value: number;
	/** Bundled default when no override is set. */
	default: number;
	/** Raw string from env-file / process-env, or null when unset. */
	rawValue: string | null;
	source: GateValueSource;
}

/** Live state of the maintenance-gate extension as the deck sees it. */
export interface MaintenanceGateState {
	/** Inverse of `NPI_DECK_MAINTENANCE_GATE_DISABLED`. */
	enabled: boolean;
	disabledRaw: string | null;
	disabledSource: GateValueSource;
	knobs: {
		minOpMsgs: GateKnob;
		minReleaseAgeMs: GateKnob;
		fireFloorMs: GateKnob;
	};
	orgRoot: string | null;
	orgRootSource: GateValueSource;
	preview: { deckMode: string; flatFileMode: string };
}

export interface UpdateMaintenanceGateRequest {
	enabled?: boolean;
	minOpMsgs?: number | null;
	minReleaseAgeMs?: number | null;
	fireFloorMs?: number | null;
}

export type StarterKind = "skills" | "extensions";

/** One bundled starter skill or extension, its origin, and whether it is opted in and installed. */
export interface StarterItem {
	kind: StarterKind;
	name: string;
	description: string;
	/** The starter's `source:` tag (e.g. "npi-deck starter (from mattpocock/skills@b8be62f, MIT)"); null when untagged. */
	origin: string | null;
	/** Listed in `NPI_DECK_STARTERS`: the deck installs it now and again at launch when it goes missing. */
	optedIn: boolean;
	installed: boolean;
	installedPath: string;
}

/** One kind of starter (skills or extensions): the bundle and where it installs. */
export interface StarterGroup {
	/** Bundled source directory, or null when the deck cannot find it. */
	sourceDir: string | null;
	targetDir: string;
	items: StarterItem[];
}

/** `GET /api/starters`. */
export interface StartersResponse {
	/** `NPI_DECK_STARTERS`, the opt-in list; read-only here when the launching shell exports it. */
	setting: EnvBackedSetting;
	skills: StarterGroup;
	extensions: StarterGroup;
}

/** `PUT /api/starters/:kind/:name`: opt a starter in (installs it now) or out (leaves any copy in place). */
export interface UpdateStarterRequest {
	optedIn: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge supervisor (long-running auxiliary processes the deck owns)
// ─────────────────────────────────────────────────────────────────────────────

export type BridgeName = "telegram";
export type BridgeStatus = "running" | "stopped" | "starting" | "crashed";

export interface BridgeInfo {
	name: BridgeName;
	label: string;
	status: BridgeStatus;
	pid?: number;
	startedAt?: string;
	stoppedAt?: string;
	exitCode?: number;
	exitSignal?: string;
	crashCount: number;
	missingEnv: string[];
	requiredEnv: string[];
	lastError?: string;
}

export interface ListBridgesResponse {
	bridges: BridgeInfo[];
}

export interface BridgeLogLine {
	stream: "stdout" | "stderr";
	text: string;
	timestamp: string;
}

export interface BridgeLogsResponse {
	name: BridgeName;
	lines: BridgeLogLine[];
}

export interface ModelInfo {
	provider: string;
	id: string;
	label: string;
	role?: string;
	contextWindow?: number;
	/** Provider has resolvable auth (api key set, oauth credentials present, or keyless). */
	isAvailable: boolean;
	/**
	 * True when the provider exposes a browser-OAuth flow (subscription auth)
	 * — e.g. `openai-codex` for ChatGPT Plus/Pro, `anthropic` w/ Claude Pro.
	 * The picker badges these so users can tell subscription variants apart
	 * from API-key variants of the same model name.
	 */
	isSubscription?: boolean;
	/** True for the model active in the requesting session. */
	isCurrent?: boolean;
	/** Optional UX hint: input modalities the provider supports for this model. */
	inputModes?: Array<"text" | "image">;
	/** A NeoPi mixture-of-agents model (`mixture/<name>`): several member models behind one id. */
	isMixture?: boolean;
}

export interface ListModelsResponse {
	models: ModelInfo[];
	active?: ModelRef;
}

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding (first-run wizard)
// ─────────────────────────────────────────────────────────────────────────────

/** Light projection of a provider credential — enough for the wizard to tick "done". */
export interface OnboardingStateProvider {
	id: string;
	kind: "oauth" | "api-key";
}

/**
 * Composite first-run state. `needsOnboarding` drives whether the web layer
 * shows the wizard; the other fields let each step render a "you've already
 * done this" tick when the user set things up out-of-band before the wizard
 * was added or via the API directly.
 */
export interface OnboardingState {
	needsOnboarding: boolean;
	completedAt: string | null;
	skipped: boolean;
	version: number;
	providers: OnboardingStateProvider[];
	kbRoot: string;
	kbExists: boolean;
}

/** Body of `POST /api/onboarding/complete`. `skipped` distinguishes "walked through" vs "X-ed out." */
export interface CompleteOnboardingRequest {
	skipped: boolean;
}

/** Body of `POST /api/onboarding/seed-kb-system`. Optional override; defaults to resolved kb root. */
export interface SeedKbSystemRequest {
	kbRoot?: string;
}

export interface SeedKbSystemResponse {
	created: string[];
	skipped: string[];
}

export interface SetSessionModelRequest {
	model: ModelRef;
}


// ─────────────────────────────────────────────────────────────────────────────
// Marketplace (SDK plugin catalog browsing + install/uninstall)
// ─────────────────────────────────────────────────────────────────────────────

export interface MarketplaceSource {
	name: string;
	sourceType: "github" | "git" | "url" | "local";
	sourceUri: string;
	updatedAt: string;
}

export interface MarketplacePluginCapabilities {
	commands?: boolean;
	agents?: boolean;
	hooks?: boolean;
	mcpServers?: boolean;
	lspServers?: boolean;
}

export interface MarketplaceCatalogEntry {
	id: string; // "name@marketplace"
	name: string;
	marketplace: string;
	description?: string;
	version?: string;
	author?: string;
	homepage?: string;
	keywords?: string[];
	category?: string;
	tags?: string[];
	capabilities: MarketplacePluginCapabilities;
	installed?: {
		scope: "user" | "project";
		version: string;
		installedAt: string;
		enabled?: boolean;
	};
}

export interface InstalledPluginInfo {
	id: string;
	name: string;
	marketplace: string;
	scope: "user" | "project";
	version: string;
	installedAt: string;
	installPath: string;
	enabled?: boolean;
	shadowedBy?: "project";
}

export interface ListMarketplaceResponse {
	sources: MarketplaceSource[];
	catalog: MarketplaceCatalogEntry[];
	installed: InstalledPluginInfo[];
}

export interface InstallPluginRequest {
	name: string;
	marketplace: string;
	scope?: "user" | "project";
	force?: boolean;
}

export interface InstallPluginResponse {
	ok: boolean;
	installed: InstalledPluginInfo;
}

export interface UninstallPluginRequest {
	id: string; // "name@marketplace"
	scope?: "user" | "project";
}

export interface AddMarketplaceRequest {
	source: string; // url, github "owner/repo", git+url, or absolute local path
}

/**
 * One installed plugin whose marketplace catalog declares a newer version,
 * as reported by NeoPi's `MarketplaceManager.checkForUpdates()`.
 */
export interface MarketplacePluginUpdate {
	pluginId: string; // "name@marketplace"
	name: string;
	marketplace: string;
	scope: "user" | "project";
	/** Installed version. */
	from: string;
	/** Version the catalog declares. */
	to: string;
}

export interface MarketplaceUpdatesResponse {
	updates: MarketplacePluginUpdate[];
	/**
	 * True when every marketplace was re-fetched from its source first
	 * (`POST /api/marketplace/updates/check`); false when installed versions
	 * were compared against the cached catalogs (`GET /api/marketplace/updates`).
	 */
	refreshed: boolean;
	/**
	 * Marketplaces whose source could not be fetched during a refresh. Their
	 * cached catalogs were compared instead. Always empty when `refreshed` is false.
	 */
	refreshErrors: Array<{ marketplace: string; error: string }>;
	checkedAt: string;
}

export interface UpgradePluginRequest {
	/** Upgrade only this scope; omitted upgrades every scope the plugin is installed in. */
	scope?: "user" | "project";
}

export interface UpgradePluginResponse {
	ok: boolean;
	upgraded: InstalledPluginInfo[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills (enumeration across every omp skill provider)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parsed SKILL.md frontmatter. `name` falls back to the directory name when
 * the file omits an explicit `name:` field, matching the omp SDK's loader.
 */
export interface SkillFrontmatter {
	name: string;
	description?: string;
	model?: string;
	triggers?: string[];
	tags?: string[];
}

/**
 * Provider identifier from the omp SDK's capability system. Open-ended so
 * the deck doesn't break when omp adds a new discovery provider, but the
 * known set is what the UI styles/labels/sorts by today.
 */
export type SkillProvider =
	| "native"           // omp's own — ~/.omp/agent/skills + <cwd>/.omp/skills
	| "claude-plugins"   // marketplace-installed plugins
	| "claude"           // shared ~/.claude/skills + .claude/skills
	| "codex"            // shared ~/.codex/skills + .codex/skills
	| "opencode"
	| "cursor"
	| "windsurf"
	| "cline"
	| "gemini"
	| "agents"           // skills nested under subagent dirs
	| "custom"           // custom directories from runtime config
	| (string & {});     // forward-compat

/**
 * A skill enumerated from any omp provider. `provider` + `level` say where
 * it came from; plugin attribution is set only when the source was a
 * marketplace-installed Claude plugin.
 */
export interface SkillSummary {
	/**
	 * Server-issued opaque identifier (base64url of the absolute SKILL.md
	 * path). Stable across reads, URL-safe, used as `/api/skills/:id`.
	 */
	id: string;
	/** Frontmatter `name` (falls back to dirName). */
	name: string;
	/** Directory under the provider's `skills/` root. */
	dirName: string;
	/** Provider that contributed this skill. */
	provider: SkillProvider;
	/** Human display label (e.g. "OMP", "Claude Plugins", "Claude Code"). */
	providerLabel: string;
	/** User vs project scope, from the SDK's source metadata. */
	level: "user" | "project";
	/** Absolute path to SKILL.md on disk. UI keeps this opaque. */
	skillPath: string;
	/** Parsed frontmatter (name, description, model, triggers, tags). */
	frontmatter: SkillFrontmatter;
	/** False only when the owning provider's enable-flag is off, or hide=true. */
	enabled: boolean;
	/**
	 * True when the deck can edit and delete this skill: an OMP user skill
	 * whose directory resolves to a direct child of the agent dir's `skills/`.
	 * Plugin, marketplace, project and other providers' skills stay read-only.
	 */
	editable: boolean;
	/** Plugin attribution — set only when `provider === "claude-plugins"`. */
	pluginId?: string;
	pluginName?: string;
	marketplace?: string;
}

export interface ListSkillsResponse {
	skills: SkillSummary[];
}

/**
 * `POST /api/skills`: author an OMP user skill at `<agentDir>/skills/<name>/SKILL.md`.
 * `name` must satisfy the Agent Skills name rules (lowercase letters, digits,
 * single hyphens, at most 64 characters) and becomes the directory name.
 */
export interface CreateSkillRequest {
	name: string;
	description: string;
	body: string;
}

/**
 * `PUT /api/skills/:id`: replace an editable skill's description and body.
 * Other frontmatter keys are kept. `revision` is the detail's revision; a
 * SKILL.md that changed since then is refused with 409.
 */
export interface UpdateSkillRequest {
	description: string;
	body: string;
	revision: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Base (Karpathy-style llm-wiki viewer over ~/kb)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One entry in a KB tree listing. `path` is always forward-slash separated
 * and rooted at the KB root (e.g. "tools/tauri-knowledge-hub.md"). For dirs
 * `mdCount` includes recursive markdown count after exclude rules.
 */
export interface KbTreeEntry {
	name: string;
	path: string;
	kind: "file" | "dir";
	/** Bytes; omitted for directories. */
	size?: number;
	/** ISO timestamp; omitted for directories. */
	mtime?: string;
	/** Recursive markdown count, dirs only. */
	mdCount?: number;
	/** True when this entry is a symlink/junction (e.g. cryptocracy). */
	symlink?: boolean;
}

export interface KbTreeResponse {
	/** The requested directory's relative path; empty for root. */
	path: string;
	dirs: KbTreeEntry[];
	files: KbTreeEntry[];
}

/**
 * One parsed wikilink from a SKILL/article body. `resolved` is the relative
 * path of the matching file (forward-slash), or null when no file matches
 * the target's stem or subpath. `anchor` carries any `#section` portion.
 */
export interface KbWikilink {
	/** Verbatim text inside `[[…]]`, including label and anchor parts. */
	raw: string;
	/** The target without label/anchor — what was used to resolve. */
	target: string;
	/** Render label (`[[target|label]]` — defaults to `target`). */
	label: string;
	/** Anchor portion (`[[target#anchor]]`) — null if absent. */
	anchor: string | null;
	/** Resolved kb-relative path with forward slashes, or null. */
	resolved: string | null;
	/** Reason resolution failed when `resolved === null`. */
	unresolvedReason?: "no-match" | "ambiguous-stem" | "outside-kb";
}

export interface KbFileResponse {
	/** Forward-slash relative path from kb root. */
	path: string;
	/** Absolute disk path; opaque to clients but useful for inspector. */
	absolutePath: string;
	/** Parsed YAML frontmatter (empty when absent or invalid). */
	frontmatter: Record<string, unknown>;
	/** Frontmatter parser warning when `---` block was malformed YAML. */
	frontmatterError?: string;
	/** SKILL.md / article body with frontmatter stripped. */
	body: string;
	/** Verbatim file content on disk (frontmatter + body) — used by the editor. */
	rawContent: string;
	/**
	 * Body with wikilinks already substituted to in-app markdown links so the
	 * web client can render directly through react-markdown without
	 * understanding `[[…]]` syntax. Resolved links become
	 * `[label](kb-link:<resolved>?anchor=<a>)`; unresolved links become
	 * `[label](kb-unresolved:<target>)`. Wikilinks inside fenced code or
	 * inline backticks are left alone.
	 */
	bodyForRender: string;
	/** Outgoing wikilinks, in order of appearance. */
	outgoingLinks: KbWikilink[];
	/** File size in bytes. */
	size: number;
	/** ISO timestamp. */
	mtime: string;
}

/**
 * One node in the KB graph. `dir` is the top-level kb directory (used by the
 * graph view to color-code: domains / tools / system / writing / cryptocracy).
 * `inbound` / `outbound` are degrees for sizing + isolation toggles.
 */
export interface KbGraphNode {
	/** Stable id — same as `path`. */
	id: string;
	path: string;
	title: string;
	/** Top-level directory ("" for files at kb root). */
	dir: string;
	inbound: number;
	outbound: number;
	/** Frontmatter tags, if any — used for tag filtering. */
	tags: string[];
}

export interface KbGraphEdge {
	source: string;
	target: string;
}

export interface KbGraphResponse {
	nodes: KbGraphNode[];
	edges: KbGraphEdge[];
	/** Number of wikilink occurrences that didn't resolve to a node. */
	unresolvedCount: number;
	/** Total nodes that exist in the index (>= nodes.length when truncated). */
	totalNodes: number;
	/**
	 * True when the response was truncated at the v1 cap (10_000 nodes). UI
	 * should surface a warning so the user knows the graph isn't whole.
	 */
	truncated: boolean;
}

export interface KbBacklink {
	/** Source file whose body links to the queried path. */
	source: string;
	/** Short snippet of body around the link (best-effort, line-bounded). */
	snippet: string;
	/** Render label that was used in the source's wikilink. */
	label: string;
}

export interface KbBacklinksResponse {
	path: string;
	backlinks: KbBacklink[];
}

/**
 * Where a search query matched a file. Used by the UI to render
 * differently — filename hits sort to the top, body hits get a snippet.
 */
export type KbSearchMatchKind = "stem" | "title" | "tag" | "body";

export interface KbSearchResult {
	/** Forward-slash kb-relative path. */
	path: string;
	/** Display title — frontmatter `name` if set, else filename stem. */
	title: string;
	/** Top-level directory ("" for root files). Used for color coding. */
	dir: string;
	/** Score (higher = better). Order is deterministic by score desc + path asc. */
	score: number;
	/** Best match kind for this file (a file may match many ways). */
	matchKind: KbSearchMatchKind;
	/** Body-context snippet centered on the first body match; empty otherwise. */
	snippet: string;
}

export interface KbSearchResponse {
	query: string;
	results: KbSearchResult[];
	/** Total candidate matches before the limit was applied. */
	totalMatches: number;
	/** True when the response was truncated to the requested limit. */
	truncated: boolean;
}

/**
 * Co-located file under a skill's directory. Listed recursively (depth-first)
 * with `relPath` carrying the path from the skill dir; the UI groups by
 * parent. Symlinks and excluded dirs (`node_modules`, `__pycache__`, `.git`)
 * are filtered server-side.
 */
export interface SkillFile {
	/** Path relative to the skill directory, forward-slash separated. */
	relPath: string;
	name: string;
	kind: "file" | "dir";
	/** Bytes; omitted for directories. */
	size?: number;
	/** ISO timestamp; omitted for directories. */
	mtime?: string;
}

/**
 * Single-skill detail. `body` is the SKILL.md content with the frontmatter
 * block stripped; consumers re-render with the chat markdown pipeline.
 */
export interface SkillDetailResponse extends SkillSummary {
	body: string;
	files: SkillFile[];
	/** Hash of the SKILL.md bytes this detail was read from; `UpdateSkillRequest.revision`. */
	revision: string;
}
// ─────────────────────────────────────────────────────────────────────────────
// WebSocket frames
// ─────────────────────────────────────────────────────────────────────────────

/** Sanitized SDK message — passthrough of @oh-my-pi/pi-coding-agent AgentMessage. */
export type AgentMessageJson = Record<string, unknown> & {
	role: "user" | "assistant" | "tool" | "system" | "custom" | string;
	content: unknown;
};

/** Sanitized SDK event — passthrough of AgentSessionEvent. */
export type AgentSessionEventJson = Record<string, unknown> & {
	type: string;
};

/**
 * Context-window utilization for an in-process agent session. Mirrors the
 * SDK's `ContextUsage` shape but is defined here so the protocol package owns
 * the canonical type the deck UI consumes.
 *
 * `tokens` and `percent` are nullable because the SDK can't reliably report
 * fresh numbers immediately after compaction — the next assistant response
 * is what supplies the post-compaction usage. While in that hole the deck
 * UI should render a "—%" / "calculating" affordance, not a 0%.
 */
export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/**
 * Live plan-mode state for a session. Mirrors the SDK's `PlanModeState` shape
 * minus internal flags the deck UI never consumes (workflow / reentry).
 * Absent on a snapshot means plan mode is off.
 */
export interface PlanModeContextWire {
	enabled: boolean;
	/** Current plan artifact; after proposal this is the agent's `local://<slug>-plan.md`. */
	planFilePath: string;
}

/**
 * A plan the agent has proposed for approval. The deck UI renders this as an
 * inline `PlanApproval` card. Replayed on `subscribed` so a page-reload during
 * pending approval re-shows the card without waiting for the next event.
 */
export interface PendingPlanApprovalWire {
	/** Stable id used to disambiguate concurrent approval responses (two tabs). */
	proposalId: string;
	/** Agent-authored `local://<slug>-plan.md` URL, preserved after approval. */
	planFilePath: string;
	/** Verbatim contents of `planFilePath` as the agent submitted it. */
	planContent: string;
	/** Normalized title derived by NeoPi from the submitted plan. */
	suggestedTitle: string;
}

/** Snapshot delivered when a client subscribes to an existing session. */
export interface SessionSnapshot {
	sessionId: string;
	/**
	 * Legacy backends may give later roots no async-job manager. The UI shows
	 * a "limited" badge only for those sessions; multi-root backends omit it.
	 */
	backgroundJobsUnavailable?: boolean;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	model?: ModelRef;
	thinkingLevel?: string;
	/** Current NeoPi configuration warnings; refreshed by `config_warnings_changed`. */
	configWarnings?: string[];
	isStreaming: boolean;
	messages: AgentMessageJson[];
	todoPhases: Array<Record<string, unknown>>;
	/**
	 * Current context-window utilization, mirroring the SDK's
	 * `session.getContextUsage()`. Absent when the model has no declared
	 * context window. `tokens` is `null` immediately after compaction (before
	 * the next assistant response provides fresh usage data); `percent` is
	 * `null` in the same case.
	 */
	contextUsage?: ContextUsage;
	/**
	 * Plan-mode state, present iff the session is in plan mode at snapshot
	 * time. The web client uses this to render the "Plan" pill and gate the
	 * Shift+Tab toggle's visual on/off without a separate state fetch.
	 */
	planMode?: PlanModeContextWire;
	/**
	 * Unresolved plan-approval card, if the agent proposed a plan that the
	 * user hasn't approved/rejected yet. Replayed verbatim on subscribe so a
	 * page reload re-renders the PlanApproval inline component.
	 */
	pendingPlanApproval?: PendingPlanApprovalWire;
	/**
	 * Prompts the SDK currently has queued for execution after the active
	 * turn finishes. Empty when no turn is in flight or no queued prompts
	 * exist. Included in the snapshot so a page-reload subscriber sees the
	 * queue immediately instead of waiting for the next `queue_state` event.
	 */
	queuedPrompts?: QueuedPromptWire[];
	/**
	 * The session file's persisted `mixture_trace` cards. A live session's
	 * `messages` is the model context, which never holds these display-only
	 * cards, so a resubscribing client rebuilds the MoA panel from this.
	 */
	mixtureTraces?: AgentMessageJson[];
}

/**
 * Wire shape of a queued prompt. Mirrors what the deck UI renders for the
 * "queued" bubble. `id` is the bridge-assigned `queuedId` echoed back in
 * `prompt_queued` and `queue_state` events so the client can target a
 * specific entry for cancel/edit.
 */
export interface QueuedPromptWire {
	id: string;
	text: string;
	images?: ImageAttachment[];
	behavior: "steer" | "followUp";
	queuedAt: number;
}

/**
 * Image attachment for prompt frames — matches the SDK's ImageContent shape.
 * `data` is the raw base64-encoded image payload (no data: URL prefix).
 */
export interface ImageAttachment {
	type: "image";
	data: string;
	mimeType: string;
}

/**
 * Possible extension-UI dialog response shapes returned by the client when an
 * agent (typically the `ask` tool, but any extension can use the same surface)
 * has asked for a selection / confirmation / free-form input.
 */
export interface ExtUiDialogResponse {
	/** Single selected option (for `select` / `input` / `editor`). */
	value?: string;
	/** Multi-select result. Reserved for future native multi-select; the
	 *  current `ask` tool implementation issues a sequence of single selects. */
	values?: string[];
	/** `confirm` dialog answer. */
	confirmed?: boolean;
	/** True iff the user cancelled (Esc, modal close, tab close). */
	cancelled?: true;
	/** True iff the dialog timed out before the user responded. */
	timedOut?: true;
}

/** Client → Server. */
export type ClientFrame =
	| { type: "ping" }
	| { type: "subscribe"; sessionId: string }
	| { type: "unsubscribe"; sessionId: string }
	| {
			type: "prompt";
			sessionId: string;
			text: string;
			images?: ImageAttachment[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| { type: "abort"; sessionId: string }
	/**
	 * Clear the session's pending-prompt queue (steering + follow-up).
	 * The server replies with a synthetic `queue_cleared` session event
	 * carrying the count of dropped entries so subscribed clients can
	 * reconcile their `queuedPrompts` UI state.
	 */
	| { type: "clear_queue"; sessionId: string }
	/**
	 * Cancel a single queued prompt by its `queuedId`. The server replies
	 * with a synthetic `queue_state` session event carrying the new ordered
	 * queue so subscribed clients can reconcile. No-op if the id is unknown
	 * (already drained, never queued, or wrong session).
	 */
	| { type: "cancel_queued"; sessionId: string; queuedId: string }
	/**
	 * Edit a queued prompt's text (and optionally images). Server pops every
	 * SDK queue entry and re-enqueues survivors with the edited entry's
	 * content substituted in-place — order preserved. Same `queue_state`
	 * echo as cancel.
	 */
	| {
			type: "edit_queued";
			sessionId: string;
			queuedId: string;
			text: string;
			images?: ImageAttachment[];
	  }
	/** Response to an `ext_ui_dialog_open` frame. */
	| ({
			type: "ext_ui_dialog_response";
			sessionId: string;
			dialogId: string;
	  } & ExtUiDialogResponse)
	/**
	 * Enter or exit NeoPi plan mode. The server restores the previous tools on
	 * exit and broadcasts `plan_mode_changed`.
	 */
	| { type: "set_plan_mode"; sessionId: string; enabled: boolean }
	/**
	 * Reply to a plan proposal. Approval exits plan mode and returns control to
	 * the agent; rejection keeps planning active and returns feedback to the
	 * agent. Edited content replaces the proposed artifact in place.
	 */
	| {
			type: "plan_response";
			sessionId: string;
			proposalId: string;
			approved: boolean;
			feedback?: string;
			editedContent?: string;
	  };

/** Server → Client. */
export type ServerFrame =
	| { type: "hello"; connectionId: string; workerGeneration: string; backend: BackendStatusResponse["running"]; capabilities: string[] }
	| { type: "pong" }
	| { type: "subscribed"; sessionId: string; snapshot: SessionSnapshot }
	| { type: "unsubscribed"; sessionId: string }
	/** Sent only to the socket that sent a `prompt` whose slash command the
	 *  deck or SDK handled itself. No agent run follows, so no `agent_end`. */
	| { type: "prompt_consumed"; sessionId: string; output: string }
	| { type: "session_event"; sessionId: string; event: AgentSessionEventJson }
	/** The server stopped running this chat (closed, reaped or shut down) and its
	 *  teardown finished. Sent to the connections that were subscribed to it. */
	| { type: "session_disposed"; sessionId: string }
	| { type: "subagents_snapshot"; sessionId: string; nodes: SubagentNode[] }
	/** Broadcast frame: any kanban-task mutation occurred. Clients refetch. */
	| { type: "tasks_changed" }
	/** Broadcast frame: skill catalog or enabled-state changed. Clients refetch. */
	| { type: "skills_changed" }
	/** Broadcast frame: any KB file under the watched root mutated. Clients refetch. */
	| { type: "kb_changed" }
	/** OAuth: SDK has produced the consent URL; client opens it in a new tab. */
	| {
			type: "oauth_consent";
			flowId: string;
			provider: string;
			url: string;
			instructions?: string;
		}
	/** OAuth: SDK status update (e.g. "Waiting for browser authentication…"). */
	| { type: "oauth_progress"; flowId: string; provider: string; message: string }
	/** OAuth: SDK is asking the user a free-form question (enterprise URL, etc). */
	| {
			type: "oauth_prompt";
			flowId: string;
			provider: string;
			promptId: string;
			message: string;
			placeholder?: string;
		}
	/** OAuth: login resolved successfully; client should refetch providers + models. */
	| { type: "oauth_complete"; flowId: string; provider: string }
	/** OAuth: login rejected (timeout, port collision, state mismatch, user cancel). */
	| { type: "oauth_failed"; flowId: string; provider: string; message: string }
	/** Broadcast: model registry availability changed (post-login / post-revoke). */
	| { type: "models_changed" }
	/** V1 routine: a new multi-step run has started. */
	| {
			type: "routine_run_started";
			routineId: string;
			runId: string;
			triggerKind: "cron" | "manual" | "webhook" | "event";
			startedAt: string;
		}
	/** V1 routine: a single step transitioned (running -> success/failed/skipped/aborted). */
	| {
			type: "routine_step_event";
			runId: string;
			stepId: string;
			stepIndex: number;
			status: RoutineStepStatus;
			startedAt?: string;
			endedAt?: string;
			durationMs?: number;
			excerpt?: { stdout?: string; stderr?: string };
			outputJson?: unknown;
			error?: string;
			model?: string;
			tokens?: { in: number; out: number };
		}
	/** V1 routine: the run finished (or was aborted). Total cost is in USD micro-cents. */
	| {
			type: "routine_run_finished";
			runId: string;
			status: "success" | "failed" | "aborted";
			abortReason?: string;
			endedAt: string;
			durationMs: number;
			totalCostMicros: number;
		}
	/**
	 * An extension UI dialog has opened in the named session. The web client
	 * renders a modal of the matching shape and replies with
	 * `ext_ui_dialog_response`. Used by the SDK `ask` tool today and by any
	 * extension calling `ctx.ui.select/editor/confirm/input`.
	 *
	 * `kind` selects the rendered shape; not every field applies to every kind.
	 * Strict superset of what `ask` needs so the same channel covers
	 * extension-driven dialogs without protocol churn.
	 */
	| {
			type: "ext_ui_dialog_open";
			sessionId: string;
			dialogId: string;
			kind: "select" | "editor" | "confirm" | "input";
			/** Title / prompt line shown above the controls. */
			prompt: string;
			/** select: options in display order; the response `value` is the chosen `label`. */
			options?: SelectOptionWire[];
			/** select: hint that the dialog allows multiple selections. */
			multi?: boolean;
			/** select: index of the option pre-focused on open. */
			initialIndex?: number;
			/** select: index of the "recommended" option (visually marked). */
			recommended?: number;
			/** select: ancillary help text below the options. */
			helpText?: string;
			/** confirm: secondary message body. */
			message?: string;
			/** input: placeholder text. */
			placeholder?: string;
			/** editor: initial textarea contents. */
			prefill?: string;
			/** editor: render with the prompt styled like the chat composer. */
			promptStyle?: boolean;
			/** Server-side timeout in ms; UI may render a countdown. 0 / absent = none. */
			timeoutMs?: number;
	  }
	/**
	 * The server-side promise behind a previously-opened dialog has been
	 * cancelled (signal aborted, session disposed, server-side timeout fired).
	 * The web client should close the matching modal without sending a
	 * response — the SDK call is already settled.
	 */
	| {
			type: "ext_ui_dialog_cancel";
			sessionId: string;
			dialogId: string;
			reason: "session_disposed" | "timeout" | "aborted";
	  }
	/**
	 * Plan mode toggled for `sessionId`. Broadcast on every enter/exit
	 * (whether user-initiated via `set_plan_mode` or server-initiated as
	 * part of approving / rejecting a proposal). Clients reconcile their
	 * composer-pill + status-pill state by mirroring this onto the session.
	 */
	| {
			type: "plan_mode_changed";
			sessionId: string;
			enabled: boolean;
			/** Always present when `enabled` — absent on exit. */
			planFilePath?: string;
	  }
	/**
	 * Agent submitted a plan by writing its slug to `xd://propose`. The web
	 * client renders the artifact and returns approval, edits or rejection
	 * feedback via `plan_response`; late subscribers see the pending card.
	 */
	| {
			type: "plan_proposed";
			sessionId: string;
			proposalId: string;
			planFilePath: string;
			planContent: string;
			suggestedTitle: string;
	  }
	/**
	 * A proposal was settled (or expired when its session was disposed).
	 * Second-tab responses to the same id are rejected as stale.
	 */
	| {
			type: "plan_proposal_resolved";
			sessionId: string;
			proposalId: string;
			outcome: "approved" | "rejected" | "resolved_elsewhere" | "expired";
	  }
	/**
	 * Server liveness heartbeat. Broadcast on a fixed interval (default 5s).
	 * Clients use the gap between consecutive heartbeats to drive a connection
	 * indicator. `serverStartedAt` lets clients detect a restart even when the
	 * WebSocket auto-reconnects: a fresh value means the server bounced.
	 */
	| {
			type: "heartbeat";
			serverStartedAt: string;
			pid: number;
			uptimeSecs: number;
			buildSha: string | null;
			version: string;
			timestamp: string;
	  }
	/**
	 * User-facing notification. Emitted by the deck's `NotificationService`
	 * for each `NotificationKind`, unless that kind is switched off in
	 * Settings. Browser-channel deliver()s push these frames to every
	 * connected client; the web layer renders an OS-level `Notification`
	 * (when permission granted) plus an audio cue.
	 */
	| {
			type: "notification";
			id: string;
			kind: NotificationKind;
			level: NotificationLevel;
			title: string;
			body?: string;
			sound?: boolean;
			source?: string;
			actionUrl?: string;
			timestamp: string;
	  }
	| { type: "error"; sessionId?: string; error: string };

/** Severity for a deck notification. Drives the audio tone + visual styling. */
export type NotificationLevel = "info" | "warn" | "error" | "critical";

/**
 * What produced a notification. Each kind can be switched off in Settings →
 * Notifications (`NPI_DECK_NOTIFICATIONS_DISABLED`).
 *   - `routine_failed`: a routine run ended failed, cancelled, timed out or over budget.
 *   - `task_shipped`: a routine step moved a task into Done.
 *   - `auth_fallback`: a model call failed auth while a subscription login covers the same model.
 */
export type NotificationKind = "routine_failed" | "task_shipped" | "auth_fallback";

/** Payload accepted by `NotificationService.notify` on the server. */
export interface NotificationPayload {
	kind: NotificationKind;
	level: NotificationLevel;
	title: string;
	body?: string;
	/** Default true for `warn` and above; explicit false suppresses the tone. */
	sound?: boolean;
	/** Free-form origin tag, e.g. `routine:<routineId>/run:<runId>`. */
	source?: string;
	/** Optional deep-link the user can click to jump to the relevant view. */
	actionUrl?: string;
}

/** One option of an `ext_ui_dialog_open` select, as NeoPi's `ExtensionUISelectItem` carries it. */
export interface SelectOptionWire {
	label: string;
	description?: string;
}

/**
 * `GET /api/sessions/transcript?path=…[&limit=N]`: a persisted session read
 * straight from its file. No SDK session is created and nothing is spawned;
 * the sidebar renders it read-only until the user resumes or sends.
 */
export interface SessionTranscriptResponse {
	sessionId: string;
	path: string;
	cwd: string;
	title?: string;
	/** The newest `limit` messages, or every message when the request set no limit. */
	messages: AgentMessageJson[];
	/**
	 * What a `limit`ed read left out: how many older messages, and the `usage`
	 * of each omitted assistant message so the session's cost still covers the
	 * whole transcript. Absent when nothing was left out.
	 */
	omitted?: { count: number; usage: unknown[] };
	backendLastRan?: { path: string; commit: string | null; version: string | null };
	/**
	 * A deck session is running from this file (opened in another tab, or
	 * before a page reload). The client subscribes to it rather than showing
	 * the file read-only; `messages` only stand in until the snapshot arrives.
	 */
	live?: true;
}

/** A child of a live deck session. parentId is another node or the root agent id. */
export interface SubagentNode {
	id: string;
	parentId: string;
	name: string;
	status: string;
	description?: string;
	activity?: string;
	sessionFile?: string;
	createdAt: number;
}

export interface SubagentTranscriptResponse {
	id: string;
	messages: AgentMessageJson[];
	nextByte: number;
	reset: boolean;
}


// ─────────────────────────────────────────────────────────────────────────────
// Tasks (kanban)
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskState {
	id: string;
	name: string;
	color: string;
	position: number;
	isDefault: boolean;
}

export interface Task {
	id: string;
	/** Monotonic deck-wide display number. Render as `T-${displayId}`. */
	displayId: number;
	title: string;
	body: string;
	stateId: string;
	orderInState: number;
	cwd?: string;
	createdAt: string;
	updatedAt: string;
	/**
	 * ISO timestamp of when this task last entered its current `stateId`.
	 * Bumps on cross-column moves; left untouched by body edits, title edits,
	 * or same-column drag reorders. Drives the per-column recency sort.
	 *
	 * Backfilled to `updated_at` for pre-004 rows on migration; values may not
	 * be perfectly accurate before the first post-deploy move.
	 */
	stateEnteredAt: string;
	archivedAt?: string;
}

export interface CreateTaskRequest {
	title: string;
	body?: string;
	stateId?: string;
	cwd?: string;
}

export interface UpdateTaskRequest {
	title?: string;
	body?: string;
	stateId?: string;
	orderInState?: number;
	/** `null` or blank clears the cwd (files the task as unassigned); omit to leave it unchanged. */
	cwd?: string | null;
	archived?: boolean;
}

/** A project on the kanban: every task sharing one `cwd`. */
export interface TaskProject {
	/** `null` is the bucket of tasks with no cwd. */
	cwd: string | null;
	/** Last path segment of `cwd`, or "Unassigned". */
	label: string;
	taskCount: number;
}

export interface ListTasksResponse {
	/** Every project's tasks, or only one project's when `GET /api/tasks?cwd=` is given. */
	tasks: Task[];
	states: TaskState[];
	/** Every project holding a task, regardless of the `cwd` filter. */
	projects: TaskProject[];
}

export interface CreateTaskStateRequest {
	name: string;
	color?: string;
	position?: number;
}

export interface UpdateTaskStateRequest {
	name?: string;
	color?: string;
	position?: number;
}

/** Body for the "reorder task states" endpoint (kanban column drag). */
export interface ReorderTaskStatesRequest {
	/** Permutation of every existing `TaskState.id`, top-of-board first. */
	orderedIds: string[];
}

export interface ReorderTaskStatesResponse {
	states: TaskState[];
}

/** Body for the "move task" convenience endpoint (kanban drop). */
export interface MoveTaskRequest {
	stateId: string;
	/** New 0-based index inside the destination column. */
	index: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbox
// ─────────────────────────────────────────────────────────────────────────────

export type InboxKind =
	| "email"
	| "ticket"
	| "idea"
	| "decision"
	| "investigation"
	| "capture";

export interface InboxItem {
	id: string;
	kind: InboxKind;
	title: string;
	body: string;
	source?: string;
	createdAt: string;
	processedAt?: string;
}

export interface CreateInboxItemRequest {
	kind: InboxKind;
	title: string;
	body?: string;
	source?: string;
}

export interface UpdateInboxItemRequest {
	title?: string;
	body?: string;
	kind?: InboxKind;
	source?: string;
	processed?: boolean;
}

export interface ListInboxResponse {
	items: InboxItem[];
}

/**
 * Promote an inbox item into a task.
 *
 * The server copies the item's `title` and `body` onto a new task in the
 * destination state (or the user's default state when omitted) and, unless
 * `markProcessed: false`, marks the source item processed so it stops
 * cluttering the unprocessed list.
 */
export interface PromoteInboxItemRequest {
	stateId?: string;
	markProcessed?: boolean;
}

export interface PromoteInboxItemResponse {
	task: Task;
	inbox: InboxItem;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routines (cron)
// ─────────────────────────────────────────────────────────────────────────────

export type RoutineActionKind = "bash" | "prompt" | "script";

export interface Routine {
	id: string;
	name: string;
	description: string;
	cron: string;
	actionKind: RoutineActionKind;
	actionBody: string;
	actionCwd?: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	lastRunAt?: string;
	nextRunAt?: string;
	// V1 additions — see "V1 routine spec" section below for the parsed-spec types.
	/** 0 = V0 single-action routine (cron+actionKind+actionBody); 1 = V1 multi-step (specYaml). */
	specVersion: 0 | 1;
	/** Concurrency policy. V0 routines default to 'skip'; V1 routines set it explicitly in their spec. */
	concurrency: RoutineConcurrency;
	/** Full V1 spec source-of-truth. NULL/undefined for V0 routines. */
	specYaml?: string;
	/** Optional runtime budget caps. */
	budget?: RoutineBudget;
	/** IANA timezone for cron evaluation. NULL = system default. */
	timezone?: string;
	/** User-authored tags for the filter UI. */
	tags?: string[];
}

export interface CreateRoutineRequest {
	name: string;
	description?: string;
	cron: string;
	actionKind: RoutineActionKind;
	actionBody: string;
	actionCwd?: string;
	enabled?: boolean;
}

export interface UpdateRoutineRequest {
	name?: string;
	description?: string;
	cron?: string;
	actionKind?: RoutineActionKind;
	actionBody?: string;
	actionCwd?: string;
	enabled?: boolean;
}

export interface RoutineRun {
	id: string;
	routineId: string;
	startedAt: string;
	endedAt?: string;
	exitCode?: number;
	stdoutExcerpt: string;
	stderrExcerpt: string;
	error?: string;
	/**
	 * Trigger kind. V0 routines only ever see 'cron' or 'manual'; V1 routines
	 * can additionally be triggered by 'webhook' (HMAC-verified POST to /hooks/*)
	 * or 'event' (telegram, deck_inbox, deck_task, future MCP notifications).
	 */
	trigger: "cron" | "manual" | "webhook" | "event";
	// V1 additions — populated by the V1 runner; 0/undefined for V0 rows.
	/** NeoPi tree selected by this run's first agent step; absent for deck-only or historical runs. */
	backend?: { path: string; commit: string | null; version: string | null };
	/**
	 * JSON-serialized trigger payload (webhook body, manual params, event payload).
	 * Values under credential-like keys (token, secret, auth, cookie, …) are
	 * `"[redacted]"`; values under other keys are stored as sent. At most 8 KiB:
	 * a larger payload is `{ truncated: true, bytes, preview }`. A
	 * signature-rejected webhook stores `{ path, headers }`, header names only.
	 */
	triggerPayload?: string;
	/** Sum of input+output LLM tokens across all agent steps in this run. */
	totalLlmTokens: number;
	/** Provider-reported cost summed across all attempts, in millionths of USD. */
	totalLlmCostMicros: number;
	/** When the runner aborted, distinct from endedAt (which is the last-step finish). */
	abortedAt?: string;
	/** 'budget' | 'timeout' | 'cancelled' | 'failure' | 'signature_invalid' | 'concurrency_skipped'. */
	abortReason?: string;
	/** Count of routine_step_runs rows for this run. */
	stepCountTotal: number;
	/** Count of step runs ending in status='failed' or 'aborted'. */
	stepCountFailed: number;
}


// ─── V1 routine spec (multi-step pipelines, spec_version=1) ──────────────

export type RoutineConcurrency =
	| "skip"
	| "queue"
	| "cancel-previous"
	| "parallel";

export interface RoutineBudget {
	/** Wall-clock cap across the whole run. */
	max_duration_secs?: number;
	/** Hard cap on estimated LLM spend per run. Estimated from token counts × model price table. */
	max_llm_cost_usd?: number;
	max_llm_tokens_input?: number;
	max_llm_tokens_output?: number;
	/** Guards against infinite-branch bugs in routine specs. */
	max_steps_executed?: number;
}

export type RoutineOnFailure = "abort" | "continue" | "retry";

export interface RoutineRetryPolicy {
	times: number;
	backoff: "linear" | "exponential";
	max_delay_secs?: number;
	/** What to do if all retries fail. Defaults to 'abort'. */
	after_retry?: "abort" | "continue";
}

export type RoutineDeckAction =
	| "create_inbox_item"
	| "create_task"
	| "move_task"
	| "promote_inbox_item_to_task"
	| "list_tasks"
	| "list_inbox"
	| "get_task"
	| "get_inbox_item"
	| "kb_orphan_census";


/** Common fields every step type accepts. */
export interface RoutineStepCommon {
	id: string;
	/** Boolean JS expression over the context. If false, step is skipped. */
	when?: string;
	on_failure?: RoutineOnFailure;
	retry?: RoutineRetryPolicy;
	timeout_secs?: number;
}

/** Discriminated union by `type`. Add a new step type here AND author its JSON schema. */
export type RoutineStep =
	| (RoutineStepCommon & {
			type: "run";
			command: string;
			cwd?: string;
		})
	| (RoutineStepCommon & {
			type: "agent";
			prompt: string;
			model?: string;
			structured_output?: { schema: unknown; strict?: boolean };
			skills_allowed?: string[];
			mcp_servers_allowed?: string[];
		})
	| (RoutineStepCommon & {
			type: "write";
			path: string;
			content: string;
			append?: boolean;
		})
	| (RoutineStepCommon & {
			type: "http";
			method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
			url: string;
			headers?: Record<string, string>;
			query?: Record<string, string | number | boolean>;
			body?: unknown;
			expect_json?: boolean;
		})
	| (RoutineStepCommon &
			(
				| {
						type: "deck";
						action: "create_inbox_item";
						kind: InboxKind;
						title: string;
						body?: string;
						source?: string;
				  }
				| {
						type: "deck";
						action: "create_task";
						title: string;
						body?: string;
						/** Task state id or case-insensitive state-name substring. Defaults to the default state. */
						state_ref?: string;
						cwd?: string;
				  }
				| {
						type: "deck";
						action: "move_task";
						/** Accepts `T-58` or `t_01...`. */
						task_ref: string;
						/** Required destination state id or case-insensitive state-name substring. */
						state_ref: string;
						/** 0-based destination index. Defaults to 0 (top of column). */
						index?: number;
				  }
				| {
						type: "deck";
						action: "promote_inbox_item_to_task";
						/** Inbox item id, usually from a prior fetch step. */
						inbox_ref: string;
						/** Destination state id or case-insensitive state-name substring. Defaults to the default state. */
						state_ref?: string;
						/** Defaults to true — promoted inbox items are marked processed. */
						mark_processed?: boolean;
				  }
				| {
						type: "deck";
						action: "list_tasks";
						/** Optional state filter — accepts a state id or a case-insensitive state-name substring (e.g. `"active"`). */
						state_ref?: string;
						/** Optional recency filter — only tasks whose `updatedAt` is within the last N hours. */
						since_hours?: number;
						/** Defaults to false; when true, archived tasks are included. */
						include_archived?: boolean;
						/** Cap on the number of tasks returned. Defaults to unlimited. */
						limit?: number;
				  }
				| {
						type: "deck";
						action: "list_inbox";
						/** Optional kind filter. */
						kind?: InboxKind;
						/** Optional recency filter — only items whose `createdAt` is within the last N hours. */
						since_hours?: number;
						/** Defaults to false; when true, already-processed inbox items are included. */
						include_processed?: boolean;
						/** Cap on the number of items returned. Defaults to unlimited. */
						limit?: number;
				  }
				| {
						type: "deck";
						action: "get_task";
						/** Accepts `T-58` or `t_01...`. */
						task_ref: string;
				  }
				| {
						type: "deck";
						action: "get_inbox_item";
						/** Inbox item id. */
						inbox_ref: string;
				  }
				| {
						type: "deck";
						/** Notes in the KB (after `.kbignore`) that no other note links to. */
						action: "kb_orphan_census";
						/** Cap on the orphans listed; `orphanCount` still counts them all. Defaults to unlimited. */
						limit?: number;
				  }
			))
	| (RoutineStepCommon & {
			type: "mcp";
			server: string;
			tool: string;
			args?: Record<string, unknown>;
		})
	| (RoutineStepCommon & {
			type: "transform";
			/** JS expression source. Evaluated in a quickjs sandbox; no network, no fs. */
			body: string;
		})
	| (RoutineStepCommon & {
			type: "wait";
			duration_secs: number;
		})
	| (RoutineStepCommon & {
			type: "set_state";
			/** Key/value pairs to upsert into routine_state. Values may use template substitution. */
			state: Record<string, unknown>;
		});

/** Discriminated union over the four trigger kinds. A routine may have multiple. */
export type RoutineTrigger =
	| { cron: string }
	| { webhook: { path: string; secret_env: string } }
	| { manual: { params_schema?: unknown } }
	| { event: { source: string; type?: string; filter?: string } };

/** The parsed V1 routine spec. Source-of-truth lives in routines.spec_yaml. */
export interface RoutineSpec {
	name: string;
	description?: string;
	trigger: RoutineTrigger[];
	concurrency?: RoutineConcurrency;
	timezone?: string;
	budget?: RoutineBudget;
	/** Declared cross-run state keys (informational; runtime can write any key via set_state). */
	state?: { declared_keys?: string[] };
	tags?: string[];
	steps: RoutineStep[];
	/**
	 * OPTIONAL canvas-mode metadata: per-step node positions plus the edge graph
	 * between them. Carried inline in spec_yaml so canvas mode is fully
	 * round-trippable without a separate persistence layer. The V1 runtime engine
	 * ignores `layout` entirely; the visual builder uses it to restore the graph.
	 */
	layout?: RoutineLayout;
}

/** Single node entry in a {@link RoutineLayout}. Keyed by the corresponding step id. */
export interface RoutineLayoutNode {
	x: number;
	y: number;
	/** If true, the canvas renders the node in compact form (id + type only). */
	collapsed?: boolean;
}

/**
 * Edge semantics:
 * - `success` (default): sequential edge, no compilation effect.
 * - `error`: reserved; future on_failure routing.
 * - `true` / `false`: branches leaving an `if`-flavored node — compile to `when:` gates on the target.
 * - `manual`: hand-drawn dependency edge that does not auto-compile.
 */
export type RoutineLayoutEdgeKind = "success" | "error" | "true" | "false" | "manual";

/** Directed edge between two step nodes on the canvas. */
export interface RoutineLayoutEdge {
	from: string;
	to: string;
	kind?: RoutineLayoutEdgeKind;
	label?: string;
}

/**
 * Canvas-mode metadata for a routine. Optional everywhere; routines authored
 * in form/spec mode never need a `layout` block. When present, `version` must
 * be `1` (bumped only on breaking layout-format changes).
 */
export interface RoutineLayout {
	version: 1;
	nodes?: Record<string, RoutineLayoutNode>;
	edges?: RoutineLayoutEdge[];
}

export type RoutineStepStatus =
	| "pending"
	| "running"
	| "success"
	| "skipped"
	| "failed"
	| "aborted";

/** Per-step execution record. One row in routine_step_runs per step per run attempt. */
export interface RoutineStepRun {
	id: string;
	runId: string;
	stepId: string;
	stepIndex: number;
	stepType: RoutineStep["type"];
	startedAt: string;
	endedAt?: string;
	status: RoutineStepStatus;
	stdoutExcerpt: string;
	stderrExcerpt: string;
	/** JSON-serialized structured output captured to the context for downstream steps. */
	outputJson?: string;
	error?: string;
	model?: string;
	llmTokensIn?: number;
	llmTokensOut?: number;
	llmCostMicros?: number;
	durationMs?: number;
	/** Retry attempt number; 1 for first attempt. */
	attempt: number;
}

export interface ListRoutineStepRunsResponse {
	steps: RoutineStepRun[];
}
export interface ListRoutinesResponse {
	routines: Routine[];
}

export interface ListRoutineRunsResponse {
	runs: RoutineRun[];
}

/**
 * `GET /api/routines/:id/webhook`: how the routine's webhook authenticates
 * deliveries. Never carries the secret or its hash.
 */
export interface RoutineWebhookStatus {
	path: string;
	/**
	 * The bare secret is accepted as `X-Routine-Signature` (deprecated). Set on
	 * registrations made before signed deliveries; cleared by rotation or
	 * `PATCH /api/routines/:id/webhook { acceptBareSecret: false }`. Once
	 * cleared it cannot be set again (`acceptBareSecret: true` answers 409).
	 */
	acceptsBareSecret: boolean;
	/**
	 * The deck holds the secret and can verify signed deliveries. False only
	 * for a pre-upgrade registration that has not yet received its bare
	 * secret; rotating the secret sets it.
	 */
	signingKeyStored: boolean;
	createdAt: string;
	lastUsedAt: string | null;
	/** Last delivery authenticated by the bare secret. */
	lastBareSecretAt: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slash commands (discovered from ~/.omp/agent/commands/ + project overrides)
// ─────────────────────────────────────────────────────────────────────────────

export type SlashCommandScope = "user" | "project" | "builtin" | "deck";

export interface SlashSubcommand {
	name: string;
	description: string;
	usage?: string;
}

export interface SlashCommand {
	name: string; // basename without .md, or "<builtin>" / "<builtin> <subcommand>"
	scope: SlashCommandScope;
	description?: string;
	argumentHint?: string;
	/** Builtin parents carry their full subcommand inventory for richer pickers. */
	subcommands?: SlashSubcommand[];
}

export interface ListSlashCommandsResponse {
	commands: SlashCommand[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem path completion (composer `@filepath` mentions)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single match entry from the path-completion endpoint. Server returns paths
 * *relative to the queried `cwd`* so the composer can insert them verbatim
 * without re-resolving against the workspace root.
 */
export interface FilePathMatch {
	/** Path relative to the queried cwd, using forward slashes. */
	path: string;
	/** Basename, surfaced for emphasis rendering in the picker. */
	name: string;
	/** True if the entry is a directory — picker can render a trailing slash. */
	isDir: boolean;
}

export interface ListFilePathsResponse {
	matches: FilePathMatch[];
	/** `true` when the underlying file list was served from a cached snapshot. */
	cached: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth providers / OAuth login flow (driven from Settings → Providers)
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderAuthState = "oauth" | "api-key" | "unconfigured";

export interface ProviderInfo {
	id: string;
	name: string;
	state: ProviderAuthState;
	/** Number of credentials stored for the provider (1 typical; >1 for round-robin). */
	count: number;
}

export interface ListProvidersResponse {
	providers: ProviderInfo[];
}

/**
 * `POST /api/auth/oauth/:provider/start` response. The deck blocks the
 * response until the SDK fires `onAuth`, so by the time the client sees
 * this it has a real consent URL to open. WS frames keyed by `flowId`
 * deliver subsequent state transitions.
 */
export interface StartOAuthResponse {
	flowId: string;
	url: string;
	instructions?: string;
}

/** Client → deck: paste the redirect URL or raw `code` from the browser. */
export interface OAuthManualCodeRequest {
	code: string;
}

/** Client → deck: reply to a mid-flow `onPrompt` request from the SDK. */
export interface OAuthPromptReplyRequest {
	promptId: string;
	answer: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP servers (`~/.omp/agent/mcp.json`, `<project>/.omp/mcp.json`)
// ─────────────────────────────────────────────────────────────────────────────

/** A scope the deck can write: NeoPi's user and project `mcp.json`. */
export type McpServerScope = "user" | "project";
export type McpTransport = "stdio" | "http" | "sse";

/**
 * One env variable or HTTP header the config file defines. Values never leave
 * the server — any of them can be a credential — so a client sees the name and
 * whether a value is stored, and keeps it by sending `value: null`.
 */
export interface McpKeyRef {
	key: string;
	/** The config file stores a non-empty value for this key. */
	set: boolean;
}

/** An env/header pair a write submits; `value: null` keeps whatever the config file already holds for that key. */
export interface McpKeyValueInput {
	key: string;
	value: string | null;
}

/**
 * One command argument as the client may show it. An argument containing a
 * URL is hidden whole; the value after a `--api-key`-shaped flag, or the right
 * side of `--api-key=…`, is redacted with `display` keeping only the flag.
 * Other arguments are masked by that heuristic only and shown as stored.
 */
export interface McpArg {
	display: string;
	redacted: boolean;
}

/**
 * One argument a write submits: literal text, or `{keepIndex}` to keep the
 * stored argument at that position, which is how a redacted one survives an
 * edit (and stays correct when the list is reordered).
 */
export type McpArgInput = string | { keepIndex: number };

/** Why a discovered server does not run. */
export type McpDisabledReason =
	/** In the user `mcp.json` `disabledServers` denylist. */
	| "denylisted"
	/** Its own config entry sets `enabled: false`. */
	| "config-flag"
	/** Legacy `mcp:<name>` entry in NeoPi's `disabledExtensions` setting. */
	| "extension-disabled"
	/** Its discovery provider is switched off. */
	| "provider-disabled"
	/** A foreign tool's `~/` config that NeoPi loads only when opted in. */
	| "user-opt-in"
	/** A higher-priority source defines the same server name. */
	| "shadowed";

/** One discovered MCP server, from any source NeoPi reads. */
export interface McpServerRow {
	name: string;
	transport: McpTransport;
	command?: string;
	args?: McpArg[];
	/** Working directory for a stdio server. */
	cwd?: string;
	/**
	 * The scheme only (`https://••••••`): host, path, query, fragment and
	 * userinfo can each be a credential, so none is sent. Keep the stored URL
	 * by sending `url: null`; a typed URL replaces it.
	 */
	url?: string;
	/** Always true when `url` is present: it is not the stored URL. */
	urlRedacted?: boolean;
	env: McpKeyRef[];
	headers: McpKeyRef[];
	timeout?: number;
	/** Absolute path of the file that defines this server. */
	sourcePath: string;
	/** Source scope as NeoPi reports it; `native` is a built-in definition with no user file. */
	level: "user" | "project" | "native";
	/** Discovery provider id (`native`, `mcp-json`, `claude`, `codex`, …) and its display name. */
	provider: string;
	providerName: string;
	/** The deck may rewrite this entry: it lives in a file NeoPi's own writer owns. */
	editable: boolean;
	/** Scope the editor writes for an editable row. */
	scope?: McpServerScope;
	/**
	 * Opaque revision of the stored entry (a keyed MAC, so it reveals nothing
	 * about the values). Present on editable rows; an update or removal must
	 * echo it and gets 409 when the entry changed since it was listed.
	 */
	revision?: string;
	state: "enabled" | "disabled" | "shadowed";
	disabledReason?: McpDisabledReason;
	/** Named in the user `enabledServers` allowlist, which overrides a non-writable source's `enabled: false`. */
	forceEnabled: boolean;
}

export interface McpServersResponse {
	/** Workspace whose project scope is listed. */
	cwd: string;
	userConfigPath: string;
	projectConfigPath: string;
	/** NeoPi's `mcp.enableProjectConfig`; false means new chats ignore the project file. */
	projectConfigEnabled: boolean;
	servers: McpServerRow[];
	/** Discovery warnings (unreadable or malformed sources), without file contents. */
	warnings: string[];
}

/**
 * The config file a mutation targets. `scope` picks NeoPi's user or project
 * `mcp.json`; `sourcePath` (a row's own `sourcePath`) keeps an edit in the file
 * that already defines the server, and is ignored unless NeoPi's writer owns it.
 */
export interface McpServerTargetRequest {
	scope: McpServerScope;
	sourcePath?: string;
}

/**
 * Server definition to write. Enabled state is not part of it: that runs
 * through the enable endpoint, which also clears NeoPi's deny/allow lists.
 */
export interface McpServerWriteRequest extends McpServerTargetRequest {
	transport: McpTransport;
	/** stdio only. */
	command?: string;
	/** Omitted keeps the stored arguments; `{keepIndex}` keeps one of them. */
	args?: McpArgInput[];
	cwd?: string;
	/** http and sse only; null keeps the stored URL, credentials included. */
	url?: string | null;
	env?: McpKeyValueInput[];
	headers?: McpKeyValueInput[];
	/** Connection timeout in ms; null removes it. */
	timeout?: number | null;
}

export interface McpServerCreateRequest extends McpServerWriteRequest {
	name: string;
}

/** Replace an existing entry; `revision` is the one its row was listed with. */
export interface McpServerUpdateRequest extends McpServerWriteRequest {
	revision: string;
}

/** Remove an existing entry; `revision` is the one its row was listed with. */
export interface McpServerDeleteRequest extends McpServerTargetRequest {
	revision: string;
}

export interface McpServerEnabledRequest extends McpServerTargetRequest {
	enabled: boolean;
}

/** What one live chat's MCP runtime did with the change. */
export interface McpLiveApply {
	sessionId: string;
	cwd: string;
	/**
	 * `applied`: the chat's MCP runtime reconnected or dropped the server and its tools were rebound.
	 * `no-mcp-runtime`: the chat runs without MCP (per-chat server selection excluded everything).
	 * `failed`: the reconcile threw; the deck server log has the details.
	 */
	outcome: "applied" | "no-mcp-runtime" | "failed";
	/** Connection state after the apply, when the chat has an MCP runtime. */
	status?: "connected" | "connecting" | "disconnected";
}

export interface McpServerMutationResponse {
	/** File the write landed in. */
	path: string;
	/** The server after the write; null when it was removed. */
	server: McpServerRow | null;
	/** Truthful statement of how far this change reached, live chats included. */
	applyNote: string;
	live: McpLiveApply[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Integrations: the MCP servers and tools a routine `mcp` step can call
// ─────────────────────────────────────────────────────────────────────────────

/** One tool a server advertised in `tools/list`. */
export interface McpIntegrationTool {
	name: string;
	title?: string;
	description?: string;
	/** The JSON Schema an `mcp` step's `args` is validated against. */
	inputSchema: Record<string, unknown>;
}

/**
 * One enabled server, connected once for this listing and closed again. A
 * failure carries NeoPi's reason with every config credential scrubbed out.
 */
export interface McpIntegrationServer {
	name: string;
	transport: McpTransport;
	/** The config file that defines it, and its scope as NeoPi reports it. */
	sourcePath?: string;
	level?: "user" | "project" | "native";
	providerName?: string;
	status: "connected" | "failed";
	error?: string;
	/** The server's own name and version from `initialize`. */
	serverInfo?: { name: string; version: string };
	tools: McpIntegrationTool[];
}

export interface McpIntegrationsResponse {
	/** Workspace whose servers were discovered (the deck's default cwd). */
	cwd: string;
	checkedAt: string;
	servers: McpIntegrationServer[];
}
