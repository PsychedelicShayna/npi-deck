import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type {
	BackendStatusResponse,
	ExtUiDialogResponse,
	ListSessionsResponse,
	ListWorkspacesResponse,
	NotificationLevel,
	PendingPlanApprovalWire,
	PlanModeContextWire,
	SessionSummary,
	SessionTranscriptResponse,
	ServerFrame,
	SubagentNode,
	WorkspaceEntry,
} from "@npi-deck/protocol";

/**
 * In-app notification record. Mirrors the wire frame plus client-side
 * metadata: `receivedAtMs` for ordering, `deliveredOs` so the OS-level
 * Notification renderer only fires once per item.
 */
export interface NotificationItem {
	id: string;
	level: NotificationLevel;
	title: string;
	body?: string;
	sound?: boolean;
	source?: string;
	actionUrl?: string;
	timestamp: string;
	receivedAtMs: number;
	deliveredOs: boolean;
	dismissed: boolean;
}

/** Max notifications retained in the in-app queue. Older items fall off. */
const MAX_NOTIFICATIONS = 50;

import { api } from "./api";
import { emptyMixtureUi, reconcileMixtureResubscribe } from "./mixture-reducer";
import { applyEvent, initSession } from "./reducer";
import { TRANSCRIPT_TAIL } from "./transcript-window";
import type { SessionUi } from "./types";
import { WsClient, type WsStatus } from "./ws";

function readBool(key: string, fallback: boolean): boolean {
	if (typeof localStorage === "undefined") return fallback;
	const raw = localStorage.getItem(key);
	if (raw === null) return fallback;
	return raw === "1";
}

/** Matches the Tailwind `lg` breakpoint (1024px) used by `Layout`. Below this
 * width the sidebar and inspector behave as overlay drawers, so persisting
 * "open" state would auto-open them on every mobile load and bury the main
 * content under a backdrop.  */
function isDesktopViewport(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;
}

/** Chrome panel state is only persisted on desktop. On mobile we always start
 * with the panel closed and never write back, so toggling on a phone does not
 * pollute the desktop preference. */
function readChromeOpen(key: string, desktopFallback: boolean): boolean {
	if (!isDesktopViewport()) return false;
	return readBool(key, desktopFallback);
}

/** UI state for a read-only transcript; `earlier` records what a tail read left out. */
function readOnlySession(t: SessionTranscriptResponse): SessionUi {
	const ui = initSession(
		{
			sessionId: t.sessionId,
			sessionFile: t.path,
			...(t.title ? { sessionName: t.title } : {}),
			cwd: t.cwd,
			isStreaming: false,
			messages: t.messages,
			todoPhases: [],
		},
		t.omitted?.usage,
	);
	ui.readOnly = t.omitted ? { path: t.path, earlier: t.omitted.count } : { path: t.path };
	ui.backendLastRan = t.backendLastRan;
	return ui;
}

interface StoreState {
	ws: WsClient | null;
	wsStatus: WsStatus;
	connectionId?: string;
	workerGeneration?: string;
	backend: BackendStatusResponse["running"];

	workspaces: WorkspaceEntry[];
	defaultCwd: string;
	sessions: SessionSummary[];

	activeId?: string;
	sessionsById: Record<string, SessionUi>;
	subagentsBySession: Record<string, SubagentNode[]>;

	// Track subscriptions to avoid duplicate subscribe messages.
	subscribed: Set<string>;

	/**
	 * Tool-card view state. `allCollapsed` is the bulk default; `perCard` holds
	 * user overrides (key = toolCallId, value = isOpen). On bulk toggle we clear
	 * `perCard` so the new default applies to every card uniformly.
	 */
	toolView: {
		allCollapsed: boolean;
		perCard: Record<string, boolean>;
	};

	/** Composer pre-fill used by `Open in chat` from the Tasks view. */
	pendingDraft?: { text: string };

	/** Shared chrome state — each view can open/close the inspector and sidebar. */
	sidebarOpen: boolean;
	inspectorOpen: boolean;

