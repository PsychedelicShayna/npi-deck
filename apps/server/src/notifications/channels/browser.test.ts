/**
 * Verifies the BrowserNotificationChannel emits a well-shaped `notification`
 * ServerFrame onto the BroadcastBus, and that optional fields are only
 * included when set (the protocol marks them optional, so undefineds should
 * not pollute the wire payload).
 */

import { describe, expect, test } from "bun:test";

import { broadcastBus, type BroadcastFrame } from "../../broadcast-bus.ts";
import { BrowserNotificationChannel } from "./browser.ts";

function captureFrames(): { frames: BroadcastFrame[]; dispose: () => void } {
	const frames: BroadcastFrame[] = [];
	const dispose = broadcastBus.subscribe((frame) => {
		frames.push(frame);
	});
	return { frames, dispose };
}

describe("BrowserNotificationChannel", () => {
	test("delivers a `notification` frame to the broadcast bus", () => {
		const { frames, dispose } = captureFrames();
		try {
			const channel = new BrowserNotificationChannel();
			channel.deliver({
				id: "n-1",
				kind: "routine_failed",
				level: "error",
				title: "boom",
				body: "details",
				sound: true,
				source: "routine:r1/run:u1",
				actionUrl: "/routines/r1/runs/u1",
				timestamp: "2026-05-23T20:00:00.000Z",
			});

			const got = frames.find((f) => f.type === "notification");
			expect(got).toBeDefined();
			if (got?.type !== "notification") throw new Error("frame missing");
			expect(got.id).toBe("n-1");
			expect(got.kind).toBe("routine_failed");
			expect(got.level).toBe("error");
			expect(got.title).toBe("boom");
			expect(got.body).toBe("details");
			expect(got.sound).toBe(true);
			expect(got.source).toBe("routine:r1/run:u1");
			expect(got.actionUrl).toBe("/routines/r1/runs/u1");
			expect(got.timestamp).toBe("2026-05-23T20:00:00.000Z");
		} finally {
			dispose();
		}
	});

	test("omits optional fields when caller doesn't set them", () => {
		const { frames, dispose } = captureFrames();
		try {
			const channel = new BrowserNotificationChannel();
			channel.deliver({
				id: "n-2",
				kind: "task_shipped",
				level: "info",
				title: "minimal",
				timestamp: "2026-05-23T20:00:00.000Z",
			});

			const got = frames.find((f) => f.type === "notification");
			expect(got).toBeDefined();
			if (got?.type !== "notification") throw new Error("frame missing");
			expect("body" in got).toBe(false);
			expect("sound" in got).toBe(false);
			expect("source" in got).toBe(false);
			expect("actionUrl" in got).toBe(false);
		} finally {
			dispose();
		}
	});

	test("channel id is the stable 'browser' string", () => {
		expect(new BrowserNotificationChannel().id).toBe("browser");
	});
});
