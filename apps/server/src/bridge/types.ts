import type { Settings } from "@oh-my-pi/pi-coding-agent";
import type {
	AgentMessageJson,
	AgentSessionEventJson,
	ContextUsage,
	ExtUiDialogResponse,
	ImageAttachment,
	ModelInfo,
	ModelRef,
	PendingPlanApprovalWire,
	PlanModeContextWire,
	ServerFrame,
	SessionSnapshot,
	SessionSummary,
	SessionTranscriptResponse,
	SubagentNode,
	SubagentTranscriptResponse,
} from "@npi-deck/protocol";

/**
 * Abstract bridge to omp. The in-process impl embeds @oh-my-pi/pi-coding-agent
 * directly; a future RPC impl will spawn `omp --mode rpc` subprocesses behind
 * the same surface. Anything the server needs from omp MUST flow through this.
 */
export interface AgentBridge {
	createSession(opts: CreateSessionOpts): Promise<SessionHandle>;
	/**
	 * Resumes of one file run one at a time: a concurrent resume gets the same
	 * live session. Rejects with {@link SessionClosedError} when the session
	 * was closed while it was opening.
	 */
	resumeSession(opts: ResumeSessionOpts): Promise<SessionHandle>;
	getSession(sessionId: string): SessionHandle | undefined;
	/**
	 * Start closing a live session and return at once. From here the session is
	 * no longer live: `getSession` misses it and settings, MCP and advisor
	 * updates skip it. NeoPi's dispose can take tens of seconds (its chronicler
	 * drains in-flight model work for up to 20 s), so it runs in the background
	 * and `session_disposed` reaches the session's subscribers when it ends.
	 * Resuming the same file meanwhile waits for the close. A session still
	 * opening is closed as soon as it has opened and never becomes live. False
	 * when no session with this id is opening, live or closing.
	 */
	closeSession(sessionId: string): boolean;
	listSessions(opts: { cwd?: string }): Promise<SessionSummary[]>;
	/**
	 * A persisted session's transcript, read from its file without creating
	 * an SDK session. `limit` keeps only the newest messages. Undefined when
	 * `sessionPath` is not a listed session.
	 */
	readTranscript(sessionPath: string, opts?: { limit?: number }): Promise<SessionTranscriptResponse | undefined>;
	/** Subagents belong to one live root generation; never accept a transcript file path from clients. */
	subagentSnapshot(sessionId: string): SubagentNode[];
	subscribeSubagents(sessionId: string, listener: (nodes: SubagentNode[]) => void): () => void;
	readSubagentTranscript(sessionId: string, id: string, fromByte?: number): Promise<SubagentTranscriptResponse>;
	abortSubagent(sessionId: string, id: string): Promise<void>;
	/** Pin a session against the idle reaper while a client is subscribed. */
	trackSubscriberAdded(sessionId: string, connectionId: string): void;
	/** Drop a subscriber; once subscribers hit zero and idle window elapses, the reaper claims it. */
	trackSubscriberRemoved(sessionId: string, connectionId: string): void;
	/** Bump last-activity-ts; called for explicit user actions outside subscribe. */
	bumpActivity(sessionId: string): void;
	/** Hot-apply runtime env values that do not require process restart. */
	applyEnvUpdate?(update: RuntimeEnvUpdate): void;
	/**
	 * Re-read the persisted settings layers into every live session's settings
	 * (and NeoPi's process-wide instance, once a tool has initialized it) after
	 * a config.yml write, so the change applies without a restart.
	 */
	reloadLiveSettings(): Promise<LiveSettingsReload[]>;
	/**
	 * Live chats' MCP runtimes, so an `mcp.json` write can reach them without a
	 * restart. Chats opened with MCP switched off report no runtime rather than
	 * pretending the change applied.
	 */
	liveMcpSessions(): LiveMcpSession[];
	/**
	 * Catalog of models the SDK knows about, plus a marker on the current one when sessionId is given.
	 * Mixtures are those the session's workspace (else `cwd`, else the server's cwd) defines and can run.
	 */
	listModels(opts?: { sessionId?: string; cwd?: string }): Promise<ModelInfo[]>;
	/**
	 * Re-discover the mixtures `cwd`'s MIXTURES.toml search path may register
	 * and replace the picker roster with them, after the Mixtures view saved a
	 * file. The only place the deck replaces a mixture roster.
	 */
	refreshMixtureRoster(cwd: string): Promise<void>;
	/**
	 * Subscribe to extension-UI dialog frames for `sessionId` (open + cancel).
	 * Returns an unsubscribe function. Implementations MAY immediately replay
	 * any already-open dialogs to a new subscriber so a late client (page
	 * reload, second tab) does not miss an active modal.
	 */
	subscribeUiFrames(
		sessionId: string,
		listener: (frame: Extract<ServerFrame, { type: "ext_ui_dialog_open" | "ext_ui_dialog_cancel" }>) => void,
	): () => void;
	/** Settle a previously-emitted dialog with the client's response. */
	respondToUiDialog(sessionId: string, dialogId: string, response: ExtUiDialogResponse): void;
	/**
	 * Subscribe to plan-mode frames for `sessionId` (mode-changed + proposed +
	 * resolved). Returns an unsubscribe function. Implementations MAY replay
	 * the current `plan_mode_changed` and any pending `plan_proposed` to a
	 * late subscriber so a page-reload during plan mode re-renders the pill
	 * and the approval card immediately.
	 */
	subscribePlanModeFrames(
		sessionId: string,
		listener: (
			frame: Extract<
				ServerFrame,
				{ type: "plan_mode_changed" | "plan_proposed" | "plan_proposal_resolved" }
			>,
		) => void,
	): () => void;
	/**
	 * Settle a previously-emitted plan-approval proposal with the client's
	 * response. Returns `"settled"` on success, `"unknown"` when the
	 * proposalId is unknown or already resolved (caller surfaces a 409 to
	 * the client so optimistic UI can roll back).
	 */
	respondToPlanApproval(
		sessionId: string,
		proposalId: string,
		response: PlanApprovalResponse,
	): Promise<"settled" | "unknown">;
	dispose(): Promise<void>;
}

