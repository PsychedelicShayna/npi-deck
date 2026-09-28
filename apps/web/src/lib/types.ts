/**
 * Local UI types derived from the protocol contract.
 *
 * The web app reduces AgentSessionEvent passthroughs into this shape so the
 * components render against a stable, opinionated state — never against the
 * raw SDK events.
 */

import type { ModelRef, PendingPlanApprovalWire, PlanModeContextWire } from "@npi-deck/protocol";

// ─── Content blocks ────────────────────────────────────────────────────────

export interface TextBlock {
	type: "text";
	text: string;
}
export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}
export interface RedactedThinkingBlock {
	type: "redactedThinking";
	data: string;
}
export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	intent?: string;
}
export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

/**
 * A content block this client has no renderer for (NeoPi's
 * `anthropicServerTool`, `fallback`, `anthropicCompaction`, … and anything
 * added later). Rendered as a visible, collapsible placeholder instead of
 * being dropped.
 */
export interface UnknownBlock {
	type: "unknown";
	blockType: string;
	raw: unknown;
}

export type AssistantContentBlock =
	| TextBlock
	| ThinkingBlock
	| RedactedThinkingBlock
	| ToolCallBlock
	| ImageBlock
	| UnknownBlock;

// ─── Messages ──────────────────────────────────────────────────────────────

export interface UserMsg {
	id: string;
	role: "user";
	text: string;
	images?: ImageBlock[];
	timestamp?: number;
	synthetic?: boolean;
}

export interface AssistantMsg {
	id: string;
	role: "assistant";
	blocks: AssistantContentBlock[];
	model?: string;
	provider?: string;
	usage?: UsageRollup;
	stopReason?: string;
	isStreaming: boolean;
	errorMessage?: string;
	timestamp?: number;
	durationMs?: number;
	ttft?: number;
}

export interface ToolResultMsg {
	id: string;
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<TextBlock | ImageBlock>;
	isError: boolean;
	timestamp?: number;
}

export interface NoticeMsg {
	id: string;
	role: "notice";
	level: "info" | "warning" | "error";
	message: string;
	source?: string;
	timestamp: number;
}

export interface CompactionMsg {
	id: string;
	role: "compaction";
	reason: string;
	action: string;
	summary?: string;
	timestamp: number;
}

export interface TtsrMsg {
	id: string;
	role: "ttsr";
	rules: Array<{ name?: string; description?: string; body?: string }>;
	timestamp: number;
}

export interface IrcMsg {
	id: string;
	role: "irc";
	customType?: string;
	content: string;
	from?: string;
	timestamp: number;
}

/** Display-only mixture trace persisted by NeoPi with hop/limit/checkpoint details. */
export interface MixtureTraceMsg {
	id: string;
	role: "mixtureTrace";
	content: string;
	details: Record<string, unknown>;
	timestamp: number;
}

export type ChatMessage =
	| UserMsg
	| AssistantMsg
	| ToolResultMsg
	| NoticeMsg
	| CompactionMsg
	| TtsrMsg
	| IrcMsg
	| MixtureTraceMsg;

// ─── Queued prompts (sent while agent was streaming) ──────────────────────

export interface QueuedPrompt {
	/** Stable id assigned by the server when the SDK queued the prompt.
	 *  Used as React key and for targeted future-cancellation if we add per-
	 *  bubble × buttons later. */
	id: string;
	text: string;
	images?: ImageBlock[];
	/** "followUp" (run after current turn) vs "steer" (interrupt). Today every
	 *  composer-driven prompt uses "followUp"; "steer" is reserved for a
	 *  future affordance. */
	behavior: "followUp" | "steer";
	/** Bridge clock at enqueue. Used purely for chronological display. */
	queuedAt: number;
}

// ─── Tool call lifecycle ───────────────────────────────────────────────────

