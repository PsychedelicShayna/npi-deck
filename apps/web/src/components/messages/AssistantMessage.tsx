import type { AssistantMsg, ToolCallStream } from "@/lib/types";
import { Markdown } from "@/lib/markdown";
import { formatCost, formatDurationMs, formatTokens } from "@/lib/utils";
import { reasoningBlockView, reasoningBlockViews, unreportedReasoningView } from "@/lib/reasoning";
import { ReasoningBlock } from "./ThinkingBlock";
import { ToolCallCard, ToolWorkingLine } from "../tools/ToolCallCard";
import { toolCallWorking } from "@/lib/tool-visibility";

interface Props {
	msg: AssistantMsg;
	toolCalls: Record<string, ToolCallStream>;
	/** Hide tool cards; a running tool shows as a one-line working row (#62). */
	toolCallsHidden?: boolean;
	/** This is the live reply of a busy session (see `liveReplyId`). */
	live?: boolean;
}

export function AssistantMessage({ msg, toolCalls, toolCallsHidden = false, live = false }: Props) {
	const lastBlockIdx = msg.blocks.length - 1;
	const unreportedReasoning = unreportedReasoningView(msg);
	const reasoningViews = reasoningBlockViews(msg);

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-2xs uppercase tracking-meta text-ink-3">
				<span className="text-ink-2">npi</span>
				{msg.model ? <span className="text-ink-4 normal-case tracking-normal">{msg.model}</span> : null}
				{msg.isStreaming ? <span className="text-accent">· streaming</span> : null}
				{msg.stopReason && !msg.isStreaming ? (
					<span className={msg.stopReason === "stop" ? "text-ink-4" : "text-warn"}>
						· {msg.stopReason}
					</span>
				) : null}
				{msg.usage?.totalTokens ? (
					<span className="text-ink-4">
						· {formatTokens(msg.usage.totalTokens)} tok · {formatCost(msg.usage.cost)}
					</span>
				) : null}
				{msg.durationMs ? (
					<span className="text-ink-4">· {formatDurationMs(msg.durationMs)}</span>
				) : null}
			</div>

			{msg.errorMessage ? (
				<div className="border-l-2 border-danger pl-3 font-mono text-xs text-danger">
					{msg.errorMessage}
				</div>
			) : null}

			{msg.blocks.length === 0 && msg.isStreaming ? (
				<div className="cursor-blink font-mono text-xs text-ink-3">…</div>
			) : null}

			<div className="space-y-3">
				{unreportedReasoning ? <ReasoningBlock view={unreportedReasoning} /> : null}
				{msg.blocks.map((b, i) => {
					if (b.type === "text") {
						const last = i === lastBlockIdx;
						return (
							<Markdown key={i} streaming={msg.isStreaming && last}>
								{b.text}
							</Markdown>
						);
					}
					if (b.type === "thinking" || b.type === "redactedThinking") {
						const view = reasoningViews[i] ?? reasoningBlockView(b, msg);
						return <ReasoningBlock key={i} view={view} streaming={msg.isStreaming} />;
					}
					if (b.type === "toolCall") {
						const stream = toolCalls[b.id];
						if (toolCallsHidden) {
							return toolCallWorking(msg, stream, live) ? (
								<ToolWorkingLine key={b.id || i} name={b.name} args={b.arguments} intent={b.intent} />
							) : null;
						}
						return (
							<ToolCallCard
								key={b.id || i}
								toolCallId={b.id}
								name={b.name}
								args={b.arguments}
								intent={b.intent}
								stream={stream}
							/>
						);
					}
					if (b.type === "image") {
						return (
							<img
								key={i}
								src={`data:${b.mimeType};base64,${b.data}`}
								alt="assistant image"
								className="max-h-96 rounded border border-line"
							/>
						);
					}
					return (
						<details key={i} className="rounded border border-dashed border-line px-2 py-1 font-mono text-2xs text-ink-3">
							<summary className="cursor-pointer">unsupported content block: {b.blockType}</summary>
							<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(b.raw, null, 2)}</pre>
						</details>
					);
				})}
			</div>
		</div>
	);
}
