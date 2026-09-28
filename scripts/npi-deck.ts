#!/usr/bin/env bun
/**
 * npi-deck launcher. Installed as `~/.local/bin/npi-deck` through the
 * `bin/npi-deck` wrapper (see docs/install.md).
 *
 *   npi-deck [--port N] [--host H] [--unit NAME] [--rebuild] [--no-systemd]
 *
 * - Resolves every path from this checkout, never from the caller's cwd.
 * - Builds the web bundle when it is missing or older than its sources.
 * - Refuses a second instance: a lock in <home>/run plus an active-unit check.
 * - Runs the server as the transient systemd user service `<unit>` in
 *   neopi-deck.slice, KillMode=control-group, so everything the worker spawns
 *   dies with it, SIGKILL included (no-orphans layer 1). systemd restarts it
 *   only on the reserved exit status (a UI restart). The launcher follows the
 *   unit's journal; SIGINT/SIGTERM/SIGHUP stop the unit. The worker watches
 *   NPI_DECK_LAUNCHER_PID and stops if the launcher dies.
 * - `--no-systemd` runs the worker as a direct child under
 *   `setpriv --pdeathsig KILL` in its own process group, kills that group and
 *   sweeps the worker's generation markers when it exits, and restarts on the
 *   reserved status. Only layers 2 and 3 apply there.
 *
 * <home> is NPI_DECK_HOME, else ~/.npi-deck.
 */
import { spawn, spawnSync, type Subprocess } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_PORT } from "../apps/server/src/config.ts";
import { getDataDir, readManagedEnvFile } from "../apps/server/src/env-store.ts";
import { GEN_ENV, sweepGenerations } from "../apps/server/src/owned/generations.ts";
import {
	isAlive,
	LAUNCHER_PID_ENV,
	LAUNCHER_START_ENV,
	processStartTime,
	RESTART_EXIT_CODE,
} from "../apps/server/src/owned/launcher.ts";

const DECK_ROOT = path.resolve(import.meta.dir, "..");
const SERVER_DIR = path.join(DECK_ROOT, "apps", "server");
const WEB_DIR = path.join(DECK_ROOT, "apps", "web");
const WEB_DIST = path.join(WEB_DIR, "dist");
const SLICE = "neopi-deck.slice";
const STOP_TIMEOUT_S = 10;
/** Environment the launcher must not hand down: its own markers and systemd's per-unit plumbing. */
const DROP_ENV = new Set([
	GEN_ENV,
	LAUNCHER_PID_ENV,
	LAUNCHER_START_ENV,
	"INVOCATION_ID",
	"JOURNAL_STREAM",
	"SYSTEMD_EXEC_PID",
	"NOTIFY_SOCKET",
	"LISTEN_PID",
	"LISTEN_FDS",
	"LISTEN_FDNAMES",
	"MANAGERPID",
	"WATCHDOG_PID",
	"WATCHDOG_USEC",
]);

const USAGE = `usage: npi-deck [--port N] [--host H] [--unit NAME] [--rebuild] [--no-systemd]

  --port N       listen port (default: NPI_DECK_PORT, else ${DEFAULT_PORT})
  --host H       bind host (default: NPI_DECK_HOST, else 127.0.0.1)
  --unit NAME    systemd unit name (default: npi-deck)
  --rebuild      rebuild the web bundle even if it looks current
  --no-systemd   run the worker as a direct child; only pdeathsig, process-group
                 and generation sweeps contain its descendants
`;

function fail(message: string, code = 1): never {
	process.stderr.write(`npi-deck: ${message}\n`);
	process.exit(code);
}

function say(message: string): void {
	process.stderr.write(`npi-deck: ${message}\n`);
}

// ─── lock ───────────────────────────────────────────────────────────────────

interface LockHolder {
	pid: number;
	startTime?: string;
	unit?: string;
}

/** Take `<run>/launcher.lock`, or return the live holder. A lock whose pid is dead (or reused) is stale and taken over. */
export function acquireLock(file: string, unit: string): LockHolder | undefined {
	const me: LockHolder = { pid: process.pid, startTime: processStartTime(process.pid), unit };
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const fd = fs.openSync(file, "wx", 0o600);
			fs.writeSync(fd, `${JSON.stringify(me)}\n`);
			fs.closeSync(fd);
			return undefined;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		let holder: LockHolder | undefined;
		try {
			holder = JSON.parse(fs.readFileSync(file, "utf8")) as LockHolder;
		} catch {
			holder = undefined; // unreadable or half-written: treat as stale
		}
		if (holder && Number.isInteger(holder.pid) && isAlive(holder)) return holder;
		fs.rmSync(file, { force: true });
	}
	fail(`could not take ${file}`);
}