export interface ToolCallStream {
	id: string;
	name: string;
	args: Record<string, unknown> | undefined;
	intent?: string;
	status: "running" | "complete" | "error";
	partialResult?: unknown;
	/** Latest `tool_stream_update` projection (e.g. a diff preview) while the call runs. */
	streamUpdate?: unknown;
	result?: unknown;
	isError: boolean;
	startedAt: number;
	endedAt?: number;
	/** Set when a paired tool_result message arrives. Mirrors result content for compatibility. */
	resultContent?: Array<TextBlock | ImageBlock>;
}

// ─── Todos ─────────────────────────────────────────────────────────────────

export interface TodoTask {
	id?: string;
	content: string;
	status: "pending" | "in_progress" | "completed" | "dropped" | string;
	notes?: string[];
}

export interface TodoPhase {
	id?: string;
	name?: string;
	tasks: TodoTask[];
}

// ─── Cost / usage ──────────────────────────────────────────────────────────

export interface UsageRollup {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	reasoningTokens?: number;
}

// ─── Session ───────────────────────────────────────────────────────────────

export interface SessionUi {
	sessionId: string;
	/** NeoPi refuses background jobs in this session (not the first live root; neopi#121). */
	backgroundJobsUnavailable?: boolean;
	/**
	 * A persisted session opened from the sidebar without starting an SDK
	 * session: the transcript is shown read-only until the user resumes or
	 * sends. `sessionId` is the file's session id; nothing is subscribed.
	 */
	readOnly?: { path: string };
	/** Previous worker exited; transcript is retained, but its live handle is gone. */
	endedByRestart?: boolean;
	backendLastRan?: { path: string; commit: string | null };
	cwd: string;
	sessionFile?: string;
	sessionName?: string;
	model?: ModelRef;
	thinkingLevel?: string;
	/** Current SDK configuration warnings, updated without restarting the session. */
	configWarnings?: string[];

	messages: ChatMessage[];
	/** Tool calls keyed by toolCallId for richer per-call rendering. */
	toolCalls: Record<string, ToolCallStream>;
	todoPhases: TodoPhase[];

	status: "idle" | "streaming" | "compacting" | "retrying";

	retry?: {
		attempt: number;
		maxAttempts: number;
		errorMessage: string;
	};

	compaction?: {
		reason: string;
		action: string;
		startedAt: number;
	};

	ttsr?: {
		rules: Array<{ name?: string; description?: string }>;
		at: number;
	};

	mode?: { mode: string; data?: unknown };
	goal?: { goal: unknown; state?: unknown } | null;

	usage: UsageRollup;
	turnCount: number;
	/**
	 * Live context-window utilization. `undefined` when the model doesn't
	 * declare a window. Updated by the bridge's synthetic `context_usage` event
	 * after every turn-end / compaction.
	 */
	contextUsage?: import("@npi-deck/protocol").ContextUsage;
	/**
	 * Bumped when an advisor note reaches this chat or an advisor finishes a
	 * review. The advisor panel refetches on change instead of polling while
	 * it is hidden.
	 */
	advisorActivity?: number;

	/** Latest provider error displayed in chrome (cleared on next turn_start). */
	lastError?: string;

	/**
	 * Prompts the user sent while the agent was streaming. The SDK queues them
	 * (as `followUp` by default) and runs each one as a new turn after the
	 * current one finishes. We track them client-side so the chat renders a
	 * visible "queued" bubble per pending prompt instead of swallowing the
	 * draft silently. Dropped entry-by-entry when the matching real user
	 * `message_start` arrives, or all at once on `queue_cleared`.
	 */
	queuedPrompts: QueuedPrompt[];

	/**
	 * Plan-mode state (T-105). `planMode` is present iff the session is in
	 * plan mode at the moment of subscribe / since the last `plan_mode_changed`
	 * frame. `pendingPlanApproval` is the unresolved card (set from
	 * `plan_proposed`, cleared on `plan_proposal_resolved` / approval response).
	 */
	planMode?: PlanModeContextWire;
	pendingPlanApproval?: PendingPlanApprovalWire;
}
