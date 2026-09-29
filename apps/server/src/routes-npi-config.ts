import { existsSync } from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import type { AnySetting } from "@oh-my-pi/pi-coding-agent/config/registry";
import type {
	NpiConfigPatchRequest,
	NpiConfigPatchResponse,
	NpiConfigResponse,
	NpiConfigSetting,
	NpiConfigTab,
	NpiModelRole,
	NpiModelRolePool,
	NpiModelRolesResponse,
} from "@npi-deck/protocol";

import { getDeckModelRegistry } from "./auth-singleton.ts";
import type { FeatureExports } from "./backend/manifest.ts";
import { feature, hasFeature, sdk } from "./backend/runtime.ts";
import type { AgentBridge } from "./bridge/types.ts";
import type { Config } from "./config.ts";
import { logger } from "./log.ts";

const log = logger("routes:npi-config");
const OTHER_TAB = "other";
const errorText = (err: unknown) => err instanceof Error ? err.message : String(err);
// NeoPi's loader embeds parser errors, which quote the offending config.yml
// line (possibly a credential). Clients get this; the log keeps the detail.
const LOAD_FAILED = "NeoPi could not load or save its settings; the deck server log has the details.";
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
/** Record order is precedence in NeoPi, so equality is order-sensitive. */
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type RawLayer = ReturnType<Settings["getGlobalSettings"]>;

/** Panel order first, then anything registered outside NeoPi's domain list, so no setting is omitted. */
function registeredSettings(): AnySetting[] {
	const api = feature("npi-config");
	const ordered = api.orderedSettings();
	const listed = new Set(ordered);
	return [...ordered, ...api.allSettings().filter(setting => !listed.has(setting))];
}

function lookup(id: string): AnySetting | undefined {
	return feature("npi-config").allSettings().find(setting => setting.id === id);
}

