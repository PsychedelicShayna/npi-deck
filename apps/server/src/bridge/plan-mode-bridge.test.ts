import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { feature, loadBackend, resolveBackendSelection } from "../backend/runtime.ts";
import { InProcessSessionHandle } from "./in-process.ts";
import { PlanModeBridge, type PlanModeSession } from "./plan-mode-bridge.ts";

const backend = resolveBackendSelection();
const root = await mkdtemp(path.join(os.tmpdir(), "deck-plan-test-"));
const priorHome = process.env.HOME;
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
await loadBackend(backend);
afterAll(async () => {
	if (priorHome === undefined) delete process.env.HOME;
	else process.env.HOME = priorHome;
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	await rm(root, { recursive: true, force: true });
});

function fixture(timeouts?: { reconnectGraceMs?: number; approvalTimeoutMs?: number }) {
	const journal: Array<{ mode: string; data?: Record<string, unknown> }> = [];
	const manager = {
		getArtifactsDir: () => root,
		getSessionId: () => "test-session",
		buildSessionContext: () => ({ mode: journal.at(-1)?.mode, modeData: journal.at(-1)?.data }),
		appendModeChange: (mode: string, data?: Record<string, unknown>) => { journal.push({ mode, data }); return String(journal.length); },
	};
	let tools = ["read"];
	let handler: ((title: string) => Promise<unknown>) | null = null;
	let state: ReturnType<PlanModeSession["getPlanModeState"]>;
	let reference = "";
	const session: PlanModeSession = {
		getPlanModeState: () => state,
		setPlanModeState: next => { state = next; },
		setPlanProposalHandler: next => { handler = next; },
		getActiveToolNames: () => [...tools],
		hasBuiltInTool: name => name === "write",
		setActiveToolsByName: async names => { tools = names; },
		setPlanReferencePath: name => { reference = name; },
	};
	const bridge = new PlanModeBridge("test-session", session, manager, timeouts);
	const planUrl = feature("plan-mode").planFileUrlForSlug("test");
	const planPath = feature("plan-mode").resolveLocalUrlToPath(planUrl, manager);
	return { bridge, manager, planUrl, planPath, get handler() { return handler; }, get state() { return state; }, get tools() { return tools; }, get reference() { return reference; } };
}

test("xd://propose exposes content, rejection feedback revises, approval exits and preserves artifact", async () => {
	const f = fixture();
	await f.bridge.enter();
	expect(f.tools).toEqual(["read", "write"]);
	await mkdir(path.dirname(f.planPath), { recursive: true });
	await writeFile(f.planPath, "# First\n\nOld plan\n");
	const propose = feature("plan-mode").dispatchResolutionDevice;
	const toolSession = { peekPlanProposalHandler: () => f.handler } as Parameters<typeof propose>[0];
	const first = propose(toolSession, "propose", "test");
	await Bun.sleep(10);
	const pending = f.bridge.getPendingPlanApproval()!;
	expect(pending.planContent).toContain("Old plan");
	expect(f.bridge.getReplayFrames().some(frame => frame.type === "plan_proposed")).toBe(true);
	expect(f.bridge.respond(pending.proposalId, { approved: false, feedback: "Add a verification step." })).toBe("settled");
	expect(f.bridge.respond(pending.proposalId, { approved: true })).toBe("unknown");
	expect(JSON.stringify(await first)).toContain("Add a verification step.");
	expect(f.bridge.isEnabled()).toBe(true);
	await writeFile(f.planPath, "# Revised\n\nVerification step\n");
	const second = propose(toolSession, "propose", "test");
	await Bun.sleep(10);
	const next = f.bridge.getPendingPlanApproval()!;
	expect(next.planContent).toContain("Verification step");
	expect(f.bridge.respond(next.proposalId, { approved: true, editedContent: "# Approved\n\nVerification step\n" })).toBe("settled");
	expect(JSON.stringify(await second)).toContain("proceed with the implementation");
	expect(f.bridge.isEnabled()).toBe(false);
	expect(f.reference).toBe(f.planUrl);
	expect(f.tools).toEqual(["read"]);
	expect(await readFile(f.planPath, "utf8")).toContain("Approved");
});

test("resume restores plan state and cancel releases an outstanding proposal", async () => {
	const f = fixture();
	f.manager.appendModeChange("plan", { planFilePath: f.planUrl });
	await f.bridge.restore();
	expect(f.state?.planFilePath).toBe(f.planUrl);
	await mkdir(path.dirname(f.planPath), { recursive: true });
	await writeFile(f.planPath, "# Draft\n");
	const proposal = f.handler!("test");
	await Bun.sleep(10);
	await f.bridge.exit();
	expect(JSON.stringify(await proposal)).toContain("cancelled");
	expect(f.bridge.getPendingPlanApproval()).toBeUndefined();
	expect(f.manager.buildSessionContext().mode).toBe("none");
});

test("disposing a root settles its pending plan before waiting for the SDK turn", async () => {
	const f = fixture();
	await f.bridge.enter();
	await mkdir(path.dirname(f.planPath), { recursive: true });
	await writeFile(f.planPath, "# Awaiting review\n");
	const proposal = f.handler!("test");
	for (let i = 0; i < 50 && !f.bridge.getPendingPlanApproval(); i++) await Bun.sleep(10);
	expect(f.bridge.getPendingPlanApproval()).toBeDefined();

	let disposed = false;
	const handle = new InProcessSessionHandle({
		session: { dispose: async () => { await proposal; } } as never,
		sessionManager: f.manager as never,
		cwd: root,
		sessionId: "test-session",
		getModelRegistry: async () => ({}) as never,
		planBridge: f.bridge,
		onDispose: () => { disposed = true; },
	});
	const closing = handle.dispose();
	const pendingWhileDisposing = f.bridge.getPendingPlanApproval();
	// If disposal is broken, settle it here so the test cannot leave a pending turn.
	f.bridge.dispose();
	await closing;
	expect(pendingWhileDisposing).toBeUndefined();
	expect(JSON.stringify(await proposal)).toContain("Session disposed.");
	expect(disposed).toBe(true);
});

