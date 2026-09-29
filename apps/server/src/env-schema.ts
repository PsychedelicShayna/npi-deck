import type { EnvBackedSetting, EnvRestartTarget, EnvValueSource, EnvValueType } from "@npi-deck/protocol";

import { MANAGED_ENV_KEYS_LOADED, readManagedEnvFile } from "./env-store.ts";
import { NOTIFICATIONS_DISABLED_ENV, NOTIFICATION_SOURCES, isNotificationKind } from "./notifications/kinds.ts";

export interface EnvSchemaEntry {
	key: string;
	defaultValue?: string;
	valueType: EnvValueType;
	sensitive: boolean;
	restartRequired: boolean;
	hotApply: boolean;
	restartTarget?: EnvRestartTarget;
	description: string;
	options?: string[];
	/** Extra check beyond `valueType`; returns an error message. */
	validate?: (value: string) => string | undefined;
}

export const ENV_SCHEMA: EnvSchemaEntry[] = [
	{
		key: "NPI_DECK_HOST",
		defaultValue: "127.0.0.1",
		valueType: "string",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Backend bind host.",
	},
	{
		key: "NPI_DECK_PORT",
		defaultValue: "1701",
		valueType: "int",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Backend HTTP/WebSocket port.",
	},
	{
		key: "NPI_DECK_WEB_PORT",
		defaultValue: "5173",
		valueType: "int",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Vite dev server port.",
	},
	{
		key: "NPI_DECK_DEFAULT_CWD",
		valueType: "path",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Default cwd for new sessions.",
	},
	{
		key: "NPI_DECK_WORKSPACES",
		valueType: "string",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Comma-separated extra workspace roots.",
	},
	{
		key: NOTIFICATIONS_DISABLED_ENV,
		valueType: "string",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: `Comma-separated notification sources the server does not emit: ${NOTIFICATION_SOURCES.map((s) => s.kind).join(", ")}.`,
		validate: (value) => {
			const unknown = value.split(",").map((s) => s.trim()).filter((s) => s && !isNotificationKind(s));
			return unknown.length > 0 ? `Unknown notification source: ${unknown.join(", ")}` : undefined;
		},
	},
	{
		key: "NPI_DECK_STARTERS",
		valueType: "string",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description:
			"Comma-separated bundled starters to install into the NeoPi agent dir, as skills/<name> or extensions/<name>. Unset installs none. Settings → Starters installs on opt-in; edits made here install at the next launch.",
		validate: (value) => {
			const bad = value.split(",").map((s) => s.trim()).filter((s) => s && !/^(skills|extensions)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s));
			return bad.length > 0 ? `Expected skills/<name> or extensions/<name>, got: ${bad.join(", ")}` : undefined;
		},
	},
	{
		key: "NPI_DECK_IDLE_TIMEOUT_MS",
		defaultValue: "300000",
		valueType: "int",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Milliseconds before unsubscribed idle sessions are reaped. 0 disables reaping.",
	},
	{
		key: "NPI_DECK_WEB_DIST",
		valueType: "path",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Static web bundle directory for production serving.",
	},
	{
		key: "NPI_DECK_DB_PATH",
		valueType: "path",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "SQLite database path. Defaults to deck.db in the data dir (NPI_DECK_HOME or ~/.npi-deck).",
	},
	{
		key: "NPI_DECK_API_BASE",
		defaultValue: "http://127.0.0.1:1701",
		valueType: "string",
		sensitive: false,
		restartRequired: false,
		hotApply: false,
		description: "Loopback API base used by standalone bridge processes. If unset, bridges derive it from NPI_DECK_HOST and NPI_DECK_PORT.",
	},
	{
		key: "LOG_LEVEL",
		defaultValue: "info",
		valueType: "enum",
		options: ["debug", "info", "warn", "error"],
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Server log threshold.",
	},
	{
		key: "PI_NO_TITLE",
		valueType: "boolean",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Disable SDK automatic title generation when set truthy.",
	},
	{
		key: "OMP_MODEL",
		valueType: "string",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Default omp SDK model identifier.",
	},
	{
		key: "TELEGRAM_BOT_TOKEN",
		valueType: "string",
		sensitive: true,
		restartRequired: true,
		restartTarget: "telegram-bridge",
		hotApply: false,
		description: "Telegram bot token used by the standalone telegram bridge. Saving it does not start the bridge process.",
	},
	{
		key: "TELEGRAM_ALLOWED_USERS",
		valueType: "string",
		sensitive: false,
		restartRequired: true,
		restartTarget: "telegram-bridge",
		hotApply: false,
		description: "Comma-separated numeric Telegram user IDs allowed to DM this bot. Required; usernames are not accepted.",
	},
	{
		key: "TELEGRAM_BRIDGE_DB_PATH",
		valueType: "path",
		sensitive: false,
		restartRequired: true,
		restartTarget: "telegram-bridge",
		hotApply: false,
		description: "Optional SQLite path for Telegram chat-to-session mappings. Defaults to the deck data directory.",
	},
	...[
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"OPENROUTER_API_KEY",
		"GROQ_API_KEY",
		"GOOGLE_API_KEY",
		"XAI_API_KEY",
	].map((key): EnvSchemaEntry => ({
		key,
		valueType: "string",
		sensitive: true,
		restartRequired: true,
		hotApply: false,
		description: "Provider API key used by the omp SDK. Replace only; never revealed in list responses.",
	})),
	{
		key: "NPI_DECK_MAINTENANCE_GATE_DISABLED",
		valueType: "boolean",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description:
			"Disable the maintenance-gate extension for new sessions when truthy. Honored by the deck (skips setting NPI_DECK_ORG_ROOT) and by the installed extension itself.",
	},
	{
		key: "OMP_MAINTENANCE_GATE_MIN_OP_MSGS",
		defaultValue: "4",
		valueType: "int",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description:
			"Floor: operator messages since the last release event before the gate may fire again.",
	},
	{
		key: "OMP_MAINTENANCE_GATE_MIN_RELEASE_AGE_MS",
		defaultValue: "480000",
		valueType: "int",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Floor: wall-clock ms since the last release event before the gate may fire again.",
	},
	{
		key: "OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS",
		defaultValue: "1500000",
		valueType: "int",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Floor: wall-clock ms between consecutive fires (cross-session via disk state).",
	},
	{
		key: "NPI_DECK_ORG_ROOT",
		valueType: "path",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description:
			"Deck-session org root the maintenance-gate uses to anchor captures. While the maintenance-gate starter is opted in and not disabled, the server sets it to the kb root unless you set it.",
	},
];

