import { describe, expect, test } from "bun:test";

import { carryAnchor, MAX_RENDERED, MESSAGE_PAGE, windowRange } from "./transcript-window";

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

describe("carryAnchor across hiding tool calls (#62)", () => {
	// 1000 messages; every message not divisible by 4 is a tool-only reply.
	const all = msgs(1000);
	const prose = all.filter((_, i) => i % 4 === 0);
	const ids = (list: Array<{ id: string }>, r: { start: number; end: number }) => list.slice(r.start, r.end).map((m) => m.id);

	test("hiding keeps the reader's stretch of the transcript, a page at least", () => {
		// Scrolled up to m401..m480, which starts on a tool-only reply.
		const shown = { start: 401, end: 481 };
		const r = windowRange(prose, carryAnchor(all, all, shown, prose));
		expect(ids(prose, r)[0]).toBe("m404");
		expect(ids(prose, r)).toContain("m480");
		expect(r.end - r.start).toBe(MESSAGE_PAGE);
	});

	test("showing again mounts the tool-only replies inside the same stretch", () => {
		const shown = windowRange(prose, { id: "m400", fromEnd: 150, count: 60 });
		const r = windowRange(all, carryAnchor(all, prose, shown, all));
		expect(ids(all, r)[0]).toBe("m400");
		expect(ids(all, r).at(-1)).toBe("m636");
		// New messages below stay counted, not mounted.
		expect(all.length - r.end).toBe(363);
	});

	test("a stretch with nothing left to show falls back to the next shown message, else the newest", () => {
		const toolOnly = { start: 401, end: 404 };
		expect(carryAnchor(all, all, toolOnly, prose).id).toBe("m404");
		expect(carryAnchor(all, all, { start: 997, end: 1000 }, prose).id).toBe("m996");
	});
});
