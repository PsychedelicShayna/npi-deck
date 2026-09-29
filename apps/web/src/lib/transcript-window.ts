import type { ChatMessage } from "./types";

/**
 * Messages a chat renders when it opens, and how many more each "show
 * earlier" adds. A long session holds thousands of messages with expanded
 * tool cards; mounting them all at once blocked the page for tens of seconds.
 */
export const MESSAGE_PAGE = 40;

/**
 * Raw messages a read-only transcript fetches when it opens; the rest load
 * when the reader asks for them. A long session's full transcript is tens of
 * megabytes of JSON.
 */
export const TRANSCRIPT_TAIL = 200;

/**
 * Most messages a chat ever mounts at once. Past it, showing earlier messages
 * drops the newest ones from the bottom, and a pinned window stops growing as
 * new messages stream in. At least `TRANSCRIPT_TAIL + MESSAGE_PAGE`, so a
 * read-only transcript's full load still ends at its newest message.
 */
export const MAX_RENDERED = TRANSCRIPT_TAIL + MESSAGE_PAGE;

/**
 * A window pinned by the reader: it starts at message `id` and holds `count`
 * messages. `fromEnd` counts from the newest message and places the start
 * when `id` is unset or gone (the messages were replaced, e.g. a resumed
 * chat's live snapshot or a read-only transcript's full load).
 */
export interface WindowAnchor {
	id?: string;
	fromEnd: number;
	count: number;
}

/**
 * Rendered messages `[start, end)`. Unanchored, the window is the newest
 * `MESSAGE_PAGE` messages and follows new ones. Anchored, it never holds
 * more than `MAX_RENDERED`, so messages arriving while the reader is
 * scrolled up are counted, not mounted.
 */
export function windowRange(
	messages: readonly Pick<ChatMessage, "id">[],
	anchor: WindowAnchor | undefined,
): { start: number; end: number } {
	const len = messages.length;
	if (!anchor) return { start: Math.max(0, len - MESSAGE_PAGE), end: len };
	let start = anchor.id === undefined ? -1 : messages.findIndex((m) => m.id === anchor.id);
	if (start < 0) start = Math.max(0, len - anchor.fromEnd);
	return { start, end: Math.min(len, start + Math.min(anchor.count, MAX_RENDERED)) };
}
