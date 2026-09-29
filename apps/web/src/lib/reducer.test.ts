/**
 * Tests for the prompt-queue lifecycle (T-88). Covers the three synthetic
 * events the bridge emits via the session_event channel — `prompt_queued`,
 * `queue_cleared` — plus the de-dup behavior that drops a queued bubble
 * when the SDK eventually emits the real user message_start it was waiting
 * on.
 */
import { describe, expect, test } from "bun:test";

import { applyEvent, initSession } from "./reducer";
import type { SessionUi } from "./types";

function fresh(): SessionUi {
	return initSession({
		sessionId: "s1",
		cwd: "/tmp/x",
		isStreaming: true,
		messages: [],
		todoPhases: [],
	});
}

function queueEvent(text: string, queuedId = `q-${text}`) {
	return { type: "prompt_queued", queuedId, text, behavior: "followUp" } as never;
}

function userMessageStart(text: string, synthetic = false) {
	return {
		type: "message_start",
		message: { role: "user", content: text, synthetic, timestamp: 1700000000000 },
	} as never;
}

describe("reducer queue lifecycle", () => {
	test("prompt_queued appends a QueuedPrompt with the server id", () => {
		const s1 = applyEvent(fresh(), queueEvent("first", "abc"));
		expect(s1.queuedPrompts).toHaveLength(1);
		expect(s1.queuedPrompts[0]).toMatchObject({
			id: "abc",
			text: "first",
			behavior: "followUp",
		});
		const s2 = applyEvent(s1, queueEvent("second", "def"));
		expect(s2.queuedPrompts.map((q) => q.id)).toEqual(["abc", "def"]);
	});

	test("real user message_start drops the first matching queued entry (FIFO)", () => {
		let s = fresh();
		s = applyEvent(s, queueEvent("alpha", "1"));
		s = applyEvent(s, queueEvent("beta", "2"));
		s = applyEvent(s, queueEvent("alpha", "3")); // duplicate text — drop the oldest

		s = applyEvent(s, userMessageStart("alpha"));
		expect(s.queuedPrompts.map((q) => q.id)).toEqual(["2", "3"]);
		// The real user message also lands in `messages` so the chat shows it.
		expect(s.messages.at(-1)).toMatchObject({ role: "user", text: "alpha", synthetic: false });
	});

	test("synthetic user message_start does NOT drop a queued entry", () => {
		// Slash-command round-trips emit synthetic user messages with the
		// command text. They didn't come from the composer queue, so they
		// must not consume a queued bubble even if the text happens to match.
		let s = fresh();
		s = applyEvent(s, queueEvent("/help", "z"));
		s = applyEvent(s, userMessageStart("/help", true));
		expect(s.queuedPrompts.map((q) => q.id)).toEqual(["z"]);
	});

	test("queue_cleared empties the queue", () => {
		let s = fresh();
		s = applyEvent(s, queueEvent("a"));
		s = applyEvent(s, queueEvent("b"));
		expect(s.queuedPrompts).toHaveLength(2);

		s = applyEvent(s, { type: "queue_cleared", cleared: { steering: 0, followUp: 2 } } as never);
		expect(s.queuedPrompts).toHaveLength(0);
	});

	test("queue_cleared on an already-empty queue is a no-op (returns same ref)", () => {
		const s = fresh();
		const next = applyEvent(s, { type: "queue_cleared", cleared: { steering: 0, followUp: 0 } } as never);
		expect(next).toBe(s);
	});

	test("non-matching user message leaves the queue untouched", () => {
		let s = fresh();
		s = applyEvent(s, queueEvent("hello", "h"));
		s = applyEvent(s, userMessageStart("something unrelated"));
		expect(s.queuedPrompts.map((q) => q.id)).toEqual(["h"]);
	});

	test("initSession seeds queuedPrompts as an empty array", () => {
		expect(fresh().queuedPrompts).toEqual([]);
	});
});

/**
 * T-106: bridge synthesizes `todo_phases_set` after every `todo_write`
 * `tool_execution_end` so the Inspector doesn't show stale todos between
 * SDK reminder ticks. Reducer must normalize the carried `todoPhases`
 * into the same shape `todo_reminder` produces, and must coexist with
 * the existing reminder path without one stomping the other.
 */
