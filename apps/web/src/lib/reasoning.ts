/**
 * How an assistant turn's reasoning renders. Providers differ in what they
 * expose: Anthropic sends readable (signed) thinking or `redactedThinking`;
 * OpenAI Responses/Codex send a summary when the model writes one and
 * otherwise an empty thinking block whose encrypted payload rides in
 * `thinkingSignature` (dropped again when the session is persisted); some
 * gateways report `usage.reasoningTokens` without any reasoning block. Every
 * shape maps to either readable text or an explicit "hidden" state, so the
 * chat never shows an expander with nothing inside.
 */

import type { AssistantMsg, RedactedThinkingBlock, ThinkingBlock } from "./types";

export type WithheldReasoningReason =
	/** Empty thinking block backed by an encrypted reasoning payload. */
	| "encrypted"
	/** Provider redacted the reasoning (Anthropic `redacted_thinking`). */
	| "redacted"
	/** Empty thinking block with nothing else to go on (e.g. reloaded from disk). */
	| "empty"
	/** Usage reports reasoning tokens but the turn carries no reasoning block. */
	| "unreported";

export type ReasoningView =
	| { kind: "text"; text: string }
	/** Streaming turn whose reasoning block has no text yet. */
	| { kind: "pending" }
	/** `tokens` is the turn's reported reasoning tokens, when the provider reports them. */
	| { kind: "withheld"; reason: WithheldReasoningReason; tokens?: number };

type TurnContext = Pick<AssistantMsg, "isStreaming" | "usage">;

/**
 * Views for every reasoning block of a turn, indexed like `msg.blocks`
 * (undefined for non-reasoning blocks). The turn-wide reasoning token count
 * belongs to the turn, not to any one block, so only the first withheld block
 * carries it.
 */
export function reasoningBlockViews(msg: Pick<AssistantMsg, "isStreaming" | "usage" | "blocks">): (ReasoningView | undefined)[] {
	let tokensShown = false;
	return msg.blocks.map((b) => {
		if (b.type !== "thinking" && b.type !== "redactedThinking") return undefined;
		const view = reasoningBlockView(b, msg);
		if (view.kind !== "withheld" || view.tokens === undefined) return view;
		if (tokensShown) return { kind: "withheld", reason: view.reason };
		tokensShown = true;
		return view;
	});
}

export function reasoningBlockView(block: ThinkingBlock | RedactedThinkingBlock, turn: TurnContext): ReasoningView {
	if (block.type === "redactedThinking") return withheld("redacted", turn);
	if (block.thinking.trim().length > 0) return { kind: "text", text: block.thinking };
	// A signature arrives at thinking_end, so an encrypted block is final even
	// while the rest of the turn keeps streaming.
	if (block.encrypted) return withheld("encrypted", turn);
	if (turn.isStreaming) return { kind: "pending" };
	return withheld("empty", turn);
}

/**
 * A finished turn that spent reasoning tokens but carries no thinking or
 * redacted block at all; null when there is nothing to report.
 */
export function unreportedReasoningView(msg: Pick<AssistantMsg, "isStreaming" | "usage" | "blocks">): ReasoningView | null {
	if (msg.isStreaming) return null;
	const tokens = msg.usage?.reasoningTokens;
	if (tokens === undefined || tokens <= 0) return null;
	if (msg.blocks.some((b) => b.type === "thinking" || b.type === "redactedThinking")) return null;
	return { kind: "withheld", reason: "unreported", tokens };
}

export function withheldReasoningNote(reason: WithheldReasoningReason): string {
	switch (reason) {
		case "encrypted":
			return "The provider returned this reasoning encrypted, without a readable summary.";
		case "redacted":
			return "Redacted by the provider; only encrypted data was returned, kept for replay.";
		case "empty":
			return "The provider returned no reasoning text for this step.";
		case "unreported":
			return "The provider reports reasoning tokens but does not expose the reasoning text.";
	}
}

function withheld(reason: WithheldReasoningReason, turn: TurnContext): ReasoningView {
	const tokens = turn.usage?.reasoningTokens;
	return tokens === undefined ? { kind: "withheld", reason } : { kind: "withheld", reason, tokens };
}
