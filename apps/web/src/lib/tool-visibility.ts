import type { AssistantMsg, ChatMessage, SessionUi, ToolCallStream } from "./types";

/**
 * Hide-tool-calls chat mode (#62): the chat shows the assistant's prose, and a
 * tool call only as a one-line "working" row while it runs. Replies that were
 * nothing but finished tool calls drop out of the chat entirely.
 */

/** Stop reasons that say nothing a reader needs once the tool cards are gone. */
const QUIET_STOPS = new Set(["stop", "toolUse"]);

/**
 * The reply whose stream-less tool calls count as running: the newest
 * assistant reply of a busy session. A snapshot taken mid-tool replays no
 * tool events, so after a reconnect the running call has no stream yet.
 */
export function liveReplyId(session: Pick<SessionUi, "messages" | "status">): string | undefined {
	if (session.status === "idle") return undefined;
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const m = session.messages[i]!;
		if (m.role === "assistant") return m.id;
	}
	return undefined;
}

/**
 * Whether a tool call is still working. Its lifecycle stream says so; a call
 * with no stream counts while its reply streams or is the live reply. A call
 * an old transcript never finished (aborted) has no stream and is not working.
 */
export function toolCallWorking(msg: AssistantMsg, stream: ToolCallStream | undefined, live: boolean): boolean {
	if (stream) return stream.status === "running";
	return msg.isStreaming || live;
}

/** Whether `msg` shows anything in the chat while tool calls are hidden. */
export function visibleWithToolsHidden(msg: ChatMessage, toolCalls: Record<string, ToolCallStream>, live: boolean): boolean {
	if (msg.role !== "assistant") return true;
	if (msg.isStreaming || msg.errorMessage) return true;
	if (msg.stopReason && !QUIET_STOPS.has(msg.stopReason)) return true;
	return msg.blocks.some((b) => {
		if (b.type === "toolCall") return toolCallWorking(msg, toolCalls[b.id], live);
		if (b.type === "text") return b.text.trim() !== "";
		return true;
	});
}

/** The chat's messages with tool calls hidden, in order. */
export function messagesWithToolsHidden(session: Pick<SessionUi, "messages" | "status" | "toolCalls">): ChatMessage[] {
	const live = liveReplyId(session);
	return session.messages.filter((m) => visibleWithToolsHidden(m, session.toolCalls, m.id === live));
}
