/**
 * Pure reducer over AgentSessionEvent passthroughs.
 *
 * Builds a coherent UI state from a stream of unknown-shape events. Treats
 * the SDK contract structurally — never imports SDK types — so the protocol
 * boundary stays narrow.
 */

import type { AgentSessionEventJson, SessionSnapshot } from "@npi-deck/protocol";
import { applyMixtureTrace, emptyMixtureUi, hydrateMixtureTraces } from "./mixture-reducer";

import type {
	AssistantContentBlock,
	AssistantMsg,
	ChatMessage,
	ImageBlock,
	MixtureTraceMsg,
	NoticeMsg,
	QueuedPrompt,
	SessionUi,
	TextBlock,
	ThinkingBlock,
	ToolCallStream,
	TodoPhase,
	UsageRollup,
} from "./types";

// ─── Public API ────────────────────────────────────────────────────────────

let ID_SEQ = 0;
const nextId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${++ID_SEQ}`;

const EMPTY_USAGE: UsageRollup = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
};

/**
 * `priorUsage` holds the `usage` of assistant messages older than
 * `snapshot.messages` (a transcript tail), so the cost rollup still covers them.
 */
export function initSession(snapshot: SessionSnapshot, priorUsage: readonly unknown[] = []): SessionUi {
	const state: SessionUi = {
		sessionId: snapshot.sessionId,
		...(snapshot.backgroundJobsUnavailable ? { backgroundJobsUnavailable: true } : {}),
		cwd: snapshot.cwd,
		sessionFile: snapshot.sessionFile,
		sessionName: snapshot.sessionName,
		model: snapshot.model,
		thinkingLevel: snapshot.thinkingLevel,
		configWarnings: snapshot.configWarnings,
		messages: [],
		toolCalls: {},
		todoPhases: normalizeTodoPhases(snapshot.todoPhases),
		status: snapshot.isStreaming ? "streaming" : "idle",
		usage: { ...EMPTY_USAGE },
		turnCount: 0,
		contextUsage: snapshot.contextUsage,
		queuedPrompts: hydrateQueuedPrompts(snapshot.queuedPrompts),
		planMode: snapshot.planMode,
		pendingPlanApproval: snapshot.pendingPlanApproval,
	};
	for (const u of priorUsage) {
		rollupUsage(state, u);
	}
	for (const m of snapshot.messages) {
		ingestMessage(state, m);
	}
	// Live snapshots carry trace cards beside the model context; transcripts inline them.
	state.mixture = hydrateMixtureTraces([...snapshot.messages, ...(snapshot.mixtureTraces ?? [])], { streaming: snapshot.isStreaming, model: snapshot.model });
	return state;
}

export function applyEvent(state: SessionUi, event: AgentSessionEventJson): SessionUi {
	switch (event.type) {
		// ─── Agent lifecycle ───────────────────────────────────────────────
		case "agent_start":
			return { ...state, status: "streaming", lastError: undefined };
		// A run ends only at a terminal agent_end. NeoPi emits
		// `isTerminal: false` when queued input or an async delivery will
		// resume the session, so the chat must stay busy through it.
		case "agent_end":
			return (event as { isTerminal?: boolean }).isTerminal === false ? state : { ...state, status: "idle" };

		// ─── Turn lifecycle ────────────────────────────────────────────────
		case "turn_start":
			return {
				...state,
				status: "streaming",
				turnCount: state.turnCount + 1,
				lastError: undefined,
			};
		// turn_end separates the turns of one run (a tool round-trip, a
		// continuation); the run is still going until agent_end.
		case "turn_end":
			return state;

		// Synthetic event the deck's bridge emits after the SDK's own turn-end
		// or compaction-complete, carrying the freshly-computed context-window
		// utilization. Lets the header indicator update without re-snapshotting.
		case "context_usage": {
			const usage = (event as { contextUsage?: import("@npi-deck/protocol").ContextUsage }).contextUsage;
			if (!usage) return state;
			return { ...state, contextUsage: usage };
		}

		// Synthetic event the deck's bridge emits after `setModel` (and possibly
		// other session-header mutations) so the UI re-renders the new model
		// label without waiting for the next assistant turn.
		case "session_updated": {
			const snap = (event as { snapshot?: SessionSnapshot }).snapshot;
			if (!snap) return state;
			return {
				...state,
				model: snap.model,
				sessionName: snap.sessionName,
				thinkingLevel: snap.thinkingLevel,
				configWarnings: snap.configWarnings,
			};
		}

		// ─── Messages ──────────────────────────────────────────────────────
		case "message_start": {
			const msg = (event as any).message;
			if (!msg) return state;
			const next = { ...state, messages: state.messages.slice() };
			ingestMessage(next, msg);
			// A reply streams until its message_end; updates and the end target it.
			const last = next.messages.at(-1);
			if (msg.role === "assistant" && last?.role === "assistant") next.messages[next.messages.length - 1] = { ...last, isStreaming: true };
			return next;
		}
		case "message_update": {
			const msg = (event as any).message;
			if (!msg || msg.role !== "assistant") return state;
			return updateAssistantMessage(state, msg);
		}
		case "message_end": {
			const msg = (event as any).message;
			if (!msg) return state;
			const next = finalizeMessage(state, msg);
			return msg.role === "custom" && msg.customType === "advisor" ? bumpAdvisorActivity(next) : next;
		}

		// ─── Tool execution ────────────────────────────────────────────────
		case "tool_execution_start": {
			const id = String((event as any).toolCallId ?? "");
			if (!id) return state;
			const stream: ToolCallStream = {
				id,
				name: String((event as any).toolName ?? "?"),
				args: (event as any).args as Record<string, unknown> | undefined,
				intent: (event as any).intent as string | undefined,
				status: "running",
				isError: false,
				startedAt: Date.now(),
			};
			return { ...state, toolCalls: { ...state.toolCalls, [id]: stream } };
		}
		case "tool_execution_update": {
			const id = String((event as any).toolCallId ?? "");
			const prev = state.toolCalls[id];
			if (!prev) return state;
			return {
				...state,
				toolCalls: {
					...state.toolCalls,
					[id]: { ...prev, partialResult: (event as any).partialResult },
				},
			};
		}
		case "tool_stream_update": {
			const id = String((event as any).toolCallId ?? "");
			const prev = state.toolCalls[id];
			if (!prev) return state;
			return {
				...state,
				toolCalls: { ...state.toolCalls, [id]: { ...prev, streamUpdate: (event as any).update } },
			};
		}
		case "tool_execution_end": {
			const id = String((event as any).toolCallId ?? "");
			const prev = state.toolCalls[id];
			const isError = Boolean((event as any).isError);
			const result = (event as any).result as unknown;
			const next: ToolCallStream = prev
				? {
						...prev,
						status: isError ? "error" : "complete",
						isError,
						result,
						endedAt: Date.now(),
					}
				: {
						id,
						name: String((event as any).toolName ?? "?"),
						args: undefined,
						status: isError ? "error" : "complete",
						isError,
						result,
						startedAt: Date.now(),
						endedAt: Date.now(),
					};
			return { ...state, toolCalls: { ...state.toolCalls, [id]: next } };
		}

		// ─── Todos ─────────────────────────────────────────────────────────
		case "todo_reminder": {
			const todos = (event as any).todos as unknown;
			return { ...state, todoPhases: normalizeTodoPhases([todos]) };
		}
		// Synthetic event emitted by the deck bridge after every `todo_write`
		// `tool_execution_end`. Carries the canonical `TodoPhase[]` from
		// `session.getTodoPhases()` so the Inspector reflects in-turn changes
		// without waiting for the next SDK reminder tick (T-106).
		case "todo_phases_set": {
			const phases = (event as { todoPhases?: unknown }).todoPhases;
			return { ...state, todoPhases: normalizeTodoPhases(phases) };
		}
		case "todo_auto_clear":
			return { ...state, todoPhases: [] };

		// ─── Compaction / retry / TTSR ────────────────────────────────────
		case "auto_compaction_start":
			return {
				...state,
				status: "compacting",
				compaction: {
					reason: String((event as any).reason ?? ""),
					action: String((event as any).action ?? ""),
					startedAt: Date.now(),
				},
			};
		case "auto_compaction_end": {
			const next: SessionUi = { ...state, status: "streaming", compaction: undefined };
			const result = (event as any).result;
			if (result && typeof result === "object") {
				const summary =
					typeof (result as any).shortSummary === "string"
						? (result as any).shortSummary
						: typeof (result as any).summary === "string"
							? (result as any).summary
							: undefined;
				next.messages = [
					...state.messages,
					{
						id: nextId("compaction"),
						role: "compaction",
						reason: String((event as any).reason ?? state.compaction?.reason ?? ""),
						action: String((event as any).action ?? state.compaction?.action ?? ""),
						summary,
						timestamp: Date.now(),
					},
				];
			}
			return next;
		}
		case "auto_retry_start":
			return {
				...state,
				status: "retrying",
				retry: {
					attempt: Number((event as any).attempt ?? 0),
					maxAttempts: Number((event as any).maxAttempts ?? 0),
					errorMessage: String((event as any).errorMessage ?? ""),
				},
			};
		case "auto_retry_end":
			return {
				...state,
				status: "streaming",
				retry: undefined,
				lastError: (event as any).success ? undefined : ((event as any).finalError as string | undefined),
			};
		case "retry_fallback_applied":
			return pushNotice(state, {
				level: "warning",
				message: `Fallback applied: ${(event as any).from} → ${(event as any).to} (${(event as any).role})`,
				source: "retry",
			});
		case "retry_fallback_succeeded":
			return pushNotice(state, {
				level: "info",
				message: `Recovered on ${(event as any).model} (${(event as any).role})`,
				source: "retry",
			});
		case "ttsr_triggered":
			return {
				...state,
				ttsr: {
					rules: ((event as any).rules as Array<{ name?: string; description?: string }>) ?? [],
					at: Date.now(),
				},
				messages: [
					...state.messages,
					{
						id: nextId("ttsr"),
						role: "ttsr",
						rules: ((event as any).rules as any[]) ?? [],
						timestamp: Date.now(),
					},
				],
			};

		// ─── Misc surface ──────────────────────────────────────────────────
		case "notice":
			return pushNotice(state, {
				level: ((event as any).level as "info" | "warning" | "error") ?? "info",
				message: String((event as any).message ?? ""),
				source: (event as any).source as string | undefined,
			});
		case "thinking_level_changed":
			return {
				...state,
				thinkingLevel: (event as any).thinkingLevel as string | undefined,
			};
		case "goal_updated":
			return {
				...state,
				goal: { goal: (event as any).goal, state: (event as any).state },
			};
		// A delivered advisor note or a finished advisor review: the advisor
		// panel refetches live state once, even while it is hidden and idle.
		case "advisor_yielded":
			return bumpAdvisorActivity(state);
		// These are payload-free SDK notifications; the bridge sends a fresh
		// snapshot for config warnings. Advisor cost is read by the visible panel.
		case "config_warnings_changed":
		case "advisor_cost_changed":
			return state;
		// One trace feeds both surfaces: the chat card (#43) and the MoA panel (#80).
		case "mixture_hop_end":
		case "mixture_checkpoint":
		case "mixture_limit":
		case "mixture_run_end": {
			const details = (event as { details?: unknown }).details;
			const withCard = appendMixtureTrace(state, details);
			const mixture = applyMixtureTrace(state.mixture ?? emptyMixtureUi(), details);
			return withCard === state && mixture === state.mixture ? state : { ...withCard, mixture };
		}
		case "irc_message": {
			const msg = (event as any).message;
			if (!msg) return state;
			return {
				...state,
				messages: [
					...state.messages,
					{
						id: nextId("irc"),
						role: "irc",
						customType: msg.customType as string | undefined,
						content: extractText(msg.content),
						from: (msg.attribution as string | undefined) ?? undefined,
						timestamp: Date.now(),
					},
				],
			};
		}

		// ─── Prompt queue (synthetic events emitted by the bridge) ────────
		// `prompt_queued` fires when the user sends a prompt while the agent
		// is mid-turn — the SDK queues it and runs it once the current turn
		// ends. Surface it as a visible bubble so the draft does not appear
		// to vanish. `queue_cleared` fires when the SDK queue is dropped
		// (explicit `clear_queue` from the user, or `abort` which mirrors
		// stop-everything intent).
		case "prompt_queued": {
			const ev = event as {
				queuedId?: string;
				text?: string;
				images?: ImageBlock[];
				behavior?: "followUp" | "steer";
			};
			const entry: QueuedPrompt = {
				id: typeof ev.queuedId === "string" && ev.queuedId.length > 0
					? ev.queuedId
					: nextId("queued"),
				text: typeof ev.text === "string" ? ev.text : "",
				behavior: ev.behavior === "steer" ? "steer" : "followUp",
				queuedAt: Date.now(),
			};
			if (Array.isArray(ev.images) && ev.images.length > 0) entry.images = ev.images;
			return { ...state, queuedPrompts: [...state.queuedPrompts, entry] };
		}
		case "queue_cleared":
			return state.queuedPrompts.length === 0
				? state
				: { ...state, queuedPrompts: [] };

		// `queue_state` is the authoritative re-broadcast emitted after a
		// cancel / edit / drain so the client replaces its `queuedPrompts`
		// wholesale instead of patching deltas. Also fires on every
		// `prompt_queued` so the snapshot id-ordering stays canonical.
		case "queue_state": {
			const ev = event as { queue?: unknown };
			const next = hydrateQueuedPrompts(ev.queue);
			if (next.length === state.queuedPrompts.length && next.every((q, i) => {
				const prev = state.queuedPrompts[i];
				return prev && prev.id === q.id && prev.text === q.text;
			})) {
				return state;
			}
			return { ...state, queuedPrompts: next };
		}
	}
	return state;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function appendMixtureTrace(state: SessionUi, details: unknown): SessionUi {
	if (!details || typeof details !== "object") return state;
	const d = details as Record<string, unknown>;
	if (typeof d.runId !== "string" || typeof d.seq !== "number" || typeof d.kind !== "string") return state;
	const id = `mixture:${d.runId}:${d.seq}`;
	if (state.messages.some((message) => message.id === id)) return state;
	const content = `${String(d.mixture ?? "Mixture")} · ${d.kind}${typeof d.memberId === "string" ? ` · ${d.memberId}` : ""}`;
	const message: MixtureTraceMsg = { id, role: "mixtureTrace", content, details: d, timestamp: typeof d.at === "number" ? d.at : Date.now() };
	return { ...state, messages: [...state.messages, message] };
}

function bumpAdvisorActivity(state: SessionUi): SessionUi {
	return { ...state, advisorActivity: (state.advisorActivity ?? 0) + 1 };
}

function pushNotice(state: SessionUi, p: Omit<NoticeMsg, "id" | "role" | "timestamp">): SessionUi {
	return {
		...state,
		messages: [
			...state.messages,
			{
				id: nextId("notice"),
				role: "notice",
				timestamp: Date.now(),
				...p,
			},
		],
	};
}

function ingestMessage(state: SessionUi, msg: any): void {
	if (!msg || typeof msg !== "object") return;
	switch (msg.role) {
		case "user": {
			const text = extractText(msg.content);
			const synthetic = Boolean(msg.synthetic);
			state.messages.push({
				id: nextId("user"),
				role: "user",
				text,
				images: extractImages(msg.content),
				timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
				synthetic,
			});
			// If this real user message corresponds to a previously-queued prompt
			// (same text, FIFO), drop the queued bubble so we don't render the
			// same message twice. Synthetic round-trips (slash echoes) don't
			// originate from the composer, so they never match the queue.
			if (!synthetic && state.queuedPrompts.length > 0 && text.length > 0) {
				const idx = state.queuedPrompts.findIndex((q) => q.text === text);
				if (idx >= 0) {
					state.queuedPrompts = [
						...state.queuedPrompts.slice(0, idx),
						...state.queuedPrompts.slice(idx + 1),
					];
				}
			}
			return;
		}
		case "custom": {
			if (msg.customType !== "mixture_trace" || msg.display === false) return;
			const details = msg.details;
			if (!details || typeof details !== "object") return;
			const d = details as Record<string, unknown>;
			if (typeof d.runId !== "string" || typeof d.seq !== "number") return;
			const id = `mixture:${d.runId}:${d.seq}`;
			if (state.messages.some((message) => message.id === id)) return;
			state.messages.push({ id, role: "mixtureTrace", content: extractText(msg.content), details: d, timestamp: typeof d.at === "number" ? d.at : Date.now() });
			return;
		}
		case "assistant": {
			state.messages.push({
				id: nextId("asst"),
				role: "assistant",
				blocks: extractAssistantBlocks(msg.content),
				model: typeof msg.model === "string" ? msg.model : undefined,
				provider: typeof msg.provider === "string" ? msg.provider : undefined,
				usage: extractUsage(msg.usage),
				stopReason: typeof msg.stopReason === "string" ? msg.stopReason : undefined,
				isStreaming: false,
				errorMessage: typeof msg.errorMessage === "string" ? msg.errorMessage : undefined,
				timestamp: typeof msg.timestamp === "number" ? msg.timestamp : undefined,
				durationMs: typeof msg.duration === "number" ? msg.duration : undefined,
				ttft: typeof msg.ttft === "number" ? msg.ttft : undefined,
			});
			if (msg.usage) {
				rollupUsage(state, msg.usage);
			}
			return;
		}
		case "toolResult": {
			// Don't add as a top-level message — fold into the toolCalls map so
			// the chat renders the tool's lifecycle as a single inline card.
			const id = String(msg.toolCallId ?? "");
			if (!id) return;
			const content = Array.isArray(msg.content)
				? (msg.content
						.map((c: any) => normalizeTextOrImage(c))
						.filter(Boolean) as Array<TextBlock | ImageBlock>)
				: [];
			const prev = state.toolCalls[id];
			// Cards render `result`; a snapshot or read-only transcript has no
			// tool_execution_end, so the persisted toolResult content is the
			// result (including verbatim refusals such as NeoPi's "Async job
			// manager unavailable for this session.").
			state.toolCalls[id] = prev
				? {
						...prev,
						result: prev.result ?? { content },
						resultContent: content,
						isError: Boolean(msg.isError ?? prev.isError),
						status: msg.isError ? "error" : prev.status === "running" ? "complete" : prev.status,
						endedAt: prev.endedAt ?? Date.now(),
					}
				: {
						id,
						name: String(msg.toolName ?? "?"),
						args: undefined,
						result: { content },
						resultContent: content,
						status: msg.isError ? "error" : "complete",
						isError: Boolean(msg.isError),
						startedAt: Date.now(),
						endedAt: Date.now(),
					};
			return;
		}
		default:
			return;
	}
}

/**
 * The reply in flight: the newest assistant message of the current turn
 * (after the latest prompt), if it is still streaming. A chat that
 * subscribed mid-reply never saw its message_start, so the newest assistant
 * message is an earlier, finished one, or belongs to an earlier turn.
 */
function streamingAssistantIndex(messages: SessionUi["messages"]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "user") return -1;
		if (m?.role === "assistant") return m.isStreaming ? i : -1;
	}
	return -1;
}

function updateAssistantMessage(state: SessionUi, msg: any): SessionUi {
	const messages = state.messages.slice();
	const i = streamingAssistantIndex(messages);
	const m = messages[i];
	if (m?.role === "assistant") {
		messages[i] = {
			...m,
			blocks: extractAssistantBlocks(msg.content),
			isStreaming: true,
			model: typeof msg.model === "string" ? msg.model : m.model,
			provider: typeof msg.provider === "string" ? msg.provider : m.provider,
		};
		return { ...state, messages };
	}
	// Its message_start came before this chat subscribed: start it here.
	messages.push({
		id: nextId("asst"),
		role: "assistant",
		blocks: extractAssistantBlocks(msg.content),
		isStreaming: true,
		model: typeof msg.model === "string" ? msg.model : undefined,
		provider: typeof msg.provider === "string" ? msg.provider : undefined,
	});
	return { ...state, messages };
}

function finalizeMessage(state: SessionUi, msg: any): SessionUi {
	if (!msg || typeof msg !== "object") return state;
	if (msg.role !== "assistant") return state;
	const messages = state.messages.slice();
	const i = streamingAssistantIndex(messages);
	const m = messages[i];
	if (m?.role !== "assistant") {
		// Its start and updates came before this chat subscribed.
		const next = { ...state, messages };
		ingestMessage(next, msg);
		return next;
	}
	messages[i] = {
		...m,
		blocks: extractAssistantBlocks(msg.content),
		isStreaming: false,
		model: typeof msg.model === "string" ? msg.model : m.model,
		provider: typeof msg.provider === "string" ? msg.provider : m.provider,
		usage: extractUsage(msg.usage) ?? m.usage,
		stopReason: typeof msg.stopReason === "string" ? msg.stopReason : m.stopReason,
		errorMessage: typeof msg.errorMessage === "string" ? msg.errorMessage : m.errorMessage,
		timestamp: typeof msg.timestamp === "number" ? msg.timestamp : m.timestamp,
		durationMs: typeof msg.duration === "number" ? msg.duration : m.durationMs,
		ttft: typeof msg.ttft === "number" ? msg.ttft : m.ttft,
	};
	const next = { ...state, messages };
	if (msg.usage) {
		rollupUsage(next, msg.usage);
	}
	return next;
}

function extractAssistantBlocks(content: unknown): AssistantContentBlock[] {
	if (!Array.isArray(content)) return [];
	const out: AssistantContentBlock[] = [];
	for (const c of content) {
		if (!c || typeof c !== "object") continue;
		const type = (c as any).type;
		if (type === "text" && typeof (c as any).text === "string") {
			out.push({ type: "text", text: (c as any).text });
		} else if (type === "thinking" && typeof (c as any).thinking === "string") {
			const block: ThinkingBlock = { type: "thinking", thinking: (c as any).thinking };
			if (hasEncryptedReasoning((c as any).thinkingSignature)) block.encrypted = true;
			out.push(block);
		} else if (type === "redactedThinking") {
			out.push({ type: "redactedThinking", data: String((c as any).data ?? "") });
		} else if (type === "toolCall") {
			out.push({
				type: "toolCall",
				id: String((c as any).id ?? ""),
				name: String((c as any).name ?? "?"),
				arguments: ((c as any).arguments ?? {}) as Record<string, unknown>,
				intent: (c as any).intent as string | undefined,
			});
		} else if (type === "image" && typeof (c as any).data === "string") {
			out.push({ type: "image", data: (c as any).data, mimeType: String((c as any).mimeType ?? "image/png") });
		} else {
			out.push({ type: "unknown", blockType: String(type ?? "?"), raw: c });
		}
	}
	return out;
}

/**
 * OpenAI Responses/Codex store the whole reasoning item as JSON in
 * `thinkingSignature`; a non-empty `encrypted_content` means the provider
 * kept the reasoning encrypted. Anthropic signatures are opaque base64 and
 * chat-completions signatures are field names, so neither matches.
 */
function hasEncryptedReasoning(signature: unknown): boolean {
	return typeof signature === "string" && signature.startsWith("{") && /"encrypted_content":"[^"]/.test(signature);
}


function normalizeTextOrImage(c: any): TextBlock | ImageBlock | null {
	if (!c || typeof c !== "object") return null;
	if (c.type === "text" && typeof c.text === "string") return { type: "text", text: c.text };
	if (c.type === "image" && typeof c.data === "string")
		return { type: "image", data: c.data, mimeType: String(c.mimeType ?? "image/png") };
	return null;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const c of content) {
			if (c && typeof c === "object" && (c as any).type === "text") {
				parts.push(String((c as any).text ?? ""));
			}
		}
		return parts.join("");
	}
	return "";
}

function extractImages(content: unknown): ImageBlock[] | undefined {
	if (!Array.isArray(content)) return undefined;
	const out: ImageBlock[] = [];
	for (const c of content) {
		const norm = normalizeTextOrImage(c);
		if (norm && norm.type === "image") out.push(norm);
	}
	return out.length > 0 ? out : undefined;
}

function extractUsage(u: unknown): UsageRollup | undefined {
	if (!u || typeof u !== "object") return undefined;
	const r = u as Record<string, unknown>;
	const cost =
		r.cost && typeof r.cost === "object"
			? Number((r.cost as Record<string, unknown>).total ?? 0)
			: 0;
	return {
		input: Number(r.input ?? 0),
		output: Number(r.output ?? 0),
		cacheRead: Number(r.cacheRead ?? 0),
		cacheWrite: Number(r.cacheWrite ?? 0),
		totalTokens: Number(r.totalTokens ?? 0),
		cost: Number.isFinite(cost) ? cost : 0,
		reasoningTokens: typeof r.reasoningTokens === "number" ? r.reasoningTokens : undefined,
	};
}

function rollupUsage(state: SessionUi, raw: unknown): void {
	const u = extractUsage(raw);
	if (!u) return;
	state.usage = {
		input: state.usage.input + u.input,
		output: state.usage.output + u.output,
		cacheRead: state.usage.cacheRead + u.cacheRead,
		cacheWrite: state.usage.cacheWrite + u.cacheWrite,
		totalTokens: state.usage.totalTokens + u.totalTokens,
		cost: state.usage.cost + u.cost,
		reasoningTokens:
			state.usage.reasoningTokens !== undefined || u.reasoningTokens !== undefined
				? (state.usage.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0)
				: undefined,
	};
}

function normalizeTodoPhases(raw: unknown): TodoPhase[] {
	if (!Array.isArray(raw)) return [];
	const out: TodoPhase[] = [];
	for (const p of raw) {
		if (!p) continue;
		// Two shapes seen in practice:
		//   - TodoPhase: { id, name, tasks: TodoItem[] }
		//   - bare TodoItem[]: array passed directly via todo_reminder.todos
		if (Array.isArray(p)) {
			out.push({ tasks: (p as any[]).map(coerceTask) });
		} else if (typeof p === "object") {
			const phase = p as Record<string, unknown>;
			const tasks = Array.isArray(phase.tasks) ? (phase.tasks as any[]).map(coerceTask) : [];
			out.push({
				id: typeof phase.id === "string" ? phase.id : undefined,
				name: typeof phase.name === "string" ? phase.name : undefined,
				tasks,
			});
		}
	}
	return out;
}

function coerceTask(t: any) {
	return {
		id: typeof t?.id === "string" ? t.id : undefined,
		content: String(t?.content ?? ""),
		status: String(t?.status ?? "pending"),
		notes: Array.isArray(t?.notes) ? (t.notes as unknown[]).map(String) : undefined,
	};
}
/**
 * Normalize the wire shape (`QueuedPromptWire[]`) into the UI's
 * `QueuedPrompt[]`. Tolerates missing optional fields and skips anything
 * that doesn't carry at least an id+text — the bridge is canonical but the
 * reducer guards against malformed events from older server builds.
 */
function hydrateQueuedPrompts(raw: unknown): QueuedPrompt[] {
	if (!Array.isArray(raw)) return [];
	const out: QueuedPrompt[] = [];
	for (const r of raw) {
		if (!r || typeof r !== "object") continue;
		const w = r as {
			id?: unknown;
			text?: unknown;
			images?: unknown;
			behavior?: unknown;
			queuedAt?: unknown;
		};
		if (typeof w.id !== "string" || w.id.length === 0) continue;
		const entry: QueuedPrompt = {
			id: w.id,
			text: typeof w.text === "string" ? w.text : "",
			behavior: w.behavior === "steer" ? "steer" : "followUp",
			queuedAt: typeof w.queuedAt === "number" ? w.queuedAt : Date.now(),
		};
		if (Array.isArray(w.images) && w.images.length > 0) {
			entry.images = w.images as ImageBlock[];
		}
		out.push(entry);
	}
	return out;
}
