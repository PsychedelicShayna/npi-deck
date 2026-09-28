/**
 * Per-session plan-mode bridge: gated off until W4 (#45).
 *
 * omp 15.x plan mode ran through a `resolve` tool and a standing resolve
 * handler. NeoPi removed both: the agent writes the plan, then
 * `write xd://propose`, which calls the session's `setPlanProposalHandler`
 * handler; `resolveApprovedPlan` finalizes the file. W4 ports the bridge onto
 * that flow using the manifest's `plan-mode` feature.
 *
 * Until then this keeps the surface InProcessAgentBridge and the web UI use
 * (snapshot, replay frames, respond) with plan mode permanently off, and
 * `enter()` rejects with PlanModeUnavailableError so the UI's toggle shows a
 * clear error instead of half-entering a mode NeoPi can't complete.
 */
import type { PendingPlanApprovalWire, PlanModeContextWire, ServerFrame } from "@npi-deck/protocol";

import type { PlanApprovalResponse } from "./types.ts";

type PlanModeChangedFrame = Extract<ServerFrame, { type: "plan_mode_changed" }>;
type PlanProposedFrame = Extract<ServerFrame, { type: "plan_proposed" }>;
type PlanProposalResolvedFrame = Extract<ServerFrame, { type: "plan_proposal_resolved" }>;
export type PlanModeFrame = PlanModeChangedFrame | PlanProposedFrame | PlanProposalResolvedFrame;

type FrameListener = (frame: PlanModeFrame) => void;

export class PlanModeUnavailableError extends Error {
	override name = "PlanModeUnavailableError";
	constructor() {
		super("Plan mode is unavailable until W4 ports it to NeoPi's xd://propose flow (#45).");
	}
}

export class PlanModeBridge {
	private readonly listeners = new Set<FrameListener>();

	isEnabled(): boolean {
		return false;
	}

	hasPendingApproval(): boolean {
		return false;
	}

	getPlanModeContext(): PlanModeContextWire | undefined {
		return undefined;
	}

	getPendingPlanApproval(): PendingPlanApprovalWire | undefined {
		return undefined;
	}

	getReplayFrames(): PlanModeFrame[] {
		return [];
	}

	subscribeFrames(listener: FrameListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async enter(): Promise<void> {
		throw new PlanModeUnavailableError();
	}

	/** Plan mode is never entered, so there is nothing to exit. */
	async exit(): Promise<void> {}

	respond(_proposalId: string, _response: PlanApprovalResponse): "settled" | "unknown" {
		return "unknown";
	}

	dispose(): void {
		this.listeners.clear();
	}
}
