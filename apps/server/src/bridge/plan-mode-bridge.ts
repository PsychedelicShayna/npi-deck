import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { PendingPlanApprovalWire, PlanModeContextWire, ServerFrame } from "@npi-deck/protocol";
import { feature } from "../backend/runtime.ts";
import { logger } from "../log.ts";
import type { PlanApprovalResponse } from "./types.ts";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";

const log = logger("bridge:plan-mode");
const DEFAULT_PLAN = "local://PLAN.md";
type PlanModeFrame = Extract<ServerFrame, { type: "plan_mode_changed" | "plan_proposed" | "plan_proposal_resolved" }>;
type FrameListener = (frame: PlanModeFrame) => void;
type PlanState = NonNullable<ReturnType<AgentSession["getPlanModeState"]>>;

/** The only SDK operations needed by the per-session plan bridge. */
export interface PlanModeSession {
	getPlanModeState(): PlanState | undefined;
	setPlanModeState: AgentSession["setPlanModeState"];
	setPlanProposalHandler: AgentSession["setPlanProposalHandler"];
	getActiveToolNames(): string[];
	hasBuiltInTool(name: string): boolean;
	setActiveToolsByName(names: string[]): Promise<void>;
	setPlanReferencePath(path: string): void;
}

interface Pending extends PendingPlanApprovalWire {
	resolve(response: PlanApprovalResponse): void;
}

export class PlanModeBridge {
	private readonly listeners = new Set<FrameListener>();
	private pending: Pending | undefined;
	private previousTools: string[] | undefined;
	private enabled = false;
	private disposed = false;
	private sequence = 0;
	private planFilePath = DEFAULT_PLAN;

	constructor(
		private readonly sessionId: string,
		private readonly session: PlanModeSession,
		private readonly sessionManager: {
			getArtifactsDir(): string | null;
			getSessionId(): string | null;
			buildSessionContext(): { mode?: string; modeData?: Record<string, unknown> };
			appendModeChange(mode: string, data?: Record<string, unknown>): string;
		},
	) {}

