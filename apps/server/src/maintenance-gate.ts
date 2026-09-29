/**
 * Maintenance-gate state
 *
 * The maintenance-gate starter extension reads its config from the managed
 * env file. This module projects the relevant keys (with their source and
 * compiled defaults) for the Settings → Starters UI, renders a preview of
 * the reminder the extension appends at turn end, and sets the deck-session
 * org root while the starter is opted in.
 *
 * Read on each call rather than caching; the values change rarely and the
 * cost is one small env-file read.
 */

import { readManagedEnvFile } from "./env-store.ts";
import { optedInStarters, starterId } from "./starters.ts";

/** The bundled extension's directory name under `starter-extensions/`. */
export const MAINTENANCE_GATE_STARTER = "maintenance-gate";

export const MAINTENANCE_GATE_DEFAULTS = {
	minOpMsgs: 4,
	minReleaseAgeMs: 8 * 60_000,
	fireFloorMs: 25 * 60_000,
} as const;

export const MAINTENANCE_GATE_ENV_KEYS = {
	disabled: "NPI_DECK_MAINTENANCE_GATE_DISABLED",
	minOpMsgs: "OMP_MAINTENANCE_GATE_MIN_OP_MSGS",
	minReleaseAgeMs: "OMP_MAINTENANCE_GATE_MIN_RELEASE_AGE_MS",
	fireFloorMs: "OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS",
	orgRoot: "NPI_DECK_ORG_ROOT",
} as const;

export type GateValueSource = "process-env" | "env-file" | "default" | "unset";

export interface GateKnob {
	value: number;
	default: number;
	rawValue: string | null;
	source: GateValueSource;
}

export interface MaintenanceGateState {
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
	/** Server-side render of the at-turn-end reminder so the UI can preview it. */
	preview: { deckMode: string; flatFileMode: string };
}

export function readMaintenanceGateState(): MaintenanceGateState {
	const file = readManagedEnvFile();
	const resolve = (key: string): { rawValue: string | null; source: GateValueSource } => {
		const processValue = process.env[key];
		const fileValue = file.values.get(key);
		if (processValue !== undefined && processValue !== fileValue) {
			return { rawValue: processValue, source: "process-env" };
		}
		if (fileValue !== undefined) return { rawValue: fileValue, source: "env-file" };
		if (processValue !== undefined) return { rawValue: processValue, source: "process-env" };
		return { rawValue: null, source: "unset" };
	};
	const intKnob = (key: string, def: number): GateKnob => {
		const { rawValue, source } = resolve(key);
		if (rawValue === null || rawValue === "") {
			return { value: def, default: def, rawValue: null, source: "default" };
		}
		const n = Number.parseInt(rawValue, 10);
		if (!Number.isFinite(n) || n <= 0) {
			return { value: def, default: def, rawValue, source };
		}
		return { value: n, default: def, rawValue, source };
	};

	const disabled = resolve(MAINTENANCE_GATE_ENV_KEYS.disabled);
	const orgRoot = resolve(MAINTENANCE_GATE_ENV_KEYS.orgRoot);
	const enabled = !isTruthy(disabled.rawValue);
	return {
		enabled,
		disabledRaw: disabled.rawValue,
		disabledSource: disabled.source,
		knobs: {
			minOpMsgs: intKnob(MAINTENANCE_GATE_ENV_KEYS.minOpMsgs, MAINTENANCE_GATE_DEFAULTS.minOpMsgs),
			minReleaseAgeMs: intKnob(
				MAINTENANCE_GATE_ENV_KEYS.minReleaseAgeMs,
				MAINTENANCE_GATE_DEFAULTS.minReleaseAgeMs,
			),
			fireFloorMs: intKnob(
				MAINTENANCE_GATE_ENV_KEYS.fireFloorMs,
				MAINTENANCE_GATE_DEFAULTS.fireFloorMs,
			),
		},
		orgRoot: orgRoot.rawValue,
		orgRootSource: orgRoot.source,
		preview: {
			deckMode: renderMaintenanceReminder("deck"),
			flatFileMode: renderMaintenanceReminder("flat-file"),
		},
	};
}

function isTruthy(value: string | null | undefined): boolean {
	if (!value) return false;
	const lower = value.trim().toLowerCase();
	return ["1", "true", "yes", "on"].includes(lower);
}

