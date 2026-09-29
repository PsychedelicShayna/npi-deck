import { Hono } from "hono";
import { statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	EnvEntry,
	ListEnvSettingsResponse,
	NotificationSettingsResponse,
	PatchEnvSettingsRequest,
	PatchEnvSettingsResponse,
	RestartServerResponse,
	RevealEnvValueResponse,
	UpdateNotificationSettingsRequest,
	UpdateWorkspaceSettingsRequest,
	WorkspaceSettingsResponse,
} from "@npi-deck/protocol";

import type { Config } from "./config.ts";
import { parseInt10, splitList } from "./config.ts";
import {
	ENV_SCHEMA,
	ENV_SCHEMA_BY_KEY,
	type EnvSchemaEntry,
	resolveEnvEntry,
	resolveEnvSetting,
	validateEnvValue,
} from "./env-schema.ts";
import {
	appendEnvAudit,
	commitManagedEnvUpdates,
	getDataDir,
	getManagedEnvPath,
} from "./env-store.ts";
import { setLogLevel } from "./log.ts";
import { NOTIFICATIONS_DISABLED_ENV, NOTIFICATION_SOURCES, isNotificationKind, parseDisabledKinds } from "./notifications/kinds.ts";
import { deriveLabel } from "./workspace-label.ts";
import { isLoopbackRequest, type RequestPeerEnv } from "./request-peer.ts";
import type { AgentBridge } from "./bridge/types.ts";

const WORKSPACES_ENV = "NPI_DECK_WORKSPACES";

