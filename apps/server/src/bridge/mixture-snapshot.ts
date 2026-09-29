/**
 * The mixture trace cards a snapshot carries for the inspector's MoA panel.
 *
 * NeoPi persists hop, limit and checkpoint cards as `mixture_trace` custom
 * messages, but a run's end only as a `mixture_run` lifecycle entry
 * (`{kind: "run_end", runId, endReason, at}`). Without it a client that was
 * disconnected when the run ended would replay the run's last hop as still
 * pending. This rebuilds a `run_end` card per ended run on the active branch,
 * keeping its runId and endReason; the header's counters come from the run's
 * last persisted card.
 */

type Fields = Record<string, unknown>;

function record(value: unknown): value is Fields {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * `messages`: the branch's transcript messages (custom cards included).
 * `entries`: the branch's session entries, root to leaf.
 */
export function mixtureSnapshotTraces(messages: readonly unknown[], entries: readonly unknown[]): Fields[] {
	const cards = messages.filter((message): message is Fields => record(message) && message.role === "custom" && message.customType === "mixture_trace");
	const last = new Map<string, Fields>();
	for (const card of cards) {
		const details = card.details;
		if (!record(details) || typeof details.runId !== "string" || typeof details.seq !== "number") continue;
		const previous = last.get(details.runId);
		if (!previous || (previous.seq as number) < details.seq) last.set(details.runId, details);
	}
	const ended: Fields[] = [];
	for (const entry of entries) {
		if (!record(entry) || entry.type !== "custom" || entry.customType !== "mixture_run" || !record(entry.data)) continue;
		const data = entry.data;
		if (data.kind !== "run_end" || typeof data.runId !== "string" || typeof data.endReason !== "string") continue;
		const tail = last.get(data.runId);
		// A run whose cards are not on this branch is not part of this conversation.
		if (!tail || tail.kind === "run_end") continue;
		const at = typeof data.at === "number" ? data.at : (tail.at as number);
		const run = record(tail.run) ? tail.run : {};
		const details = {
			v: 1,
			runId: data.runId,
			mixture: tail.mixture,
			seq: (tail.seq as number) + 1,
			at,
			run: { ...run, status: "done", phase: "ended", activeMemberId: undefined, endReason: data.endReason },
			kind: "run_end",
			endReason: data.endReason,
			usage: ZERO_USAGE,
		};
		ended.push({ role: "custom", customType: "mixture_trace", display: true, content: `${String(tail.mixture)} · run end`, details, timestamp: at });
		last.set(data.runId, details);
	}
	return [...cards, ...ended];
}
