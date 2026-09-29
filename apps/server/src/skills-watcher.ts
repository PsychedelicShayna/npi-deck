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
 * `skills_changed` broadcast so the UI refetches without polling. Each
 * broadcast first drops NeoPi's capability read cache, which otherwise keeps
 * serving a SKILL.md's old frontmatter to the listing after it changes.
 *
 * A root that does not exist yet is watched through its nearest existing
 * ancestor and armed once it appears, so the first skill authored into a fresh
 * agent dir (from the deck or by hand) still reaches the UI. A root that is
 * deleted goes back to that state.
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
import { forgetCachedSkillReads } from "./skill-authoring.ts";

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

	let pending: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const fire = (): void => {
		if (disposed) return;
		forgetCachedSkillReads();
		broadcastBus.broadcast({ type: "skills_changed" });
	};

	const schedule = (): void => {
		if (pending) clearTimeout(pending);
		pending = setTimeout(fire, DEBOUNCE_MS);
	};

	const stopWatching = watchSkillRoots(roots, schedule);

	return function disposeWatcher(): void {
		disposed = true;
		if (pending) {
			clearTimeout(pending);
			pending = undefined;
		}
		stopWatching();
	};
}

/**
 * Watch each root recursively and call `onChange` for every event under it.
 * A missing root is armed when it appears (and `onChange` fires then, since
 * files may have landed before the watch did); a deleted root waits again.
 * Returns the disposer.
 */
export function watchSkillRoots(roots: readonly string[], onChange: () => void): () => void {
	const watchers = new Set<FSWatcher>();
	let disposed = false;

	const close = (w: FSWatcher): void => {
		watchers.delete(w);
		try {
			w.close();
		} catch {
			// best-effort
		}
	};

	const open = (dir: string, recursive: boolean, listener: () => void): FSWatcher | undefined => {
		try {
			const w = watch(dir, { recursive, persistent: false }, listener);
			w.on("error", (err) => {
				log.warn(`watcher error at ${dir}, stopping that root`, err);
				close(w);
			});
			watchers.add(w);
			return w;
		} catch (err) {
			log.warn(`failed to start watcher at ${dir} (cockpit will rely on manual refresh)`, err);
			return undefined;
		}
	};

	const arm = (root: string): void => {
		if (disposed) return;
		if (existsSync(root)) {
			const w = open(root, true, () => {
				if (!existsSync(root)) {
					close(w!);
					arm(root);
				}
				onChange();
			});
			if (w) log.info(`watching ${root}`);
			return;
		}
		let ancestor = path.dirname(root);
		while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
		// The path component below `ancestor` on the way to `root`: once it exists, move one level closer.
		const next = path.join(ancestor, path.relative(ancestor, root).split(path.sep)[0]!);
		const w = open(ancestor, false, () => {
			if (!existsSync(next)) return;
			close(w!);
			arm(root);
			if (existsSync(root)) onChange();
		});
		if (w) log.info(`${root} does not exist yet; watching ${ancestor} for it`);
	};

	for (const root of roots) arm(root);

	return function stop(): void {
		disposed = true;
		for (const w of [...watchers]) close(w);
	};
}
