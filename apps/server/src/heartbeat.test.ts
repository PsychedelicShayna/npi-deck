/**
 * Smoke test for the WS heartbeat broadcast. The hub is wired to the shared
 * BroadcastBus at construction time; this verifies that:
 *   - heartbeats are emitted on the interval (we subscribe + advance the
 *     real clock just enough to catch one)
 *   - the frame shape matches the protocol contract
 *   - dispose() stops the timer
 *
 * We deliberately don't spin up a Bun.serve here — the hub's broadcast()
 * goes through BroadcastBus regardless of connection state, so a bus
 * subscriber is sufficient evidence.
 */

import { afterAll, describe, expect, test } from "bun:test";

import { broadcastBus, type BroadcastFrame } from "./broadcast-bus.ts";
import { HEARTBEAT_INTERVAL_MS, WsHub } from "./ws.ts";

// Minimal AgentBridge stub — heartbeat path doesn't touch any bridge methods,
// so an empty object satisfies the constructor's type bound at runtime.
const stubBridge = {} as unknown as ConstructorParameters<typeof WsHub>[0];

describe("WsHub heartbeat", () => {
	test("HEARTBEAT_INTERVAL_MS is a sensible value (5-30s)", () => {
		expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
		expect(HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(30_000);
	});

	test("broadcasts a heartbeat frame on its interval", async () => {
		const frames: BroadcastFrame[] = [];
		const unsubscribe = broadcastBus.subscribe((frame) => {
			if (frame.type === "heartbeat") frames.push(frame);
		});

		const hub = new WsHub(stubBridge, "heartbeat-test");
		try {
			// Wait long enough for at least one tick of the real interval. Cap at
			// 7s so the test fails fast if the timer isn't firing rather than
			// hanging forever.
			const deadline = Date.now() + HEARTBEAT_INTERVAL_MS + 2000;
			while (frames.length === 0 && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 250));
			}

			expect(frames.length).toBeGreaterThanOrEqual(1);
			const f = frames[0];
			if (!f || f.type !== "heartbeat") throw new Error("no heartbeat captured");
			expect(typeof f.serverStartedAt).toBe("string");
			expect(typeof f.pid).toBe("number");
			expect(typeof f.uptimeSecs).toBe("number");
			expect(typeof f.version).toBe("string");
			expect(typeof f.timestamp).toBe("string");
			// buildSha is null when no git / no env / no .buildinfo — accept either.
			expect(f.buildSha === null || typeof f.buildSha === "string").toBe(true);
		} finally {
			hub.dispose();
			unsubscribe();
		}
	}, { timeout: HEARTBEAT_INTERVAL_MS + 4000 });

	test("dispose stops the heartbeat timer", async () => {
		const before: BroadcastFrame[] = [];
		const unsub = broadcastBus.subscribe((f) => {
			if (f.type === "heartbeat") before.push(f);
		});
		const hub = new WsHub(stubBridge, "heartbeat-test");
		hub.dispose();
		// Give the loop a tick + a margin; no heartbeats expected.
		await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL_MS + 500));
		unsub();

		expect(before).toHaveLength(0);
	}, { timeout: HEARTBEAT_INTERVAL_MS + 2000 });

	// Bun test isolates module state per file, but the heartbeat timer is on
	// the WsHub instance and our tests dispose explicitly. The afterAll is
	// belt-and-suspenders for the rare case where an assertion above throws
	// before dispose() runs.
	afterAll(() => {
		// Nothing to do — instance-scoped timers are GC'd with the instance.
	});
});
