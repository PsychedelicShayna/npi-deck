import { expect, test } from "bun:test";
import { latestErrorTerminal, mixtureSnapshotTraces } from "./mixture-snapshot.ts";

// Branch entries as NeoPi's SessionManager.getBranch() returns them.
const hop = (runId: string, seq: number, memberId: string, extra: Record<string, unknown> = {}) => ({
	type: "custom_message",
	customType: "mixture_trace",
	display: true,
	content: memberId,
	details: { v: 1, runId, mixture: "tea", seq, at: 100 + seq, kind: "hop", hop: seq, memberId, run: { status: "running", phase: "hop_ready", activeMemberId: "editor", hops: seq, usd: 0.02, window: { hops: seq, usd: 0.02 } }, ...extra },
});
const lifecycle = (data: Record<string, unknown>, timestamp?: string) => ({ type: "custom", customType: "mixture_run", data, ...(timestamp ? { timestamp } : {}) });
const userMessage = { type: "message", message: { role: "user", content: "hi" } };
const runIds = (traces: ReturnType<typeof mixtureSnapshotTraces>) => [...new Set(traces.map(trace => (trace.details as { runId: string }).runId))];

test("a run that ended on this branch gets a run_end card with its runId and endReason", () => {
	const traces = mixtureSnapshotTraces([
		userMessage,
		hop("r1", 3, "writer"),
		hop("r1", 5, "editor"),
		lifecycle({ runId: "r1", checkpoint: true }),
		lifecycle({ kind: "run_end", runId: "r1", endReason: "terminal", at: 900, responseId: "x" }),
	]);
	expect(traces).toHaveLength(3);
	expect(traces[0]).toMatchObject({ role: "custom", customType: "mixture_trace", content: "writer" });
	expect(traces[2]).toMatchObject({
		customType: "mixture_trace",
		details: { runId: "r1", mixture: "tea", seq: 6, at: 900, kind: "run_end", endReason: "terminal", run: { status: "done", endReason: "terminal", hops: 5 } },
	});
});

test("a run still going, or a run_end for a run with no cards on this branch, gets no run_end", () => {
	const traces = mixtureSnapshotTraces([hop("live", 3, "writer"), lifecycle({ kind: "run_end", runId: "elsewhere", endReason: "terminal", at: 1 })]);
	expect(traces.map(trace => (trace.details as { kind: string }).kind)).toEqual(["hop"]);
});

test("a member failure's persisted error checkpoint becomes an error checkpoint card", () => {
	// NeoPi: the failed hop's card (run header still `running`), then a `mixture_run` checkpoint with reason `error`.
	const traces = mixtureSnapshotTraces([
		hop("r2", 3, "writer", { status: "failed" }),
		lifecycle({ v: 1, reason: "error", run: { id: "r2", status: "error", seq: 3, key: { mixture: "tea" } }, committedThrough: 0 }, "2026-09-29T00:00:00.000Z"),
	]);
	expect(traces).toHaveLength(2);
	expect(traces[1]).toMatchObject({
		details: { runId: "r2", mixture: "tea", seq: 4, kind: "checkpoint", reason: "error", at: Date.parse("2026-09-29T00:00:00.000Z"), run: { status: "error", endReason: "error" } },
	});
	// Ordinary hop and decision checkpoints are not terminal and add nothing.
	expect(mixtureSnapshotTraces([hop("r3", 3, "writer"), lifecycle({ v: 1, reason: "hop", run: { id: "r3", status: "running", seq: 3 } })])).toHaveLength(1);
});

test("a run that fails before its first hop gets an error card built from the serialized run", () => {
	// NeoPi: a hop request that does not fit the member's context fails the run before any hop card.
	const checkpoint = lifecycle(
		{
			v: 1,
			reason: "error",
			run: { id: "r4", status: "error", seq: 1, key: { host: "s", mixture: "tea", lineage: [], conversation: "s" }, lifetime: { hops: 0, usd: 0, startedAt: 5 }, window: { hops: 0, usd: 0, startedAt: 5 } },
			committedThrough: 0,
		},
		"2026-09-29T01:00:00.000Z",
	);
	const traces = mixtureSnapshotTraces([userMessage, checkpoint]);
	expect(traces).toEqual([
		expect.objectContaining({
			customType: "mixture_trace",
			details: expect.objectContaining({ runId: "r4", mixture: "tea", seq: 2, kind: "checkpoint", reason: "error", at: Date.parse("2026-09-29T01:00:00.000Z"), run: expect.objectContaining({ status: "error", hops: 0, usd: 0, window: { hops: 0, usd: 0 } }) }),
		}),
	]);
	// The bridge's live path finds it as the branch's latest failure, and only then.
	expect(latestErrorTerminal([checkpoint])).toMatchObject({ details: { runId: "r4", reason: "error" } });
	expect(latestErrorTerminal([checkpoint, lifecycle({ v: 1, reason: "hop", run: { id: "r5", seq: 1 } })])).toBeUndefined();
});

test("runs before the latest /clear reset boundary are left out, cards and run ends alike", () => {
	const failedBefore = lifecycle({ v: 1, reason: "error", run: { id: "old-failed", status: "error", seq: 1, key: { mixture: "tea" } } });
	const branch = [
		userMessage,
		hop("old", 1, "writer"),
		lifecycle({ kind: "run_end", runId: "old", endReason: "terminal", at: 10 }),
		failedBefore,
		{ type: "reset_boundary" },
		userMessage,
		hop("new", 1, "writer"),
	];
	expect(runIds(mixtureSnapshotTraces(branch))).toEqual(["new"]);
	// A failure before the boundary is not the current conversation's latest failure.
	expect(latestErrorTerminal([...branch.slice(0, 4), { type: "reset_boundary" }])).toBeUndefined();
	// Compaction drops neither entries nor runs: a run before a compaction stays.
	expect(runIds(mixtureSnapshotTraces([hop("kept", 1, "writer"), { type: "compaction", summary: "…" }, hop("after", 1, "writer")]))).toEqual(["kept", "after"]);
});