export function releaseLock(file: string): void {
	try {
		const holder = JSON.parse(fs.readFileSync(file, "utf8")) as LockHolder;
		if (holder.pid === process.pid) fs.rmSync(file, { force: true });
	} catch {
		// already gone
	}
}

// ─── web bundle ─────────────────────────────────────────────────────────────

function newestMtime(p: string): number {
	let st: fs.Stats;
	try {
		st = fs.statSync(p);
	} catch {
		return 0;
	}
	if (!st.isDirectory()) return st.mtimeMs;
	let newest = st.mtimeMs;
	for (const entry of fs.readdirSync(p)) {
		if (entry === "node_modules" || entry === "dist") continue;
		newest = Math.max(newest, newestMtime(path.join(p, entry)));
	}
	return newest;
}

function ensureWebBundle(force: boolean): void {
	const built = (() => {
		try {
			return fs.statSync(path.join(WEB_DIST, "index.html")).mtimeMs;
		} catch {
			return 0;
		}
	})();
	const sources = [
		path.join(WEB_DIR, "src"),
		path.join(WEB_DIR, "public"),
		path.join(WEB_DIR, "index.html"),
		path.join(WEB_DIR, "vite.config.ts"),
		path.join(WEB_DIR, "package.json"),
		path.join(DECK_ROOT, "packages", "protocol", "src"),
	];
	if (!force && built > 0 && Math.max(...sources.map(newestMtime)) <= built) return;
	say(built === 0 ? "building the web bundle" : "web bundle is stale; rebuilding");
	const res = spawnSync({ cmd: [process.execPath, "run", "build"], cwd: WEB_DIR, stdout: "inherit", stderr: "inherit" });
	if (res.exitCode !== 0) fail(`web build failed (exit ${res.exitCode}); fix it or run \`bun run build\` in ${WEB_DIR}`);
}

// ─── worker environment ─────────────────────────────────────────────────────

function workerEnv(extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined && !DROP_ENV.has(k)) env[k] = v;
	}
	return { ...env, ...extra };
}

/** systemd EnvironmentFile syntax: KEY="value" with \ " ` $ escaped; newlines stay literal inside the quotes. */
export function formatEnvironmentFile(env: Record<string, string>): string {
	let out = "";
	for (const [k, v] of Object.entries(env)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
		out += `${k}="${v.replace(/[\\"`$]/g, (c) => `\\${c}`)}"\n`;
	}
	return out;
}

// ─── health ─────────────────────────────────────────────────────────────────

async function waitHealthy(base: string, stillRunning: () => boolean): Promise<boolean> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline && stillRunning()) {
		try {
			const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
			if (res.ok) return true;
		} catch {
			// not up yet
		}
		await Bun.sleep(300);
	}
	return false;
}

// ─── systemd ────────────────────────────────────────────────────────────────

function systemctl(...args: string[]): { code: number; out: string } {
	const res = spawnSync({ cmd: ["systemctl", "--user", ...args], stdout: "pipe", stderr: "pipe" });
	return { code: res.exitCode ?? 1, out: res.stdout.toString() + res.stderr.toString() };
}

function systemdAvailable(): boolean {
	if (!Bun.which("systemd-run") || !Bun.which("systemctl")) return false;
	return systemctl("show-environment").code === 0;
}

function unitState(unit: string): { active: string; sub: string } {
	const { out } = systemctl("show", `${unit}.service`, "-p", "ActiveState", "-p", "SubState");
	const get = (key: string) => out.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? "";
	return { active: get("ActiveState"), sub: get("SubState") };
}

const RUNNING_STATES = new Set(["active", "activating", "reloading", "deactivating"]);

function unitRunning(unit: string): boolean {
	const s = unitState(unit);
	return RUNNING_STATES.has(s.active) || s.sub === "auto-restart";
}