/** The org root the deck last set itself; a value it did not set belongs to the user. */
let deckOrgRoot: string | undefined;

/**
 * Point `NPI_DECK_ORG_ROOT` at `kbRoot` while the maintenance-gate starter is
 * opted in and not disabled, so the extension treats every session this
 * server spawns (routine subprocesses inherit the env) as a deck-managed org
 * root regardless of cwd, which rarely has the flat-file org markers the
 * upstream detector looks for. Otherwise remove the value the deck set. A
 * value from the launching shell or the managed .env is left alone.
 */
export function syncMaintenanceGateOrgRoot(kbRoot: string): void {
	const key = MAINTENANCE_GATE_ENV_KEYS.orgRoot;
	const current = process.env[key];
	if (current !== undefined && current !== deckOrgRoot) return;
	const wanted = optedInStarters().has(starterId("extensions", MAINTENANCE_GATE_STARTER))
		&& !isTruthy(process.env[MAINTENANCE_GATE_ENV_KEYS.disabled]);
	if (wanted) {
		process.env[key] = kbRoot;
		deckOrgRoot = kbRoot;
	} else if (current !== undefined) {
		delete process.env[key];
		deckOrgRoot = undefined;
	}
}

/**
 * Server-side mirror of the maintenance-gate extension's `buildReminder()`.
 * Lives here so the deck UI can preview both profiles without reaching into
 * the installed extension. If `starter-extensions/maintenance-gate/index.ts`
 * changes the row table, update both sides — they are intentionally a
 * format contract (see kb://system/format-contracts-not-register-contracts).
 */
export function renderMaintenanceReminder(profile: "deck" | "flat-file"): string {
	const deckMode = profile === "deck";
	const rows: [string, string][] = deckMode
		? [
				["Reusable insight or pattern", "→ `kb://system/<topic>.md`"],
				[
					"Project status changed",
					"→ `POST /api/inbox` with `kind: \"capture\"` describing the change; daily briefing reconciles into `kb://system/projects-hub.md`",
				],
				["New task identified", "→ `POST /api/tasks`"],
				[
					"Question worth preserving",
					"→ `POST /api/inbox` with `kind: \"capture\"` (or `kind: \"investigation\"` if you intend to follow up)",
				],
				["Feature idea / future project", "→ `POST /api/inbox` with `kind: \"idea\"`"],
				["Decision needed", "→ `POST /api/inbox` with `kind: \"decision\"`"],
				["Bug to investigate", "→ `POST /api/inbox` with `kind: \"investigation\"`"],
				["Quick unsorted capture", "→ `POST /api/inbox` with `kind: \"capture\"`"],
				[
					"New capability learned",
					"→ create a skill at `.omp/skills/<name>/SKILL.md` (project) or `~/.omp/agent/skills/<name>/SKILL.md` (user)",
				],
			]
		: [
				["Reusable insight or pattern", "→ `knowledge/<subfolder>/<topic>.md`"],
				["Project status changed", "→ update `context/current-state.md`"],
				["New task identified", "→ `tasks/<name>.md`"],
				["Question worth preserving", "→ `queries/<question>.md`"],
				["Feature idea / future project", "→ `inbox/ideas/<item>.md`"],
				["Decision needed", "→ `inbox/decisions/<item>.md`"],
				["Bug to investigate", "→ `inbox/investigations/<item>.md`"],
				["Quick unsorted capture", "→ `inbox/captures/<item>.md`"],
				[
					"New capability learned",
					"→ create a skill at `.omp/skills/<name>/SKILL.md` (project) or `~/.omp/agent/skills/<name>/SKILL.md` (user)",
				],
			];
	const releaseClause = deckMode
		? "invoking any of the REST endpoints below (or writing to one of the listed paths)"
		: "writing to any of the paths below";

	return [
		"---",
		"",
		"## Maintenance check",
		"",
		`Did this segment of work produce any of the signals below? Capture **now** — ${releaseClause} releases this check automatically. If nothing applies, state the literal phrase "No maintenance needed" to release.`,
		"",
		"| Signal | Action if present |",
		"|--------|-------------------|",
		...rows.map(([signal, action]) => `| ${signal} | ${action} |`),
		"",
		"Be aggressive about capture — lost insights are unrecoverable.",
		"",
		"---",
	].join("\n");
}
