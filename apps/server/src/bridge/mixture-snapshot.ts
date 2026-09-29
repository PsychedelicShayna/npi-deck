/**
 * The mixture trace cards a snapshot carries for the inspector's MoA panel.
 *
 * NeoPi persists hop, limit and abort-checkpoint cards as `mixture_trace`
 * custom messages, but how a run ended only as `mixture_run` entries: a
 * lifecycle `{kind: "run_end", runId, endReason, at}` after a committed
 * answer, or an `error` checkpoint (`{reason: "error", run}`) after a member
 * failed. Without them a client that was away when the run ended would replay
 * its last hop as still pending. This rebuilds a `run_end` card, or an
 * `error` checkpoint card, per ended run on the active branch, keeping its
 * runId; the header's counters come from the run's last persisted card.
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
	const rebuilt: Fields[] = [];
	const push = (tail: Fields, details: Fields, label: string) => {
		rebuilt.push({ role: "custom", customType: "mixture_trace", display: true, content: `${String(tail.mixture)} · ${label}`, details, timestamp: details.at });
		last.set(details.runId as string, details);
	};
	for (const entry of entries) {
		if (!record(entry) || entry.type !== "custom" || entry.customType !== "mixture_run" || !record(entry.data)) continue;
		const data = entry.data;
		const entryAt = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		if (data.kind === "run_end" && typeof data.runId === "string" && typeof data.endReason === "string") {
			const tail = last.get(data.runId);
			// A run whose cards are not on this branch is not part of this conversation.
			if (!tail || tail.kind === "run_end") continue;
			const at = typeof data.at === "number" ? data.at : (tail.at as number);
			const run = record(tail.run) ? tail.run : {};
			push(tail, {
				v: 1,
				runId: data.runId,
				mixture: tail.mixture,
				seq: (tail.seq as number) + 1,
				at,
				run: { ...run, status: "done", phase: "ended", activeMemberId: undefined, endReason: data.endReason },
				kind: "run_end",
				endReason: data.endReason,
				usage: ZERO_USAGE,
			}, "run end");
			continue;
		}
		// A failed member ends the run with an `error` checkpoint and no card or run end
		// (the failed hop's card still says the run is running). Rebuild that terminal.
		if (data.reason === "error" && record(data.run) && typeof data.run.id === "string") {
			const serialized = data.run;
			const tail = last.get(serialized.id as string);
			if (!tail || tail.kind === "run_end" || (tail.kind === "checkpoint" && tail.reason === "error")) continue;
			const run = record(tail.run) ? tail.run : {};
			const seq = Math.max((tail.seq as number) + 1, typeof serialized.seq === "number" ? serialized.seq + 1 : 0);
			push(tail, {
				v: 1,
				runId: serialized.id,
				mixture: tail.mixture,
				seq,
				at: Number.isFinite(entryAt) ? entryAt : (tail.at as number),
				run: { ...run, status: "error", phase: "ended", activeMemberId: undefined, endReason: typeof serialized.endReason === "string" ? serialized.endReason : "error" },
				kind: "checkpoint",
				reason: "error",
			}, "checkpoint (error)");
		}
	}
	return [...cards, ...rebuilt];
}
