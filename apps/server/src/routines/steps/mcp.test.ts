import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { RoutineSpec, RoutineStep } from "@npi-deck/protocol";

import { loadBackend, resolveBackendSelection, sdk } from "../../backend/runtime.ts";
import { closeDb, openDb } from "../../db/index.ts";
import { listStepRuns } from "../../db/routine-step-runs.ts";
import { createV1Routine, listRuns, updateRoutine } from "../../db/routines.ts";
import { REDACTED } from "../../mcp-secrets.ts";
import { initializeOwnedGeneration, stopOwnedProcesses } from "../../owned-process.ts";
import { RoutinesRunner } from "../../routines-runner.ts";
import type { RunContext } from "../types.ts";
import { executeMcpStep } from "./mcp.ts";

const root = mkdtempSync(path.join(tmpdir(), "deck-mcp-step-test-"));
if (!process.env.PI_CODING_AGENT_DIR) process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const selection = resolveBackendSelection();
if (!selection) throw new Error("mcp step tests require a configured NeoPi backend");
await loadBackend(selection);
// NeoPi fixes its agent dir at first load; whichever test file got there first, it must be temporary.
if (!sdk().getAgentDir().startsWith(tmpdir())) throw new Error(`refusing to run against a non-temporary agent dir: ${sdk().getAgentDir()}`);

const fixture = path.join(import.meta.dir, "mcp-test-server.ts");
/** A workspace whose project `.omp/mcp.json` defines the fake server; `elsewhere` defines none. */
const project = path.join(root, "project");
const elsewhere = path.join(root, "elsewhere");
const events = path.join(root, "events.jsonl");
const offEvents = path.join(root, "off-events.jsonl");
// The config names an env variable; NeoPi resolves it, so this value exists only in the resolved config.
const ENV_SECRET = "tok-env-secret-456";
const ARG_SECRET = "sk-argv-secret-123";
process.env.MCP_STEP_TEST_TOKEN = ENV_SECRET;

mkdirSync(path.join(project, ".omp"), { recursive: true });
mkdirSync(elsewhere, { recursive: true });
writeFileSync(path.join(project, ".omp", "mcp.json"), JSON.stringify({
	mcpServers: {
		fake: {
			type: "stdio",
			command: process.execPath,
			args: [fixture, events, "--api-key", ARG_SECRET],
			env: { FAKE_TOKEN: "MCP_STEP_TEST_TOKEN" },
		},
		off: { type: "stdio", command: process.execPath, args: [fixture, offEvents], enabled: false },
	},
}));

afterAll(() => {
	delete process.env.MCP_STEP_TEST_TOKEN;
	rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
	rmSync(events, { force: true });
	rmSync(offEvents, { force: true });
});

type McpStep = Extract<RoutineStep, { type: "mcp" }>;
const step = (tool: string, args?: Record<string, unknown>, server = "fake"): McpStep =>
	({ id: "call", type: "mcp", server, tool, ...(args ? { args } : {}) });
const context = (): RunContext => ({
	run: { id: "run-1", started: "", iso_started: "", date: "2026-09-29", trigger_kind: "manual" },
	trigger: { word: "hi" },
	steps: {},
	env: {},
	secrets: {},
	state: { n: 2 },
});
const run = (s: McpStep, cwd = project, signal = new AbortController().signal) => executeMcpStep(s, context(), signal, cwd);
const logged = (file = events): Array<Record<string, unknown>> =>
	existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const calls = () => logged().filter(event => event.event === "call");

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
async function waitFor(check: () => boolean, ms = 5_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline) await Bun.sleep(25);
	return check();
}
/** Every server this suite started has exited. */
function serversGone(): boolean {
	return logged().filter(event => event.event === "start").every(event => !alive(event.pid as number));
}

test("templated args reach the tool with their types; text and structured result land in the step", async () => {
	const result = await run(step("echo", { text: "{{ trigger.word }}", times: "{{ state.n }}" }));
	expect(result.error).toBeUndefined();
	expect(result.status).toBe("success");
	expect(result.stdoutExcerpt).toBe("hi hi");
	expect(result.json).toEqual({ content: [{ type: "text", text: "hi hi" }], structuredContent: { echoed: "hi hi" } });
	expect(calls()).toEqual([{ event: "call", name: "echo", arguments: { text: "hi", times: 2 } }]);
	expect(await waitFor(serversGone)).toBe(true);
});

test("args that break the tool's input schema fail the step before anything is sent", async () => {
	const result = await run(step("echo", { times: 0, extra: true }));
	expect(result.status).toBe("failed");
	expect(result.error).toStartWith("args for fake/echo does not match schema:");
	expect(result.error).toContain("text");
	expect(calls()).toEqual([]);
});

test("a server that is not configured, or is disabled, for the routine's cwd is refused by name", async () => {
	const unknown = await run(step("echo", { text: "x" }, "nope"));
	expect(unknown.status).toBe("failed");
	expect(unknown.error).toContain("MCP server 'nope' is not configured, or is disabled");
	expect(unknown.error).toContain("Available: fake");

	const disabled = await run(step("echo", { text: "x" }, "off"));
	expect(disabled.status).toBe("failed");
	expect(disabled.error).toContain("MCP server 'off' is not configured, or is disabled");
	expect(existsSync(offEvents)).toBe(false);

	// Discovery follows the routine's cwd: the project server is not visible from another workspace.
	const otherCwd = await run(step("echo", { text: "x" }), elsewhere);
	expect(otherCwd.status).toBe("failed");
	expect(otherCwd.error).toContain("MCP server 'fake' is not configured, or is disabled");
	expect(existsSync(events)).toBe(false);
});

