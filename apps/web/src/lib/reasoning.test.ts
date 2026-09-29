/**
 * Every reasoning shape NeoPi's providers emit must reduce to readable text or
 * an explicit hidden state (#96): an empty expander is never an outcome.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { AssistantMessage } from "../components/messages/AssistantMessage";
import { applyEvent, initSession } from "./reducer";
import { reasoningBlockView, reasoningBlockViews, unreportedReasoningView } from "./reasoning";
import type { AssistantMsg, RedactedThinkingBlock, ThinkingBlock } from "./types";

const usage = (reasoningTokens?: number) => ({
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	...(reasoningTokens === undefined ? {} : { reasoningTokens }),
	cost: { total: 0 },
});

const codexItem = (encrypted_content: string | null, summary: Array<{ type: string; text: string }> = []) =>
	JSON.stringify({ type: "reasoning", id: "rs_1", summary, encrypted_content });

/** Reduce raw NeoPi assistant messages the way a session snapshot does. */
function reduce(...messages: Array<Record<string, unknown>>): AssistantMsg[] {
	const s = initSession({
		sessionId: "s",
		cwd: "/tmp",
		isStreaming: false,
		todoPhases: [],
		messages: messages.map((m) => ({ role: "assistant", ...m })),
	} as never);
	return s.messages as AssistantMsg[];
}

function reasoningBlocks(msg: AssistantMsg) {
	return msg.blocks.filter(
		(b): b is ThinkingBlock | RedactedThinkingBlock => b.type === "thinking" || b.type === "redactedThinking",
	);
}

