/**
 * Resolves identifying metadata about the running deck server. Exposed via
 * `/api/health` and broadcast on every WS heartbeat so the web client can
 * detect restarts and surface the running version in the connection
 * indicator.
 *
 * Resolution order for `buildSha`:
 *   1. `NPI_DECK_BUILD_SHA` env var (set by CI)
 *   2. `apps/server/.buildinfo` file (`{ "sha": "...", "version": "..." }`)
 *   3. `git rev-parse HEAD` from the repo root (dev fallback)
 *   4. `null` (no git, no env, no .buildinfo)
 *
 * Cached at module load. A new process is required to refresh — which is the
 * whole point: a new value tells clients "this is a different server."
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../package.json" with { type: "json" };

export interface BuildInfo {
	/** Process start time. New each boot. */
	readonly serverStartedAt: string;
	/** Process pid. */
	readonly pid: number;
	/** `package.json` version field. */
	readonly version: string;
	/** Build commit SHA, or null if unresolvable. */
	readonly buildSha: string | null;
}

function resolveBuildSha(): string | null {
	const envSha = process.env.NPI_DECK_BUILD_SHA?.trim();
	if (envSha) return envSha;

	const here = path.dirname(fileURLToPath(import.meta.url));
	const buildInfoPath = path.join(here, "..", ".buildinfo");
	try {
		if (fs.existsSync(buildInfoPath)) {
			const parsed = JSON.parse(fs.readFileSync(buildInfoPath, "utf-8")) as {
				sha?: unknown;
			};
			if (typeof parsed.sha === "string" && parsed.sha.length > 0) {
				return parsed.sha;
			}
		}
	} catch {
		// fall through — .buildinfo unreadable, try git
	}

	// Git fallback (synchronous, runs once at boot). Bun.spawnSync keeps us off
	// node:child_process and avoids the Windows quoting traps that plague
	// `cmd /c git ...`. Repo root is two levels up from apps/server/src.
	try {
		const repoRoot = path.resolve(here, "..", "..", "..");
		const proc = Bun.spawnSync({
			cmd: ["git", "rev-parse", "HEAD"],
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode === 0) {
			const sha = new TextDecoder().decode(proc.stdout).trim();
			if (/^[a-f0-9]{40}$/i.test(sha)) return sha;
		}
	} catch {
		// git not on PATH or not a repo — accept null
	}

	return null;
}

const SERVER_STARTED_AT = new Date().toISOString();
const SERVER_STARTED_MS = Date.now();
const VERSION = (packageJson as { version?: string }).version ?? "0.0.0";
const BUILD_SHA = resolveBuildSha();

/** Snapshot the build/identity info. Stable across the process lifetime. */
export function getBuildInfo(): BuildInfo {
	return {
		serverStartedAt: SERVER_STARTED_AT,
		pid: process.pid,
		version: VERSION,
		buildSha: BUILD_SHA,
	};
}

/** Whole-seconds uptime since process boot. Computed fresh on each call. */
export function getUptimeSecs(): number {
	return Math.floor((Date.now() - SERVER_STARTED_MS) / 1000);
}