export const ENV_SCHEMA_BY_KEY = new Map(ENV_SCHEMA.map((entry) => [entry.key, entry]));

export function validateEnvValue(entry: EnvSchemaEntry, value: string): string | undefined {
	if (entry.valueType === "int") {
		const n = Number.parseInt(value, 10);
		if (!Number.isFinite(n) || String(n) !== value.trim()) return "Expected an integer";
		if (n < 0) return "Expected a non-negative integer";
	}
	if (entry.valueType === "boolean") {
		const lower = value.trim().toLowerCase();
		if (!["", "0", "1", "true", "false", "yes", "no", "on", "off"].includes(lower)) {
			return "Expected on/off, true/false, 1/0, or empty";
		}
	}
	if (entry.valueType === "enum" && entry.options && !entry.options.includes(value.trim())) {
		return `Expected one of: ${entry.options.join(", ")}`;
	}
	return entry.validate?.(value);
}

/** True for the off spellings `validateEnvValue` accepts for a boolean: 0, false, no, off. */
export function isEnvFlagOff(value: string | undefined): boolean {
	return ["0", "false", "no", "off"].includes((value ?? "").trim().toLowerCase());
}

/**
 * Effective value of a schema key and where it came from. A value the
 * launching shell exported wins over the managed .env; a key the deck loaded
 * from (or wrote to) the .env reports `env-file`.
 */
export function resolveEnvEntry(entry: EnvSchemaEntry): { source: EnvValueSource; value?: string } {
	const file = readManagedEnvFile();
	const fileValue = file.values.get(entry.key);
	const processValue = process.env[entry.key];
	if (processValue !== undefined && !(MANAGED_ENV_KEYS_LOADED.has(entry.key) && processValue === fileValue)) {
		return { source: "process-env", value: processValue };
	}
	if (fileValue !== undefined) return { source: "env-file", value: fileValue };
	if (entry.defaultValue !== undefined) return { source: "default", value: entry.defaultValue };
	return { source: "unset" };
}

/** Resolve `key` for a Settings panel: its value, and whether saving through the managed .env can change it. */
export function resolveEnvSetting(key: string): { value?: string; setting: EnvBackedSetting } {
	const entry = ENV_SCHEMA_BY_KEY.get(key);
	if (!entry) throw new Error(`${key} is not in ENV_SCHEMA`);
	const { source, value } = resolveEnvEntry(entry);
	return { value, setting: { key, source, editable: source !== "process-env" } };
}