async function runSystemd(opts: RunOpts): Promise<number> {
	const { unit, runDir, env, base } = opts;
	if (unitRunning(unit)) fail(`${unit}.service is already running; stop it with \`systemctl --user stop ${unit}\``);
	systemctl("reset-failed", `${unit}.service`);

	const envFile = path.join(runDir, `${unit}.env`);
	fs.writeFileSync(envFile, formatEnvironmentFile(env), { mode: 0o600 });
	fs.chmodSync(envFile, 0o600);
	const since = `@${Math.floor(Date.now() / 1000)}`;
	const run = spawnSync({
		cmd: [
			"systemd-run",
			"--user",
			"--quiet",
			"--collect",
			`--unit=${unit}`,
			`--slice=${SLICE}`,
			"--description=NPI deck",
			`--working-directory=${SERVER_DIR}`,
			"-p", "Type=exec",
			"-p", `EnvironmentFile=${envFile}`,
			"-p", "KillMode=control-group",
			"-p", `RestartForceExitStatus=${RESTART_EXIT_CODE}`,
			"-p", "RestartSec=1s",
			"-p", `TimeoutStopSec=${STOP_TIMEOUT_S}s`,
			"-p", "StartLimitIntervalSec=60s",
			"-p", "StartLimitBurst=5",
			"--",
			process.execPath,
			"src/index.ts",
		],
		stdout: "inherit",
		stderr: "inherit",
	});
	if (run.exitCode !== 0) {
		fs.rmSync(envFile, { force: true });
		fail(`systemd-run failed (exit ${run.exitCode})`);
	}
	say(`started ${unit}.service in ${SLICE}`);

	// The journal follower must not outlive a SIGKILLed launcher.
	const follow = [
		"journalctl", "--user", `--user-unit=${unit}.service`, "--follow", "--output=cat", `--since=${since}`,
	];
	const journal = spawn({
		cmd: opts.setpriv ? [opts.setpriv, "--pdeathsig", "KILL", "--", ...follow] : follow,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "ignore",
	});

	let stopRequested = false;
	const finish = (code: number): number => {
		journal.kill("SIGKILL");
		fs.rmSync(envFile, { force: true });
		return code;
	};

	const done = new Promise<number>((resolve) => {
		const onSignal = (sig: NodeJS.Signals) => {
			if (stopRequested) return;
			stopRequested = true;
			say(`${sig}: stopping ${unit}.service`);
			systemctl("stop", `${unit}.service`);
			resolve(0);
		};
		for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, onSignal);
		const poll = setInterval(() => {
			if (stopRequested || unitRunning(unit)) return;
			clearInterval(poll);
			say(`${unit}.service stopped on its own; see \`journalctl --user -u ${unit}\``);
			resolve(1);
		}, 500);
	});

	void waitHealthy(base, () => !stopRequested && unitRunning(unit)).then((ok) => {
		if (ok) say(`ready at ${base}`);
	});

	return finish(await done);
}

/** Signal only the worker's original process group; PID/PGID reuse must not kill a stranger. */
export function signalWorkerGroup(pid: number, startTime: string | undefined, signal: NodeJS.Signals): void {
	if (!startTime) return;
	let stat: string;
	try { stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return; }
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	if (fields[19] !== startTime || Number(fields[2]) !== pid) return;
	try { process.kill(-pid, signal); } catch { /* group already exited */ }
}

// ─── direct child (--no-systemd) ────────────────────────────────────────────

