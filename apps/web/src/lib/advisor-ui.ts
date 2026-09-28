import { create } from "zustand";

/** Which chat has the "choose advisors" picker open (composer button or `/advisors`). */
export const useAdvisorPicker = create<{ openFor: string | null; open(sessionId: string): void; close(): void }>()(set => ({
	openFor: null,
	open: sessionId => set({ openFor: sessionId }),
	close: () => set({ openFor: null }),
}));

/**
 * Per-chat panel memory, kept across reloads. Timestamps are advisor-note
 * timestamps: `dismissedThrough` hides the panel until a newer note arrives,
 * `seenThrough` marks notes already read in the expanded panel.
 */
export interface AdvisorPanelMemory { collapsed: boolean; dismissedThrough: number | null; seenThrough: number }

const KEY = "npi-deck:advisor-panel";
const KEEP = 100;
const EMPTY: AdvisorPanelMemory = { collapsed: false, dismissedThrough: null, seenThrough: 0 };

function readAll(): Record<string, AdvisorPanelMemory & { at: number }> {
	try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, AdvisorPanelMemory & { at: number }>; }
	catch { return {}; }
}

export function readPanelMemory(sessionId: string): AdvisorPanelMemory {
	const stored = readAll()[sessionId];
	return stored ? { collapsed: stored.collapsed, dismissedThrough: stored.dismissedThrough, seenThrough: stored.seenThrough } : EMPTY;
}

export function writePanelMemory(sessionId: string, memory: AdvisorPanelMemory): void {
	const all = readAll();
	all[sessionId] = { ...memory, at: Date.now() };
	// Keep the most recently touched chats only.
	const kept = Object.entries(all).sort(([, a], [, b]) => b.at - a.at).slice(0, KEEP);
	try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept))); } catch { /* storage full or disabled */ }
}