describe("reducer todo_phases_set (T-106)", () => {
	test("replaces todoPhases with the carried snapshot, normalized", () => {
		let s = fresh();
		s = applyEvent(s, {
			type: "todo_phases_set",
			todoPhases: [
				{
					id: "phase-1",
					name: "Merge",
					tasks: [
						{ id: "t1", content: "Stage A", status: "completed" },
						{ id: "t2", content: "Stage B", status: "in_progress" },
					],
				},
			],
		} as never);
		expect(s.todoPhases).toHaveLength(1);
		expect(s.todoPhases[0]!.name).toBe("Merge");
		expect(s.todoPhases[0]!.tasks.map((t) => t.status)).toEqual(["completed", "in_progress"]);
	});

	test("empty array clears todoPhases", () => {
		let s = fresh();
		s = applyEvent(s, {
			type: "todo_phases_set",
			todoPhases: [{ name: "phase", tasks: [{ content: "x", status: "pending" }] }],
		} as never);
		expect(s.todoPhases).toHaveLength(1);
		s = applyEvent(s, { type: "todo_phases_set", todoPhases: [] } as never);
		expect(s.todoPhases).toEqual([]);
	});

	test("missing todoPhases payload is treated as empty (defensive)", () => {
		let s = fresh();
		s = applyEvent(s, { type: "todo_phases_set" } as never);
		expect(s.todoPhases).toEqual([]);
	});

	test("does not interfere with todo_reminder's existing wrap-once shape", () => {
		let s = fresh();
		// SDK-style reminder: single phase value (NOT wrapped)
		s = applyEvent(s, {
			type: "todo_reminder",
			todos: { name: "from-reminder", tasks: [{ content: "x", status: "pending" }] },
		} as never);
		expect(s.todoPhases[0]!.name).toBe("from-reminder");
		// Synthetic event then overrides cleanly with the canonical shape
		s = applyEvent(s, {
			type: "todo_phases_set",
			todoPhases: [{ name: "from-sync", tasks: [{ content: "y", status: "completed" }] }],
		} as never);
		expect(s.todoPhases[0]!.name).toBe("from-sync");
	});
});

describe("reducer queue_state event", () => {
	test("replaces queuedPrompts wholesale with the broadcast list", () => {
		let s = fresh();
		s = applyEvent(s, queueEvent("a", "1"));
		s = applyEvent(s, queueEvent("b", "2"));
		s = applyEvent(s, queueEvent("c", "3"));

		s = applyEvent(s, {
			type: "queue_state",
			queue: [
				{ id: "1", text: "a", behavior: "followUp", queuedAt: 1 },
				{ id: "3", text: "c", behavior: "followUp", queuedAt: 3 },
			],
		} as never);
		expect(s.queuedPrompts.map((q) => q.id)).toEqual(["1", "3"]);
	});

	test("returns the same state ref when the broadcast queue is structurally identical", () => {
		let s = fresh();
		s = applyEvent(s, queueEvent("a", "1"));
		const before = s;
		s = applyEvent(s, {
			type: "queue_state",
			queue: [{ id: "1", text: "a", behavior: "followUp", queuedAt: 1 }],
		} as never);
		expect(s).toBe(before);
	});

	test("queue_state with edited text on the same id updates that entry only", () => {
		let s = fresh();
		s = applyEvent(s, queueEvent("draft", "x"));
		s = applyEvent(s, {
			type: "queue_state",
			queue: [{ id: "x", text: "polished", behavior: "followUp", queuedAt: 1 }],
		} as never);
		expect(s.queuedPrompts[0]).toMatchObject({ id: "x", text: "polished" });
	});

	test("malformed queue entries (no id) are dropped, not crashed on", () => {
		const s = applyEvent(fresh(), {
			type: "queue_state",
			queue: [
				{ text: "ghost", behavior: "followUp" },
				{ id: "ok", text: "kept", behavior: "followUp", queuedAt: 1 },
			],
		} as never);
		expect(s.queuedPrompts.map((q) => q.id)).toEqual(["ok"]);
	});
});

