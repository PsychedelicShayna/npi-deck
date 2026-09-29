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
 * The source dir comes from `starterSkillsDir()` (assets.ts;
 * `NPI_DECK_STARTER_SKILLS_DIR` overrides).
 *
 * Disable with `NPI_DECK_INSTALL_STARTER_SKILLS=0` (or Settings → Starters).
 */

import { cp, readdir, stat } from "node:fs/promises";
import * as path from "node:path";

import { starterSkillsDir } from "./assets.ts";
import { sdk } from "./backend/runtime.ts";
import { logger } from "./log.ts";
import { pathOccupied, starterAutoInstallEnabled, starterTargetRoot } from "./starters.ts";

const log = logger("starter-skills");

export interface StarterInstallResult {
	installed: string[];
	skipped: string[];
}

export async function installStarterSkills(agentDir = sdk().getAgentDir()): Promise<StarterInstallResult> {
	if (!starterAutoInstallEnabled("skills")) {
		log.info("starter skills install disabled via NPI_DECK_INSTALL_STARTER_SKILLS");
		return { installed: [], skipped: [] };
	}

	const sourceDir = starterSkillsDir();
	if (!sourceDir) {
		log.warn("no starter-skills source dir found; skipping");
		return { installed: [], skipped: [] };
	}

	let targetRoot: string;
	try {
		targetRoot = await starterTargetRoot(agentDir, "skills");
	} catch (err) {
		log.warn("refusing to install starter skills", err);
		return { installed: [], skipped: [] };
	}

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
		// the destination once anything occupies it, a symlink included (cp
		// would follow it). If they want a starter back, they delete the
		// destination and restart.
		if (await pathOccupied(dst)) {
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


// Re-export the synchronous stat for tests and callers that need it explicitly.
export async function isDir(p: string): Promise<boolean> {
	try {
		const s = await stat(p);
		return s.isDirectory();
	} catch {
		return false;
	}
}
