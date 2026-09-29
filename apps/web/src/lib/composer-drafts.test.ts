import { afterEach, expect, test } from "bun:test";
import { dropDraft, MAX_DRAFTS, readDraft, saveDraft } from "./composer-drafts";

const ids = Array.from({ length: MAX_DRAFTS + 2 }, (_, i) => `s${i}`);
afterEach(() => { for (const id of ids) dropDraft(id); });

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