test("abandoned plan approval expires without approving or deleting its artifact", async () => {
	const f = fixture({ reconnectGraceMs: 30, approvalTimeoutMs: 200 });
	await f.bridge.enter();
	await mkdir(path.dirname(f.planPath), { recursive: true });
	await writeFile(f.planPath, "# Unapproved\n");
	const unsubscribe = f.bridge.subscribeFrames(() => {});
	const proposal = f.handler!("test");
	for (let i = 0; i < 50 && !f.bridge.getPendingPlanApproval(); i++) await Bun.sleep(10);
	expect(f.bridge.getPendingPlanApproval()).toBeDefined();
	unsubscribe();
	const outcome = await Promise.race([
		proposal.then(value => ({ settled: true, value })),
		Bun.sleep(500).then(() => ({ settled: false, value: undefined })),
	]);
	expect(f.bridge.getPendingPlanApproval()?.proposalId).toBeUndefined();
	expect(f.bridge.isEnabled()).toBe(true);
	expect(await readFile(f.planPath, "utf8")).toBe("# Unapproved\n");
	f.bridge.dispose();
	expect(outcome.settled).toBe(true);
	expect(JSON.stringify(outcome.value)).toContain("expired");
});

test("another reviewer or a timely reconnect preserves the pending decision", async () => {
	const f = fixture({ reconnectGraceMs: 100, approvalTimeoutMs: 1_000 });
	await f.bridge.enter();
	await mkdir(path.dirname(f.planPath), { recursive: true });
	await writeFile(f.planPath, "# Reviewable\n");
	const disconnectFirst = f.bridge.subscribeFrames(() => {});
	const disconnectSecond = f.bridge.subscribeFrames(() => {});
	const proposal = f.handler!("test");
	for (let i = 0; i < 50 && !f.bridge.getPendingPlanApproval(); i++) await Bun.sleep(10);
	const id = f.bridge.getPendingPlanApproval()!.proposalId;
	disconnectFirst();
	await Bun.sleep(150);
	expect(f.bridge.getPendingPlanApproval()?.proposalId).toBe(id);
	disconnectSecond();
	await Bun.sleep(10);
	const replay = f.bridge.getReplayFrames();
	const disconnectReconnected = f.bridge.subscribeFrames(() => {});
	expect(replay.some(frame => frame.type === "plan_proposed" && frame.proposalId === id)).toBe(true);
	await Bun.sleep(150);
	expect(f.bridge.getPendingPlanApproval()?.proposalId).toBe(id);
	expect(f.bridge.respond(id, { approved: false, feedback: "Revise this." })).toBe("settled");
	expect(JSON.stringify(await proposal)).toContain("Revise this.");
	disconnectReconnected();
	f.bridge.dispose();
});

test("a connected but unattended reviewer cannot hold a proposal indefinitely", async () => {
	const f = fixture({ reconnectGraceMs: 500, approvalTimeoutMs: 30 });
	await f.bridge.enter();
	await mkdir(path.dirname(f.planPath), { recursive: true });
	await writeFile(f.planPath, "# Still unapproved\n");
	const disconnect = f.bridge.subscribeFrames(() => {});
	const proposal = f.handler!("test");
	const outcome = await Promise.race([
		proposal.then(value => ({ settled: true, value })),
		Bun.sleep(500).then(() => ({ settled: false, value: undefined })),
	]);
	expect(outcome.settled).toBe(true);
	expect(JSON.stringify(outcome.value)).toContain("approval timed out");
	expect(f.bridge.hasPendingApproval()).toBe(false);
	expect(f.bridge.isEnabled()).toBe(true);
	expect(await readFile(f.planPath, "utf8")).toBe("# Still unapproved\n");
	disconnect();
	f.bridge.dispose();
});

test("concurrent proposal preparation cannot overwrite and strand a decision", async () => {
	const f = fixture();
	await f.bridge.enter();
	await mkdir(path.dirname(f.planPath), { recursive: true });
	await writeFile(f.planPath, "# One decision\n");
	const first = f.handler!("test");
	await expect(f.handler!("test")).rejects.toThrow("not ready for another proposal");
	for (let i = 0; i < 50 && !f.bridge.getPendingPlanApproval(); i++) await Bun.sleep(10);
	const id = f.bridge.getPendingPlanApproval()!.proposalId;
	expect(f.bridge.respond(id, { approved: false, feedback: "One answer." })).toBe("settled");
	expect(JSON.stringify(await first)).toContain("One answer.");
	f.bridge.dispose();
});

test("disposing during proposal preparation cannot install a late pending decision", async () => {
	const f = fixture();
	await f.bridge.enter();
	await mkdir(path.dirname(f.planPath), { recursive: true });
	await writeFile(f.planPath, "# Closing\n");
	const proposal = f.handler!("test");
	f.bridge.dispose();
	await expect(proposal).rejects.toThrow("no longer ready for this proposal");
	expect(f.bridge.hasPendingApproval()).toBe(false);
});
