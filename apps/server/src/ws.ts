import type { ServerWebSocket } from "bun";
import type { ClientFrame, ServerFrame } from "@npi-deck/protocol";

import type { AgentBridge, SessionHandle } from "./bridge/types.ts";
import { broadcastBus } from "./broadcast-bus.ts";
import { logger } from "./log.ts";
import { getBuildInfo, getUptimeSecs } from "./build-info.ts";
import { workRegistry } from "./work-registry.ts";
import { activeBackend } from "./backend/runtime.ts";
import type { BackendStatusResponse } from "@npi-deck/protocol";
const log = logger("ws");

/** One connection's stream of one live session generation. */
interface Subscription {
	/** The generation it streams; a chat reopened under the same id is another handle. */
	handle: SessionHandle;
	teardown: () => void;
}

/** Per-connection state. */
export interface ConnectionData {
	connectionId: string;
	subscriptions: Map<string, Subscription>;
}

/**
 * Interval between heartbeat broadcasts, in milliseconds. The web client
 * expects roughly one frame per 5s; missed frames (>15s gap) drive the
 * "disconnected" indicator.
 */
export const HEARTBEAT_INTERVAL_MS = 5000;

export class WsHub {
	private readonly connections = new Set<ServerWebSocket<ConnectionData>>();
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

	constructor(private bridge: AgentBridge, private readonly generation: string) {
		broadcastBus.subscribe((frame) => {
			if (frame.type === "session_disposed") this.sessionDisposed(frame.sessionId);
			else this.broadcast(frame);
		});
		this.startHeartbeat();
	}

	private startHeartbeat(): void {
		if (this.heartbeatTimer) return;
		this.heartbeatTimer = setInterval(() => {
			const info = getBuildInfo();
			// Push through the shared bus so any subscriber (the hub itself, future
			// telemetry, tests) sees the frame, not just connected WS sockets.
			broadcastBus.broadcast({
				type: "heartbeat",
				serverStartedAt: info.serverStartedAt,
				pid: info.pid,
				uptimeSecs: getUptimeSecs(),
				buildSha: info.buildSha,
				version: info.version,
				timestamp: new Date().toISOString(),
			});
		}, HEARTBEAT_INTERVAL_MS);
		// Don't keep the event loop alive solely for heartbeats.
		this.heartbeatTimer.unref?.();
	}

