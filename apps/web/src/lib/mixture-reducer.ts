/**
 * Mixture run state for the conversation-side MoA panel. Fed by the same
 * `mixture_*` session events that append the chat's trace cards (#43), and by
 * the persisted `mixture_trace` custom messages on (re)subscribe. Display only:
 * nothing here is replayed to a model or counted as usage.
 *
 * What NeoPi provides, and what it does not (pinned 9f8647e):
 * - Live events: `mixture_hop_end`, `mixture_limit`, `mixture_checkpoint`,
 *   `mixture_run_end`. There is no hop-start or run-start event; the member
 *   currently generating is the run header's `activeMemberId` after the last
 *   event.
 * - The transcript keeps hop/limit/checkpoint cards but not `run_end`, so a
 *   run replayed from history has no recorded outcome unless it checkpointed.
 * - No conversation-reset event reaches session listeners; the deck sees a
 *   replaced conversation only as a changed session file on (re)subscribe.
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
 * Rebuild from persisted `mixture_trace` custom messages (a snapshot or
 * transcript). Replayed runs are history; only when the session is streaming
 * can the last one still be running.
 */
export function hydrateMixtureTraces(messages: readonly unknown[], streaming = false): MixtureUi {
	let state = emptyMixtureUi();
	for (const message of messages) {
		if (record(message) && message.role === "custom" && message.customType === "mixture_trace" && message.display !== false) {
			state = applyMixtureTrace(state, message.details, false);
		}
	}
	if (!streaming || !state.currentRunId) return state;
	return { ...state, runs: state.runs.map(run => (run.runId === state.currentRunId ? { ...run, live: true } : run)) };
}

/**
 * A resubscribe replaced the session state with a fresh snapshot. Keep what
 * this client saw live but the transcript does not persist (`run_end`), mark
 * the reconnect, and treat a changed session file as a replaced conversation:
 * its runs are gone and never resume (NeoPi drops them on reset).
 */
export function reconcileMixtureResubscribe(
	previous: MixtureUi | undefined,
	hydrated: MixtureUi,
	change: { at: number; conversationReplaced: boolean },
): MixtureUi {
	if (!previous || (previous.runs.length === 0 && previous.resets.length === 0)) return hydrated;
	if (change.conversationReplaced) {
		const runIds = previous.runs.map(run => run.runId);
		return {
			...hydrated,
			reconnectedAt: change.at,
			resets: runIds.length ? [...previous.resets, { at: change.at, runIds }] : previous.resets,
		};
	}
	let merged = hydrated;
	for (const run of previous.runs) {
		const kept = hydrated.runs.find(candidate => candidate.runId === run.runId);
		// A live-only run (no persisted trace) is kept whole; a replayed one gains the live-only events.
		for (const trace of run.traces) {
			if (!kept?.traces.some(candidate => candidate.seq === trace.seq)) merged = applyMixtureTrace(merged, trace, run.live);
		}
	}
	const liveBefore = new Set(previous.runs.filter(run => run.live).map(run => run.runId));
	return {
		...merged,
		runs: merged.runs.map(run => (liveBefore.has(run.runId) && !run.live ? { ...run, live: true } : run)),
		currentRunId: merged.runs.some(run => run.runId === previous.currentRunId) ? previous.currentRunId : merged.currentRunId,
		reconnectedAt: change.at,
		resets: previous.resets,
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