	isEnabled(): boolean { return this.enabled; }
	hasPendingApproval(): boolean { return this.pending !== undefined; }
	getPlanModeContext(): PlanModeContextWire | undefined {
		return this.enabled ? { enabled: true, planFilePath: this.planFilePath } : undefined;
	}
	getPendingPlanApproval(): PendingPlanApprovalWire | undefined {
		const p = this.pending;
		return p ? { proposalId: p.proposalId, planFilePath: p.planFilePath, planContent: p.planContent,
			suggestedTitle: p.suggestedTitle } : undefined;
	}
	getReplayFrames(): PlanModeFrame[] {
		const frames: PlanModeFrame[] = [];
		if (this.enabled) frames.push({ type: "plan_mode_changed", sessionId: this.sessionId, enabled: true, planFilePath: this.planFilePath });
		const p = this.getPendingPlanApproval();
		if (p) frames.push({ type: "plan_proposed", sessionId: this.sessionId, ...p });
		return frames;
	}
	subscribeFrames(listener: FrameListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private emit(frame: PlanModeFrame): void {
		for (const listener of this.listeners) {
			try { listener(frame); } catch (error) { log.warn("plan listener failed", error); }
		}
	}

	/** Resume the journal's last mode before the first new prompt. */
	async restore(): Promise<void> {
		const context = this.sessionManager.buildSessionContext();
		if (context.mode !== "plan") return;
		const file = context.modeData?.planFilePath;
		await this.enter(typeof file === "string" && file.startsWith("local://") ? file : DEFAULT_PLAN, false);
	}

	async enter(planFilePath = DEFAULT_PLAN, persist = true): Promise<void> {
		if (this.disposed) throw new Error("Session disposed");
		if (this.enabled) return;
		feature("plan-mode");
		const tools = this.session.getActiveToolNames();
		if (!this.session.hasBuiltInTool("write")) throw new Error("Plan mode requires NeoPi's built-in write tool.");
		const active = [...new Set([...tools, "write"])];
		const oldState = this.session.getPlanModeState();
		this.session.setPlanModeState({ enabled: true, planFilePath, workflow: "parallel", reentry: persist ? undefined : true });
		try { await this.session.setActiveToolsByName(active); }
		catch (error) { this.session.setPlanModeState(oldState); throw error; }
		this.previousTools = tools;
		this.planFilePath = planFilePath;
		this.session.setPlanProposalHandler(title => this.propose(title));
		this.enabled = true;
		if (persist) this.sessionManager.appendModeChange("plan", { planFilePath });
		this.emit({ type: "plan_mode_changed", sessionId: this.sessionId, enabled: true, planFilePath });
	}

	async exit(): Promise<void> {
		if (!this.enabled) return;
		this.settlePending({ approved: false, feedback: "Plan review cancelled: plan mode was exited." }, "rejected");
		this.session.setPlanModeState(undefined);
		try { if (this.previousTools) await this.session.setActiveToolsByName(this.previousTools); }
		catch (error) {
			this.session.setPlanModeState({ enabled: true, planFilePath: this.planFilePath, workflow: "parallel" });
			throw error;
		}
		this.session.setPlanProposalHandler(null);
		this.previousTools = undefined;
		this.enabled = false;
		this.sessionManager.appendModeChange("none");
		this.emit({ type: "plan_mode_changed", sessionId: this.sessionId, enabled: false });
	}

	respond(proposalId: string, response: PlanApprovalResponse): "settled" | "unknown" {
		if (!this.pending || this.pending.proposalId !== proposalId) return "unknown";
		this.settlePending(response, response.approved ? "approved" : "rejected");
		return "settled";
	}
	private settlePending(response: PlanApprovalResponse, outcome: "approved" | "rejected" | "expired"): void {
		const p = this.pending;
		if (!p) return;
		this.pending = undefined;
		this.emit({ type: "plan_proposal_resolved", sessionId: this.sessionId, proposalId: p.proposalId, outcome });
		p.resolve(response);
	}

	private localPath(url: string): string {
		return feature("plan-mode").resolveLocalUrlToPath(url, {
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		});
	}
	private async listPlans(): Promise<string[]> {
		const root = path.dirname(this.localPath(feature("plan-mode").planFileUrlForSlug("candidate")));
		const entries = await readdir(root).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		const candidates = await Promise.all(entries.filter(name => name.endsWith("-plan.md")).map(async name => ({
			url: `local://${name}`, mtime: (await stat(path.join(root, name))).mtimeMs,
		})));
		return candidates.sort((a, b) => b.mtime - a.mtime).map(item => item.url);
	}
	private async propose(title: string): Promise<{ content: Array<{ type: "text"; text: string }>; details: { planFilePath: string; title: string; planExists: boolean } }> {
		const { resolveApprovedPlan } = feature("plan-mode");
		if (!this.enabled || this.pending) throw new Error("Plan mode is not ready for another proposal.");
		const plan = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: this.planFilePath,
			readPlan: async url => {
				try { return await readFile(this.localPath(url), "utf8"); }
				catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
			},
			listPlanFiles: () => this.listPlans(),
		});
		this.planFilePath = plan.planFilePath;
		const state = this.session.getPlanModeState();
		if (state) this.session.setPlanModeState({ ...state, planFilePath: plan.planFilePath });
		this.sessionManager.appendModeChange("plan", { planFilePath: plan.planFilePath });
		const proposalId = `pa_${this.sessionId}_${++this.sequence}`;
		const decision = new Promise<PlanApprovalResponse>(resolve => {
			this.pending = { proposalId, planFilePath: plan.planFilePath, planContent: plan.planContent,
				suggestedTitle: plan.title, resolve };
		});
		this.emit({ type: "plan_proposed", sessionId: this.sessionId, ...this.getPendingPlanApproval()! });
		const response = await decision;
		const details = { planFilePath: plan.planFilePath, title: plan.title, planExists: true };
		if (!response.approved) return { content: [{ type: "text", text: `Plan refinement requested. ${response.feedback?.trim() || "Please revise the plan."} Update ${plan.planFilePath}, then write the slug to xd://propose again.` }], details };
		if (response.editedContent !== undefined) await writeFile(this.localPath(plan.planFilePath), response.editedContent, "utf8");
		this.session.setPlanReferencePath(plan.planFilePath);
		await this.exit();
		return { content: [{ type: "text", text: `Plan approved at ${plan.planFilePath}. Plan mode exited; proceed with the implementation.` }], details };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.settlePending({ approved: false, feedback: "Session disposed." }, "expired");
		this.session.setPlanProposalHandler(null);
		this.listeners.clear();
	}
}
