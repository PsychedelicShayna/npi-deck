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
} from "@npi-deck/protocol";

import { feature, sdk } from "./backend/runtime.ts";
import type { AgentBridge } from "./bridge/types.ts";
import type { Config } from "./config.ts";
import { logger } from "./log.ts";

const log = logger("routes:npi-config");
const OTHER_TAB = "other";
const errorText = (err: unknown) => err instanceof Error ? err.message : String(err);

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
 * Converts a request value with the setting's own rules. Text goes through its
 * parser (booleans accept on/off, arrays and records take JSON, enums check
 * membership); string settings are JSON-quoted first so the exact text survives
 * the parser's trim. Typed JSON values reach `set`, which normalizes them and
 * runs the setting's validate and type checks.
 */
function requestValue(setting: AnySetting, value: unknown): unknown {
	if (typeof value !== "string") return value;
	return setting.parse(setting.type === "string" ? JSON.stringify(value) : value);
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
				configPath: path.join(sdk().getAgentDir(), "config.yml"),
				tabs: tabsFor(described),
				settings: described,
			};
			return c.json(body);
		} catch (err) {
			log.warn("read NeoPi config failed", err);
			return c.json({ error: errorText(err) }, 500);
		}
	});

	app.patch("/npi-config", async c => {
		let body: NpiConfigPatchRequest;
		try { body = await c.req.json() as NpiConfigPatchRequest; }
		catch { return c.json({ error: "JSON body required" }, 400); }
		if (!body || typeof body.id !== "string" || (body.unset !== true && body.value === undefined))
			return c.json({ error: "id and either value or unset: true required" }, 400);
		try {
			return c.json(await serializeSave(async (): Promise<NpiConfigPatchResponse> => {
				const setting = lookup(body.id);
				if (!setting) throw new RequestError(`Unknown setting: ${body.id}`, 404);
				const locked = envLock(setting);
				if (locked) throw new RequestError(locked, 409);
				const settings = await sdk().Settings.loadIsolated({ cwd: config.defaultCwd, agentDir: sdk().getAgentDir() });
				try {
					if (body.unset === true) setting.unset(settings);
					else setting.set(settings, requestValue(setting, body.value));
				} catch (err) {
					throw new RequestError(errorText(err), 400);
				}
				await settings.flush();
				const live = await bridge.reloadLiveSettings();
				const fresh = await load();
				const described = describe(setting, fresh, fresh.getGlobalSettings());
				return {
					setting: described,
					live: live.map(entry => ({
						sessionId: entry.sessionId,
						cwd: entry.cwd,
						provenance: setting.provenance(entry.settings),
						effectiveValue: described.secret ? null : setting.get(entry.settings) ?? null,
						...(entry.error ? { error: entry.error } : {}),
					})),
				};
			}));
		} catch (err) {
			if (err instanceof RequestError) return c.json({ error: err.message }, err.status);
			log.warn(`save NeoPi setting ${body.id} failed`, err);
			return c.json({ error: errorText(err) }, 500);
		}
	});

	return app;
}
