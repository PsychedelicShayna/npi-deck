/**
 * Composer prompt history (npi-deck T-10).
 *
 * Mirrors the omp TUI's `editor.addToHistory(text)` muscle memory: ArrowUp
 * recalls past prompts, ArrowDown walks back toward the live draft. The hook
 * splits cleanly into a pure {@link ComposerHistoryStore} (used by unit tests
 * and by the React wrapper) and {@link useComposerHistory}, which adds
 * localStorage persistence keyed by the active workspace cwd so two windows
 * pointed at different repos do not bleed prompts across each other.
 *
 * The store is intentionally ref-shaped, not React state: callers want to
 * read/walk on every keystroke without re-rendering the whole composer.
 */
import { useCallback, useEffect, useRef } from "react";

export const MAX_HISTORY = 100;
export const PERSIST_DEBOUNCE_MS = 500;
const STORAGE_PREFIX = "npi-deck:composer-history:";

function storageKey(cwd: string): string {
	return `${STORAGE_PREFIX}${cwd}`;
}

function readStoredHistory(cwd: string): string[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const raw = localStorage.getItem(storageKey(cwd));
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		const out: string[] = [];
		for (const item of parsed) {
			if (typeof item === "string" && item.length > 0) out.push(item);
		}
		// Honor the cap even on load, in case a previous build stored more.
		return out.length > MAX_HISTORY ? out.slice(out.length - MAX_HISTORY) : out;
	} catch {
		return [];
	}
}

function writeStoredHistory(cwd: string, entries: ReadonlyArray<string>): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(storageKey(cwd), JSON.stringify(entries));
	} catch {
		// Quota / disabled storage / private mode — silently degrade to in-memory only.
	}
}

export interface ComposerHistoryStore {
	/** Read-only view of the entries (oldest first, newest last). */
	snapshot(): ReadonlyArray<string>;
	/**
	 * Record a sent prompt at the newest end. Consecutive duplicates collapse,
	 * and a recall-then-send-unmodified is a no-op so walking history does not
	 * pollute it. Sets pointer back to the live-draft slot.
	 */
	push(text: string): void;
	/**
	 * Walk one entry older. Returns the recalled text, or null when there is
	 * nothing to recall. On the first up() the caller's live draft is stashed
	 * so down()-past-newest can restore it.
	 */
	up(currentDraft: string): string | null;
	/**
	 * Walk one entry newer. Returns the recalled text; when stepping past the
	 * newest entry it returns the stashed live draft and exits walking mode.
	 * Returns null when not currently walking.
	 */
	down(): string | null;
	/** Clear walking state without touching entries. */
	reset(): void;
	isWalking(): boolean;
}

/**
 * Build a fresh, in-memory history store. Tests use this directly; the React
 * hook layers localStorage persistence on top.
 */
export function createComposerHistoryStore(initial: ReadonlyArray<string> = []): ComposerHistoryStore {
	const entries: string[] = [];
	for (const e of initial) {
		if (typeof e === "string" && e.length > 0) entries.push(e);
	}
	if (entries.length > MAX_HISTORY) entries.splice(0, entries.length - MAX_HISTORY);

	let pointer = -1; // -1 == not walking; sits past the newest entry
	let savedDraft = "";
	let lastRecalled: string | null = null;

	function push(text: string): void {
		// Don't store empty sends — the composer's send() already guards on
		// content, but defense in depth keeps the store invariant tight.
		if (text.length === 0) {
			lastRecalled = null;
			pointer = -1;
			return;
		}
		// Recall-then-send-unmodified: caller pushed the exact text we last
		// handed back. Don't double-record it.
		if (lastRecalled !== null && text === lastRecalled) {
			lastRecalled = null;
			pointer = -1;
			return;
		}
		// De-dupe consecutive identical sends (e.g. user retries the same prompt).
		const last = entries[entries.length - 1];
		if (last !== text) {
			entries.push(text);
			if (entries.length > MAX_HISTORY) entries.splice(0, entries.length - MAX_HISTORY);
		}
		lastRecalled = null;
		pointer = -1;
		savedDraft = "";
	}

	function up(currentDraft: string): string | null {
		if (entries.length === 0) return null;
		if (pointer === -1) {
			savedDraft = currentDraft;
			pointer = entries.length - 1;
		} else if (pointer > 0) {
			pointer -= 1;
		}
		// At pointer 0 with another up(), we stay pinned at the oldest entry
		// — standard shell behavior.
		const recalled = entries[pointer] ?? null;
		lastRecalled = recalled;
		return recalled;
	}

	function down(): string | null {
		if (pointer === -1) return null;
		if (pointer < entries.length - 1) {
			pointer += 1;
			const recalled = entries[pointer] ?? null;
			lastRecalled = recalled;
			return recalled;
		}
		// Step past newest entry — restore the stashed live draft and exit
		// walking mode. The returned string may be empty, which is correct;
		// the composer treats empty draft as "no walking".
		const draft = savedDraft;
		pointer = -1;
		savedDraft = "";
		lastRecalled = null;
		return draft;
	}

	function reset(): void {
		pointer = -1;
		savedDraft = "";
		lastRecalled = null;
	}

	return {
		snapshot: () => entries.slice(),
		push,
		up,
		down,
		reset,
		isWalking: () => pointer !== -1,
	};
}