describe("reducer keeps what the renderer needs from reasoning blocks", () => {
	test("an OpenAI reasoning item with encrypted content marks the block encrypted", () => {
		const [msg] = reduce({ content: [{ type: "thinking", thinking: "", thinkingSignature: codexItem("gAAAAB") }] });
		expect(msg?.blocks).toEqual([{ type: "thinking", thinking: "", encrypted: true }]);
	});

	test("signatures that are not encrypted payloads leave the block unmarked", () => {
		const [msg] = reduce({
			content: [
				{ type: "thinking", thinking: "signed", thinkingSignature: "EqQBCkYIBxgCKkB" },
				{ type: "thinking", thinking: "", thinkingSignature: codexItem(null) },
				{ type: "thinking", thinking: "", thinkingSignature: codexItem("") },
				{ type: "thinking", thinking: "summary", thinkingSignature: "reasoning_content" },
				{ type: "thinking", thinking: "" },
			],
		});
		expect(msg?.blocks.map((b) => (b as ThinkingBlock).encrypted)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test("redacted thinking survives as its own block", () => {
		const [msg] = reduce({ content: [{ type: "redactedThinking", data: "EmwKAhgB" }] });
		expect(msg?.blocks.map((b) => b.type)).toEqual(["redactedThinking"]);
	});
});

describe("reasoning view per shape", () => {
	test("readable thinking renders its text", () => {
		const [msg] = reduce({ content: [{ type: "thinking", thinking: "plan", thinkingSignature: "sig" }], usage: usage() });
		expect(reasoningBlockView(reasoningBlocks(msg!)[0]!, msg!)).toEqual({ kind: "text", text: "plan" });
	});

	test("encrypted reasoning without a summary is withheld with the turn's reasoning tokens", () => {
		const [msg] = reduce({
			content: [{ type: "thinking", thinking: "", thinkingSignature: codexItem("gAAAAB") }],
			usage: usage(10),
		});
		expect(reasoningBlockView(reasoningBlocks(msg!)[0]!, msg!)).toEqual({ kind: "withheld", reason: "encrypted", tokens: 10 });
	});

	test("a whitespace-only block reloaded without its signature is withheld, not an empty expander", () => {
		const [msg] = reduce({ content: [{ type: "thinking", thinking: " \n" }], usage: usage(10) });
		expect(reasoningBlockView(reasoningBlocks(msg!)[0]!, msg!)).toEqual({ kind: "withheld", reason: "empty", tokens: 10 });
	});

	test("redacted reasoning is withheld and omits a token count the provider never reported", () => {
		const [msg] = reduce({ content: [{ type: "redactedThinking", data: "EmwKAhgB" }], usage: usage() });
		expect(reasoningBlockView(reasoningBlocks(msg!)[0]!, msg!)).toEqual({ kind: "withheld", reason: "redacted" });
	});

	test("an empty streaming block is pending until its encrypted payload lands, even mid-turn", () => {
		const open = { type: "thinking", thinking: "" };
		const ended = { ...open, thinkingSignature: codexItem("gAAAAB") };
		let s = initSession({ sessionId: "s", cwd: "/tmp", isStreaming: true, todoPhases: [], messages: [] } as never);
		s = applyEvent(s, { type: "message_update", message: { role: "assistant", content: [open] } } as never);
		const live = s.messages[0] as AssistantMsg;
		expect(reasoningBlockView(reasoningBlocks(live)[0]!, live)).toEqual({ kind: "pending" });

		const answering = { role: "assistant", content: [ended, { type: "text", text: "ans" }] };
		s = applyEvent(s, { type: "message_update", message: answering } as never);
		const midTurn = s.messages[0] as AssistantMsg;
		expect(midTurn.isStreaming).toBe(true);
		expect(reasoningBlockView(reasoningBlocks(midTurn)[0]!, midTurn)).toEqual({ kind: "withheld", reason: "encrypted" });

		s = applyEvent(s, { type: "message_end", message: { ...answering, usage: usage(7) } } as never);
		const done = s.messages[0] as AssistantMsg;
		expect(reasoningBlockView(reasoningBlocks(done)[0]!, done)).toEqual({ kind: "withheld", reason: "encrypted", tokens: 7 });
	});

	test("the turn's reasoning token count appears on one withheld block, not on each", () => {
		const [msg] = reduce({
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "thinking", thinking: "", thinkingSignature: codexItem("gAAAAB") },
				{ type: "text", text: "mid" },
				{ type: "thinking", thinking: "", thinkingSignature: codexItem("gAAAAC") },
			],
			usage: usage(42),
		});
		expect(reasoningBlockViews(msg!)).toEqual([
			{ kind: "text", text: "plan" },
			{ kind: "withheld", reason: "encrypted", tokens: 42 },
			undefined,
			{ kind: "withheld", reason: "encrypted" },
		]);
	});

	test("reasoning tokens with no reasoning block are reported for the finished turn only", () => {
		const [tokensNoBlock, zeroTokens, withBlock, unknown] = reduce(
			{ content: [{ type: "text", text: "answer" }], usage: usage(412) },
			{ content: [{ type: "text", text: "answer" }], usage: usage(0) },
			{ content: [{ type: "thinking", thinking: "plan" }], usage: usage(412) },
			{ content: [{ type: "text", text: "answer" }], usage: usage() },
		);
		expect(unreportedReasoningView(tokensNoBlock!)).toEqual({ kind: "withheld", reason: "unreported", tokens: 412 });
		expect(unreportedReasoningView(zeroTokens!)).toBeNull();
		expect(unreportedReasoningView(withBlock!)).toBeNull();
		expect(unreportedReasoningView(unknown!)).toBeNull();
		expect(unreportedReasoningView({ ...tokensNoBlock!, isStreaming: true })).toBeNull();
	});
});

describe("assistant message rendering of hidden reasoning", () => {
	const render = (msg: AssistantMsg) => renderToStaticMarkup(createElement(AssistantMessage, { msg, toolCalls: {} }));

	test("hidden reasoning shows a non-expandable explanation with its token count", () => {
		const [encrypted, unreported] = reduce(
			{ content: [{ type: "thinking", thinking: "", thinkingSignature: codexItem("gAAAAB") }], usage: usage(1234) },
			{ content: [{ type: "text", text: "answer" }], usage: usage(412) },
		);
		for (const [msg, tokens] of [[encrypted!, "1.2k"], [unreported!, "412"]] as const) {
			const html = render(msg);
			expect(html).not.toContain("<button");
			expect(html).toContain(`${tokens} reasoning tok this turn`);
		}
	});

	test("readable thinking keeps its expander", () => {
		const [msg] = reduce({ content: [{ type: "thinking", thinking: "plan" }], usage: usage(3) });
		expect(render(msg!)).toContain("<button");
	});
});
