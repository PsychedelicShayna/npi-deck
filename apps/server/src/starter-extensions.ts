/**
 * Starter-extensions installer.
 *
 * The repo ships a small set of omp SDK extensions under `starter-extensions/`
 * at the workspace root. On server boot we copy any starter that isn't
 * already present at `~/.omp/agent/extensions/<name>/` into place —
 * idempotent, never overwrites a user-edited target, never touches
 * starters the user has deleted intentionally (absence on disk means
 * "skip until missing").
 *
 * Rationale: extensions ride on top of omp's SDK and are loaded for every
 * omp session (TUI, deck, ACP, etc.). Bundling them through the deck means
 * a fresh `omp` install with npi-deck picks them up automatically; deleting
 * the destination dir + restarting the deck restores them.
 *
 * Disable with `NPI_DECK_INSTALL_STARTER_EXTENSIONS=0` (or Settings → Starters).
 *
 * The source dir comes from `starterExtensionsDir()` (assets.ts;
 * `NPI_DECK_STARTER_EXTENSIONS_DIR` overrides).
 */

import { existsSync } from "node:fs";
import { cp, readdir, stat } from "node:fs/promises";
import * as path from "node:path";

import { starterExtensionsDir } from "./assets.ts";
import { sdk } from "./backend/runtime.ts";
import { logger } from "./log.ts";
import { starterAutoInstallEnabled } from "./starters.ts";

const log = logger("starter-extensions");

export interface StarterExtensionInstallResult {
	installed: string[];
	skipped: string[];
}

export async function installStarterExtensions(agentDir = sdk().getAgentDir()): Promise<StarterExtensionInstallResult> {
	if (!starterAutoInstallEnabled("extensions")) {
		log.info("starter extensions install disabled via NPI_DECK_INSTALL_STARTER_EXTENSIONS");
		return { installed: [], skipped: [] };
	}

	const sourceDir = starterExtensionsDir();
	if (!sourceDir) {
		log.warn("no starter-extensions source dir found; skipping");
		return { installed: [], skipped: [] };
	}

	const targetRoot = path.join(agentDir, "extensions");

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
			log.info(`installed starter extension "${name}" → ${dst}`);
		} catch (err) {
			log.warn(`failed to install starter extension "${name}"`, err);
		}
	}

	if (installed.length === 0 && skipped.length === 0) {
		log.info("no starter extensions present in source directory");
	} else if (installed.length === 0) {
		log.info(`starter extensions already present: ${skipped.join(", ")}`);
	} else {
		log.info(
			`starter extensions installed: ${installed.join(", ")}${
				skipped.length > 0 ? ` (already present: ${skipped.join(", ")})` : ""
			}`,
		);
	}

	return { installed, skipped };
}

// Re-export the async dir check for tests / external callers.
export async function isDir(p: string): Promise<boolean> {
	try {
		const s = await stat(p);
		return s.isDirectory();
	} catch {
		return false;
	}
}
