/**
 * Mixture run state for the conversation-side MoA panel. Fed by the same
 * `mixture_*` session events that append the chat's trace cards (#43), and by
 * the persisted `mixture_trace` custom messages on (re)subscribe. Display only:
 * nothing here is replayed to a model or counted as usage.
 *
 * What NeoPi provides, and what it does not:
 * - Live events: `mixture_hop_end`, `mixture_limit`, `mixture_checkpoint`,
 *   `mixture_run_end`. There is no hop-start or run-start event; the member
 *   currently generating is the run header's `activeMemberId` after the last
 *   event.
 * - The transcript keeps hop/limit/checkpoint cards; a run's end is only a
 *   lifecycle entry, which the deck's snapshot turns back into a `run_end` card.
 * - No conversation-reset event reaches session listeners; the deck sees a
 *   reset (a new session file, `/clear`, tree navigation) on (re)subscribe as
 *   runs missing from the active branch's snapshot.
 */
import type { MixtureHopTrace, MixtureTrace, MixtureTraceHeader } from "@npi-deck/protocol";

export interface MixtureRunUi {
	runId: string;
	mixture: string;
	/** Header of the highest-seq event: the run's state after it. */
	latest: MixtureTraceHeader;
	/** Every event once, by seq; a repeated (runId, seq) replaces its earlier copy. */
	traces: MixtureTrace[];
	/** Seen live on this connection (or possibly still running at hydration); replayed history is not. */
	live: boolean;
}

export interface MixtureReset {
	at: number;
	/** Runs the replaced conversation held. */
	runIds: string[];
}

export interface MixtureUi {
	runs: MixtureRunUi[];
	currentRunId: string | null;
	/** Set when a resubscribe replaced earlier panel state (a websocket reconnect or reopened chat). */
	reconnectedAt?: number;
	/** Conversation replacements observed while this panel was open. */
	resets: MixtureReset[];
	/** Events that could not be read as mixture traces. */
	dropped: number;
}

