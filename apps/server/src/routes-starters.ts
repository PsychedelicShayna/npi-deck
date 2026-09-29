/**
 * Starter routes
 *
 * Starters are the skills and extensions bundled with the deck. GET /starters
 * lists them with their installed state and the launch-time install switches;
 * PUT /starters/auto-install flips those switches. The maintenance gate, the
 * one starter extension with settings, projects its env-backed state (see
 * `maintenance-gate.ts`); its PUT writes the managed env file.
 */

import { Hono } from "hono";
import type {
	MaintenanceGateState,
	StartersResponse,
	UpdateMaintenanceGateRequest,
	UpdateStarterAutoInstallRequest,
} from "@npi-deck/protocol";

import { sdk } from "./backend/runtime.ts";
import { appendEnvAudit, commitManagedEnvUpdates } from "./env-store.ts";
import { ENV_SCHEMA_BY_KEY, resolveEnvSetting, validateEnvValue } from "./env-schema.ts";
import { MAINTENANCE_GATE_ENV_KEYS, readMaintenanceGateState } from "./maintenance-gate.ts";
import { STARTER_AUTO_INSTALL_ENV, readStarterGroup, type StarterKind } from "./starters.ts";

export function buildStartersRouter(opts: { agentDir?: () => string } = {}): Hono {
	const app = new Hono();
	const agentDir = opts.agentDir ?? (() => sdk().getAgentDir());
	const readStarters = (): StartersResponse | null => {
		let dir: string;
		try {
			dir = agentDir();
		} catch {
			return null;
		}
		return { skills: readStarterGroup("skills", dir), extensions: readStarterGroup("extensions", dir) };
	};
	const noBackend = { error: "No NeoPi backend is loaded, so the deck cannot tell which agent directory starters install into. Pick one under Settings → Backend." };

	app.get("/starters", (c) => {
		const body = readStarters();
		return body ? c.json(body) : c.json(noBackend, 503);
	});

	app.put("/starters/auto-install", async (c) => {
		let body: UpdateStarterAutoInstallRequest;
		try {
			body = (await c.req.json()) as UpdateStarterAutoInstallRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const updates: Record<string, string | null> = {};
		for (const kind of ["skills", "extensions"] as StarterKind[]) {
			const value = body[kind];
			if (value === undefined) continue;
			if (typeof value !== "boolean") return c.json({ error: `${kind} must be a boolean` }, 400);
			const key = STARTER_AUTO_INSTALL_ENV[kind];
			if (!resolveEnvSetting(key).setting.editable) {
				return c.json({ error: `${key} is set by the launching shell; unset it there to change it here` }, 409);
			}
			// Unset is the default (install); 0 turns the installer off.
			updates[key] = value ? null : "0";
		}
		await commitManagedEnvUpdates(updates);
		const set = Object.keys(updates).filter((k) => updates[k] !== null);
		const unset = Object.keys(updates).filter((k) => updates[k] === null);
		if (set.length > 0) await appendEnvAudit("set", set);
		if (unset.length > 0) await appendEnvAudit("unset", unset);
		const next = readStarters();
		return next ? c.json(next) : c.json(noBackend, 503);
	});

	app.get("/starters/maintenance-gate", (c) => {
		const body: MaintenanceGateState = readMaintenanceGateState();
		return c.json(body);
	});

	app.put("/starters/maintenance-gate", async (c) => {
		let body: UpdateMaintenanceGateRequest;
		try {
			body = (await c.req.json()) as UpdateMaintenanceGateRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		const updates: Record<string, string | null> = {};

		if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
			// `enabled` is the UI affordance; we store its inverse as
			// NPI_DECK_MAINTENANCE_GATE_DISABLED=1 (truthy = off). `null`
			// clears the override and reverts to the implicit default (on).
			if (body.enabled === false) {
				updates[MAINTENANCE_GATE_ENV_KEYS.disabled] = "1";
			} else {
				updates[MAINTENANCE_GATE_ENV_KEYS.disabled] = null;
			}
		}

		const numericKnobs: Array<[keyof UpdateMaintenanceGateRequest, string]> = [
			["minOpMsgs", MAINTENANCE_GATE_ENV_KEYS.minOpMsgs],
			["minReleaseAgeMs", MAINTENANCE_GATE_ENV_KEYS.minReleaseAgeMs],
			["fireFloorMs", MAINTENANCE_GATE_ENV_KEYS.fireFloorMs],
		];
		for (const [field, envKey] of numericKnobs) {
			if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
			const raw = body[field];
			if (raw === null || raw === undefined) {
				updates[envKey] = null;
				continue;
			}
			if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
				return c.json({ error: `${String(field)} must be a positive integer or null` }, 400);
			}
			updates[envKey] = String(Math.floor(raw));
		}

		// Defense-in-depth: also run env-schema validators when the key is
		// registered there. Catches anything the per-field guard above missed
		// (e.g. someone hand-wires a different validation rule via env-schema).
		for (const [key, value] of Object.entries(updates)) {
			if (value === null) continue;
			const entry = ENV_SCHEMA_BY_KEY.get(key);
			if (entry) {
				const err = validateEnvValue(entry, value);
				if (err) return c.json({ error: `${key}: ${err}` }, 400);
			}
		}

		await commitManagedEnvUpdates(updates);
		const set = Object.keys(updates).filter((k) => updates[k] !== null);
		const unset = Object.keys(updates).filter((k) => updates[k] === null);
		if (set.length > 0) await appendEnvAudit("set", set);
		if (unset.length > 0) await appendEnvAudit("unset", unset);

		const resp: MaintenanceGateState = readMaintenanceGateState();
		return c.json(resp);
	});

	return app;
}
