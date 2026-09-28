/**
 * Starter routes
 *
 * Opt-in starter extensions whose config the deck manages. Today that is the
 * maintenance gate: GET projects its env-backed state (see
 * `maintenance-gate.ts`), PUT writes the managed env file.
 */

import { Hono } from "hono";
import type { MaintenanceGateState, UpdateMaintenanceGateRequest } from "@npi-deck/protocol";

import { appendEnvAudit, applyManagedEnvUpdatesToProcess, writeManagedEnvUpdates } from "./env-store.ts";
import { ENV_SCHEMA_BY_KEY, validateEnvValue } from "./env-schema.ts";
import { MAINTENANCE_GATE_ENV_KEYS, readMaintenanceGateState } from "./maintenance-gate.ts";

export function buildStartersRouter(): Hono {
	const app = new Hono();

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

		await writeManagedEnvUpdates(updates);
		applyManagedEnvUpdatesToProcess(updates);
		const set = Object.keys(updates).filter((k) => updates[k] !== null);
		const unset = Object.keys(updates).filter((k) => updates[k] === null);
		if (set.length > 0) await appendEnvAudit("set", set);
		if (unset.length > 0) await appendEnvAudit("unset", unset);

		const resp: MaintenanceGateState = readMaintenanceGateState();
		return c.json(resp);
	});

	return app;
}
