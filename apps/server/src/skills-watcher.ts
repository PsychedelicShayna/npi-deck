/**
 * Filesystem watchers across every root that contributes skills omp will load:
 *
 *   1. `~/.omp/agent/skills/`      — omp-native user skills
 *   2. `<defaultCwd>/.omp/skills/` — omp-native project skills for the deck's
 *                                    default workspace (others come on demand
 *                                    when the UI passes `?cwd=`)
 *   3. `getPluginsCacheDir()`      — claude-plugin marketplace installs
 *
 * Anything (create, write, rename, delete) under any of these fires a debounced
 * `skills_changed` broadcast so the UI refetches without polling.
 *
 * Gated by `NPI_DECK_WATCH_SKILLS` (default on). Set `=0` to disable when
 * running on filesystems that misbehave under recursive watch (some VPNs,
 * network drives, OneDrive shadowing). Per-root watch errors degrade to no-op
 * for that root only; the rest keep working.
 *
 * Phase 1.5 of the Skills Cockpit (docs/proposals/skills-cockpit.md). The
 * `claude`/`codex`/`opencode` provider roots are not watched yet — if a user
 * authors against those they'll see changes on next refetch.
 */

import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import * as path from "node:path";

import { sdk } from "./backend/runtime.ts";

import { broadcastBus } from "./broadcast-bus.ts";
import type { Config } from "./config.ts";
import { logger } from "./log.ts";

const log = logger("skills:watcher");

// Many filesystem events fire during a single install/uninstall (file copies,
// rename-to-rename, etc). Debouncing keeps the WS fan-out cheap; 250ms is
// short enough that the UI feels live and long enough to coalesce a burst.
const DEBOUNCE_MS = 250;

export function startSkillsWatcher(config: Config): () => void {
	if (process.env.NPI_DECK_WATCH_SKILLS === "0") {
		log.info("skills watcher disabled via NPI_DECK_WATCH_SKILLS=0");
		return () => {};
	}

	const roots = [
		// Native: user-level OMP skills
		path.join(sdk().getAgentDir(), "skills"),
		// Native: project-level skills for the deck's default cwd. Other
		// project cwds get coverage by the manual-refetch path via WS.
		path.join(config.defaultCwd, ".omp", "skills"),
		// Marketplace plugin cache (Claude-plugin format)
		sdk().getPluginsCacheDir(),
	];

	const watchers: FSWatcher[] = [];
	let pending: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const fire = (): void => {
		if (disposed) return;
		broadcastBus.broadcast({ type: "skills_changed" });
	};

	const schedule = (): void => {
		if (pending) clearTimeout(pending);
		pending = setTimeout(fire, DEBOUNCE_MS);
	};

	for (const root of roots) {
		if (!existsSync(root)) {
			log.info(`skipping ${root} (does not exist yet)`);
			continue;
		}
		try {
			const w = watch(root, { recursive: true, persistent: false }, () => {
				schedule();
			});
			w.on("error", (err) => {
				log.warn(`watcher error at ${root}, stopping that root`, err);
				try {
					w.close();
				} catch {
					// best-effort
				}
			});
			watchers.push(w);
			log.info(`watching ${root}`);
		} catch (err) {
			log.warn(`failed to start watcher at ${root} (cockpit will rely on manual refresh)`, err);
		}
	}

	if (watchers.length === 0) {
		log.warn("no skill roots watchable; UI will need manual refresh");
	}

	return function disposeWatcher(): void {
		disposed = true;
		if (pending) {
			clearTimeout(pending);
			pending = undefined;
		}
		for (const w of watchers) {
			try {
				w.close();
			} catch {
				// best-effort
			}
		}
		watchers.length = 0;
	};
}