export function emptyMixtureUi(): MixtureUi {
	return { runs: [], currentRunId: null, resets: [], dropped: 0 };
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The fields the panel keys and orders on. Everything else is read
 * defensively at render time, like the chat cards, so a newer NeoPi payload
 * degrades to a less detailed row instead of a dropped event.
 */
export function isMixtureTrace(value: unknown): value is MixtureTrace {
	return (
		record(value) &&
		typeof value.runId === "string" &&
		value.runId.length > 0 &&
		typeof value.seq === "number" &&
		typeof value.kind === "string" &&
		record(value.run) &&
		typeof value.run.status === "string"
	);
}

/** `live`: the event arrived on this connection, so its run belongs to the session's current activity. */
export function applyMixtureTrace(state: MixtureUi, value: unknown, live = true): MixtureUi {
	if (!isMixtureTrace(value)) return { ...state, dropped: state.dropped + 1 };
	const index = state.runs.findIndex(run => run.runId === value.runId);
	const previous = state.runs[index];
	const same = previous?.traces.find(trace => trace.seq === value.seq);
	if (same && JSON.stringify(same) === JSON.stringify(value) && (previous!.live || !live)) return state;
	const traces = previous ? previous.traces.filter(trace => trace.seq !== value.seq) : [];
	traces.push(value);
	traces.sort((a, b) => a.seq - b.seq);
	const latest = traces[traces.length - 1]!;
	const run: MixtureRunUi = {
		runId: value.runId,
		mixture: typeof value.mixture === "string" ? value.mixture : (previous?.mixture ?? "mixture"),
		latest,
		traces,
		live: live || !!previous?.live,
	};
	const runs = [...state.runs];
	if (index < 0) runs.push(run);
	else runs[index] = run;
	return { ...state, runs, currentRunId: index < 0 ? value.runId : state.currentRunId };
}

/**
 * A member failure ends the run at once. NeoPi's failed hop card still says the
 * run is running and no run end or card follows it live (only a persisted
 * `error` checkpoint, which the deck's snapshot rebuilds).
 */
function failedLast(run: MixtureRunUi): boolean {
	const last = run.traces[run.traces.length - 1];
	return last?.kind === "hop" && last.status === "failed";
}

/** A run ended by `run_end`, by an abort/error checkpoint as its last event, or by a failed member. */
function ended(run: MixtureRunUi): boolean {
	const last = run.traces[run.traces.length - 1];
	return run.traces.some(trace => trace.kind === "run_end") || (last?.kind === "checkpoint" && INTERRUPTING_CHECKPOINT.has(last.reason)) || failedLast(run);
}

/**
 * Rebuild from persisted `mixture_trace` custom messages (a snapshot or
 * transcript). Replayed runs are history until a live event for that run
 * arrives. The one exception: while the session streams on `mixture/<name>`,
 * the latest run of that mixture that has not ended is the one running now.
 */
export function hydrateMixtureTraces(messages: readonly unknown[], active?: { streaming: boolean; model?: { provider: string; id: string } }): MixtureUi {
	let state = emptyMixtureUi();
	for (const message of messages) {
		if (record(message) && message.role === "custom" && message.customType === "mixture_trace" && message.display !== false) {
			state = applyMixtureTrace(state, message.details, false);
		}
	}
	const latest = state.runs.find(run => run.runId === state.currentRunId);
	if (!latest || !active?.streaming || active.model?.provider !== "mixture" || active.model.id !== latest.mixture || ended(latest)) return state;
	return { ...state, runs: state.runs.map(run => (run === latest ? { ...run, live: true } : run)) };
}

/**
 * A resubscribe replaced the session state with a fresh snapshot of the
 * active branch. Runs whose cards are not on that branch are gone (a new or
 * cleared conversation, another session file, or tree navigation within the
 * same file) and are recorded as a reset; NeoPi never resumes them. Runs
 * still on the branch keep what this client saw live, and the reconnect is
 * marked.
 */
export function reconcileMixtureResubscribe(previous: MixtureUi | undefined, hydrated: MixtureUi, at: number): MixtureUi {
	if (!previous || (previous.runs.length === 0 && previous.resets.length === 0)) return hydrated;
	const onBranch = new Set(hydrated.runs.map(run => run.runId));
	const vanished = previous.runs.filter(run => !onBranch.has(run.runId)).map(run => run.runId);
	let merged = hydrated;
	for (const run of previous.runs) {
		if (!onBranch.has(run.runId)) continue;
		const kept = hydrated.runs.find(candidate => candidate.runId === run.runId);
		// Gain the events this client saw live that the snapshot does not carry. A run end the
		// snapshot rebuilt from NeoPi's lifecycle entry may carry another seq than the live one.
		const keptEnd = kept?.traces.some(candidate => candidate.kind === "run_end");
		for (const trace of run.traces) {
			if (kept?.traces.some(candidate => candidate.seq === trace.seq) || (keptEnd && trace.kind === "run_end")) continue;
			merged = applyMixtureTrace(merged, trace, run.live);
		}
	}
	const liveBefore = new Set(previous.runs.filter(run => run.live).map(run => run.runId));
	return {
		...merged,
		runs: merged.runs.map(run => (liveBefore.has(run.runId) && !run.live ? { ...run, live: true } : run)),
		currentRunId: previous.currentRunId && onBranch.has(previous.currentRunId) ? previous.currentRunId : merged.currentRunId,
		reconnectedAt: at,
		resets: vanished.length ? [...previous.resets, { at, runIds: vanished }] : previous.resets,
		dropped: previous.dropped + hydrated.dropped,
	};
}

/** Latest observed state for each visit, keeping distinct visits and branch identities. */
export function mixtureHops(run: MixtureRunUi): MixtureHopTrace[] {
	const hops = new Map<string, MixtureHopTrace>();
	for (const trace of run.traces) {
		if (trace.kind === "hop" || trace.kind === "branch") hops.set(`${trace.hop}:${trace.branchOf ?? ""}:${trace.memberId}`, trace);
	}
	return [...hops.values()].sort((a, b) => a.hop - b.hop || a.seq - b.seq);
}

export type MixtureRunPhase =
	| { kind: "running"; activeMemberId?: string; phase: string }
	| { kind: "completed"; endReason: string }
	| { kind: "interrupted"; reason: string }
	| { kind: "paused"; reason: string }
	/** The client lost the stream mid-run; the shown state is the last one observed. */
	| { kind: "disconnected"; activeMemberId?: string }
	/** Replayed from the transcript, which does not record how the run ended. */
	| { kind: "unrecorded" };

const INTERRUPTING_END = new Set(["aborted", "error"]);
const INTERRUPTING_CHECKPOINT = new Set(["abort", "error"]);
/** Run phases in which `activeMemberId` is the member about to run or running. */
const MEMBER_PHASES = new Set(["hop_ready", "generating", "resume_hop", "decision_pending", "awaiting_tools"]);

/** Where one run stands, from its traces plus the session's live state. */
export function mixtureRunPhase(
	run: MixtureRunUi,
	session: { streaming: boolean; connected: boolean; endedByRestart: boolean; current: boolean },
): MixtureRunPhase {
	const end = run.traces.findLast(trace => trace.kind === "run_end");
	if (end && end.kind === "run_end")
		return INTERRUPTING_END.has(end.endReason) ? { kind: "interrupted", reason: end.endReason } : { kind: "completed", endReason: end.endReason };
	const checkpoint = run.traces.findLast(trace => trace.kind === "checkpoint");
	if (checkpoint && checkpoint.kind === "checkpoint" && INTERRUPTING_CHECKPOINT.has(checkpoint.reason) && checkpoint.seq === run.latest.seq)
		return { kind: "interrupted", reason: checkpoint.reason };
	// NeoPi fails the run the moment a member fails; the failed hop is its last event live.
	if (failedLast(run)) return { kind: "interrupted", reason: "member failed" };
	const status = run.latest.run.status;
	if (status === "done") return { kind: "completed", endReason: run.latest.run.endReason ?? "done" };
	if (status === "error") return { kind: "interrupted", reason: run.latest.run.endReason ?? "error" };
	if (status === "paused" || status === "checkpoint") return { kind: "paused", reason: checkpoint && checkpoint.kind === "checkpoint" ? checkpoint.reason : status };
	// Replayed history has no live outcome; only a run seen live can still be running.
	if (!run.live) return { kind: "unrecorded" };
	if (session.endedByRestart) return { kind: "interrupted", reason: "worker restart" };
	if (!session.current || !session.streaming) return { kind: "unrecorded" };
	// After the last hop the header keeps its member while the run finalizes; nobody is working then.
	const activeMemberId = MEMBER_PHASES.has(run.latest.run.phase) ? run.latest.run.activeMemberId : undefined;
	if (!session.connected) return { kind: "disconnected", activeMemberId };
	return { kind: "running", activeMemberId, phase: run.latest.run.phase };
}
