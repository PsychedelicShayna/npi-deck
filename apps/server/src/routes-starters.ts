/**
 * Starter routes
 *
 * Starters are the skills and extensions bundled with the deck (see
 * `starters.ts`). GET /starters lists each with its origin tag, whether it is
 * opted in and whether it is installed. PUT /starters/:kind/:name opts one in,
 * which copies it into the agent dir now, or out, which stops the launch-time
 * copy and leaves an installed copy alone. The maintenance gate, the one
 * starter extension with settings, projects its env-backed state (see
 * `maintenance-gate.ts`); its PUT writes the managed env file.
 */

import { Hono } from "hono";
import type {
	MaintenanceGateState,
	StartersResponse,
	UpdateMaintenanceGateRequest,
	UpdateStarterRequest,
} from "@npi-deck/protocol";

import { sdk } from "./backend/runtime.ts";
import { appendEnvAudit, commitManagedEnvUpdates } from "./env-store.ts";
import { ENV_SCHEMA_BY_KEY, validateEnvValue } from "./env-schema.ts";
import { resolveKbRoot } from "./kb-service.ts";
import {
	MAINTENANCE_GATE_ENV_KEYS,
	MAINTENANCE_GATE_STARTER,
	readMaintenanceGateState,
	syncMaintenanceGateOrgRoot,
} from "./maintenance-gate.ts";
import {
	STARTERS_ENV,
	STARTER_KINDS,
	bundledStarterNames,
	installStarter,
	readStarterGroup,
	resolveStartersSetting,
	starterId,
	type StarterKind,
} from "./starters.ts";

// Opt-in changes read, install and rewrite the process-wide list; run them one at a time.
let optInQueue: Promise<unknown> = Promise.resolve();

export function buildStartersRouter(opts: { agentDir?: () => string; kbRoot?: () => string } = {}): Hono {
	const app = new Hono();
	const agentDir = opts.agentDir ?? (() => sdk().getAgentDir());
	const kbRoot = opts.kbRoot ?? resolveKbRoot;
	/** Only a loaded backend has an agent dir; without one, starters are skipped entirely. */
	const currentAgentDir = (): string | null => {
		try {
			return agentDir();
		} catch {
			return null;
		}
	};
	const readStarters = (dir: string): StartersResponse => {
		const { setting, optedIn } = resolveStartersSetting();
		return {
			setting,
			skills: readStarterGroup("skills", dir, optedIn),
			extensions: readStarterGroup("extensions", dir, optedIn),
		};
	};
	const noBackend = { error: "No NeoPi backend is loaded, so the deck cannot tell which agent directory starters install into. Pick one under Settings → Backend." };

	app.get("/starters", (c) => {
		const dir = currentAgentDir();
		return dir ? c.json(readStarters(dir)) : c.json(noBackend, 503);
	});

	app.put("/starters/:kind/:name", async (c) => {
		const kind = c.req.param("kind") as StarterKind;
		const name = c.req.param("name");
		if (!STARTER_KINDS.includes(kind) || !bundledStarterNames(kind).includes(name)) {
			return c.json({ error: `${kind}/${name} is not a bundled starter` }, 404);
		}
		let body: UpdateStarterRequest;
		try {
			body = (await c.req.json()) as UpdateStarterRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (typeof body?.optedIn !== "boolean") return c.json({ error: "optedIn must be a boolean" }, 400);
		const dir = currentAgentDir();
		if (!dir) return c.json(noBackend, 503);

		const run = optInQueue.then(async () => {
			const { setting, optedIn } = resolveStartersSetting();
			if (!setting.editable) {
				return c.json({ error: `${STARTERS_ENV} is set by the launching shell; unset it there to change it here` }, 409);
			}
			const id = starterId(kind, name);
			if (body.optedIn) {
				// Install first so a refused or failed copy leaves the list as it was.
				try {
					await installStarter(dir, kind, name);
				} catch (err) {
					return c.json({ error: `Could not install ${id}: ${err instanceof Error ? err.message : String(err)}` }, 500);
				}
				optedIn.add(id);
			} else {
				optedIn.delete(id);
			}
			const next = [...optedIn].sort().join(",");
			await commitManagedEnvUpdates({ [STARTERS_ENV]: next || null });
			await appendEnvAudit(next ? "set" : "unset", [STARTERS_ENV]);
			if (kind === "extensions" && name === MAINTENANCE_GATE_STARTER) syncMaintenanceGateOrgRoot(kbRoot());
			return c.json(readStarters(dir));
		});
		optInQueue = run.catch(() => {});
		return run;
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
		if (MAINTENANCE_GATE_ENV_KEYS.disabled in updates) syncMaintenanceGateOrgRoot(kbRoot());

		const resp: MaintenanceGateState = readMaintenanceGateState();
		return c.json(resp);
	});

	return app;
}
