import { describe, expect, test } from "bun:test";

import { MAX_RENDERED, MESSAGE_PAGE, windowRange } from "./transcript-window";

const msgs = (n: number, prefix = "m") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));

describe("windowRange", () => {
	test("an unanchored window shows only the newest page and follows new messages", () => {
		expect(windowRange(msgs(MESSAGE_PAGE * 3), undefined)).toEqual({ start: MESSAGE_PAGE * 2, end: MESSAGE_PAGE * 3 });
		expect(windowRange(msgs(5), undefined)).toEqual({ start: 0, end: 5 });
	});

	test("a pinned window keeps its messages and counts newer ones instead of mounting them", () => {
		const anchor = { id: "m460", fromEnd: 40, count: 40 };
		expect(windowRange(msgs(500), anchor)).toEqual({ start: 460, end: 500 });
		// 400 messages stream in while the reader is scrolled up.
		expect(windowRange(msgs(900), anchor)).toEqual({ start: 460, end: 500 });
	});

	test("no anchor mounts more than MAX_RENDERED messages", () => {
		expect(windowRange(msgs(5000), { id: "m100", fromEnd: 4900, count: 4900 })).toEqual({ start: 100, end: 100 + MAX_RENDERED });
	});

	test("replaced messages keep the window's distance from the newest", () => {
		// A read-only transcript's full load rebuilds the tail under new ids.
		expect(windowRange(msgs(5000, "full"), { fromEnd: 240, count: 240 })).toEqual({ start: 4760, end: 5000 });
		// A resumed chat's live snapshot is shorter than the anchor's reach.
		expect(windowRange(msgs(100, "live"), { id: "m0", fromEnd: 240, count: 240 })).toEqual({ start: 0, end: 100 });
	});
});
