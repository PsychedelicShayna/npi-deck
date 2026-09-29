/**
 * Hide-tool-calls chat mode (#62): prose stays, finished tool calls and the
 * replies that were only tool calls drop out, and a running tool is a slim
 * "working" row so a busy turn never looks idle.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AssistantMessage } from "../components/messages/AssistantMessage";
import { applyEvent, initSession } from "./reducer";
import { toolCallsHiddenPreference, useStore } from "./store";
import { liveReplyId, messagesWithToolsHidden } from "./tool-visibility";
import type { AssistantMsg, ChatMessage, SessionUi } from "./types";

const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const reply = (content: unknown[], extra: Record<string, unknown> = {}) => ({ role: "assistant", content, stopReason: "toolUse", ...extra });
const result = (toolCallId: string, toolName: string) => ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], isError: false });

/** A turn: prose with a read, a bash-only reply, then a bash call whose result has not arrived. */
function turn(isStreaming: boolean): SessionUi {
	return initSession({
		sessionId: "s",
		cwd: "/tmp",
		isStreaming,
		todoPhases: [],
		messages: [
			{ role: "user", content: [{ type: "text", text: "fix the build" }], timestamp: 1 },
			reply([{ type: "text", text: "Looking at the config." }, call("t1", "read", { path: "tsconfig.json" })]),
			result("t1", "read"),
			reply([call("t2", "bash", { command: "bun install" })]),
			result("t2", "bash"),
			reply([{ type: "text", text: "" }, call("t3", "bash", { command: "bun run build" })]),
		],
	} as never);
}

const text = (m: ChatMessage) =>
	m.role === "user" ? m.text : m.role === "assistant" ? m.blocks.map((b) => (b.type === "text" ? b.text : b.type === "toolCall" ? `<${b.id}>` : "")).join("") : m.role;
const render = (msg: AssistantMsg, s: SessionUi, toolCallsHidden: boolean) =>
	renderToStaticMarkup(createElement(AssistantMessage, { msg, toolCalls: s.toolCalls, toolCallsHidden, live: msg.id === liveReplyId(s) }));
const assistants = (s: SessionUi) => s.messages.filter((m): m is AssistantMsg => m.role === "assistant");

describe("chat with tool calls hidden", () => {
	test("a busy turn keeps its prose and a working row for the running tool, not finished tool-only replies", () => {
		const s = turn(true);
		expect(messagesWithToolsHidden(s).map(text)).toEqual(["fix the build", "Looking at the config.<t1>", "<t3>"]);

		const [prose, , running] = assistants(s);
		const proseHtml = render(prose!, s, true);
		expect(proseHtml).toContain("Looking at the config.");
		expect(proseHtml).not.toContain("tsconfig.json");
		expect(proseHtml).not.toContain("<button");

		// Reconnected mid-tool: the snapshot replays no tool events, yet the call is working.
		const runningHtml = render(running!, s, true);
		expect(runningHtml).toContain('role="status"');
		expect(runningHtml).toContain("working");
		expect(runningHtml).toContain("bun run build");
		expect(runningHtml).not.toContain("<button");
	});

	test("an idle transcript's never-finished call shows no working row", () => {
		const s = turn(false);
		expect(messagesWithToolsHidden(s).map(text)).toEqual(["fix the build", "Looking at the config.<t1>"]);
		expect(render(assistants(s)[2]!, s, true)).not.toContain("working");
	});

	test("a running tool's row lasts until its execution ends", () => {
		let s = turn(false);
		s = applyEvent(s, { type: "tool_execution_start", toolCallId: "t3", toolName: "bash", args: { command: "bun run build" } } as never);
		expect(messagesWithToolsHidden(s).map(text)).toContain("<t3>");
		expect(render(assistants(s)[2]!, s, true)).toContain("working");
		s = applyEvent(s, { type: "tool_execution_end", toolCallId: "t3", toolName: "bash", result: { content: [] }, isError: false } as never);
		expect(messagesWithToolsHidden(s).map(text)).not.toContain("<t3>");
	});

	test("a tool-only reply that failed or was aborted stays visible", () => {
		const s = initSession({
			sessionId: "s",
			cwd: "/tmp",
			isStreaming: false,
			todoPhases: [],
			messages: [
				reply([call("a", "bash", { command: "sleep 99" })], { stopReason: "aborted" }),
				reply([call("b", "bash", { command: "x" })], { stopReason: "error", errorMessage: "provider exploded" }),
				result("a", "bash"),
				result("b", "bash"),
			],
		} as never);
		const shown = messagesWithToolsHidden(s) as AssistantMsg[];
		expect(shown.map((m) => m.stopReason)).toEqual(["aborted", "error"]);
		expect(render(shown[1]!, s, true)).toContain("provider exploded");
	});

	test("showing tool calls again renders every card", () => {
		const s = turn(true);
		const [prose, toolOnly] = assistants(s);
		expect(render(prose!, s, false)).toContain("tsconfig.json");
		expect(render(toolOnly!, s, false)).toContain("bun install");
	});
});

test("the hide-tool-calls choice is saved for this browser's next load", () => {
	const saved = new Map<string, string>();
	const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) },
	});
	try {
		expect(toolCallsHiddenPreference()).toBe(false);
		useStore.getState().setToolCallsHidden(true);
		expect(useStore.getState().toolCallsHidden).toBe(true);
		expect(toolCallsHiddenPreference()).toBe(true);
		useStore.getState().setToolCallsHidden(false);
		expect(toolCallsHiddenPreference()).toBe(false);
	} finally {
		if (original) Object.defineProperty(globalThis, "localStorage", original);
		else delete (globalThis as { localStorage?: unknown }).localStorage;
	}
});
