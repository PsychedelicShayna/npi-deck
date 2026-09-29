/**
 * An image attached in the composer. The file is held once, as the browser's
 * Blob; its base64 is built only when the prompt is sent.
 */
export interface PendingImage {
	id: string;
	file: Blob;
	mimeType: string;
	/** Object URL for the thumbnail; revoked when the image is discarded. */
	preview: string;
}

export interface ComposerDraft {
	text: string;
	images: PendingImage[];
	/** Images dropped to save memory since the composer last showed this draft. */
	droppedImages?: number;
}

/**
 * Most image bytes held across the drafts of chats not on screen. Past it,
 * the least recently touched drafts lose their images first; their text
 * stays, without the images' placeholders.
 */
export const MAX_DRAFT_IMAGE_BYTES = 64 * 1024 * 1024;

/** The placeholder the composer types for each attached image. */
const IMAGE_PLACEHOLDER = /\[Image #\d+\] ?/g;

/**
 * Unsent composer drafts by session id, oldest-touched first. The composer
 * remounts per session, so text typed for one chat is never sent to another
 * and is still there when the reader switches back. A draft lives until its
 * session leaves the store; only its images can be evicted, never its text.
 */
const drafts = new Map<string, ComposerDraft>();

function imageBytes(draft: ComposerDraft): number {
	let bytes = 0;
	for (const image of draft.images) bytes += image.file.size;
	return bytes;
}

/** Let the browser free images nothing will show or send again. */
export function releaseImages(images: readonly PendingImage[]): void {
	for (const image of images) URL.revokeObjectURL(image.preview);
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
	if (!draft.text && draft.images.length === 0 && !draft.droppedImages) return;
	drafts.set(sessionId, draft);
	// The draft being saved is the one on screen; its images are in the
	// composer anyway. Older drafts give up theirs, oldest first, and say so
	// when the reader returns.
	let bytes = 0;
	for (const d of drafts.values()) bytes += imageBytes(d);
	for (const [id, d] of drafts) {
		if (bytes <= MAX_DRAFT_IMAGE_BYTES || id === sessionId) break;
		if (d.images.length === 0) continue;
		bytes -= imageBytes(d);
		releaseImages(d.images);
		drafts.set(id, {
			text: d.text.replace(IMAGE_PLACEHOLDER, ""),
			images: [],
			droppedImages: (d.droppedImages ?? 0) + d.images.length,
		});
	}
}

export function dropDraft(sessionId: string): void {
	const draft = drafts.get(sessionId);
	if (!draft) return;
	releaseImages(draft.images);
	drafts.delete(sessionId);
}