export function buildSettingsRouter(
	bridge: AgentBridge,
	config: Config,
	opts: { restartServer?: () => RestartServerResponse } = {},
): Hono<RequestPeerEnv> {
	const app = new Hono<RequestPeerEnv>();

	app.get("/settings/env", (c) => c.json(buildEnvResponse()));

	app.get("/settings/env/:key", async (c) => {
		if (c.req.query("reveal") !== "1") return c.json({ error: "reveal=1 required" }, 400);
		if (!isLoopbackRequest(c.req.raw, c.env)) return c.json({ error: "secret reveal requires loopback" }, 403);
		const key = c.req.param("key");
		const entry = ENV_SCHEMA_BY_KEY.get(key);
		if (!entry) return c.json({ error: "unknown env key" }, 404);
		const current = resolveEnvEntry(entry);
		await appendEnvAudit("reveal", [key]);
		const body: RevealEnvValueResponse = {
			key,
			value: current.value ?? "",
			masked: maskValue(current.value ?? "", entry.sensitive),
			isSet: isNonEmpty(current.value),
			source: current.source,
		};
		return c.json(body);
	});

	app.patch("/settings/env", async (c) => {
		let body: PatchEnvSettingsRequest;
		try {
			body = (await c.req.json()) as PatchEnvSettingsRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const updates = body.updates ?? {};
		const clean: Record<string, string | null> = {};
		for (const [key, value] of Object.entries(updates)) {
			const entry = ENV_SCHEMA_BY_KEY.get(key);
			if (!entry) return c.json({ error: `unknown env key: ${key}` }, 400);
			if (value !== null && typeof value !== "string") {
				return c.json({ error: `invalid env value for ${key}` }, 400);
			}
			if (value !== null) {
				const err = validateEnvValue(entry, value);
				if (err) return c.json({ error: `${key}: ${err}` }, 400);
			}
			clean[key] = value;
		}

		const appliedHot = await commitEnvUpdates(clean, bridge, config);
		const response = buildEnvResponse() as PatchEnvSettingsResponse;
		response.appliedHot = appliedHot;
		return c.json(response);
	});

	app.get("/settings/workspaces", (c) => c.json(buildWorkspacesResponse(config)));

	app.put("/settings/workspaces", async (c) => {
		let body: UpdateWorkspaceSettingsRequest;
		try {
			body = (await c.req.json()) as UpdateWorkspaceSettingsRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!Array.isArray(body.pinned) || body.pinned.some((p) => typeof p !== "string")) {
			return c.json({ error: "pinned must be an array of paths" }, 400);
		}
		if (!resolveEnvSetting(WORKSPACES_ENV).setting.editable) {
			return c.json({ error: `${WORKSPACES_ENV} is set by the launching shell; unset it there to manage workspaces here` }, 409);
		}
		const pinned: string[] = [];
		for (const raw of body.pinned) {
			const expanded = raw.trim().replace(/^~(?=$|\/)/, os.homedir());
			if (!path.isAbsolute(expanded)) return c.json({ error: `${raw}: use an absolute path` }, 400);
			const cwd = path.resolve(expanded);
			if (cwd.includes(",")) return c.json({ error: `${raw}: a workspace path cannot contain a comma` }, 400);
			if (!isDirectory(cwd)) return c.json({ error: `${raw}: no directory at this path` }, 400);
			if (!pinned.includes(cwd)) pinned.push(cwd);
		}
		await commitEnvUpdates({ [WORKSPACES_ENV]: pinned.length > 0 ? pinned.join(",") : null }, bridge, config);
		return c.json(buildWorkspacesResponse(config));
	});

	app.get("/settings/notifications", (c) => c.json(buildNotificationsResponse()));

	app.put("/settings/notifications", async (c) => {
		let body: UpdateNotificationSettingsRequest;
		try {
			body = (await c.req.json()) as UpdateNotificationSettingsRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!Array.isArray(body.disabled)) return c.json({ error: "disabled must be an array" }, 400);
		const unknown = body.disabled.filter((kind) => typeof kind !== "string" || !isNotificationKind(kind));
		if (unknown.length > 0) return c.json({ error: `unknown notification source: ${unknown.join(", ")}` }, 400);
		if (!resolveEnvSetting(NOTIFICATIONS_DISABLED_ENV).setting.editable) {
			return c.json({ error: `${NOTIFICATIONS_DISABLED_ENV} is set by the launching shell; unset it there to manage notifications here` }, 409);
		}
		const disabled = NOTIFICATION_SOURCES.map((s) => s.kind).filter((kind) => body.disabled.includes(kind));
		await commitEnvUpdates({ [NOTIFICATIONS_DISABLED_ENV]: disabled.length > 0 ? disabled.join(",") : null }, bridge, config);
		return c.json(buildNotificationsResponse());
	});

	app.post("/server/restart", (c) => {
		if (!isLoopbackRequest(c.req.raw, c.env)) return c.json({ error: "restart requires loopback" }, 403);
		const resp = opts.restartServer?.() ?? { ok: false, message: "Restart is unavailable" };
		return c.json(resp);
	});

	return app;
}

/** Write managed env keys, audit the change and apply what can change without a restart. */
async function commitEnvUpdates(
	updates: Record<string, string | null>,
	bridge: AgentBridge,
	config: Config,
): Promise<string[]> {
	await commitManagedEnvUpdates(updates);
	const set = Object.keys(updates).filter((key) => updates[key] !== null);
	const unset = Object.keys(updates).filter((key) => updates[key] === null);
	if (set.length > 0) await appendEnvAudit("set", set);
	if (unset.length > 0) await appendEnvAudit("unset", unset);
	return applyHotUpdates(updates, bridge, config);
}

function isDirectory(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function buildWorkspacesResponse(config: Config): WorkspaceSettingsResponse {
	const { setting } = resolveEnvSetting(WORKSPACES_ENV);
	return {
		defaultCwd: config.defaultCwd,
		pinned: config.extraWorkspaces.map((cwd) => ({ cwd, label: deriveLabel(cwd), exists: isDirectory(cwd) })),
		setting,
	};
}

function buildNotificationsResponse(): NotificationSettingsResponse {
	const { value, setting } = resolveEnvSetting(NOTIFICATIONS_DISABLED_ENV);
	const disabled = parseDisabledKinds(value);
	return {
		sources: NOTIFICATION_SOURCES.map((source) => ({ ...source, enabled: !disabled.has(source.kind) })),
		setting,
	};
}

function buildEnvResponse(): ListEnvSettingsResponse {
	const entries = ENV_SCHEMA.map((entry) => toResponseEntry(entry));
	return {
		entries,
		envFilePath: getManagedEnvPath(),
		dataDir: getDataDir(),
		restartRequired: entries.some((entry) => entry.restartTarget === "server" && entry.source === "env-file"),
	};
}

function toResponseEntry(entry: EnvSchemaEntry): EnvEntry {
	const current = resolveEnvEntry(entry);
	return {
		key: entry.key,
		masked: maskValue(current.value ?? "", entry.sensitive),
		isSet: isNonEmpty(current.value),
		source: current.source,
		...(entry.defaultValue !== undefined ? { defaultValue: entry.defaultValue } : {}),
		valueType: entry.valueType,
		sensitive: entry.sensitive,
		restartRequired: entry.restartRequired,
		hotApply: entry.hotApply,
		description: entry.description,
		...(entry.options ? { options: entry.options } : {}),
		...(entry.restartRequired ? { restartTarget: entry.restartTarget ?? "server" } : {}),
	};
}

function isNonEmpty(value: string | undefined): boolean {
	return value !== undefined && value !== "";
}

function maskValue(value: string, sensitive: boolean): string {
	if (!value) return "unset";
	if (!sensitive) return value;
	const tail = value.slice(-4);
	return tail ? `••••••••${tail}` : "••••••••";
}

function applyHotUpdates(
	updates: Record<string, string | null>,
	bridge: AgentBridge,
	config: Config,
): string[] {
	const applied: string[] = [];
	const effective = new Map(ENV_SCHEMA.map((entry) => [entry.key, resolveEnvEntry(entry).value]));

	if ("LOG_LEVEL" in updates) {
		if (setLogLevel(effective.get("LOG_LEVEL") ?? "info")) applied.push("LOG_LEVEL");
	}
	if ("NPI_DECK_IDLE_TIMEOUT_MS" in updates) {
		const next = parseInt10(effective.get("NPI_DECK_IDLE_TIMEOUT_MS"), 5 * 60_000);
		config.idleTimeoutMs = next;
		bridge.applyEnvUpdate?.({ idleTimeoutMs: next });
		applied.push("NPI_DECK_IDLE_TIMEOUT_MS");
	}
	if ("NPI_DECK_DEFAULT_CWD" in updates) {
		const next = effective.get("NPI_DECK_DEFAULT_CWD")?.trim() || os.homedir();
		config.defaultCwd = path.resolve(next);
		applied.push("NPI_DECK_DEFAULT_CWD");
	}
	if ("NPI_DECK_WORKSPACES" in updates) {
		config.extraWorkspaces = splitList(effective.get("NPI_DECK_WORKSPACES")).map((p) => path.resolve(p));
		applied.push("NPI_DECK_WORKSPACES");
	}
	return applied;
}