test("an unknown tool fails with the tools the server does offer", async () => {
	const result = await run(step("nope"));
	expect(result.status).toBe("failed");
	expect(result.error).toContain("MCP server 'fake' has no tool 'nope'. Tools: echo, leak, fail, hang, picture, odd-schema");
});

test("isError fails the step with the tool's own text, still recording the result", async () => {
	const result = await run(step("fail"));
	expect(result.status).toBe("failed");
	expect(result.error).toStartWith("denied for ");
	expect(result.json).toMatchObject({ isError: true });
});

test("config credentials never reach step output, even when the server echoes them", async () => {
	const leak = await run(step("leak"));
	const fail = await run(step("fail"));
	expect(leak.status).toBe("success");
	for (const result of [leak, fail]) {
		const recorded = JSON.stringify(result);
		expect(recorded).not.toContain(ENV_SECRET);
		expect(recorded).not.toContain(ARG_SECRET);
		expect(recorded).toContain(REDACTED);
	}
	expect(leak.json).toMatchObject({ structuredContent: { token: REDACTED, argv: ["--api-key", REDACTED] } });
});

test("a schema Ajv cannot compile does not block the call; stderr says validation was skipped", async () => {
	const result = await run(step("odd-schema", { value: 1 }));
	expect(result.status).toBe("success");
	expect(result.stdoutExcerpt).toBe('odd {"value":1}');
	expect(result.stderrExcerpt).toContain("args for fake/odd-schema schema could not be compiled");
	expect(result.stderrExcerpt).toContain("args were not validated locally");
});

test("binary content is recorded by size, not as base64", async () => {
	const result = await run(step("picture"));
	expect(result.status).toBe("success");
	expect(result.stdoutExcerpt).toBe("a picture");
	expect(result.json).toEqual({
		content: [
			{ type: "image", mimeType: "image/png", dataOmitted: "4096 base64 characters" },
			{ type: "text", text: "a picture" },
		],
	});
});

test("aborting a call in flight reports aborted and stops the server process", async () => {
	const abort = new AbortController();
	const pending = run(step("hang"), project, abort.signal);
	expect(await waitFor(() => calls().length === 1)).toBe(true);
	abort.abort();
	const result = await pending;
	expect(result.status).toBe("aborted");
	expect(await waitFor(serversGone)).toBe(true);
});

// Through the runner: `steps.<id>` feeds the next step, and the step timeout ends a stuck call.
let home = "";
let runner: RoutinesRunner | undefined;
function routineIn(cwd: string, steps: RoutineSpec["steps"]) {
	home = mkdtempSync(path.join(root, "home-"));
	process.env.NPI_DECK_HOME = home;
	openDb({ path: path.join(home, "deck.db") });
	initializeOwnedGeneration();
	runner = new RoutinesRunner();
	const spec = { version: 1, name: "mcp", trigger: [{ manual: {} }], steps, concurrency: "skip" } as RoutineSpec;
	const created = createV1Routine({ name: `mcp-${crypto.randomUUID()}`, spec, specYaml: JSON.stringify(spec) });
	updateRoutine(created.id, { actionCwd: cwd });
	return created;
}
afterEach(async () => {
	if (!runner) return;
	await runner.dispose();
	await stopOwnedProcesses();
	closeDb();
	delete process.env.NPI_DECK_HOME;
	runner = undefined;
});

test("a routine run records the call and hands its result to the next step", async () => {
	const out = path.join(root, "after.txt");
	const routine = routineIn(project, [
		{ id: "call", type: "mcp", server: "fake", tool: "echo", args: { text: "from-mcp" } },
		{ id: "after", type: "run", command: `printf '%s' '{{ steps.call.json.structuredContent.echoed }}' > '${out}'` },
	]);
	await runner!.fire(routine.id);
	const [latest] = listRuns(routine.id);
	expect(latest?.abortReason).toBeUndefined();
	expect(latest?.exitCode).toBe(0);
	const [call] = listStepRuns(latest!.id);
	expect(call?.status).toBe("success");
	expect(call?.stdoutExcerpt).toBe("from-mcp");
	expect(readFileSync(out, "utf8")).toBe("from-mcp");
});

test("the step timeout ends a stuck call, records a timeout and leaves no server behind", async () => {
	const routine = routineIn(project, [{ id: "stuck", type: "mcp", server: "fake", tool: "hang", timeout_secs: 1 }]);
	const started = Date.now();
	await runner!.fire(routine.id);
	expect(Date.now() - started).toBeLessThan(5_000);
	const [latest] = listRuns(routine.id);
	expect(latest?.abortReason).toBe("timeout");
	expect(listStepRuns(latest!.id)[0]?.status).toBe("aborted");
	expect(await waitFor(serversGone)).toBe(true);
});
