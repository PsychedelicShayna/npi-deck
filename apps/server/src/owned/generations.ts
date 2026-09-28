/**
 * Generation markers: the part of no-orphans layer 2 that needs no spawn
 * wrapper (plan, "No-orphans guarantee").
 *
 * Each worker boot picks a fresh id and puts it in its own environment as
 * `NPI_DECK_GEN`, so every descendant inherits it, including setsid'd MCP
 * servers that a process-group kill misses. The ids of the generations a
 * data dir has run are journaled in `<home>/run/generations.json`. Only one
 * worker runs per data dir (the launcher's lock), so any process still
 * carrying a journaled id other than the current one belongs to a dead
 * worker and is killed:
 *   - by the next worker at boot (`beginGeneration`), and
 *   - by the launcher once its worker is gone (`sweepGenerations`).
 *
 * `spawnOwned()` (W7a) adds the pdeathsig wrapper, process groups and the
 * owned-process journal on top of this; it does not replace it.
 *
 * Linux only: without `/proc` the scan finds nothing and the sweep is a no-op.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const GEN_ENV = "NPI_DECK_GEN";

const JOURNAL = "generations.json";
const MAX_PASSES = 5;

export interface GenerationProcess {
	pid: number;
	gen: string;
}

export function readGenerations(runDir: string): string[] {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(runDir, JOURNAL), "utf8"));
		return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === "string" && g.length > 0) : [];
	} catch {
		return [];
	}
}

function writeGenerations(runDir: string, gens: string[]): void {
	fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
	const file = path.join(runDir, JOURNAL);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(gens)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/**
 * Live processes whose environment carries one of `gens`. Only this user's
 * processes are readable, which is the set the deck can have spawned anyway.
 * The calling process is never included.
 */
export function findGenerationProcesses(gens: ReadonlySet<string>): GenerationProcess[] {
	if (gens.size === 0) return [];
	let entries: string[];
	try {
		entries = fs.readdirSync("/proc");
	} catch {
		return [];
	}
	const prefix = `${GEN_ENV}=`;
	const found: GenerationProcess[] = [];
	for (const entry of entries) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
		let environ: string;
		try {
			environ = fs.readFileSync(`/proc/${pid}/environ`, "latin1");
		} catch {
			continue; // gone, or another user's
		}
		for (const kv of environ.split("\0")) {
			if (!kv.startsWith(prefix)) continue;
			const gen = kv.slice(prefix.length);
			if (gens.has(gen)) found.push({ pid, gen });
			break;
		}
	}
	return found;
}

/**
 * SIGKILL every process carrying one of `gens`, repeating until a scan comes
 * back empty so that children forked mid-sweep are caught too. Returns the
 * pids signalled.
 */
export function killGenerations(gens: ReadonlySet<string>): number[] {
	const killed: number[] = [];
	for (let pass = 0; pass < MAX_PASSES; pass++) {
		const procs = findGenerationProcesses(gens);
		if (procs.length === 0) break;
		for (const { pid } of procs) {
			try {
				process.kill(pid, "SIGKILL");
				killed.push(pid);
			} catch {
				// already gone
			}
		}
	}
	return killed;
}

/** Kill every journaled generation and empty the journal. The caller must know no worker of this data dir is alive. */
export function sweepGenerations(runDir: string): number[] {
	const gens = readGenerations(runDir);
	const killed = killGenerations(new Set(gens));
	if (gens.length > 0) writeGenerations(runDir, []);
	return killed;
}

/**
 * Boot hook for the worker. Kills what earlier generations left behind, then
 * marks this process (and so everything it spawns from now on) with a fresh
 * id and journals it. MUST run before the worker spawns anything.
 */
export function beginGeneration(runDir: string): { gen: string; swept: number[] } {
	const swept = sweepGenerations(runDir);
	const gen = randomUUID();
	process.env[GEN_ENV] = gen;
	writeGenerations(runDir, [gen]);
	return { gen, swept };
}