/** The key's value in one raw settings layer; a YAML `null` is NeoPi's unset tombstone. */
function layerValue(layer: RawLayer, segments: readonly string[]): unknown {
	let node: unknown = layer;
	for (const key of segments) {
		if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	return node ?? undefined;
}

/** An active environment variable that overrides every settings layer, or undefined. */
function envLock(setting: AnySetting): string | undefined {
	if (!setting.envName || setting.envFallback !== false || setting.envValue() === undefined) return undefined;
	return `$${setting.envName} overrides this setting while it is set. Remove it from the deck's Env settings or the launching environment to edit it here.`;
}

/** The global file NeoPi reads and saves: the first existing of its main config names (config.yml, then config.yaml). */
function globalConfigFile(): string {
	const agentDir = sdk().getAgentDir();
	const files = feature("npi-config").MAIN_CONFIG_FILENAMES.map(name => path.join(agentDir, name));
	return files.find(file => existsSync(file)) ?? files[0]!;
}

function describe(setting: AnySetting, settings: Settings, globalLayer: RawLayer): NpiConfigSetting {
	const ui = setting.ui;
	const definition = setting.definition;
	const secret = setting.isCredential;
	// JSON has no undefined; secrets never leave the server.
	const shown = (value: unknown) => secret || value === undefined ? null : value;
	const raw = layerValue(globalLayer, setting.segments);
	const invalidGlobalValue = raw !== undefined && !setting.accepts(raw);
	const lockedReason = envLock(setting);
	const result: NpiConfigSetting = {
		id: setting.id,
		type: setting.type,
		tab: ui?.tab ?? OTHER_TAB,
		group: ui ? ui.group ?? "General" : setting.segments.length > 1 ? setting.segments[0]! : "General",
		label: ui?.label ?? setting.id,
		description: ui?.description ?? "",
		defaultValue: shown(setting.default),
		value: shown(raw !== undefined && !invalidGlobalValue ? raw : setting.default),
		effectiveValue: shown(setting.get(settings)),
		provenance: setting.provenance(settings),
		inGlobalConfig: raw !== undefined,
		invalidGlobalValue,
		secret,
		configured: setting.isConfigured(settings),
	};
	if (ui?.warning) result.warning = ui.warning;
	if (setting.enumValues) result.enumValues = [...setting.enumValues];
	if (Array.isArray(ui?.options)) {
		result.options = ui.options.map(option => ({
			value: option.value,
			label: option.label,
			...(option.description ? { description: option.description } : {}),
		}));
	} else if (ui?.options === "runtime") result.runtimeOptions = true;
	if (definition.type === "array" && definition.items) result.items = [...definition.items.values];
	if (ui?.ordered) result.ordered = true;
	if (definition.pathScoped) result.pathScoped = true;
	if (setting.envName) result.env = { name: setting.envName, fallback: setting.envFallback !== false, active: setting.envValue() !== undefined };
	// Entry and field names only, so write-only credential records can be edited per field.
	if (secret && definition.type === "record" && isRecord(raw))
		result.secretEntries = Object.entries(raw).map(([key, entry]) => ({ key, fields: isRecord(entry) ? Object.keys(entry) : [] }));
	if (lockedReason) result.lockedReason = lockedReason;
	return result;
}

/** Registry tabs in panel order with their declared group order; groups a tab lacks are appended, never dropped. */
function tabsFor(settings: readonly NpiConfigSetting[]): NpiConfigTab[] {
	const api = feature("npi-config");
	const used = new Map<string, string[]>();
	for (const setting of settings) {
		const groups = used.get(setting.tab) ?? [];
		if (!groups.includes(setting.group)) groups.push(setting.group);
		used.set(setting.tab, groups);
	}
	const labels = api.TAB_METADATA as Record<string, { label: string }>;
	const declared = api.TAB_GROUPS as Record<string, readonly string[]>;
	const order = [...api.SETTING_TABS, ...[...used.keys()].filter(tab => tab !== OTHER_TAB && !(api.SETTING_TABS as string[]).includes(tab))];
	if (used.has(OTHER_TAB)) order.push(OTHER_TAB);
	return order.flatMap(id => {
		const groups = used.get(id);
		if (!groups) return [];
		const known = (declared[id] ?? []).filter(group => groups.includes(group));
		const extra = groups.filter(group => !known.includes(group));
		return [{
			id,
			label: id === OTHER_TAB ? "Other" : labels[id]?.label ?? id,
			groups: id === OTHER_TAB ? extra.sort((a, b) => a.localeCompare(b)) : [...known, ...extra],
		}];
	});
}

/**
 * The value a request writes, converted with the setting's own rules. Text goes
 * through its parser (booleans accept on/off, arrays and records take JSON,
 * enums check membership); string settings are JSON-quoted first so the exact
 * text survives the parser's trim. Typed JSON values reach `set`, which
 * normalizes them and runs the setting's validate and type checks. `entries`
 * edits single keys of the record in config.yml, so a write-only credential
 * record is edited without resending what the browser never sees: null deletes
 * an entry, an object merges its fields into the existing entry (a null field
 * deletes that field), and any other value replaces the entry.
 */
function requestValue(setting: AnySetting, body: NpiConfigPatchRequest, globalLayer: RawLayer): unknown {
	if (body.entries !== undefined) {
		const current = layerValue(globalLayer, setting.segments);
		const next: Record<string, unknown> = isRecord(current) ? { ...current } : {};
		for (const [key, value] of Object.entries(body.entries)) {
			if (value === null) delete next[key];
			else if (isRecord(value)) {
				const existing = next[key];
				const fields: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
				for (const [field, fieldValue] of Object.entries(value)) {
					if (fieldValue === null) delete fields[field];
					else fields[field] = fieldValue;
				}
				next[key] = fields;
			} else next[key] = value;
		}
		return next;
	}
	if (typeof body.value !== "string") return body.value;
	return setting.parse(setting.type === "string" ? JSON.stringify(body.value) : body.value);
}

function requestShapeError(body: NpiConfigPatchRequest | null): string | undefined {
	if (!isRecord(body) || typeof body.id !== "string") return "id required";
	const modes = [body.value !== undefined, body.unset === true, body.entries !== undefined].filter(Boolean).length;
	if (modes !== 1) return "exactly one of value, unset: true or entries required";
	if (body.entries !== undefined && (!isRecord(body.entries) || Object.keys(body.entries).some(key => key.trim() === "")))
		return "entries must map non-empty keys to values, or null to delete";
	return undefined;
}

// One config.yml write at a time from this process; NeoPi's flush merges
// against the file on disk, so edits from the TUI in between are kept.
let saveQueue: Promise<void> = Promise.resolve();
function serializeSave<T>(run: () => Promise<T>): Promise<T> {
	const result = saveQueue.then(run);
	saveQueue = result.then(() => {}, () => {});
	return result;
}

class RequestError extends Error {
	constructor(message: string, readonly status: 400 | 404 | 409) {
		super(message);
	}
}

type RolesApi = FeatureExports<"model-roles">;
type Registry = Awaited<ReturnType<typeof getDeckModelRegistry>>;
type RoleCatalogSession = ConstructorParameters<RolesApi["RpcRoles"]>[0];
type RoleModel = Parameters<ReturnType<RolesApi["getRoleInfo"]>["accepts"]>[0];

// What NeoPi's role filters read of a mixture-of-agents model: it declares no
// kind (so it is a chat model) and no web-search capability. Mixtures register
// per workspace, so the shared registry may not hold any when this runs.
const MIXTURE_SHAPE = { api: "mixture", provider: "mixture", id: "", name: "" } as unknown as RoleModel;

/** A role's selector in one raw layer; NeoPi joins a list of selectors with commas. */
function roleValue(layer: RawLayer, role: string): string | null {
	const value = layerValue(layer, ["modelRoles", role]);
	if (typeof value === "string") return value;
	return Array.isArray(value) && value.every(entry => typeof entry === "string") ? value.join(",") : null;
}

/**
 * NeoPi's `get_roles` catalog for `settings`, with the per-role model pools.
 * The catalog needs a session only for its active role, which a settings view
 * has none of, so it gets an empty branch.
 */
function modelRoles(settings: Settings, registry: Registry): Pick<NpiModelRolesResponse, "roles" | "pools"> {
	const api = feature("model-roles");
	const session = { settings, modelRegistry: registry, sessionManager: { getBranch: () => [] }, sessionId: "" } as unknown as RoleCatalogSession;
	const globalLayer = settings.getGlobalSettings();
	const available = registry.getAvailable("all");
	const pools: NpiModelRolePool[] = [];
	// Roles judged by the same filter function share a pool.
	const poolFor = new Map<(model: RoleModel) => boolean, number>();
	const roles = new api.RpcRoles(session).list().roles.map((role): NpiModelRole => {
		const accepts = api.getRoleInfo(role.id, settings).accepts;
		let pool = poolFor.get(accepts);
		if (pool === undefined) {
			pool = pools.push({
				models: available.filter(model => accepts(model as RoleModel)).map(model => `${model.provider}/${model.id}`),
				mixtures: accepts(MIXTURE_SHAPE),
			}) - 1;
			poolFor.set(accepts, pool);
		}
		return {
			id: role.id,
			name: role.name,
			...(role.tag ? { tag: role.tag } : {}),
			section: role.section,
			builtin: role.source === "builtin",
			hidden: role.hidden,
			value: roleValue(globalLayer, role.id),
			effectiveValue: role.configured ?? null,
			provenance: settings.getModelRoleProvenance(role.id),
			patterns: role.patterns,
			...(role.resolved
				? {
						resolved: {
							provider: role.resolved.provider,
							modelId: role.resolved.modelId,
							...(role.resolved.thinkingLevel !== undefined ? { thinkingLevel: String(role.resolved.thinkingLevel) } : {}),
						},
					}
				: {}),
			pool,
		};
	});
	return { roles, pools };
}

export function buildNpiConfigRouter(bridge: AgentBridge, config: Config): Hono {
	const app = new Hono();
	const load = () => sdk().Settings.loadReadOnly({ cwd: config.defaultCwd, agentDir: sdk().getAgentDir() });

	app.get("/npi-config", async c => {
		try {
			const settings = await load();
			const globalLayer = settings.getGlobalSettings();
			const described = registeredSettings().map(setting => describe(setting, settings, globalLayer));
			const body: NpiConfigResponse = {
				cwd: config.defaultCwd,
				configPath: globalConfigFile(),
				tabs: tabsFor(described),
				settings: described,
			};
			return c.json(body);
		} catch (err) {
			log.warn("read NeoPi config failed", err);
			return c.json({ error: LOAD_FAILED }, 500);
		}
	});

	app.get("/npi-config/model-roles", async c => {
		if (!hasFeature("model-roles") || !hasFeature("npi-config"))
			return c.json({ error: "This NeoPi backend does not expose its model-role catalog; edit modelRoles under Settings → NeoPi." }, 501);
		try {
			const settings = await load();
			const setting = lookup("modelRoles");
			if (!setting) return c.json({ error: "This NeoPi backend does not register modelRoles." }, 501);
			const body: NpiModelRolesResponse = {
				cwd: config.defaultCwd,
				configPath: globalConfigFile(),
				setting: describe(setting, settings, settings.getGlobalSettings()),
				...modelRoles(settings, await getDeckModelRegistry()),
				thinkingLevels: [...feature("model-roles").CLI_THINKING_LEVELS],
			};
			return c.json(body);
		} catch (err) {
			log.warn("read NeoPi model roles failed", err);
			return c.json({ error: LOAD_FAILED }, 500);
		}
	});

	app.patch("/npi-config", async c => {
		let body: NpiConfigPatchRequest;
		try { body = await c.req.json() as NpiConfigPatchRequest; }
		catch { return c.json({ error: "JSON body required" }, 400); }
		const shapeError = requestShapeError(body);
		if (shapeError) return c.json({ error: shapeError }, 400);
		try {
			return c.json(await serializeSave(async (): Promise<NpiConfigPatchResponse> => {
				const setting = lookup(body.id);
				if (!setting) throw new RequestError(`Unknown setting: ${body.id}`, 404);
				const locked = envLock(setting);
				if (locked) throw new RequestError(locked, 409);
				if (body.entries !== undefined && setting.type !== "record") throw new RequestError(`${setting.id} is not a record; send value instead of entries`, 400);
				// A writable load moves a malformed config.yml aside; a read-only load
				// fails first instead, leaving the user's file where it is.
				await load();
				const settings = await sdk().Settings.loadIsolated({ cwd: config.defaultCwd, agentDir: sdk().getAgentDir() });
				try {
					if (body.unset === true) setting.unset(settings);
					else setting.set(settings, requestValue(setting, body, settings.getGlobalSettings()));
				} catch (err) {
					// Parser and type errors quote the submitted value; never echo a credential.
					throw new RequestError(setting.isCredential
						? `Invalid value for ${setting.id} (expected a ${setting.type}); it is not shown because this setting holds credentials.`
						: errorText(err), 400);
				}
				const intended = layerValue(settings.getGlobalSettings(), setting.segments);
				await settings.flush();
				const fresh = await load();
				// NeoPi skips a pending write when another process changed the same key
				// since it was read, and still resolves the flush.
				if (!sameValue(layerValue(fresh.getGlobalSettings(), setting.segments), intended))
					throw new RequestError(`${setting.id} changed in the config file while saving, so NeoPi kept that value. Reload and try again.`, 409);
				const live = await bridge.reloadLiveSettings();
				const described = describe(setting, fresh, fresh.getGlobalSettings());
				return {
					setting: described,
					live: live.map(entry => ({
						sessionId: entry.sessionId,
						cwd: entry.cwd,
						provenance: setting.provenance(entry.settings),
						effectiveValue: described.secret ? null : setting.get(entry.settings) ?? null,
						...(entry.failed ? { reloadFailed: true as const } : {}),
					})),
				};
			}));
		} catch (err) {
			if (err instanceof RequestError) return c.json({ error: err.message }, err.status);
			log.warn(`save NeoPi setting ${body.id} failed`, err);
			return c.json({ error: LOAD_FAILED }, 500);
		}
	});

	return app;
}