/**
 * Composer-history hook. Loads any persisted entries for `cwd` on mount and
 * whenever cwd changes, debounces writes back to localStorage, and flushes
 * pending writes on cwd change / unmount.
 *
 * Returned store is stable across renders — the caller can read it from a
 * keydown handler without re-binding on every keystroke.
 */
export function useComposerHistory(cwd: string | undefined): ComposerHistoryStore {
	// Empty cwd → in-memory only, no persistence. Keeps the contract simple
	// when there's no active session yet.
	const storeRef = useRef<ComposerHistoryStore | null>(null);
	if (storeRef.current === null) storeRef.current = createComposerHistoryStore();

	const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cwdRef = useRef<string | undefined>(cwd);

	const flushPersist = useCallback((): void => {
		if (persistTimerRef.current !== null) {
			clearTimeout(persistTimerRef.current);
			persistTimerRef.current = null;
		}
		const c = cwdRef.current;
		const store = storeRef.current;
		if (!c || !store) return;
		writeStoredHistory(c, store.snapshot());
	}, []);

	const schedulePersist = useCallback((): void => {
		if (!cwdRef.current) return;
		if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
		persistTimerRef.current = setTimeout(() => {
			persistTimerRef.current = null;
			const c = cwdRef.current;
			const store = storeRef.current;
			if (!c || !store) return;
			writeStoredHistory(c, store.snapshot());
		}, PERSIST_DEBOUNCE_MS);
	}, []);

	// Reload entries whenever cwd changes. We rebuild the store rather than
	// mutating in place so any pointer/savedDraft state from the previous
	// workspace is dropped — recalling a prompt typed against project A into
	// project B's composer would be confusing.
	useEffect(() => {
		// Flush any pending write to the *previous* cwd before swapping.
		flushPersist();
		cwdRef.current = cwd;
		const initial = cwd ? readStoredHistory(cwd) : [];
		storeRef.current = createComposerHistoryStore(initial);
	}, [cwd, flushPersist]);

	// On unmount, write whatever's pending so a quick send-then-close-tab
	// doesn't lose the last entry.
	useEffect(() => {
		return () => {
			flushPersist();
		};
	}, [flushPersist]);

	// Stable facade — methods read through to the live storeRef so React's
	// referential identity doesn't trip up downstream memoization.
	const facade = useRef<ComposerHistoryStore>({
		snapshot: () => storeRef.current?.snapshot() ?? [],
		push: (text) => {
			storeRef.current?.push(text);
			schedulePersist();
		},
		up: (currentDraft) => storeRef.current?.up(currentDraft) ?? null,
		down: () => storeRef.current?.down() ?? null,
		reset: () => storeRef.current?.reset(),
		isWalking: () => storeRef.current?.isWalking() ?? false,
	});

	return facade.current;
}
