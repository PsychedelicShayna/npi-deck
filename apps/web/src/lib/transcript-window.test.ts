import { describe, expect, test } from "bun:test";

import { MESSAGE_PAGE, windowStart } from "./transcript-window";

const msgs = (n: number, prefix = "m") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));

describe("windowStart", () => {
	test("an unanchored window shows only the newest page", () => {
		expect(windowStart(msgs(MESSAGE_PAGE * 3), undefined)).toBe(MESSAGE_PAGE * 2);
		expect(windowStart(msgs(5), undefined)).toBe(0);
	});

	test("a pinned message stays first while newer messages arrive", () => {
		const anchor = { id: "m10", fromEnd: 490 };
		expect(windowStart(msgs(500), anchor)).toBe(10);
		expect(windowStart(msgs(900), anchor)).toBe(10);
	});

	test("replaced messages keep the window's distance from the newest", () => {
		// A read-only transcript's full load prepends older messages under new ids.
		expect(windowStart(msgs(5000, "full"), { id: "m0", fromEnd: 260 })).toBe(4740);
		// A resumed chat's live snapshot is shorter than the anchor's reach.
		expect(windowStart(msgs(100, "live"), { id: "m0", fromEnd: 260 })).toBe(0);
	});
});
