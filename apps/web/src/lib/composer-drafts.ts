import type { ImageAttachment } from "@npi-deck/protocol";

/** An image attached in the composer: the wire payload plus its local id and preview. */
export interface PendingImage extends ImageAttachment {
	id: string;
	preview: string;
}

export interface ComposerDraft {
	text: string;
	images: PendingImage[];
}

/**
 * Most unsent drafts kept. Pasted images are held as base64, and read-only
 * chats stay in the store until the page reloads, so the drafts touched
 * least recently are dropped past this.
 */
export const MAX_DRAFTS = 20;

/**
 * Unsent composer drafts by session id, oldest-touched first. The composer
 * remounts per session, so text typed for one chat is never sent to another
 * and is still there when the reader switches back.
 */
const drafts = new Map<string, ComposerDraft>();

export function readDraft(sessionId: string): ComposerDraft | undefined {
	const draft = drafts.get(sessionId);
	if (draft) {
		drafts.delete(sessionId);
		drafts.set(sessionId, draft);
	}
	return draft;
}

/** Store the session's draft as the most recent; an empty draft is dropped. */
export function saveDraft(sessionId: string, draft: ComposerDraft): void {
	drafts.delete(sessionId);
	if (!draft.text && draft.images.length === 0) return;
	drafts.set(sessionId, draft);
	for (const oldest of drafts.keys()) {
		if (drafts.size <= MAX_DRAFTS) break;
		drafts.delete(oldest);
	}
}

export function dropDraft(sessionId: string): void {
	drafts.delete(sessionId);
}
