/**
 * Watcher rooted at the KB. Fires a debounced `kb_changed` broadcast on any
 * mutation under the watched tree and invalidates the KbService index so
 * the next read sees fresh data. Events under paths the cockpit hides (the
 * skip set, `NPI_DECK_KB_EXCLUDE_DIRS`, `.kbignore`) are dropped; an edit
 * to `.kbignore` itself always fires, which is how its rules hot-reload.
 *
 * Gated by `NPI_DECK_WATCH_KB`. Per-root errors degrade to no-op (the
 * cockpit still works; the UI just needs manual refresh on changes). On
 * platforms without recursive watch (Linux without `--recursive` support
 * in older Node/Bun), the cockpit shows a warning at startup — handled
 * by wrapping `fs.watch` in try/catch.
 */

import { existsSync, watch, type FSWatcher } from "node:fs";

import { broadcastBus } from "./broadcast-bus.ts";
import type { KbService } from "./kb-service.ts";
import { logger } from "./log.ts";

const log = logger("kb:watcher");

const DEBOUNCE_MS = 250;

export function startKbWatcher(service: KbService): () => void {
	if (process.env.NPI_DECK_WATCH_KB === "0") {
		log.info("kb watcher disabled via NPI_DECK_WATCH_KB=0");
		return () => {};
	}

	const root = service.root;
	if (!existsSync(root)) {
		log.warn(`kb root does not exist; watcher inactive: ${root}`);
		return () => {};
	}

	let watcher: FSWatcher | undefined;
	let pending: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const fire = (): void => {
		if (disposed) return;
		service.invalidate();
		broadcastBus.broadcast({ type: "kb_changed" });
	};

	const schedule = (): void => {
		if (pending) clearTimeout(pending);
		pending = setTimeout(fire, DEBOUNCE_MS);
	};

	try {
		watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
			if (filename && service.isWatchEventIgnored(filename.toString())) return;
			schedule();
		});
		watcher.on("error", (err) => {
			log.warn(`watcher error at ${root}, stopping`, err);
			try {
				watcher?.close();
			} catch {
				// best-effort
			}
			watcher = undefined;
		});
		log.info(`watching ${root} for kb_changed broadcasts`);
	} catch (err) {
		log.warn(`failed to start watcher at ${root} (cockpit will rely on manual refresh)`, err);
		watcher = undefined;
	}

	return function disposeWatcher(): void {
		disposed = true;
		if (pending) {
			clearTimeout(pending);
			pending = undefined;
		}
		if (watcher) {
			try {
				watcher.close();
			} catch {
				// best-effort
			}
			watcher = undefined;
		}
	};
}
