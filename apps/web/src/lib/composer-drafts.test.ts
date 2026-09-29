import { afterEach, expect, test } from "bun:test";
import { dropDraft, MAX_DRAFT_IMAGE_CHARS, MAX_DRAFTS, readDraft, saveDraft, type PendingImage } from "./composer-drafts";

const ids = Array.from({ length: MAX_DRAFTS + 2 }, (_, i) => `s${i}`);
afterEach(() => { for (const id of ids) dropDraft(id); });

/** An attachment whose base64 and preview together hold `chars` characters. */
function image(chars: number): PendingImage {
	const data = "A".repeat(chars / 2);
	return { id: crypto.randomUUID(), type: "image", mimeType: "image/png", data, preview: data };
}

test("past the cap, the draft touched least recently is dropped", () => {
	for (const id of ids.slice(0, MAX_DRAFTS)) saveDraft(id, { text: `draft ${id}`, images: [] });
	// Reopening s0 makes it recent; s1 is now the oldest.
	expect(readDraft("s0")?.text).toBe("draft s0");
	saveDraft(ids[MAX_DRAFTS]!, { text: "one more", images: [] });
	expect(readDraft("s1")).toBeUndefined();
	expect(readDraft("s0")?.text).toBe("draft s0");
	expect(readDraft(ids[MAX_DRAFTS]!)?.text).toBe("one more");
});

test("an emptied draft is not kept", () => {
	saveDraft("s0", { text: "typed", images: [] });
	saveDraft("s0", { text: "", images: [] });
	expect(readDraft("s0")).toBeUndefined();
});

test("past the image budget, the oldest drafts lose their images first and keep their text", () => {
	const third = Math.floor(MAX_DRAFT_IMAGE_CHARS / 3) + 1024;
	saveDraft("s0", { text: "t0", images: [image(third)] });
	saveDraft("s1", { text: "", images: [image(third)] });
	saveDraft("s2", { text: "t2", images: [image(third)] });
	// Three thirds plus a little: only the oldest gives up its images.
	expect(readDraft("s0")).toEqual({ text: "t0", images: [] });
	expect(readDraft("s1")?.images).toHaveLength(1);
	expect(readDraft("s2")?.images).toHaveLength(1);

	// A draft on screen keeps its images even alone over the budget; an
	// image-only draft that loses its images is gone.
	saveDraft("s3", { text: "t3", images: [image(MAX_DRAFT_IMAGE_CHARS + 2)] });
	expect(readDraft("s1")).toBeUndefined();
	expect(readDraft("s2")).toEqual({ text: "t2", images: [] });
	expect(readDraft("s3")?.images).toHaveLength(1);
});