describe("reducer queuedPrompts snapshot hydration", () => {
	test("initSession hydrates queuedPrompts from snapshot when present", () => {
		const s = initSession({
			sessionId: "s1",
			cwd: "/tmp/x",
			isStreaming: true,
			messages: [],
			todoPhases: [],
			queuedPrompts: [
				{ id: "k1", text: "first", behavior: "followUp", queuedAt: 1 },
				{ id: "k2", text: "second", behavior: "steer", queuedAt: 2 },
			],
		});
		expect(s.queuedPrompts.map((q) => q.id)).toEqual(["k1", "k2"]);
		expect(s.queuedPrompts[1]?.behavior).toBe("steer");
	});
});

describe("run status across NeoPi's agent_end", () => {
	test("a non-terminal agent_end and turn_end keep the chat busy; the terminal agent_end idles it", () => {
		let s = fresh();
		s = applyEvent(s, { type: "agent_start" } as never);
		s = applyEvent(s, { type: "turn_start" } as never);
		s = applyEvent(s, { type: "turn_end" } as never);
		expect(s.status).toBe("streaming");
		s = applyEvent(s, { type: "agent_end", isTerminal: false } as never);
		expect(s.status).toBe("streaming");
		s = applyEvent(s, { type: "agent_end" } as never);
		expect(s.status).toBe("idle");
	});
});

describe("config warnings snapshot updates", () => {
	test("refresh replaces and clears warnings without losing the selected model", () => {
		let state = initSession({
			sessionId: "s1", cwd: "/tmp/x", isStreaming: false, messages: [], todoPhases: [],
			model: { provider: "mixture", id: "reviewers" }, configWarnings: ["retry chain unresolved"],
		});
		expect(state.configWarnings).toEqual(["retry chain unresolved"]);
		state = applyEvent(state, { type: "session_updated", snapshot: {
			sessionId: "s1", cwd: "/tmp/x", isStreaming: false, messages: [], todoPhases: [],
			model: { provider: "mixture", id: "reviewers" }, configWarnings: [],
		} } as never);
		expect(state.configWarnings).toEqual([]);
		expect(state.model).toEqual({ provider: "mixture", id: "reviewers" });
	});
});

describe("mixture trace events", () => {
	test("hop, checkpoint and terminal events remain visible with stable run ids", () => {
		const hop = { v: 1, kind: "hop", runId: "r1", seq: 1, at: 42, mixture: "reviewers", memberId: "writer", output: "draft", visible: true, run: { status: "running" } };
		let state = applyEvent(fresh(), { type: "mixture_hop_end", details: hop } as never);
		state = applyEvent(state, { type: "mixture_checkpoint", details: { ...hop, kind: "checkpoint", seq: 2, reason: "abort" } } as never);
		state = applyEvent(state, { type: "mixture_run_end", details: { ...hop, kind: "run_end", seq: 3, endReason: "done", run: { status: "completed" } } } as never);
		expect(state.messages.filter((msg) => msg.role === "mixtureTrace").map((msg) => msg.id)).toEqual(["mixture:r1:1", "mixture:r1:2", "mixture:r1:3"]);
		const same = applyEvent(state, { type: "mixture_hop_end", details: hop } as never);
		expect(same).toBe(state);
	});

	test("persisted trace cards restore without a new run event", () => {
		const state = initSession({ sessionId: "s1", cwd: "/tmp/x", isStreaming: false, todoPhases: [], messages: [
			{ role: "custom", customType: "mixture_trace", display: true, content: "writer", details: { v: 1, runId: "r2", seq: 4, kind: "hop", memberId: "writer", output: "answer", visible: true, run: { status: "running" } } },
		] });
		expect(state.messages).toMatchObject([{ id: "mixture:r2:4", role: "mixtureTrace", content: "writer" }]);
	});
});

describe("assistant content blocks", () => {
	test("a block type the client doesn't know is kept as a visible placeholder", () => {
		let s = fresh();
		s = applyEvent(s, {
			type: "message_start",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "hi" },
					{ type: "anthropicServerTool", name: "web_fetch", input: {} },
				],
				timestamp: 1700000000000,
			},
		} as never);
		const msg = s.messages.find((m) => m.role === "assistant") as { blocks: Array<{ type: string; blockType?: string }> };
		expect(msg.blocks.map((b) => b.type)).toEqual(["text", "unknown"]);
		expect(msg.blocks[1]?.blockType).toBe("anthropicServerTool");
	});
});