	/**
	 * Monotonic counter bumped every time the server broadcasts a `tasks_changed`
	 * frame (any kanban mutation, whether triggered by the deck UI, a deck slash
	 * command, or an agent calling the REST API). Views that own a local tasks
	 * cache (e.g. TasksView) subscribe to this counter and refetch when it
	 * changes — keeps the kanban view live without polling.
	 */
	tasksChangeCounter: number;

	/**
	 * Mirror of {@link tasksChangeCounter} for the skill catalog. Bumped on every
	 * `skills_changed` frame (plugin install / uninstall / enable / disable, or
	 * a SKILL.md mutation under the plugins cache dir). Drives live refetch in
	 * `SkillsView` without polling.
	 */
	skillsChangeCounter: number;

	/**
	 * Counter for `kb_changed` broadcasts. Bumped on any mutation under the
	 * watched kb root; `KbView` watches it and refetches the current file +
	 * tree. Same pattern as `tasksChangeCounter` / `skillsChangeCounter`.
	 */
	kbChangeCounter: number;

	/**
	 * Per-session open extension-UI dialog (currently used by the SDK `ask`
	 * tool, but the channel is shape-typed to cover any extension dialog).
	 * At most one dialog per session is open at a time because the SDK awaits
	 * each `ctx.ui.*` call serially; if a second open arrives it replaces the
	 * first (the server-side bridge already cancelled the predecessor before
	 * sending the new one). Cleared on `ext_ui_dialog_cancel` and on local
	 * response submission.
	 */
	pendingDialogs: Record<string, Extract<ServerFrame, { type: "ext_ui_dialog_open" }>>;

	/**
	 * Latest heartbeat the server has broadcast. `lastHeartbeatAt` is the
	 * client's local Date.now() at the moment we received the frame, NOT the
	 * server's `timestamp` — the gap drives the connection indicator and must
	 * be measured in the client's clock.
	 */
	heartbeat: {
		lastReceivedAtMs: number;
		serverStartedAt: string;
		pid: number;
		uptimeSecs: number;
		buildSha: string | null;
		version: string;
	} | null;

	/**
	 * In-app notification queue. Each `notification` frame is appended; the
	 * notification renderer pops from here when delivering an OS notification
	 * + audio cue, and a small toast surface reads from here too. Capped at
	 * MAX_NOTIFICATIONS via prune; oldest fall off.
	 */
	notifications: NotificationItem[];

	// ─── Actions ─────────────────────────────────────────────────────────
	bootstrap(): Promise<void>;
	connect(): void;
	disconnect(): void;
	refreshWorkspaces(): Promise<void>;
	refreshSessions(cwd?: string): Promise<void>;
	createSession(opts: { cwd: string; resumeFromPath?: string }): Promise<string>;
	/**
	 * Show a persisted session read-only, straight from its file. No SDK
	 * session starts (so no MCP/LSP processes) until `resumeSession` or the
	 * first send.
	 */
	openTranscript(path: string): Promise<void>;
	/** Load the older messages a read-only transcript left out when it opened. */
	loadEarlierTranscript(id: string): Promise<void>;
	/** Turn the active read-only transcript into a live session. */
	resumeSession(id: string): Promise<string>;
	selectSession(id: string): void;
	sendPrompt(text: string, images?: import("@npi-deck/protocol").ImageAttachment[]): void;
	abort(): void;
	/** Drop every queued (followUp / steering) prompt for the active session.
	 *  Server echoes a `queue_cleared` session event that reconciles
	 *  `queuedPrompts` in the reducer. */
	clearQueue(): void;
	/** Cancel a single queued prompt by its server-assigned id. Server echoes
	 *  a `queue_state` session event with the new ordered queue. */
	cancelQueued(queuedId: string): void;
	/** Edit a queued prompt's text (and optionally images) in place. */
	editQueued(queuedId: string, text: string, images?: import("@npi-deck/protocol").ImageAttachment[]): void;
	disposeSession(id: string): Promise<void>;
	renameSession(id: string, name: string): Promise<void>;
	toggleAllToolCards(): void;
	setToolCardOpen(id: string, open: boolean): void;
	setPendingDraft(draft: { text: string } | undefined): void;
	setSidebarOpen(open: boolean): void;
	setInspectorOpen(open: boolean): void;
	/** Send a dialog response over the WS and clear it locally. */
	respondToExtUiDialog(sessionId: string, dialogId: string, response: ExtUiDialogResponse): void;
	/**
	 * Toggle plan mode on the active session (T-105). Idempotent on the wire;
	 * server emits `plan_mode_changed` which the reducer mirrors back.
	 */
	setPlanMode(enabled: boolean): void;
	/**
	 * Reply to a `plan_proposed` card. Optimistically clears
	 * `pendingPlanApproval` so the UI hides immediately; the server emits
	 * `plan_proposal_resolved`, and on `error` (stale proposalId) the next
	 * `plan_proposed` replay on subscribe will restore it.
	 */
	respondToPlanApproval(args: {
		sessionId: string;
		proposalId: string;
		approved: boolean;
		feedback?: string;
		editedContent?: string;
	}): void;
	/** Mark a notification as delivered to the OS so the renderer only fires once. */
	markNotificationDelivered(id: string): void;
	/** Hide an in-app toast for a notification (does not affect an already-delivered OS notif). */
	dismissNotification(id: string): void;
}

