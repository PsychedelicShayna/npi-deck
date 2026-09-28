/**
 * Contract between the `npi-deck` launcher (`scripts/npi-deck.ts`) and the
 * worker it supervises (plan, W13 and "No-orphans guarantee", layer 1).
 *
 * - The launcher passes its pid and /proc start time. The worker shuts down
 *   when that process is gone, which under systemd empties the unit's cgroup.
 * - A restart requested from the UI is the worker exiting with
 *   `RESTART_EXIT_CODE`. systemd restarts on exactly that status
 *   (`RestartForceExitStatus`); the `--no-systemd` launcher does the same.
 */
import * as fs from "node:fs";

/** EX_TEMPFAIL. Reserved: nothing else in the worker exits with it. */
export const RESTART_EXIT_CODE = 75;

export const LAUNCHER_PID_ENV = "NPI_DECK_LAUNCHER_PID";
export const LAUNCHER_START_ENV = "NPI_DECK_LAUNCHER_STARTTIME";

/** Field 22 of /proc/<pid>/stat (clock ticks since boot); undefined when the process is gone or /proc is absent. */
export function processStartTime(pid: number): string | undefined {
	let stat: string;
	try {
		stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return undefined;
	}
	// comm (field 2) may contain spaces and parens; fields after it follow the last ')'.
	const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	return rest[19];
}

export interface LauncherIdentity {
	pid: number;
	startTime?: string;
}

export function launcherFromEnv(env: NodeJS.ProcessEnv = process.env): LauncherIdentity | undefined {
	const pid = Number(env[LAUNCHER_PID_ENV]);
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	return { pid, startTime: env[LAUNCHER_START_ENV] || undefined };
}

export function isAlive(who: LauncherIdentity): boolean {
	try {
		process.kill(who.pid, 0);
	} catch (err) {
		// EPERM means it exists but is not ours; still alive.
		if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	if (!who.startTime) return true;
	const now = processStartTime(who.pid);
	// A different start time is a reused pid: the launcher is gone.
	return now === undefined || now === who.startTime;
}

/** Calls `onGone` once, the first time the launcher is found dead. Returns a disposer. */
export function watchLauncher(who: LauncherIdentity, onGone: () => void, intervalMs = 1000): () => void {
	const timer = setInterval(() => {
		if (isAlive(who)) return;
		clearInterval(timer);
		onGone();
	}, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
