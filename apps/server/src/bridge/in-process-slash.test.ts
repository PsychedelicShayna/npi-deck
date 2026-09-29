/**
 * A slash command the deck or SDK answers itself shows up in the chat as a
 * synthetic prompt and reply. The reply must end like any other message, or
 * clients keep it streaming and write the next reply into it.
 */
import { expect, test } from "bun:test";

import { InProcessSessionHandle } from "./in-process.ts";

test("a synthetic slash-command reply is ended, not left streaming", async () => {
	const emitted: Array<{ type: string; message?: { role?: string } }> = [];
	const handle = new InProcessSessionHandle({
		session: { isStreaming: false, messages: [], async dispose() {} } as never,
		sessionManager: { buildSessionContext: () => ({ messages: [] }), getBranch: () => [] } as never,
		cwd: "/tmp/stub",
		sessionId: "stub-1",
		getModelRegistry: async () => ({}) as never,
		planBridge: { dispose() {}, getPlanModeContext: () => undefined, getPendingPlanApproval: () => undefined } as never,
		onDispose: () => {},
	});
	handle.subscribe((event) => emitted.push(event as never));
	// A usage error: answered by the deck before it touches the task store.
	const result = await handle.dispatchDeckSlashCommand("/task add");
	expect(result.kind).toBe("consumed");
	expect(emitted.map((e) => `${e.type}:${e.message?.role}`)).toEqual([
		"message_start:user",
		"message_start:assistant",
		"message_end:assistant",
	]);
});