describe("tool results from a snapshot", () => {
	test("a persisted toolResult becomes the card's result, so errors show after reload", () => {
		const s = initSession({
			sessionId: "s2",
			cwd: "/tmp/x",
			isStreaming: false,
			todoPhases: [],
			messages: [
				{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "x" } }] },
				{ role: "toolResult", toolCallId: "t1", toolName: "bash", isError: true, content: [{ type: "text", text: "Async job manager unavailable for this session." }] },
			],
		});
		expect(s.toolCalls.t1?.result).toEqual({ content: [{ type: "text", text: "Async job manager unavailable for this session." }] });
		expect(s.toolCalls.t1?.isError).toBe(true);
	});
});

describe("a reply already streaming when the chat subscribes", () => {
	const assistant = (text: string, totalTokens: number) => ({
		role: "assistant", content: [{ type: "text", text }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { total: 0 } }, timestamp: 1,
	});
	const textOf = (s: SessionUi) => s.messages.map((m) => m.role === "user" ? m.text : m.role === "assistant" ? m.blocks.map((b) => (b as { text: string }).text).join("") : m.role);

	test("lands after the prompt it answers and leaves the earlier reply alone", () => {
		// A reload or reconnect mid-turn: the snapshot holds the committed
		// messages, not the reply in flight.
		let s = initSession({
			sessionId: "s1", cwd: "/tmp", isStreaming: true, todoPhases: [],
			messages: [{ role: "user", content: "first", timestamp: 1 }, assistant("first answer", 10), { role: "user", content: "second", timestamp: 2 }] as never,
		});
		s = applyEvent(s, { type: "message_update", message: assistant("second ans", 0) } as never);
		s = applyEvent(s, { type: "message_update", message: assistant("second answer", 0) } as never);
		expect(textOf(s)).toEqual(["first", "first answer", "second", "second answer"]);
		s = applyEvent(s, { type: "message_end", message: assistant("second answer", 5) } as never);
		expect(textOf(s)).toEqual(["first", "first answer", "second", "second answer"]);
		expect(s.messages.at(-1)).toMatchObject({ role: "assistant", isStreaming: false });
		expect(s.usage.totalTokens).toBe(15);
	});

	test("a reply that ends before any update still appears once", () => {
		let s = initSession({
			sessionId: "s1", cwd: "/tmp", isStreaming: true, todoPhases: [],
			messages: [{ role: "user", content: "first", timestamp: 1 }, assistant("first answer", 10), { role: "user", content: "second", timestamp: 2 }] as never,
		});
		s = applyEvent(s, { type: "message_end", message: assistant("second answer", 5) } as never);
		expect(textOf(s)).toEqual(["first", "first answer", "second", "second answer"]);
		expect(s.usage.totalTokens).toBe(15);
	});

	test("a reply seen from its start streams in place", () => {
		let s = initSession({ sessionId: "s1", cwd: "/tmp", isStreaming: false, todoPhases: [], messages: [{ role: "user", content: "q", timestamp: 1 }] as never });
		s = applyEvent(s, { type: "message_start", message: assistant("", 0) } as never);
		s = applyEvent(s, { type: "message_update", message: assistant("par", 0) } as never);
		s = applyEvent(s, { type: "message_end", message: assistant("partial", 5) } as never);
		expect(textOf(s)).toEqual(["q", "partial"]);
		expect(s.usage.totalTokens).toBe(5);
	});

	test("a reply left unended before the latest prompt is never written into", () => {
		// An earlier bridge sent slash-command replies without message_end.
		let s = initSession({ sessionId: "s1", cwd: "/tmp", isStreaming: false, todoPhases: [], messages: [] });
		s = applyEvent(s, { type: "message_start", message: { role: "user", content: "/help", synthetic: true, timestamp: 1 } } as never);
		s = applyEvent(s, { type: "message_start", message: assistant("help text", 0) } as never);
		s = applyEvent(s, { type: "message_start", message: { role: "user", content: "question", timestamp: 2 } } as never);
		// Subscribed mid-reply: no message_start for the answer.
		s = applyEvent(s, { type: "message_update", message: assistant("ans", 0) } as never);
		s = applyEvent(s, { type: "message_end", message: assistant("answer", 5) } as never);
		expect(textOf(s)).toEqual(["/help", "help text", "question", "answer"]);
	});
});