export const useStore = create<StoreState>()(
	subscribeWithSelector((set, get) => ({
		ws: null,
		wsStatus: "closed",
		backend: null,
		workspaces: [],
		defaultCwd: "",
		sessions: [],
		sessionsById: {},
		subagentsBySession: {},
		subscribed: new Set<string>(),
		toolView: { allCollapsed: false, perCard: {} },
		tasksChangeCounter: 0,
		skillsChangeCounter: 0,
		kbChangeCounter: 0,
		pendingDialogs: {},
		heartbeat: null,
		notifications: [],
		// Hydrate chrome state from localStorage at module init so first render
		// matches the user's last preference — but only on desktop. On mobile the
		// panels are overlay drawers and always start closed.
		sidebarOpen: readChromeOpen("npi-deck:sidebar-open", true),
		inspectorOpen: readChromeOpen("npi-deck:inspector-open", false),

		async bootstrap() {
			get().connect();
			await Promise.all([get().refreshWorkspaces(), get().refreshSessions()]);
		},

		connect() {
			if (get().ws) return;
			const ws = new WsClient();
			ws.onStatus((status) => set({ wsStatus: status }));
			ws.subscribe((frame) => handleFrame(frame, set, get));
			ws.connect();
			set({ ws });
		},

		disconnect() {
			get().ws?.dispose();
			set({ ws: null, wsStatus: "closed" });
		},

		async refreshWorkspaces() {
			const generation = get().workerGeneration;
			try {
				const resp: ListWorkspacesResponse = await api.listWorkspaces();
				if (generation === get().workerGeneration) set({ workspaces: resp.workspaces, defaultCwd: resp.defaultCwd });
			} catch (err) {
				console.warn("listWorkspaces failed", err);
			}
		},

		async refreshSessions(cwd?: string) {
			const generation = get().workerGeneration;
			try {
				const resp: ListSessionsResponse = await api.listSessions(cwd);
				if (generation === get().workerGeneration) set({ sessions: resp.sessions });
			} catch (err) {
				console.warn("listSessions failed", err);
			}
		},

		async createSession(opts) {
			const generation = get().workerGeneration;
			const created = await api.createSession({
				cwd: opts.cwd,
				...(opts.resumeFromPath ? { resumeFromPath: opts.resumeFromPath } : {}),
			});
			if (generation !== get().workerGeneration) throw new Error("worker restarted during session creation; retry explicitly");
			// Subscribe immediately; reducer will hydrate from the `subscribed` snapshot.
			get().ws?.send({ type: "subscribe", sessionId: created.sessionId });
			get().subscribed.add(created.sessionId);
			set((s) => {
				// A resumed read-only transcript is live now; keep showing it
				// until the snapshot replaces it, but stop treating it as read-only.
				const prev = s.sessionsById[created.sessionId];
				return prev?.readOnly
					? { activeId: created.sessionId, sessionsById: { ...s.sessionsById, [created.sessionId]: { ...prev, readOnly: undefined } } }
					: { activeId: created.sessionId };
			});
			// Background-refresh sidebar to reflect the new entry.
			void get().refreshSessions();
			void get().refreshWorkspaces();
			return created.sessionId;
		},

		async openTranscript(path) {
			const live = Object.values(get().sessionsById).find((s) => s.sessionFile === path && !s.readOnly);
			if (live) {
				get().selectSession(live.sessionId);
				return;
			}
			const t = await api.getTranscript(path, TRANSCRIPT_TAIL);
			const ui = readOnlySession(t);
			set((s) => ({ sessionsById: { ...s.sessionsById, [t.sessionId]: ui }, activeId: t.sessionId }));
		},

		async loadEarlierTranscript(id) {
			const ro = get().sessionsById[id]?.readOnly;
			if (!ro?.earlier) return;
			const t = await api.getTranscript(ro.path);
			// Each open, reopen or worker restart gives the session a new
			// `readOnly` object, and a resume drops it. Anything but the object
			// this load started from means the response is stale.
			const current = get().sessionsById[id];
			if (current?.readOnly !== ro) return;
			const next = readOnlySession(t);
			if (current.endedByRestart) next.endedByRestart = true;
			set((s) => ({ sessionsById: { ...s.sessionsById, [id]: next } }));
		},

		async resumeSession(id) {
			const ro = get().sessionsById[id];
			if (!ro?.readOnly) return id;
			return get().createSession({ cwd: ro.cwd, resumeFromPath: ro.readOnly.path });
		},

		selectSession(id: string) {
			set({ activeId: id });
			if (get().sessionsById[id]?.readOnly) return;
			if (!get().subscribed.has(id)) {
				get().ws?.send({ type: "subscribe", sessionId: id });
				get().subscribed.add(id);
			}
		},

		sendPrompt(text, images) {
			const id = get().activeId;
			if (!id) return;
			// First send in a read-only transcript resumes it, then sends.
			if (get().sessionsById[id]?.readOnly) {
				void get()
					.resumeSession(id)
					.then(() => get().sendPrompt(text, images))
					.catch((err) => console.error("resume before send failed", err));
				return;
			}
			const frame: Parameters<NonNullable<StoreState["ws"]>["send"]>[0] = images && images.length > 0
				? { type: "prompt", sessionId: id, text, images }
				: { type: "prompt", sessionId: id, text };
			get().ws?.send(frame);
		},

		abort() {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "abort", sessionId: id });
		},

		clearQueue() {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "clear_queue", sessionId: id });
		},

		cancelQueued(queuedId: string) {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "cancel_queued", sessionId: id, queuedId });
		},

		editQueued(queuedId, text, images) {
			const id = get().activeId;
			if (!id) return;
			const frame: Parameters<NonNullable<StoreState["ws"]>["send"]>[0] = images && images.length > 0
				? { type: "edit_queued", sessionId: id, queuedId, text, images }
				: { type: "edit_queued", sessionId: id, queuedId, text };
			get().ws?.send(frame);
		},

		async disposeSession(id: string) {
			if (!get().sessionsById[id]?.readOnly) {
				try {
					await api.disposeSession(id);
				} catch (err) {
					console.warn("dispose failed", err);
				}
			}
			set((s) => {
				const next = { ...s.sessionsById };
				delete next[id];
				return {
					sessionsById: next,
					activeId: s.activeId === id ? undefined : s.activeId,
				};
			});
		},

		async renameSession(id, name) {
			// Re-throw on failure so the caller (ChatHeader) can keep the input
			// open + surface the error. Silently swallowing makes Windows-EPERM
			// failures from the SDK's atomic-rename journal save look like the
			// UI is broken when it's actually the FS rejecting the rename
			// because the journal file is held open by the live session.
			await api.renameSession(id, name);
			set((s) => {
				const existing = s.sessionsById[id];
				const next = existing
					? { ...s.sessionsById, [id]: { ...existing, sessionName: name } }
					: s.sessionsById;
				const sessions = s.sessions.map((r) => (r.id === id ? { ...r, title: name } : r));
				return { sessionsById: next, sessions };
			});
		},

		toggleAllToolCards() {
			set((s) => ({
				toolView: { allCollapsed: !s.toolView.allCollapsed, perCard: {} },
			}));
		},

		setToolCardOpen(id, open) {
			set((s) => ({
				toolView: {
					allCollapsed: s.toolView.allCollapsed,
					perCard: { ...s.toolView.perCard, [id]: open },
				},
			}));
		},

		setPendingDraft(draft) {
			set({ pendingDraft: draft });
		},

		setSidebarOpen(open) {
			// Only persist on desktop so toggling on mobile (where the panel is an
			// ephemeral overlay) doesn't auto-open it the next time the user lands
			// on the page from a wider screen.
			if (isDesktopViewport()) {
				try {
					localStorage.setItem("npi-deck:sidebar-open", open ? "1" : "0");
				} catch {}
			}
			set({ sidebarOpen: open });
		},

		setInspectorOpen(open) {
			if (isDesktopViewport()) {
				try {
					localStorage.setItem("npi-deck:inspector-open", open ? "1" : "0");
				} catch {}
			}
			set({ inspectorOpen: open });
		},

		respondToExtUiDialog(sessionId, dialogId, response) {
			// Clear local state first — the dialog modal closes immediately —
			// then send the response over the WS so the SDK call settles.
			set((s) => {
				const current = s.pendingDialogs[sessionId];
				if (!current || current.dialogId !== dialogId) return {};
				const next = { ...s.pendingDialogs };
				delete next[sessionId];
				return { pendingDialogs: next };
			});
			get().ws?.send({
				type: "ext_ui_dialog_response",
				sessionId,
				dialogId,
				...response,
			});
		},

		setPlanMode(enabled) {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "set_plan_mode", sessionId: id, enabled });
		},

		respondToPlanApproval({ sessionId, proposalId, approved, feedback, editedContent }) {
			// Optimistically clear the local approval card so the UI hides
			// immediately. Server emits `plan_proposal_resolved`; if the
			// proposalId is stale (sibling tab won the race), the bridge's
			// own replay-on-subscribe will restore the next pending proposal
			// (if any) without us having to roll back here.
			set((s) => {
				const prev = s.sessionsById[sessionId];
				if (!prev || !prev.pendingPlanApproval) return {};
				if (prev.pendingPlanApproval.proposalId !== proposalId) return {};
				return {
					sessionsById: {
						...s.sessionsById,
						[sessionId]: { ...prev, pendingPlanApproval: undefined },
					},
				};
			});
			get().ws?.send({
				type: "plan_response",
				sessionId,
				proposalId,
				approved,
				...(feedback !== undefined ? { feedback } : {}),
				...(editedContent !== undefined ? { editedContent } : {}),
			});
		},

		markNotificationDelivered(id) {
			set((s) => {
				const i = s.notifications.findIndex((n) => n.id === id);
				if (i < 0 || s.notifications[i]?.deliveredOs) return {};
				const next = s.notifications.slice();
				const target = next[i];
				if (!target) return {};
				next[i] = { ...target, deliveredOs: true };
				return { notifications: next };
			});
		},

		dismissNotification(id) {
			set((s) => {
				const i = s.notifications.findIndex((n) => n.id === id);
				if (i < 0 || s.notifications[i]?.dismissed) return {};
				const next = s.notifications.slice();
				const target = next[i];
				if (!target) return {};
				next[i] = { ...target, dismissed: true };
				return { notifications: next };
			});
		},
	})),
);

