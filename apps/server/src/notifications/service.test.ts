/**
 * Tests for NotificationService. Covers:
 *   - default-sound rules per level
 *   - envelope shape (id, timestamp stamped on)
 *   - multi-channel fan-out + error isolation
 *   - register/unregister/listChannels
 *
 * Uses an in-memory test channel — no WS plumbing required.
 */

import { describe, expect, test } from "bun:test";

import { NotificationService } from "./service.ts";
import type {
	NotificationChannel,
	NotificationEnvelope,
	NotificationLevel,
} from "./types.ts";

/** Channel that records every envelope it receives in order. */
class RecordingChannel implements NotificationChannel {
	readonly id: string;
	readonly received: NotificationEnvelope[] = [];

	constructor(id = "recording") {
		this.id = id;
	}

	deliver(envelope: NotificationEnvelope): void {
		this.received.push(envelope);
	}
}

/** Channel whose deliver always throws — used to verify isolation. */
class FailingChannel implements NotificationChannel {
	readonly id = "failing";
	deliver(): void {
		throw new Error("simulated channel failure");
	}
}

describe("NotificationService", () => {
	test("envelope gets a uuid + iso timestamp", async () => {
		const svc = new NotificationService();
		const channel = new RecordingChannel();
		svc.register(channel);

		const env = (await svc.notify({ kind: "routine_failed", level: "info", title: "hello" }))!;

		expect(env.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		expect(env.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		expect(channel.received).toHaveLength(1);
		expect(channel.received[0]?.id).toBe(env.id);
	});

	test("default sound: info silent, warn+ audible", async () => {
		const svc = new NotificationService();
		const ch = new RecordingChannel();
		svc.register(ch);

		await svc.notify({ kind: "routine_failed", level: "info", title: "i" });
		await svc.notify({ kind: "routine_failed", level: "warn", title: "w" });
		await svc.notify({ kind: "routine_failed", level: "error", title: "e" });
		await svc.notify({ kind: "routine_failed", level: "critical", title: "c" });

		expect(ch.received.map((e) => e.sound)).toEqual([false, true, true, true]);
	});

	test("explicit sound:false suppresses tone even on critical", async () => {
		const svc = new NotificationService();
		const ch = new RecordingChannel();
		svc.register(ch);

		await svc.notify({ kind: "routine_failed", level: "critical", title: "silent crit", sound: false });

		expect(ch.received[0]?.sound).toBe(false);
	});

	test("multi-channel fan-out: every channel receives the same envelope", async () => {
		const svc = new NotificationService();
		const a = new RecordingChannel("a");
		const b = new RecordingChannel("b");
		svc.register(a);
		svc.register(b);

		const env = (await svc.notify({ kind: "routine_failed", level: "warn", title: "fan-out" }))!;

		expect(a.received).toHaveLength(1);
		expect(b.received).toHaveLength(1);
		expect(a.received[0]?.id).toBe(env.id);
		expect(b.received[0]?.id).toBe(env.id);
	});

	test("one failing channel does not block siblings", async () => {
		const svc = new NotificationService();
		const failing = new FailingChannel();
		const good = new RecordingChannel("good");
		svc.register(failing);
		svc.register(good);

		await svc.notify({ kind: "routine_failed", level: "error", title: "isolate-me" });

		expect(good.received).toHaveLength(1);
		expect(good.received[0]?.title).toBe("isolate-me");
	});

	test("register replaces existing channel with same id", async () => {
		const svc = new NotificationService();
		const first = new RecordingChannel("dup");
		const second = new RecordingChannel("dup");
		svc.register(first);
		svc.register(second);

		await svc.notify({ kind: "routine_failed", level: "info", title: "x" });

		expect(svc.listChannels()).toEqual(["dup"]);
		expect(first.received).toHaveLength(0);
		expect(second.received).toHaveLength(1);
	});

	test("unregister removes channel", async () => {
		const svc = new NotificationService();
		const ch = new RecordingChannel("temp");
		svc.register(ch);

		expect(svc.unregister("temp")).toBe(true);
		expect(svc.unregister("temp")).toBe(false);

		await svc.notify({ kind: "routine_failed", level: "info", title: "after-unreg" });

		expect(ch.received).toHaveLength(0);
	});

	test("no channels registered: notify still returns an envelope", async () => {
		const svc = new NotificationService();

		const env = (await svc.notify({ kind: "routine_failed", level: "info", title: "into the void" }))!;

		expect(env.title).toBe("into the void");
		expect(env.id).toBeTruthy();
	});

	test("all level values accepted", async () => {
		const svc = new NotificationService();
		const ch = new RecordingChannel();
		svc.register(ch);

		const levels: NotificationLevel[] = ["info", "warn", "error", "critical"];
		for (const level of levels) {
			await svc.notify({ kind: "routine_failed", level, title: `t-${level}` });
		}

		expect(ch.received.map((e) => e.level)).toEqual(levels);
	});

	test("envelope preserves optional fields", async () => {
		const svc = new NotificationService();
		const ch = new RecordingChannel();
		svc.register(ch);

		await svc.notify({
			kind: "routine_failed",
			level: "warn",
			title: "with-extras",
			body: "more detail",
			source: "routine:foo/run:bar",
			actionUrl: "/routines/foo/runs/bar",
		});

		const env = ch.received[0];
		expect(env?.body).toBe("more detail");
		expect(env?.source).toBe("routine:foo/run:bar");
		expect(env?.actionUrl).toBe("/routines/foo/runs/bar");
	});
});
