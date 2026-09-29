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

	test("after the last hop the run is finalizing and no member is shown working", () => {
		const last = { ...hop(2, "editor", "editor"), run: { ...hop(2, "editor", "editor").run, phase: "finalizing" } };
		const state = applyEvent(session(), { type: "mixture_hop_end", details: last } as never);
		expect(mixtureRunPhase(onlyRun(state), live)).toEqual({ kind: "running", activeMemberId: undefined, phase: "finalizing" });
	});

	test("an aborted run is interrupted, whether it ended or checkpointed", () => {
		const ended = applyEvent(applyEvent(session(), { type: "mixture_hop_end", details: hop(1, "writer", "editor") } as never), { type: "mixture_run_end", details: runEnd(2, "aborted") } as never);
		expect(mixtureRunPhase(onlyRun(ended), live)).toEqual({ kind: "interrupted", reason: "aborted" });
		const checkpointed = applyEvent(session(), { type: "mixture_checkpoint", details: checkpoint(2, "abort") } as never);
		expect(mixtureRunPhase(onlyRun(checkpointed), live)).toEqual({ kind: "interrupted", reason: "abort" });
	});

	test("replayed history never shows as running, even while a new turn streams", () => {
		const replayed = onlyRun(session([card(hop(1, "writer", "editor"))], "/s/one.jsonl", false));
		expect(mixtureRunPhase(replayed, live)).toEqual({ kind: "unrecorded" });
		expect(mixtureRunPhase(replayed, { ...live, endedByRestart: true })).toEqual({ kind: "unrecorded" });
	});

	test("a run seen live is interrupted by a worker restart and frozen while disconnected", () => {
		const run = onlyRun(applyEvent(session(), { type: "mixture_hop_end", details: hop(1, "writer", "editor") } as never));
		expect(mixtureRunPhase(run, { ...live, endedByRestart: true })).toEqual({ kind: "interrupted", reason: "worker restart" });
		expect(mixtureRunPhase(run, { ...live, connected: false })).toEqual({ kind: "disconnected", activeMemberId: "editor" });
	});

	test("a snapshot taken mid-run on the same mixture resumes the latest unfinished run as live", () => {
		const onMixture = (model: { provider: string; id: string }, traces: unknown[]) =>
			initSession({ sessionId: "s1", cwd: "/tmp/x", isStreaming: true, model, messages: [], todoPhases: [], mixtureTraces: traces as never });
		const state = onMixture({ provider: "mixture", id: "draft-then-edit" }, [card(hop(1, "writer", "editor"))]);
		expect(mixtureRunPhase(onlyRun(state), live)).toEqual({ kind: "running", activeMemberId: "editor", phase: "generating" });
		expect(state.messages).toEqual([]);
	});

	test("streaming on another model never revives a historical mixture run", () => {
		const onOther = initSession({ sessionId: "s1", cwd: "/tmp/x", isStreaming: true, model: { provider: "anthropic", id: "claude" }, messages: [], todoPhases: [], mixtureTraces: [card(hop(1, "writer", "editor"))] as never });
		expect(mixtureRunPhase(onlyRun(onOther), live)).toEqual({ kind: "unrecorded" });
		// Nor does a finished run of the active mixture.
		const finished = initSession({ sessionId: "s1", cwd: "/tmp/x", isStreaming: true, model: { provider: "mixture", id: "draft-then-edit" }, messages: [], todoPhases: [], mixtureTraces: [card(hop(1, "writer", "editor")), card(runEnd(2, "terminal"))] as never });
		expect(mixtureRunPhase(onlyRun(finished), live)).toEqual({ kind: "completed", endReason: "terminal" });
		// A live event for the run is what makes it current.
		const resumed = applyEvent(onOther, { type: "mixture_hop_end", details: hop(2, "editor") } as never);
		expect(onlyRun(resumed).live).toBe(true);
	});

	test("a run that ended while disconnected shows completed from the snapshot's rebuilt run end", () => {
		const before = applyEvent(session(), { type: "mixture_hop_end", details: hop(1, "writer", "editor") } as never);
		const snapshot = session([card(hop(1, "writer", "editor")), card(hop(2, "editor")), card(runEnd(4, "terminal"))], "/s/one.jsonl", false);
		const merged = reconcileMixtureResubscribe(before.mixture, snapshot.mixture!, 5);
		expect(mixtureRunPhase(merged.runs[0]!, { ...live, streaming: false })).toEqual({ kind: "completed", endReason: "terminal" });
	});

	test("reconnecting keeps live-only events and does not duplicate a rebuilt run end", () => {
		let before = applyEvent(session(), { type: "mixture_hop_end", details: hop(1, "writer", "editor") } as never);
		before = applyEvent(before, { type: "mixture_hop_end", details: hop(2, "editor") } as never);
		before = applyEvent(before, { type: "mixture_run_end", details: runEnd(5, "terminal") } as never);
		const withoutEnd = reconcileMixtureResubscribe(before.mixture, session([card(hop(1, "writer", "editor")), card(hop(2, "editor"))], "/s/one.jsonl", false).mixture!, 99);
		expect(withoutEnd.reconnectedAt).toBe(99);
		expect(withoutEnd.runs[0]!.traces.map(trace => trace.seq)).toEqual([1, 2, 5]);
		const rebuilt = reconcileMixtureResubscribe(before.mixture, session([card(hop(1, "writer", "editor")), card(hop(2, "editor")), card(runEnd(3, "terminal"))], "/s/one.jsonl", false).mixture!, 99);
		expect(rebuilt.runs[0]!.traces.filter(trace => trace.kind === "run_end")).toHaveLength(1);
	});

	test("runs missing from the new branch are dropped as a reset, whether or not the session file changed", () => {
		let before = applyEvent(session(), { type: "mixture_hop_end", details: hop(1, "writer", "editor") } as never);
		before = applyEvent(before, { type: "mixture_hop_end", details: { ...hop(1, "writer"), runId: "run-2" } } as never);
		// Tree navigation in the same file: the new branch keeps run-2 only.
		const branched = reconcileMixtureResubscribe(before.mixture, session([card({ ...hop(1, "writer"), runId: "run-2" })]).mixture!, 7);
		expect(branched.runs.map(run => run.runId)).toEqual(["run-2"]);
		expect(branched.resets).toEqual([{ at: 7, runIds: ["run-1"] }]);
		// A new, empty conversation drops everything.
		const cleared = reconcileMixtureResubscribe(before.mixture, session([], "/s/two.jsonl").mixture!, 8);
		expect(cleared.runs).toEqual([]);
		expect(cleared.resets).toEqual([{ at: 8, runIds: ["run-1", "run-2"] }]);
		// A first subscribe is neither a reconnect nor a reset.
		expect(reconcileMixtureResubscribe(undefined, emptyMixtureUi(), 7)).toEqual(emptyMixtureUi());
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
