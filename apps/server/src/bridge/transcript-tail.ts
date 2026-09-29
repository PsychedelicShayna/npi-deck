import type { SessionTranscriptResponse } from "@npi-deck/protocol";

type Tail<M> = { messages: M[]; omitted?: NonNullable<SessionTranscriptResponse["omitted"]> };

/**
 * The newest `limit` messages of a transcript. What is left out is reported
 * as a count plus each omitted assistant message's `usage`, so the client's
 * cost rollup still spans the whole session. No limit keeps every message.
 */
export function transcriptTail<M extends { role?: unknown; usage?: unknown }>(messages: M[], limit?: number): Tail<M> {
	if (limit === undefined || messages.length <= limit) return { messages };
	const cut = messages.length - limit;
	const usage: unknown[] = [];
	for (let i = 0; i < cut; i++) {
		const m = messages[i]!;
		if (m.role === "assistant" && m.usage !== undefined) usage.push(m.usage);
	}
	return { messages: messages.slice(cut), omitted: { count: cut, usage } };
}
