/**
 * Maintenance-gate state
 *
 * The maintenance-gate starter extension reads its config from the managed
 * env file. This module projects the relevant keys (with their source and
 * compiled defaults) for the Settings → Starters UI, and renders a preview of
 * the reminder the extension appends at turn end.
 *
 * Read on each call rather than caching; the values change rarely and the
 * cost is one small env-file read.
 */

import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readManagedEnvFile } from "./env-store.ts";

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
	/** Whether the installed extension copy still exists on disk. */
	installedExtensionPresent: boolean;
	installedExtensionPath: string;
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

	const installedExtensionPath = path.join(
		os.homedir(),
		".omp",
		"agent",
		"extensions",
		"maintenance-gate",
		"index.ts",
	);

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
		installedExtensionPresent: existsSync(installedExtensionPath),
		installedExtensionPath,
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