	/** For tests + clean shutdown. After dispose, no more heartbeats fire. */
	dispose(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	createConnectionData(): ConnectionData {
		return {
			connectionId: crypto.randomUUID(),
			subscriptions: new Map(),
		};
	}

	onOpen(ws: ServerWebSocket<ConnectionData>): void {
		this.connections.add(ws);
		const backend = activeBackend();
		const running: BackendStatusResponse["running"] = backend ? { id: backend.selection.id, path: backend.identity.path, source: backend.selection.source, version: backend.identity.version, commit: backend.identity.commit } : null;
		send(ws, { type: "hello", connectionId: ws.data.connectionId, workerGeneration: this.generation, backend: running, capabilities: backend ? Object.entries(backend.features).filter(([, status]) => status.available).map(([name]) => name) : [] });
		log.debug(`open ${ws.data.connectionId}`);
	}

	async onMessage(ws: ServerWebSocket<ConnectionData>, raw: string | Buffer): Promise<void> {
		let frame: ClientFrame;
		try {
			frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as ClientFrame;
		} catch {
			send(ws, { type: "error", error: "invalid json" });
			return;
		}

		switch (frame.type) {
			case "ping":
				send(ws, { type: "pong" });
				return;

			case "subscribe":
				await this.handleSubscribe(ws, frame.sessionId);
				return;

			case "unsubscribe":
				this.handleUnsubscribe(ws, frame.sessionId);
				return;

			case "prompt":
				await this.handlePrompt(ws, frame);
				return;

			case "abort":
				await this.handleAbort(ws, frame.sessionId);
				return;

			case "clear_queue":
				this.handleClearQueue(ws, frame.sessionId);
				return;

			case "cancel_queued":
				await this.handleCancelQueued(ws, frame);
				return;

			case "edit_queued":
				await this.handleEditQueued(ws, frame);
				return;

			case "ext_ui_dialog_response":
				this.handleExtUiDialogResponse(ws, frame);
				return;

			case "set_plan_mode":
				await this.handleSetPlanMode(ws, frame);
				return;

			case "plan_response":
				await this.handlePlanResponse(ws, frame);
				return;

			default:
				send(ws, { type: "error", error: `unknown frame type` });
		}
	}

	onClose(ws: ServerWebSocket<ConnectionData>): void {
		this.connections.delete(ws);
		const subs = ws.data.subscriptions;
		const connectionId = ws.data.connectionId;
		log.debug(`close ${connectionId} subs=${subs.size}`);
		for (const [sessionId, sub] of subs.entries()) {
			try {
				sub.teardown();
			} catch (err) {
				log.warn(`unsubscribe on close failed`, err);
			}
			this.bridge.trackSubscriberRemoved(sessionId, connectionId);
		}
		subs.clear();
	}

	private broadcast(frame: ServerFrame): void {
		const payload = JSON.stringify(frame);
		for (const ws of this.connections) {
			try {
				ws.send(payload);
			} catch (err) {
				log.warn(`broadcast send failed`, err);
			}
		}
	}

	/** Drop every connection's subscription to an ended session and tell those clients. */
	private sessionDisposed(sessionId: string): void {
		for (const ws of this.connections) {
			if (!this.dropSubscription(ws, sessionId)) continue;
			try {
				send(ws, { type: "session_disposed", sessionId });
			} catch (err) {
				log.warn(`session_disposed send failed`, err);
			}
		}
	}

	private dropSubscription(ws: ServerWebSocket<ConnectionData>, sessionId: string): boolean {
		const sub = ws.data.subscriptions.get(sessionId);
		if (!sub) return false;
		ws.data.subscriptions.delete(sessionId);
		sub.teardown();
		this.bridge.trackSubscriberRemoved(sessionId, ws.data.connectionId);
		return true;
	}

	// ───────────────────────────────────────────────────────────────────────

	private async handleSubscribe(ws: ServerWebSocket<ConnectionData>, sessionId: string): Promise<void> {
		const connectionId = ws.data.connectionId;
		const current = ws.data.subscriptions.get(sessionId);
		if (current) {
			const handle = this.bridge.getSession(sessionId);
			if (handle === current.handle) {
				this.bridge.bumpActivity(sessionId);
				send(ws, { type: "subscribed", sessionId, snapshot: handle.snapshot() });
				return;
			}
			// Closing, or closed and reopened: that generation's stream is over.
			// Drop it; the chat is answered below as ended or subscribed afresh.
			this.dropSubscription(ws, sessionId);
		}

		const handle = this.bridge.getSession(sessionId);
		if (!handle) {
			// Stopped since the client last saw it (idle reaper, dispose): the
			// client keeps its transcript read-only and resumes on the next send.
			send(ws, { type: "session_disposed", sessionId });
			return;
		}

		const unsubSession = handle.subscribe((event) => {
			send(ws, { type: "session_event", sessionId, event });
		});
		// Mirror extension-UI dialog frames (ask tool etc.) into this connection.
		// `subscribeUiFrames` also replays any already-open dialogs so a page-
		// reload subscriber sees the pending modal immediately.
		const unsubUi = this.bridge.subscribeUiFrames(sessionId, (frame) => {
			send(ws, frame);
		});
		// Mirror plan-mode lifecycle frames (mode-changed + proposed + resolved)
		// into this connection. `subscribePlanModeFrames` replays the current
		// plan-mode state + any pending approval card so a late tab re-renders
		// the pill + approval UI immediately.
		const unsubPlan = this.bridge.subscribePlanModeFrames(sessionId, (frame) => {
			send(ws, frame);
		});
		const unsubSubagents = this.bridge.subscribeSubagents(sessionId, (nodes) => {
			send(ws, { type: "subagents_snapshot", sessionId, nodes });
		});
		const teardown = (): void => {
			try {
				unsubSession();
			} catch (err) {
				log.warn(`session unsubscribe threw`, err);
			}
			try {
				unsubUi();
			} catch (err) {
				log.warn(`ui unsubscribe threw`, err);
			}
			try {
				unsubPlan();
			} catch (err) {
				log.warn(`plan-mode unsubscribe threw`, err);
			}
			try {
				unsubSubagents();
			} catch (err) {
				log.warn(`subagent unsubscribe threw`, err);
			}
		};
		ws.data.subscriptions.set(sessionId, { handle, teardown });
		this.bridge.trackSubscriberAdded(sessionId, connectionId);
		send(ws, { type: "subscribed", sessionId, snapshot: handle.snapshot() });
	}

	private handleUnsubscribe(ws: ServerWebSocket<ConnectionData>, sessionId: string): void {
		this.dropSubscription(ws, sessionId);
		send(ws, { type: "unsubscribed", sessionId });
	}

	private async handlePrompt(
		ws: ServerWebSocket<ConnectionData>,
		frame: Extract<ClientFrame, { type: "prompt" }>,
	): Promise<void> {
		const handle = this.bridge.getSession(frame.sessionId);
		if (!handle) {
			send(ws, { type: "error", sessionId: frame.sessionId, error: "session not active" });
			return;
		}
		const opts: { streamingBehavior?: "steer" | "followUp"; images?: typeof frame.images } = {};
		// Default to "followUp" so a prompt sent while the agent is mid-turn is
		// queued instead of throwing AgentBusyError (which the user never sees —
		// it just looks like the message vanished). The web composer can still
		// override to "steer" when we surface that affordance.
		opts.streamingBehavior = frame.streamingBehavior ?? "followUp";
		if (frame.images && frame.images.length > 0) opts.images = frame.images;
		this.bridge.bumpActivity(frame.sessionId);
		const sendError = (err: unknown): void => {
			send(ws, {
				type: "error",
				sessionId: frame.sessionId,
				error: `prompt failed: ${String(err)}`,
			});
		};
		let release: () => void;
		try {
			release = workRegistry.admit("prompt", `${frame.sessionId}:${crypto.randomUUID()}`);
		} catch (err) {
			sendError(err);
			return;
		}
		const consumed = (output: string): void => {
			send(ws, { type: "prompt_consumed", sessionId: frame.sessionId, output });
		};
		const forward = async (text: string): Promise<void> => {
			if (!(await handle.prompt(text, opts))) consumed("Done.");
		};
		if (frame.text.startsWith("/")) {
			handle
				.dispatchDeckSlashCommand(frame.text)
				.then((deck) => {
					if (deck.kind === "consumed") return consumed(deck.output);
					if (deck.kind === "rewritten") return forward(deck.prompt);
					return handle
						.dispatchSlashCommand(frame.text)
						.then((sdk) => {
							if (sdk.kind === "consumed") return consumed(sdk.output);
							if (sdk.kind === "rewritten") return forward(sdk.prompt);
							return forward(frame.text);
						});
				})
				.catch(sendError).finally(release);
			return;
		}
		forward(frame.text).catch(sendError).finally(release);
	}

	private async handleAbort(ws: ServerWebSocket<ConnectionData>, sessionId: string): Promise<void> {
		const handle = this.bridge.getSession(sessionId);
		if (!handle) {
			send(ws, { type: "error", sessionId, error: "session not active" });
			return;
		}
		this.bridge.bumpActivity(sessionId);
		try {
			await handle.abort();
		} catch (err) {
			send(ws, { type: "error", sessionId, error: `abort failed: ${String(err)}` });
		}
	}

	private handleClearQueue(ws: ServerWebSocket<ConnectionData>, sessionId: string): void {
		const handle = this.bridge.getSession(sessionId);
		if (!handle) {
			send(ws, { type: "error", sessionId, error: "session not active" });
			return;
		}
		this.bridge.bumpActivity(sessionId);
		try {
			handle.clearQueue();
		} catch (err) {
			send(ws, { type: "error", sessionId, error: `clear queue failed: ${String(err)}` });
		}
	}

	private async handleCancelQueued(
		ws: ServerWebSocket<ConnectionData>,
		frame: Extract<ClientFrame, { type: "cancel_queued" }>,
	): Promise<void> {
		const handle = this.bridge.getSession(frame.sessionId);
		if (!handle) {
			send(ws, { type: "error", sessionId: frame.sessionId, error: "session not active" });
			return;
		}
		this.bridge.bumpActivity(frame.sessionId);
		try {
			await handle.cancelQueuedById(frame.queuedId);
		} catch (err) {
			send(ws, {
				type: "error",
				sessionId: frame.sessionId,
				error: `cancel queued failed: ${String(err)}`,
			});
		}
	}

	private async handleEditQueued(
		ws: ServerWebSocket<ConnectionData>,
		frame: Extract<ClientFrame, { type: "edit_queued" }>,
	): Promise<void> {
		const handle = this.bridge.getSession(frame.sessionId);
		if (!handle) {
			send(ws, { type: "error", sessionId: frame.sessionId, error: "session not active" });
			return;
		}
		// Refuse silently-empty edits — the user almost certainly meant cancel.
		if (!frame.text || frame.text.trim().length === 0) {
			send(ws, {
				type: "error",
				sessionId: frame.sessionId,
				error: "edit_queued: text required (use cancel_queued to drop)",
			});
			return;
		}
		this.bridge.bumpActivity(frame.sessionId);
		try {
			await handle.editQueuedById(frame.queuedId, frame.text, frame.images);
		} catch (err) {
			send(ws, {
				type: "error",
				sessionId: frame.sessionId,
				error: `edit queued failed: ${String(err)}`,
			});
		}
	}

	private handleExtUiDialogResponse(
		ws: ServerWebSocket<ConnectionData>,
		frame: Extract<ClientFrame, { type: "ext_ui_dialog_response" }>,
	): void {
		// We don't gate on subscription state here: a user can answer a dialog
		// from any connection that received the open frame (the bridge replays
		// pending frames on subscribe). Bumping activity keeps the reaper away
		// while the user is mid-decision.
		this.bridge.bumpActivity(frame.sessionId);
		const { type: _t, sessionId, dialogId, ...response } = frame;
		void _t;
		try {
			this.bridge.respondToUiDialog(sessionId, dialogId, response);
		} catch (err) {
			log.warn(`respondToUiDialog threw`, err);
			send(ws, {
				type: "error",
				sessionId,
				error: `ext_ui_dialog_response failed: ${String(err)}`,
			});
		}
	}

	private async handleSetPlanMode(
		ws: ServerWebSocket<ConnectionData>,
		frame: Extract<ClientFrame, { type: "set_plan_mode" }>,
	): Promise<void> {
		const handle = this.bridge.getSession(frame.sessionId);
		if (!handle) {
			send(ws, { type: "error", sessionId: frame.sessionId, error: "session not active" });
			return;
		}
		this.bridge.bumpActivity(frame.sessionId);
		try {
			await handle.setPlanMode(frame.enabled);
		} catch (err) {
			log.warn(`setPlanMode threw`, err);
			send(ws, {
				type: "error",
				sessionId: frame.sessionId,
				error: `set_plan_mode failed: ${String((err as Error).message ?? err)}`,
			});
		}
	}

	private async handlePlanResponse(
		ws: ServerWebSocket<ConnectionData>,
		frame: Extract<ClientFrame, { type: "plan_response" }>,
	): Promise<void> {
		// Like ext_ui_dialog_response: any connection that observed the
		// plan_proposed (replayed on subscribe) is allowed to answer. We
		// bump activity to keep the reaper away while the user is mid-
		// decision and during the proposal response.
		this.bridge.bumpActivity(frame.sessionId);
		const { approved, feedback, editedContent, proposalId, sessionId } = frame;
		try {
			const outcome = await this.bridge.respondToPlanApproval(sessionId, proposalId, {
				approved,
				...(feedback !== undefined ? { feedback } : {}),
				...(editedContent !== undefined ? { editedContent } : {}),
			});
			if (outcome === "unknown") {
				// 409-equivalent: stale/double-click. The client rolls back its
				// optimistic UI. The bridge already broadcasts the canonical
				// `plan_proposal_resolved` from whichever side won the race.
				send(ws, {
					type: "error",
					sessionId,
					error: `plan_response: proposal ${proposalId} already resolved or unknown`,
				});
			}
		} catch (err) {
			log.warn(`respondToPlanApproval threw`, err);
			send(ws, {
				type: "error",
				sessionId,
				error: `plan_response failed: ${String((err as Error).message ?? err)}`,
			});
		}
	}
}

function send(ws: ServerWebSocket<ConnectionData>, frame: ServerFrame): void {
	ws.send(JSON.stringify(frame));
}