export interface RuntimeEnvUpdate {
	idleTimeoutMs?: number;
}

/** One live session's settings after {@link AgentBridge.reloadLiveSettings}. */
export interface LiveSettingsReload {
	sessionId: string;
	cwd: string;
	settings: Settings;
	/** The reload failed and was logged (its message can quote config.yml); the session keeps its previous layers. */
	failed?: true;
}

/** One live chat's MCP runtime, for reconciling a written `mcp.json` change. */
export interface LiveMcpSession {
	sessionId: string;
	cwd: string;
	/**
	 * Reconnect (`enabled`) or drop (`!enabled`) one server from the config on
	 * disk and rebind the chat's MCP tools, exactly as NeoPi's own
	 * `/mcp enable` / `/mcp disable` do. Resolves `"no-mcp-runtime"` when the
	 * chat runs without an MCP manager; rejects when NeoPi's reconcile throws.
	 */
	apply(name: string, enabled: boolean): Promise<"applied" | "no-mcp-runtime">;
	/** NeoPi's connection state for `name`, or undefined without an MCP runtime. */
	status(name: string): "connected" | "connecting" | "disconnected" | undefined;
}

/** Invalid per-session MCP selection; callers can return a client error. */
export class McpAllowlistError extends Error {
	override name = "McpAllowlistError";
}

/** The session was closed while it was opening; it never became live. */
export class SessionClosedError extends Error {
	override name = "SessionClosedError";
}

export interface CreateSessionOpts {
	cwd: string;
	model?: ModelRef;
	/** Per-session MCP server names; absent inherits backend settings, [] disables MCP. */
	mcpServersAllowed?: string[];
}

export interface ResumeSessionOpts {
	sessionPath: string;
	/** Per-session MCP server names; absent inherits backend settings, [] disables MCP. */
	mcpServersAllowed?: string[];
}

export type EventListener = (event: AgentSessionEventJson) => void;

export interface SessionHandle {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly cwd: string;

