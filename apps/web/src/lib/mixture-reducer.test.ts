import { describe, expect, test } from "bun:test";

import { emptyMixtureUi, hydrateMixtureTraces, mixtureHops, mixtureRunPhase, reconcileMixtureResubscribe, type MixtureRunUi } from "./mixture-reducer";
import { applyEvent, initSession } from "./reducer";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
const header = (seq: number, status: string, activeMemberId?: string) => ({
	v: 1,
	runId: "run-1",
	mixture: "draft-then-edit",
	seq,
	at: 1_000 + seq,
	run: { status, phase: status === "running" ? "generating" : "ended", activeMemberId, hops: seq, usd: 0.01 * seq, window: { hops: seq, usd: 0.01 * seq } },
});
const hop = (seq: number, memberId: string, next?: string) => ({ ...header(seq, "running", next), kind: "hop", hop: seq, memberId, model: `fake/${memberId}`, output: `${memberId} output`, usage, elapsedMs: 10, status: "done", visible: true });
const runEnd = (seq: number, endReason: string) => ({ ...header(seq, endReason === "terminal" ? "done" : "error"), kind: "run_end", endReason, usage });
const checkpoint = (seq: number, reason: string) => ({ ...header(seq, "checkpoint"), kind: "checkpoint", reason });
const card = (details: unknown) => ({ role: "custom", customType: "mixture_trace", display: true, content: "card", details });
const live = { streaming: true, connected: true, endedByRestart: false, current: true };

function session(messages: unknown[] = [], sessionFile = "/s/one.jsonl", isStreaming = true) {
	return initSession({ sessionId: "s1", cwd: "/tmp/x", sessionFile, isStreaming, messages: messages as never, todoPhases: [] });
}
function onlyRun(state: ReturnType<typeof session>): MixtureRunUi {
	expect(state.mixture?.runs).toHaveLength(1);
	return state.mixture!.runs[0]!;
}

describe("mixture panel state", () => {
	test("live events show the active member and end completed, while chat cards keep every trace", () => {
		let state = applyEvent(session(), { type: "mixture_hop_end", details: hop(1, "writer", "editor") } as never);
		expect(mixtureRunPhase(onlyRun(state), live)).toEqual({ kind: "running", activeMemberId: "editor", phase: "generating" });
		state = applyEvent(state, { type: "mixture_hop_end", details: hop(2, "editor") } as never);
		state = applyEvent(state, { type: "mixture_run_end", details: runEnd(3, "terminal") } as never);
		expect(mixtureRunPhase(onlyRun(state), { ...live, streaming: false })).toEqual({ kind: "completed", endReason: "terminal" });
		expect(mixtureHops(onlyRun(state)).map(item => item.memberId)).toEqual(["writer", "editor"]);
		expect(state.messages.filter(message => message.role === "mixtureTrace")).toHaveLength(3);
	});

	test("an aborted run is interrupted, whether it ended or checkpointed", () => {
		const ended = applyEvent(applyEvent(session(), { type: "mixture_hop_end", details: hop(1, "writer", "editor") } as never), { type: "mixture_run_end", details: runEnd(2, "aborted") } as never);
		expect(mixtureRunPhase(onlyRun(ended), live)).toEqual({ kind: "interrupted", reason: "aborted" });
		const checkpointed = applyEvent(session(), { type: "mixture_checkpoint", details: checkpoint(2, "abort") } as never);
		expect(mixtureRunPhase(onlyRun(checkpointed), live)).toEqual({ kind: "interrupted", reason: "abort" });
	});

	test("a run replayed from the transcript has no recorded outcome; a worker restart interrupts it", () => {
		const replayed = session([card(hop(1, "writer", "editor"))], "/s/one.jsonl", false);
		const run = onlyRun(replayed);
		expect(mixtureRunPhase(run, { ...live, streaming: false })).toEqual({ kind: "unrecorded" });
		expect(mixtureRunPhase(run, { ...live, endedByRestart: true })).toEqual({ kind: "interrupted", reason: "worker restart" });
		expect(mixtureRunPhase(run, { ...live, connected: false })).toEqual({ kind: "disconnected", activeMemberId: "editor" });
	});

	test("a live snapshot's persisted trace cards rebuild the panel without adding chat messages", () => {
		const state = initSession({ sessionId: "s1", cwd: "/tmp/x", isStreaming: true, messages: [], todoPhases: [], mixtureTraces: [card(hop(1, "writer", "editor"))] as never });
		expect(mixtureRunPhase(onlyRun(state), live)).toEqual({ kind: "running", activeMemberId: "editor", phase: "generating" });
		expect(state.messages).toEqual([]);
	});

	test("reconnecting keeps live-only run_end events the transcript does not persist", () => {
		let before = applyEvent(session(), { type: "mixture_hop_end", details: hop(1, "writer", "editor") } as never);
		before = applyEvent(before, { type: "mixture_hop_end", details: hop(2, "editor") } as never);
		before = applyEvent(before, { type: "mixture_run_end", details: runEnd(3, "terminal") } as never);
		const snapshot = session([card(hop(1, "writer", "editor")), card(hop(2, "editor"))], "/s/one.jsonl", false);
		const merged = reconcileMixtureResubscribe(before.mixture, snapshot.mixture!, { at: 99, conversationReplaced: false });
		expect(merged.reconnectedAt).toBe(99);
		expect(merged.runs[0]!.traces.map(trace => trace.seq)).toEqual([1, 2, 3]);
		expect(mixtureRunPhase(merged.runs[0]!, { ...live, streaming: false })).toEqual({ kind: "completed", endReason: "terminal" });
	});

	test("a replaced conversation drops its runs and records the reset", () => {
		const before = applyEvent(session(), { type: "mixture_hop_end", details: hop(1, "writer", "editor") } as never);
		const replaced = reconcileMixtureResubscribe(before.mixture, session([], "/s/two.jsonl").mixture!, { at: 7, conversationReplaced: true });
		expect(replaced.runs).toEqual([]);
		expect(replaced.resets).toEqual([{ at: 7, runIds: ["run-1"] }]);
		// A first subscribe is neither a reconnect nor a reset.
		expect(reconcileMixtureResubscribe(undefined, emptyMixtureUi(), { at: 7, conversationReplaced: true })).toEqual(emptyMixtureUi());
	});

	test("an update to an existing (runId, seq) replaces it; unreadable payloads are counted, not applied", () => {
		const first = hydrateMixtureTraces([card(hop(1, "writer", "editor"))]);
		const updated = hydrateMixtureTraces([card(hop(1, "writer", "editor")), card({ ...hop(1, "writer", "editor"), output: "revised" })]);
		expect(onlyRun({ mixture: updated } as never).traces).toHaveLength(1);
		expect((mixtureHops(updated.runs[0]!)[0] as { output?: string }).output).toBe("revised");
		expect(first.dropped).toBe(0);
		expect(hydrateMixtureTraces([card({ kind: "hop" })]).dropped).toBe(1);
	});
});
