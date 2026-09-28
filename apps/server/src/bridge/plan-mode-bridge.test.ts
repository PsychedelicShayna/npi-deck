import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { feature, loadBackend, resolveBackendSelection } from "../backend/runtime.ts";
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

function fixture() {
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
	const bridge = new PlanModeBridge("test-session", session, manager);
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