function handleFrame(
	frame: ServerFrame,
	set: (partial: Partial<StoreState> | ((s: StoreState) => Partial<StoreState>)) => void,
	get: () => StoreState,
): void {
	switch (frame.type) {
		case "hello": {
			const initial = get().workerGeneration === undefined;
			const changed = !initial && get().workerGeneration !== frame.workerGeneration;
			if (changed) {
				set((s) => {
					const sessionsById: Record<string, SessionUi> = {};
					for (const [id, session] of Object.entries(s.sessionsById)) {
						if (!session.sessionFile) continue;
						sessionsById[id] = {
							...session, status: "idle", readOnly: { ...session.readOnly, path: session.sessionFile },
							endedByRestart: true, queuedPrompts: [], pendingPlanApproval: undefined,
							messages: session.messages.map(m => m.role === "assistant" ? { ...m, isStreaming: false } : m),
						};
					}
					return { connectionId: frame.connectionId, workerGeneration: frame.workerGeneration, backend: frame.backend,
						sessionsById, activeId: s.activeId && sessionsById[s.activeId] ? s.activeId : undefined,
						subscribed: new Set<string>(), subagentsBySession: {}, pendingDialogs: {},
						heartbeat: null, sessions: [], workspaces: [] };
				});
			} else {
				set({ connectionId: frame.connectionId, workerGeneration: frame.workerGeneration, backend: frame.backend });
				for (const id of get().subscribed) get().ws?.send({ type: "subscribe", sessionId: id });
			}
			// Bootstrap starts REST reads before the first WS hello. Their
			// generation is undefined, so they may be discarded once hello
			// identifies the worker. Fetch again against the identified worker.
			if (initial || changed) {
				void get().refreshSessions();
				void get().refreshWorkspaces();
			}
			return;
		}

		case "subscribed":
			set((s) => {
				const previous = s.sessionsById[frame.sessionId];
				const next = initSession(frame.snapshot);
				// A read-only transcript becoming live is a first subscribe, not a reconnect.
				const live = previous && !previous.readOnly ? previous : undefined;
				return {
					sessionsById: {
						...s.sessionsById,
						[frame.sessionId]: { ...next, backendLastRan: s.backend
							? { path: s.backend.path, commit: s.backend.commit }
							: previous?.backendLastRan,
							// Advisor events sent while this client was away are not replayed;
							// every (re)subscribe tells the advisor panel to refetch.
							advisorActivity: (previous?.advisorActivity ?? 0) + 1,
							// Mixture events are not replayed either; keep what was seen live.
							mixture: reconcileMixtureResubscribe(live?.mixture, next.mixture ?? emptyMixtureUi(), {
								at: Date.now(),
								conversationReplaced: !!live?.sessionFile && live.sessionFile !== frame.snapshot.sessionFile,
							}) },
					},
				};
			});
			return;

		case "subagents_snapshot":
			set((s) => ({ subagentsBySession: { ...s.subagentsBySession, [frame.sessionId]: frame.nodes } }));
			return;

		case "unsubscribed":
			get().subscribed.delete(frame.sessionId);
			return;

		case "session_event": {
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev) return {};
				const next = applyEvent(prev, frame.event);
				return { sessionsById: { ...s.sessionsById, [frame.sessionId]: next } };
			});
			return;
		}

		case "tasks_changed":
			set((s) => ({ tasksChangeCounter: s.tasksChangeCounter + 1 }));
			return;

		case "skills_changed":
			set((s) => ({ skillsChangeCounter: s.skillsChangeCounter + 1 }));
			return;

		case "kb_changed":
			set((s) => ({ kbChangeCounter: s.kbChangeCounter + 1 }));
			return;

		case "ext_ui_dialog_open":
			set((s) => ({
				pendingDialogs: { ...s.pendingDialogs, [frame.sessionId]: frame },
			}));
			return;

		case "ext_ui_dialog_cancel":
			set((s) => {
				const current = s.pendingDialogs[frame.sessionId];
				if (!current || current.dialogId !== frame.dialogId) return {};
				const next = { ...s.pendingDialogs };
				delete next[frame.sessionId];
				return { pendingDialogs: next };
			});
			return;

		case "plan_mode_changed":
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev) return {};
				const planMode: PlanModeContextWire | undefined = frame.enabled
					? { enabled: true, planFilePath: frame.planFilePath ?? "local://PLAN.md" }
					: undefined;
				// On exit, drop any unresolved approval card; a reply is no
				// longer possible after the proposal handler is cleared.
				const pendingPlanApproval = frame.enabled ? prev.pendingPlanApproval : undefined;
				return {
					sessionsById: {
						...s.sessionsById,
						[frame.sessionId]: { ...prev, planMode, pendingPlanApproval },
					},
				};
			});
			return;

		case "plan_proposed":
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev) return {};
				const pending: PendingPlanApprovalWire = {
					proposalId: frame.proposalId,
					planFilePath: frame.planFilePath,
					planContent: frame.planContent,
					suggestedTitle: frame.suggestedTitle,
				};
				return {
					sessionsById: {
						...s.sessionsById,
						[frame.sessionId]: { ...prev, pendingPlanApproval: pending },
					},
				};
			});
			return;

		case "plan_proposal_resolved":
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev?.pendingPlanApproval) return {};
				if (prev.pendingPlanApproval.proposalId !== frame.proposalId) return {};
				return {
					sessionsById: {
						...s.sessionsById,
						[frame.sessionId]: { ...prev, pendingPlanApproval: undefined },
					},
				};
			});
			return;

		case "session_disposed":
			set((s) => {
				const nextSessions = { ...s.sessionsById };
				delete nextSessions[frame.sessionId];
				const nextDialogs = { ...s.pendingDialogs };
				const subagentsBySession = { ...s.subagentsBySession };
				delete subagentsBySession[frame.sessionId];
				delete nextDialogs[frame.sessionId];
				return {
					sessionsById: nextSessions,
					pendingDialogs: nextDialogs,
					subagentsBySession,
					activeId: s.activeId === frame.sessionId ? undefined : s.activeId,
				};
			});
			return;

		case "error":
			set((s) => {
				const id = frame.sessionId;
				if (!id) return {};
				const prev = s.sessionsById[id];
				if (!prev) return {};
				return {
					sessionsById: {
						...s.sessionsById,
						[id]: { ...prev, lastError: frame.error },
					},
				};
			});
			return;

		case "heartbeat":
			set(() => ({
				heartbeat: {
					lastReceivedAtMs: Date.now(),
					serverStartedAt: frame.serverStartedAt,
					pid: frame.pid,
					uptimeSecs: frame.uptimeSecs,
					buildSha: frame.buildSha,
					version: frame.version,
				},
			}));
			return;

		case "notification":
			set((s) => {
				// Dedupe by id: server may re-send on reconnect.
				if (s.notifications.some((n) => n.id === frame.id)) return {};
				const item: NotificationItem = {
					id: frame.id,
					level: frame.level,
					title: frame.title,
					timestamp: frame.timestamp,
					receivedAtMs: Date.now(),
					deliveredOs: false,
					dismissed: false,
				};
				if (frame.body !== undefined) item.body = frame.body;
				if (frame.sound !== undefined) item.sound = frame.sound;
				if (frame.source !== undefined) item.source = frame.source;
				if (frame.actionUrl !== undefined) item.actionUrl = frame.actionUrl;
				const next = [...s.notifications, item];
				// Cap retention; oldest fall off.
				if (next.length > MAX_NOTIFICATIONS) next.splice(0, next.length - MAX_NOTIFICATIONS);
				return { notifications: next };
			});
			return;

		case "pong":
		default:
			return;
	}
}

// Selectors ────────────────────────────────────────────────────────────────
export const selectActiveSession = (s: StoreState): SessionUi | undefined =>
	s.activeId ? s.sessionsById[s.activeId] : undefined;
