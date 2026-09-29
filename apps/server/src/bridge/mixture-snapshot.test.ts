import { expect, test } from "bun:test";
import { mixtureSnapshotTraces } from "./mixture-snapshot.ts";

const hop = (runId: string, seq: number, memberId: string) => ({
	role: "custom",
	customType: "mixture_trace",
	display: true,
	content: memberId,
	details: { v: 1, runId, mixture: "tea", seq, at: 100 + seq, kind: "hop", hop: seq, memberId, run: { status: "running", phase: "hop_ready", activeMemberId: "editor", hops: seq, usd: 0.02, window: { hops: seq, usd: 0.02 } } },
});
const lifecycle = (data: Record<string, unknown>) => ({ type: "custom", customType: "mixture_run", data });

test("a run that ended on this branch gets a run_end card with its runId and endReason", () => {
	const traces = mixtureSnapshotTraces(
		[{ role: "user", content: "hi" }, hop("r1", 3, "writer"), hop("r1", 5, "editor")],
		[lifecycle({ runId: "r1", checkpoint: true }), lifecycle({ kind: "run_end", runId: "r1", endReason: "terminal", at: 900, responseId: "x" })],
	);
	expect(traces).toHaveLength(3);
	expect(traces[2]).toMatchObject({
		customType: "mixture_trace",
		details: { runId: "r1", mixture: "tea", seq: 6, at: 900, kind: "run_end", endReason: "terminal", run: { status: "done", endReason: "terminal", hops: 5 } },
	});
});

test("a run still going, or one whose cards are on another branch, gets no run_end", () => {
	const traces = mixtureSnapshotTraces([hop("live", 3, "writer")], [lifecycle({ kind: "run_end", runId: "elsewhere", endReason: "terminal", at: 1 })]);
	expect(traces.map(trace => (trace.details as { kind: string }).kind)).toEqual(["hop"]);
});
