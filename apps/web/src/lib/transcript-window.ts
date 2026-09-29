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
 * Where the rendered window starts. `id` pins it to a message; `fromEnd`
 * counts from the newest message and places the window when `id` is unset or
 * gone (the messages were replaced, e.g. a resumed chat's live snapshot or a
 * read-only transcript's full load).
 */
export interface WindowAnchor {
	id?: string;
	fromEnd: number;
}

/**
 * Index of the first rendered message. Unanchored, the window is the newest
 * `MESSAGE_PAGE` messages.
 */
export function windowStart(messages: readonly Pick<ChatMessage, "id">[], anchor: WindowAnchor | undefined): number {
	if (anchor?.id !== undefined) {
		const pinned = messages.findIndex((m) => m.id === anchor.id);
		if (pinned >= 0) return pinned;
	}
	return Math.max(0, messages.length - (anchor?.fromEnd ?? MESSAGE_PAGE));
}
