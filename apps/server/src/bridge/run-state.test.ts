/**
 * The reaper disposes a session only while `turnInFlight` is false. NeoPi's
 * `agent_end` can be non-terminal (a queued or async continuation resumes the
 * run), and `turn_end` fires between the turns of one run: neither may mark
 * the session idle, or the reaper kills a live run.
 */
import { describe, expect, test } from "bun:test";

import { nextTurnInFlight } from "./in-process.ts";

function replay(events: Array<{ type: string; isTerminal?: boolean }>): boolean[] {
	let busy = false;
	return events.map((e) => (busy = nextTurnInFlight(busy, e)));
}

describe("nextTurnInFlight", () => {
	test("a multi-turn run with a non-terminal agent_end stays busy until the terminal one", () => {
		expect(
			replay([
				{ type: "agent_start" },
				{ type: "turn_start" },
				{ type: "turn_end" },
				{ type: "agent_end", isTerminal: false },
				{ type: "turn_start" },
				{ type: "turn_end" },
				{ type: "agent_end" },
			]),
		).toEqual([true, true, true, true, true, true, false]);
	});

	test("agent_end with isTerminal: true settles the run", () => {
		expect(replay([{ type: "agent_start" }, { type: "agent_end", isTerminal: true }])).toEqual([true, false]);
	});
});
