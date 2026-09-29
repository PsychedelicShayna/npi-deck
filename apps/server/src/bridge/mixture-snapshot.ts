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
 * runId. Counters come from the run's last persisted card, or, for a run that
 * failed before its first hop and so has no cards, from the serialized run.
 * Only the current conversation counts: entries before the latest `/clear`
 * reset boundary belong to runs NeoPi has dropped.
 */

type Fields = Record<string, unknown>;

function record(value: unknown): value is Fields {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * The current conversation's part of a branch: the entries after the latest
 * `/clear` `reset_boundary`. NeoPi drops every run at that boundary
 * (`resetConversation`) and starts the live transcript and model context after
 * it. Compaction is different: it neither drops runs nor removes entries from
 * the branch, so runs before a compaction stay.
 */
function afterReset(branch: readonly unknown[]): readonly unknown[] {
	const boundary = branch.findLastIndex(entry => record(entry) && entry.type === "reset_boundary");
	return boundary < 0 ? branch : branch.slice(boundary + 1);
}

/** `branch`: the session's branch entries, root to leaf (`SessionManager.getBranch()`). */
export function mixtureSnapshotTraces(branch: readonly unknown[]): Fields[] {
	const entries = afterReset(branch);
	// Persisted cards are `custom_message` entries; shape them as the transcript's custom messages.
	const cards: Fields[] = entries.flatMap(entry =>
		record(entry) && entry.type === "custom_message" && entry.customType === "mixture_trace" && entry.display !== false
			? [{ role: "custom", customType: "mixture_trace", display: true, content: entry.content, details: entry.details, timestamp: typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : undefined }]
			: [],
	);
	const last = new Map<string, Fields>();
	for (const card of cards) {
		const details = card.details;
		if (!record(details) || typeof details.runId !== "string" || typeof details.seq !== "number") continue;
		const previous = last.get(details.runId);
		if (!previous || (previous.seq as number) < details.seq) last.set(details.runId, details);
	}
	const rebuilt: Fields[] = [];
	const push = (mixture: unknown, details: Fields, label: string) => {
		rebuilt.push({ role: "custom", customType: "mixture_trace", display: true, content: `${String(mixture)} · ${label}`, details, timestamp: details.at });
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
			push(tail.mixture, {
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
		// A failed run ends with an `error` checkpoint and no card or run end: after a
		// failed hop (whose card still says running), or before any hop (a request that
		// does not fit the member's context), when the run has no cards at all.
		if (data.reason === "error" && record(data.run) && typeof data.run.id === "string") {
			const serialized = data.run;
			const tail = last.get(serialized.id as string);
			if (tail && (tail.kind === "run_end" || (tail.kind === "checkpoint" && tail.reason === "error"))) continue;
			const mixture = tail?.mixture ?? (record(serialized.key) && typeof serialized.key.mixture === "string" ? serialized.key.mixture : undefined);
			if (typeof mixture !== "string") continue;
			const counters = (value: unknown) => (record(value) && typeof value.hops === "number" && typeof value.usd === "number" ? { hops: value.hops, usd: value.usd } : undefined);
			const lifetime = counters(serialized.lifetime) ?? { hops: 0, usd: 0 };
			const run = tail && record(tail.run) ? tail.run : { ...lifetime, window: counters(serialized.window) ?? lifetime };
			const seq = Math.max(tail ? (tail.seq as number) + 1 : 1, typeof serialized.seq === "number" ? serialized.seq + 1 : 0);
			const startedAt = record(serialized.window) && typeof serialized.window.startedAt === "number" ? serialized.window.startedAt : Date.now();
			push(mixture, {
				v: 1,
				runId: serialized.id,
				mixture,
				seq,
				at: Number.isFinite(entryAt) ? entryAt : ((tail?.at as number | undefined) ?? startedAt),
				run: { ...run, status: "error", phase: "ended", activeMemberId: undefined, endReason: typeof serialized.endReason === "string" ? serialized.endReason : "error" },
				kind: "checkpoint",
				reason: "error",
			}, "checkpoint (error)");
		}
	}
	return [...cards, ...rebuilt];
}

/**
 * The terminal card for the run the branch's latest `mixture_run` error
 * checkpoint belongs to, if that checkpoint is the branch's last mixture
 * record. NeoPi emits no live event for it, so the bridge sends this after the
 * failed outer response ends.
 */
export function latestErrorTerminal(branch: readonly unknown[]): Fields | undefined {
	const entries = afterReset(branch);
	const lastRecord = entries.findLast(entry => record(entry) && entry.type === "custom" && entry.customType === "mixture_run" && record(entry.data));
	if (!record(lastRecord) || !record(lastRecord.data) || lastRecord.data.reason !== "error" || !record(lastRecord.data.run)) return undefined;
	const runId = lastRecord.data.run.id;
	const cards = mixtureSnapshotTraces(entries);
	return cards.findLast(card => record(card.details) && card.details.runId === runId && card.details.kind === "checkpoint" && card.details.reason === "error");
}