	subscribe(listener: EventListener): () => void;
	snapshot(): SessionSnapshot;
	/** False when NeoPi handles the prompt locally; no agent_end follows. */
	prompt(
		text: string,
		opts?: { streamingBehavior?: "steer" | "followUp"; images?: ImageAttachment[] },
	): Promise<boolean>;
	/** True iff a turn is currently in-flight. Used by the WS layer to decide
	 *  whether a freshly-arrived prompt is being queued vs. running immediately. */
	isStreamingNow(): boolean;
	/** Number of prompts the SDK currently has queued (steering + follow-up +
	 *  hidden next-turn). */
	queuedMessageCount(): number;
	/** Drop every queued prompt. Returns the per-bucket counts that were
	 *  cleared so the caller can surface a `queue_cleared` event. */
	clearQueue(): { steering: number; followUp: number };
	/**
	 * Snapshot of the bridge-tracked shadow queue (the user-visible queue
	 * mirrored from the SDK). Includes stable `id`s the client can use to
	 * target a specific entry for cancel/edit. Empty when no turn is in flight.
	 */
	getQueueSnapshot(): import("@npi-deck/protocol").QueuedPromptWire[];
	/**
	 * Cancel a single queued prompt by its `id`. Returns true if an entry
	 * was removed, false if the id was unknown (already drained, etc).
	 * Emits a synthetic `queue_state` event on success so subscribers
	 * reconcile their `queuedPrompts` list.
	 */
	cancelQueuedById(id: string): Promise<boolean>;
	/**
	 * Replace a queued prompt's text (and optionally images) in place.
	 * Returns true if the edit landed, false if the id was unknown.
	 * Implementation pops every SDK queue entry synchronously then
	 * re-enqueues survivors with the edited entry substituted — order
	 * preserved. Emits a synthetic `queue_state` event on success.
	 */
	editQueuedById(
		id: string,
		text: string,
		images?: import("@npi-deck/protocol").ImageAttachment[],
	): Promise<boolean>;
	abort(): Promise<void>;
	setName(name: string): Promise<void>;
	/**
	 * Trigger manual compaction with optional focus instructions. Resolves once
	 * the SDK acknowledges the call; the actual compaction event arrives via
	 * the regular session event stream so the deck UI can react.
	 */
	compact(focus?: string): Promise<void>;
	/** Swap the live agent session to a different model. Throws on unknown ref or missing auth. */
	setModel(ref: ModelRef): Promise<void>;
	/**
	 * Try to dispatch a leading slash command via the omp SDK's text-mode
	 * dispatcher. Returns `"fallthrough"` when nothing matched — caller should
	 * forward the original text via `prompt()`. `"consumed"` means the SDK ran
	 * the command and there is no follow-up turn. `"rewritten"` means the
	 * command produced a new prompt string the caller should send instead.
	 */
	dispatchSlashCommand(text: string): Promise<SlashDispatchResult>;
	/**
	 * Try to dispatch a leading slash command via the deck's own registry
	 * (kanban operations etc). Same return shape as `dispatchSlashCommand` so
	 * the WS hub can branch identically.
	 */
	dispatchDeckSlashCommand(text: string): Promise<SlashDispatchResult>;
	/**
	 * Snapshot of context-window utilization. Returns `undefined` when the
	 * underlying model has no declared context window.
	 */
	getContextUsage(): ContextUsage | undefined;
	dispose(): Promise<void>;
	/** Idempotent enter/exit. No-op when state already matches. */
	setPlanMode(enabled: boolean): Promise<void>;
	/** Read the bridge's plan-mode context for snapshot replay. */
	getPlanModeContext(): PlanModeContextWire | undefined;
	/** Read the unresolved plan-approval card for snapshot replay. */
	getPendingPlanApproval(): PendingPlanApprovalWire | undefined;
	/**
	 * Settle a plan-approval proposal. Returns `"settled"` on success,
	 * `"unknown"` when the proposalId does not match the pending entry
	 * (already resolved by a sibling tab; second clicker gets a 409).
	 */
	respondToPlanApproval(
		proposalId: string,
		response: PlanApprovalResponse,
	): Promise<"settled" | "unknown">;
}

export type SlashDispatchResult =
	| { kind: "fallthrough" }
	| { kind: "consumed"; output: string }
	| { kind: "rewritten"; output: string; prompt: string };

export interface AgentMessagePassthrough extends AgentMessageJson {}
/**
 * Decision for `xd://propose`. Rejection returns feedback to the planning
 * agent; approval may replace the proposed artifact in place.
 */
export interface PlanApprovalResponse {
	approved: boolean;
	feedback?: string;
	editedContent?: string;
}
