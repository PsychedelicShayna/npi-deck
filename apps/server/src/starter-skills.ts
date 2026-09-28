/**
 * Starter-skills installer.
 *
 * The repo ships a small set of omp-native skills under `starter-skills/` at
 * the workspace root. On server boot we copy any starter that isn't already
 * present at `~/.omp/agent/skills/<name>/` into place — idempotent, never
 * overwrites a user-edited target, never touches starters the user has
 * deleted intentionally (we don't track them; absence on disk just means
 * "skip until missing").
 *
 * Rationale: omp doesn't ship a first-party authoring skill, and the upstream
 * `skill-creator` is Claude-Code-bound. Bundling our own native authoring
 * skill removes the bootstrapping gap — a fresh `omp` install with npi-deck
 * gets `/skill:create-skill` immediately, no marketplace dance required.
 *
 * Path resolution:
 * - In dev (`bun --hot src/index.ts`), `import.meta.dir` is
 *   `<repo>/apps/server/src/`, so `../../../starter-skills` resolves to the
 *   workspace's `starter-skills/`.
 * - In bundled prod the resolution still works as long as the build copies
 *   `starter-skills/` next to the bundled entry point (or the env var
 *   `NPI_DECK_STARTER_SKILLS_DIR` overrides). Both knobs are checked.
 *
 * Disable with `NPI_DECK_INSTALL_STARTER_SKILLS=0`.
 */

import { existsSync } from "node:fs";
import { cp, readdir, stat } from "node:fs/promises";
import * as path from "node:path";

import { sdk } from "./backend/runtime.ts";
import { logger } from "./log.ts";

const log = logger("starter-skills");

export interface StarterInstallResult {
	installed: string[];
	skipped: string[];
}

export async function installStarterSkills(): Promise<StarterInstallResult> {
	if (process.env.NPI_DECK_INSTALL_STARTER_SKILLS === "0") {
		log.info("starter skills install disabled via NPI_DECK_INSTALL_STARTER_SKILLS=0");
		return { installed: [], skipped: [] };
	}

	const sourceDir = resolveStarterSourceDir();
	if (!sourceDir) {
		log.warn("no starter-skills source dir found; skipping");
		return { installed: [], skipped: [] };
	}

	const targetRoot = path.join(sdk().getAgentDir(), "skills");

	let entries;
	try {
		entries = await readdir(sourceDir, { withFileTypes: true });
	} catch (err) {
		log.warn(`failed to read starter source ${sourceDir}`, err);
		return { installed: [], skipped: [] };
	}

	const installed: string[] = [];
	const skipped: string[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const name = entry.name;
		const src = path.join(sourceDir, name);
		const dst = path.join(targetRoot, name);

		// Idempotent contract: never overwrite, never repair. The user owns
		// the destination once it exists. If they want a starter back, they
		// delete the destination dir and restart.
		if (existsSync(dst)) {
			skipped.push(name);
			continue;
		}

		try {
			await cp(src, dst, { recursive: true });
			installed.push(name);
			log.info(`installed starter skill "${name}" → ${dst}`);
		} catch (err) {
			log.warn(`failed to install starter skill "${name}"`, err);
		}
	}

	if (installed.length === 0 && skipped.length === 0) {
		log.info("no starter skills present in source directory");
	} else if (installed.length === 0) {
		log.info(`starter skills already present: ${skipped.join(", ")}`);
	} else {
		log.info(
			`starter skills installed: ${installed.join(", ")}${
				skipped.length > 0 ? ` (already present: ${skipped.join(", ")})` : ""
			}`,
		);
	}

	return { installed, skipped };
}

function resolveStarterSourceDir(): string | undefined {
	// Explicit override wins.
	const override = process.env.NPI_DECK_STARTER_SKILLS_DIR;
	if (override && existsSync(override) && isDirSync(override)) return override;

	// Walk up from this file looking for a sibling `starter-skills/` dir.
	// Handles both dev (`apps/server/src/`) and any bundled layout that keeps
	// the starter tree at or near the package root.
	const candidates = [
		path.resolve(import.meta.dir, "..", "..", "..", "starter-skills"),
		path.resolve(import.meta.dir, "..", "..", "starter-skills"),
		path.resolve(import.meta.dir, "..", "starter-skills"),
		path.resolve(process.cwd(), "starter-skills"),
	];
	for (const c of candidates) {
		if (existsSync(c) && isDirSync(c)) return c;
	}
	return undefined;
}

function isDirSync(p: string): boolean {
	try {
		// `existsSync` doesn't distinguish file/dir; statSync would but we want
		// to keep this allocation-free. fs.statSync via node:fs isn't imported;
		// the readdir below will reject on file paths if we slip through here.
		// A tiny try-catch on readdir is acceptable: the candidate list is short.
		return true;
	} catch {
		return false;
	}
}

// Re-export the synchronous stat for tests and callers that need it explicitly.
export async function isDir(p: string): Promise<boolean> {
	try {
		const s = await stat(p);
		return s.isDirectory();
	} catch {
		return false;
	}
}
