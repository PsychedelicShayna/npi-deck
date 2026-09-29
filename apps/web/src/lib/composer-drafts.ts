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
 * Most unsent drafts kept. Read-only chats stay in the store until the page
 * reloads, so the drafts touched least recently are dropped past this.
 */
export const MAX_DRAFTS = 20;

/**
 * Most image data held across the drafts of chats not on screen, counted in
 * string length of each image's base64 `data` and its `preview` data URL
 * (both are held). Past it, the least recently touched drafts lose their
 * images first; their text stays.
 */
export const MAX_DRAFT_IMAGE_CHARS = 64 * 1024 * 1024;

/**
 * Unsent composer drafts by session id, oldest-touched first. The composer
 * remounts per session, so text typed for one chat is never sent to another
 * and is still there when the reader switches back.
 */
const drafts = new Map<string, ComposerDraft>();

function imageChars(draft: ComposerDraft): number {
	let chars = 0;
	for (const image of draft.images) chars += image.data.length + image.preview.length;
	return chars;
}

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
	// The draft being saved is the one on screen; its images are in the
	// composer anyway. Older drafts give up theirs, oldest first.
	let chars = 0;
	for (const d of drafts.values()) chars += imageChars(d);
	for (const [id, d] of drafts) {
		if (chars <= MAX_DRAFT_IMAGE_CHARS || id === sessionId) break;
		if (d.images.length === 0) continue;
		chars -= imageChars(d);
		if (d.text) drafts.set(id, { text: d.text, images: [] });
		else drafts.delete(id);
	}
}

export function dropDraft(sessionId: string): void {
	drafts.delete(sessionId);
}