async function runDirect(opts: RunOpts): Promise<number> {
	const { runDir, env, base } = opts;
	say("running without systemd: descendants are contained only by pdeathsig, process groups and generation sweeps");
	if (!opts.setpriv) say("setpriv not found: the worker will not die with a SIGKILLed launcher");

	let child: Subprocess | undefined;
	let childStartTime: string | undefined;
	let stopRequested = false;
	const killGroup = (sig: NodeJS.Signals) => {
		if (child) signalWorkerGroup(child.pid, childStartTime, sig);
	};
	const onSignal = (sig: NodeJS.Signals) => {
		if (stopRequested) return;
		stopRequested = true;
		say(`${sig}: stopping the worker`);
		killGroup("SIGTERM");
		setTimeout(() => killGroup("SIGKILL"), STOP_TIMEOUT_S * 1000).unref();
	};
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, onSignal);

	for (;;) {
		const cmd = [process.execPath, "src/index.ts"];
		child = spawn({
			cmd: opts.setpriv ? [opts.setpriv, "--pdeathsig", "KILL", "--", ...cmd] : cmd,
			cwd: SERVER_DIR,
			env,
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
			detached: true, // own session and process group
		});
		childStartTime = processStartTime(child.pid);
		const running = child;
		void waitHealthy(base, () => running.exitCode === null && running.signalCode === null).then((ok) => {
			if (ok) say(`ready at ${base}`);
		});
		const code = await child.exited;
		// Whatever the worker left in its group or marked with its generation dies here.
		killGroup("SIGKILL");
		const swept = sweepGenerations(runDir);
		if (swept.length > 0) say(`killed ${swept.length} leftover process(es) of the dead worker`);
		if (!stopRequested && code === RESTART_EXIT_CODE) {
			say("restart requested; starting the next generation");
			continue;
		}
		return stopRequested ? 0 : code;
	}
}

// ─── main ───────────────────────────────────────────────────────────────────

interface RunOpts {
	unit: string;
	runDir: string;
	env: Record<string, string>;
	base: string;
	setpriv?: string;
}

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: {
			port: { type: "string" },
			host: { type: "string" },
			unit: { type: "string", default: "npi-deck" },
			rebuild: { type: "boolean", default: false },
			"no-systemd": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
		strict: true,
	});
	if (values.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (values.port !== undefined && !/^\d+$/.test(values.port)) fail(`--port must be a number, got ${values.port}`);
	const unit = values.unit ?? "npi-deck";
	if (!/^[A-Za-z0-9:_.\\-]+$/.test(unit)) fail(`invalid unit name ${unit}`);

	if (!fs.existsSync(path.join(DECK_ROOT, "node_modules"))) {
		fail(`dependencies are missing; run \`bun install --frozen-lockfile\` in ${DECK_ROOT}`);
	}

	const home = getDataDir();
	const runDir = path.join(home, "run");
	fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });

	const useSystemd = !values["no-systemd"];
	if (useSystemd && !systemdAvailable()) {
		fail("no systemd user manager is reachable. Pass --no-systemd to run without cgroup containment.");
	}

	const lockFile = path.join(runDir, "launcher.lock");
	const holder = acquireLock(lockFile, unit);
	if (holder) fail(`already running (launcher pid ${holder.pid}${holder.unit ? `, unit ${holder.unit}` : ""}); lock ${lockFile}`);
	process.on("exit", () => releaseLock(lockFile));
	// A SIGKILLed systemd launcher leaves its EnvironmentFile (0600, holds the launch env) behind.
	fs.rmSync(path.join(runDir, `${unit}.env`), { force: true });

	ensureWebBundle(values.rebuild ?? false);

	const managed = readManagedEnvFile(path.join(home, ".env")).values;
	const setting = (key: string) => process.env[key]?.trim() || managed.get(key)?.trim() || undefined;
	const host = values.host ?? setting("NPI_DECK_HOST") ?? "127.0.0.1";
	const port = values.port ?? setting("NPI_DECK_PORT") ?? String(DEFAULT_PORT);
	const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
	const base = `http://${probeHost.includes(":") ? `[${probeHost}]` : probeHost}:${port}`;

	const env = workerEnv({
		NODE_ENV: "production",
		NPI_DECK_HOME: home,
		NPI_DECK_WEB_DIST: WEB_DIST,
		NPI_DECK_HOST: host,
		NPI_DECK_PORT: port,
		[LAUNCHER_PID_ENV]: String(process.pid),
		...(processStartTime(process.pid) ? { [LAUNCHER_START_ENV]: processStartTime(process.pid)! } : {}),
	});
	const opts: RunOpts = { unit, runDir, env, base, setpriv: Bun.which("setpriv") ?? undefined };

	const code = useSystemd ? await runSystemd(opts) : await runDirect(opts);
	// Belt and braces: nothing of this data dir's generations survives the launcher.
	const swept = sweepGenerations(runDir);
	if (swept.length > 0) say(`killed ${swept.length} leftover process(es)`);
	return code;
}

if (import.meta.main) {
	main().then(
		(code) => process.exit(code),
		(err) => fail(err instanceof Error ? err.message : String(err)),
	);
}
