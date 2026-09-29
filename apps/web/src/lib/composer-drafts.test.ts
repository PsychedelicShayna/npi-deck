import { afterEach, beforeEach, expect, test } from "bun:test";
import { dropDraft, readDraft, saveDraft, type PendingImage } from "./composer-drafts";

const MiB = 1024 * 1024;
const ids = Array.from({ length: 25 }, (_, i) => `s${i}`);
const originalRevoke = URL.revokeObjectURL;
let revoked: string[] = [];

beforeEach(() => {
	revoked = [];
	URL.revokeObjectURL = (url: string) => { revoked.push(url); };
});
afterEach(() => {
	for (const id of ids) dropDraft(id);
	URL.revokeObjectURL = originalRevoke;
});

/** A pasted image of `bytes` bytes; its preview URL is named for the assertions. */
function image(name: string, bytes: number): PendingImage {
	return { id: name, file: new Blob([new Uint8Array(bytes)], { type: "image/png" }), mimeType: "image/png", preview: `blob:${name}` };
}

test("text drafts are never evicted, however many chats have one", () => {
	for (const id of ids) saveDraft(id, { text: `draft ${id}`, images: [] });
	expect(ids.map((id) => readDraft(id)?.text)).toEqual(ids.map((id) => `draft ${id}`));
});

test("an emptied draft is not kept", () => {
	saveDraft("s0", { text: "typed", images: [] });
	saveDraft("s0", { text: "", images: [] });
	expect(readDraft("s0")).toBeUndefined();
});

test("two 20 MiB images in one draft fit the budget", () => {
	saveDraft("s0", { text: "[Image #1] [Image #2] compare", images: [image("a", 20 * MiB), image("b", 20 * MiB)] });
	saveDraft("s1", { text: "other chat", images: [] });
	expect(readDraft("s0")?.images).toHaveLength(2);
	expect(revoked).toEqual([]);
});

test("past the image budget, the oldest draft loses its images, their placeholders, and says so", () => {
	saveDraft("s0", { text: "look at [Image #1] and [Image #2] please", images: [image("a", 30 * MiB), image("b", 10 * MiB)] });
	saveDraft("s1", { text: "", images: [image("c", 20 * MiB)] });
	saveDraft("s2", { text: "[Image #1]", images: [image("d", 20 * MiB)] });
	// 80 MiB held: s0, the oldest, gives up its 40 MiB; s1 and s2 keep theirs.
	expect(readDraft("s0")).toEqual({ text: "look at and please", images: [], droppedImages: 2 });
	expect(revoked).toEqual(["blob:a", "blob:b"]);
	expect(readDraft("s1")?.images).toHaveLength(1);
	expect(readDraft("s2")?.images).toHaveLength(1);
});

test("an image-only draft that loses its images stays, to report the loss", () => {
	saveDraft("s0", { text: "[Image #1] ", images: [image("a", 50 * MiB)] });
	saveDraft("s1", { text: "hi", images: [image("b", 20 * MiB)] });
	expect(readDraft("s0")).toEqual({ text: "", images: [], droppedImages: 1 });
	// Once the composer has shown it and saved the draft back, it is gone.
	saveDraft("s0", { text: "", images: [] });
	expect(readDraft("s0")).toBeUndefined();
});

test("closing a chat releases its draft's images", () => {
	saveDraft("s0", { text: "x", images: [image("a", 1024)] });
	dropDraft("s0");
	expect(revoked).toEqual(["blob:a"]);
	expect(readDraft("s0")).toBeUndefined();
});
