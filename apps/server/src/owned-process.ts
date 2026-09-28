import * as fs from "node:fs";
import * as path from "node:path";
import { getDataDir } from "./env-store.ts";
import { beginGeneration, GEN_ENV, killGenerations } from "./owned/generations.ts";
import { workRegistry } from "./work-registry.ts";

interface OwnedRecord { pid: number; pgid: number; starttime: string; generation: string }
const active = new Map<number, OwnedRecord>();
const releases = new Map<number, () => void>();
let journalPath: string | undefined;

function runDir(): string { return path.join(getDataDir(), "run"); }
function journal(): string { return journalPath ?? path.join(runDir(), "owned.json"); }
function starttime(pid: number): string | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; // field 22, after pid and comm
	} catch { return undefined; }
}
function recorded(): OwnedRecord[] {
	try {
		const rows: unknown = JSON.parse(fs.readFileSync(journal(), "utf8"));
		return Array.isArray(rows) ? rows.filter((r): r is OwnedRecord => typeof r?.pid === "number" && typeof r?.pgid === "number" && typeof r?.starttime === "string") : [];
	} catch { return []; }
}
function persist(): void {
	const file = journal();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify([...active.values()]) + "\n", { mode: 0o600 });
	fs.renameSync(tmp, file);
}
function signalGroup(record: OwnedRecord, signal: NodeJS.Signals): void {
	if (process.platform !== "linux") {
		try { process.kill(record.pid, signal); } catch { /* already exited */ }
		return;
	}
	// A reused PID must never let an old journal kill an unrelated group.
	if (starttime(record.pid) !== record.starttime) return;
	try { process.kill(-record.pgid, signal); } catch { /* group already exited */ }
}

/** Must run before the first server spawn, under the launcher's single-worker lock. */
export function initializeOwnedGeneration(): void {
	journalPath = path.join(runDir(), "owned.json");
	// Sweep the old process groups before the generation sweep removes their leaders.
	for (const record of recorded()) signalGroup(record, "SIGKILL");
	active.clear();
	persist();
	beginGeneration(runDir());
}

/** Boot sweep also catches descendants that left their leader's process group. */
export async function sweepOwnedProcesses(): Promise<void> {
	for (const record of recorded()) signalGroup(record, "SIGKILL");
}

export type OwnedProcess = Bun.Subprocess<Bun.SpawnOptions.Writable, Bun.SpawnOptions.Readable, Bun.SpawnOptions.Readable>;
/** Sole server spawn boundary. Owns the process group and journals leader identity. */
export function spawnOwned<
	const In extends Bun.SpawnOptions.Writable = "ignore",
	const Out extends Bun.SpawnOptions.Readable = "pipe",
	const Err extends Bun.SpawnOptions.Readable = "inherit",
>(cmd: string[], options: Omit<Bun.SpawnOptions.SpawnOptions<In, Out, Err>, "cmd" | "detached"> = {}, policy: { replaceEnv?: boolean } = {}): Bun.Subprocess<In, Out, Err> {
	if (!cmd.length) throw new Error("spawnOwned requires a command");
	const wrapped = process.platform === "linux" && fs.existsSync("/usr/bin/setpriv")
		? ["/usr/bin/setpriv", "--pdeathsig", "KILL", "--", ...cmd] : cmd;
	const env = { ...(policy.replaceEnv ? {} : process.env), ...options.env, ...(process.env[GEN_ENV] ? { [GEN_ENV]: process.env[GEN_ENV] } : {}) } as Record<string, string>;
	const onExit = options.onExit;
	const releaseWork = workRegistry.admit("process", crypto.randomUUID());
	let proc: Bun.Subprocess<In, Out, Err>;
	try {
		proc = Bun.spawn<In, Out, Err>({ ...options, cmd: wrapped, env, detached: process.platform !== "win32", onExit: (child, code, signal, error) => {
		const record = active.get(child.pid);
		if (record) {
			// A shell can exit with background descendants still in its group.
			try { process.kill(-record.pgid, "SIGKILL"); } catch { /* empty */ }
			active.delete(child.pid);
			releases.get(child.pid)?.();
			releases.delete(child.pid);
			persist();
		}
		onExit?.(child, code, signal, error);
		} });
	} catch (error) {
		releaseWork();
		throw error;
	}
	const begun = starttime(proc.pid);
	if (begun) {
		active.set(proc.pid, { pid: proc.pid, pgid: proc.pid, starttime: begun, generation: process.env[GEN_ENV] ?? "" });
		releases.set(proc.pid, releaseWork);
		persist();
	}
	else releaseWork();
	// Extremely short-lived children can exit before onExit sees the record.
	void proc.exited.then(() => {
		if (!active.has(proc.pid)) return;
		try { process.kill(-proc.pid, "SIGKILL"); } catch { /* empty */ }
		active.delete(proc.pid);
		releases.get(proc.pid)?.();
		releases.delete(proc.pid);
		persist();
	});
	return proc;
}

/** Terminate the entire tree, escalating after the bounded grace period. */
export async function terminateOwned(proc: OwnedProcess, graceMs = 800): Promise<void> {
	const record = active.get(proc.pid);
	if (record) signalGroup(record, "SIGTERM");
	else try { proc.kill(); } catch { /* exited */ }
	await Promise.race([proc.exited.then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, graceMs))]);
	if (record) {
		// Even a reaped leader may have live grandchildren in its group.
		try { process.kill(-record.pgid, "SIGKILL"); } catch { /* empty */ }
	} else try { proc.kill("SIGKILL"); } catch { /* exited */ }
	await proc.exited.catch(() => undefined);
}

export async function stopOwnedProcesses(): Promise<void> {
	const records = [...active.values()];
	for (const record of records) signalGroup(record, "SIGTERM");
	await new Promise((resolve) => setTimeout(resolve, 800));
	for (const record of records) {
		try { process.kill(-record.pgid, "SIGKILL"); } catch { /* empty */ }
	}
	killGenerations(new Set(process.env[GEN_ENV] ? [process.env[GEN_ENV]] : []));
	active.clear();
	for (const release of releases.values()) release();
	releases.clear();
	persist();
}
