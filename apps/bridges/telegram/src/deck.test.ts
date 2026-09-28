/**
 * Drives `DeckClient.promptSession` against a fake deck WebSocket that
 * replays scripted server frames, pinning when a Telegram prompt settles.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerFrame } from "@npi-deck/protocol";

import { DeckClient } from "./deck.ts";

const SESSION = "s-1";

type Script = (text: string) => ServerFrame[];

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
	server?.stop(true);
	server = null;
});

function fakeDeck(script: Script, idleTimeoutMs?: number, onFrame?: (frame: { type: string; approved?: boolean; feedback?: string }) => ServerFrame[]): DeckClient {
	server = Bun.serve({
		port: 0,
		fetch(req, srv) {
			if (srv.upgrade(req, { data: undefined })) return undefined;
			return new Response("no", { status: 400 });
		},
		websocket: {
			message(ws, raw) {
				const frame = JSON.parse(String(raw)) as { type: string; sessionId: string; text?: string; approved?: boolean; feedback?: string };
				if (frame.type === "subscribe") {
					ws.send(JSON.stringify({ type: "subscribed", sessionId: frame.sessionId, snapshot: {} }));
					return;
				}
				for (const out of onFrame?.(frame) ?? []) ws.send(JSON.stringify(out));
				if (frame.type === "prompt") {
					for (const out of script(frame.text ?? "")) ws.send(JSON.stringify(out));
				}
			},
		},
	});
	const base = `http://127.0.0.1:${server.port}`;
	return new DeckClient(base, `ws://127.0.0.1:${server.port}/ws`, idleTimeoutMs);
}

function event(e: Record<string, unknown>): ServerFrame {
	return { type: "session_event", sessionId: SESSION, event: e } as unknown as ServerFrame;
}

function assistant(text: string): ServerFrame {
	return event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
}

describe("DeckClient.promptSession", () => {
	test("a tool exchange settles on the final answer, not the first tool turn", async () => {
		const deck = fakeDeck(() => [
			event({ type: "agent_start" }),
			assistant("Let me check the file."),
			event({ type: "turn_end" }),
			event({ type: "agent_end", isTerminal: false }),
			assistant("The file has 42 lines."),
			event({ type: "turn_end" }),
			event({ type: "agent_end" }),
		]);
		const seen: string[] = [];
		const final = await deck.promptSession({ sessionId: SESSION, text: "how long is it?", onText: (t) => seen.push(t) });
		expect(final).toBe("The file has 42 lines.");
		expect(seen).toEqual(["Let me check the file.", "The file has 42 lines."]);
	});

	test("a consumed slash command settles, and the next prompt still completes", async () => {
		const deck = fakeDeck((text) =>
			text.startsWith("/")
				? [
						event({ type: "message_start", message: { role: "user", content: text, synthetic: true } }),
						{ type: "prompt_consumed", sessionId: SESSION, output: "No tasks." },
					]
				: [assistant("hello"), event({ type: "agent_end" })],
		);
		expect(await deck.promptSession({ sessionId: SESSION, text: "/task list", onText: () => {} })).toBe("No tasks.");
		expect(await deck.promptSession({ sessionId: SESSION, text: "hi", onText: () => {} })).toBe("hello");
	});

	test("rejects an unreviewable proposal instead of hanging the Telegram turn", async () => {
		const sent: Array<{ type: string; approved?: boolean; feedback?: string }> = [];
		const deck = fakeDeck(() => [{
			type: "plan_proposed", sessionId: SESSION, proposalId: "p-1", planFilePath: "local://greeting-plan.md",
			planContent: "# Greeting", suggestedTitle: "greeting",
		}], 500, frame => {
			sent.push(frame);
			return frame.type === "plan_response" ? [assistant("Open the plan in the web UI."), event({ type: "agent_end" })] : [];
		});
		expect(await deck.promptSession({ sessionId: SESSION, text: "plan", onText: () => {} })).toBe("Open the plan in the web UI.");
		expect(sent.some(frame => frame.type === "plan_response" && frame.approved === false && frame.feedback?.includes("web UI"))).toBe(true);
		expect(sent.some(frame => frame.type === "set_plan_mode")).toBe(true);
	});

	test("a prompt that never completes fails after the idle timeout", async () => {
		const deck = fakeDeck(() => [assistant("working…")], 50);
		await expect(deck.promptSession({ sessionId: SESSION, text: "stall", onText: () => {} })).rejects.toThrow(
			/giving up on this prompt/,
		);
	});
});
