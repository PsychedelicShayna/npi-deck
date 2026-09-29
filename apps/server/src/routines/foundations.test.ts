import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RoutineSpec } from "@npi-deck/protocol";
import { openDb, closeDb, getDb } from "../db/index.ts";
import { listStepRuns } from "../db/routine-step-runs.ts";
import { createRoutine, createV1Routine, getRoutine, listRuns, updateV1Routine } from "../db/routines.ts";
import { RoutinesRunner } from "../routines-runner.ts";
import { initializeOwnedGeneration, stopOwnedProcesses } from "../owned-process.ts";

const root = "/home/shayna/tmp";
let home = "";
let runner: RoutinesRunner | undefined;
function setup(agentCommand?: () => string[]): void {
	fs.mkdirSync(root, { recursive: true });
	home = fs.mkdtempSync(path.join(root, "npi-routine-test-"));
	process.env.NPI_DECK_HOME = home;
	process.env.NPI_DECK_DB_PATH = path.join(home, "deck.db");
	openDb({ path: process.env.NPI_DECK_DB_PATH });
	initializeOwnedGeneration();
	runner = agentCommand ? new RoutinesRunner(agentCommand) : new RoutinesRunner();
}
function routine(spec: RoutineSpec, enabled = true) {
	return createV1Routine({ name: `test-${crypto.randomUUID()}`, spec, specYaml: JSON.stringify(spec), enabled });
}
function spec(steps: RoutineSpec["steps"], concurrency: RoutineSpec["concurrency"] = "skip"): RoutineSpec {
	return { version: 1, name: "test", trigger: [{ manual: {} }], steps, concurrency } as RoutineSpec;
}
afterEach(async () => {
	await runner?.dispose();
	await stopOwnedProcesses();
	closeDb();
	delete process.env.NPI_DECK_HOME;
	delete process.env.NPI_DECK_DB_PATH;
	if (home) fs.rmSync(home, { recursive: true, force: true });
	home = ""; runner = undefined;
});

test("queue holds second invocation until first finishes, then releases the busy state", async () => {
	setup();
	const marker = path.join(home, "marker");
	const release = path.join(home, "release");
	const r = routine(spec([{ id: "wait", type: "run", command: `echo start >> '${marker}'; until test -f '${release}'; do sleep .05; done; echo end >> '${marker}'` }], "queue"));
	const first = runner!.fire(r.id);
	for (let i = 0; i < 60 && !fs.existsSync(marker); i++) await Bun.sleep(25);
	expect(fs.existsSync(marker)).toBe(true);
	const second = runner!.fire(r.id);
	await Bun.sleep(80);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["start"]);
	expect(runner!.workSnapshot).toHaveLength(2);
	fs.writeFileSync(release, "");
	await Promise.all([first, second]);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["start", "end", "start", "end"]);
	expect(runner!.busy).toBe(false);
});

test("deadline kills shell grandchild and records timeout", async () => {
	setup();
	const pidFile = path.join(home, "grandchild.pid");
	const r = routine(spec([{ id: "slow", type: "run", timeout_secs: 1, command: `sleep 30 & echo $! > '${pidFile}'; wait` }]));
	const start = Date.now();
	await runner!.fire(r.id);
	expect(Date.now() - start).toBeLessThan(4000);
	const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
	await Bun.sleep(100);
	const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="], { stdout: "pipe", stderr: "ignore" });
	const status = new TextDecoder().decode(ps.stdout).trim();
	// PID 1 may take a moment to reap a killed child; a zombie has no executable process.
	expect(status === "" || status.startsWith("Z")).toBe(true);
	expect(listRuns(r.id)[0]?.abortReason).toBe("timeout");
});

test("run-duration budget preempts a longer step deadline and its child group", async () => {
	setup();
	const pidFile = path.join(home, "budget-grandchild.pid");
	const s = spec([{ id: "slow", type: "run", timeout_secs: 20,
		command: `sleep 30 & echo $! > '${pidFile}'; wait` }]);
	s.budget = { max_duration_secs: 1 };
	const r = routine(s);
	const start = Date.now();
	await runner!.fire(r.id);
	expect(Date.now() - start).toBeLessThan(4000);
	const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
	const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="], { stdout: "pipe", stderr: "ignore" });
	const status = new TextDecoder().decode(ps.stdout).trim();
	expect(status === "" || status.startsWith("Z")).toBe(true);
	expect(listRuns(r.id)[0]?.abortReason).toBe("timeout");
});

test("disabled webhook does not execute, successful webhook persists payload", async () => {
	setup();
	const marker = path.join(home, "webhook");
	const s = spec([{ id: "write", type: "run", command: `echo yes > '${marker}'` }]);
	const disabled = routine(s, false);
	await runner!.fire(disabled.id, "webhook", { key: "forbidden" });
	expect(fs.existsSync(marker)).toBe(false);
	expect(listRuns(disabled.id)).toHaveLength(0);
	const enabled = routine(s);
	await runner!.fire(enabled.id, "webhook", { key: "accepted" });
	expect(fs.readFileSync(marker, "utf8").trim()).toBe("yes");
	expect(JSON.parse(listRuns(enabled.id)[0]!.triggerPayload!)).toEqual({ key: "accepted" });
});

test("disabled routine ignores cron and event triggers but still runs manually", async () => {
	setup();
	const marker = path.join(home, "disabled");
	const r = routine(spec([{ id: "write", type: "run", command: `echo ran >> '${marker}'` }]), false);
	for (const trigger of ["cron", "event"] as const) await runner!.fire(r.id, trigger, { source: "deck_inbox" });
	expect(fs.existsSync(marker)).toBe(false);
	expect(listRuns(r.id)).toHaveLength(0);
	await runner!.fire(r.id, "manual", { key: "by-hand" });
	expect(fs.existsSync(marker)).toBe(true);
	expect(listRuns(r.id).map((run) => run.trigger)).toEqual(["manual"]);
});

test("abort and continue run only once despite a retained retry block", async () => {
	setup();
	for (const mode of ["abort", "continue"] as const) {
		const attemptsFile = path.join(home, `attempts-${mode}`);
		const nextFile = path.join(home, `next-${mode}`);
		const r = routine(spec([
			{ id: "fail", type: "run", command: `echo attempted >> '${attemptsFile}'; exit 7`,
				on_failure: mode, retry: { times: 3, backoff: "linear", max_delay_secs: 0 } },
			{ id: "next", type: "run", command: `echo reached > '${nextFile}'` },
		]));
		await runner!.fire(r.id);
		expect(fs.readFileSync(attemptsFile, "utf8").trim().split("\n")).toEqual(["attempted"]);
		expect(fs.existsSync(nextFile)).toBe(mode === "continue");
		const run = listRuns(r.id)[0]!;
		expect(listStepRuns(run.id).map(attempt => [attempt.stepId, attempt.attempt, attempt.status])).toEqual(
			mode === "continue" ? [["fail", 1, "failed"], ["next", 1, "success"]] : [["fail", 1, "failed"]],
		);
		expect(run.abortReason).toBe(mode === "abort" ? "failure" : undefined);
	}
});

test("continue ignores retry policy and cancellation during retry backoff prevents next attempt", async () => {
	setup();
	const marker = path.join(home, "attempts");
	const r = routine(spec([{ id: "fail", type: "run", command: `echo attempt >> '${marker}'; exit 7`, retry: { times: 3, backoff: "linear", max_delay_secs: 1 }, on_failure: "continue" }]));
	await runner!.fire(r.id);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
	const retry = routine(spec([{ id: "fail", type: "run", command: `echo attempt >> '${marker}'; exit 7`, retry: { times: 3, backoff: "linear", max_delay_secs: 2 }, on_failure: "retry" }]));
	const running = runner!.fire(retry.id);
	for (let i = 0; i < 40 && fs.readFileSync(marker, "utf8").trim().split("\n").length < 2; i++) await Bun.sleep(25);
	await runner!.dispose();
	await running;
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(2);
	expect(listRuns(retry.id)[0]?.abortReason).toBe("cancelled");
});

test("multi-cron next run remains the earliest after a manual run", async () => {
	setup();
	const s = spec([{ id: "fast", type: "run", command: "true" }]);
	s.trigger = [{ cron: "0 0 1 1 *" }, { cron: "* * * * *" }];
	const r = routine(s);
	runner!.schedule(r);
	const before = getRoutine(r.id)?.nextRunAt;
	expect(before).toBeDefined();
	expect(new Date(before!).getTime() - Date.now()).toBeLessThan(61_000);
	await runner!.fire(r.id);
	const after = getRoutine(r.id)?.nextRunAt;
	expect(after).toBeDefined();
	expect(new Date(after!).getTime() - Date.now()).toBeLessThan(61_000);
});

test("disabling a cron routine clears next run, and a manual run while disabled does not restore it", async () => {
	setup();
	const s = spec([{ id: "fast", type: "run", command: "true" }]);
	s.trigger = [{ cron: "* * * * *" }];
	const r = routine(s);
	runner!.schedule(r);
	expect(getRoutine(r.id)?.nextRunAt).toBeDefined();
	runner!.schedule(updateV1Routine(r.id, { enabled: false })!);
	expect(getRoutine(r.id)?.nextRunAt).toBeUndefined();
	await runner!.fire(r.id, "manual");
	const after = getRoutine(r.id)!;
	expect(after.lastRunAt).toBeDefined();
	expect(after.nextRunAt).toBeUndefined();
});

test("legacy shell routines also queue before spawning and drain on shutdown", async () => {
	setup();
	const marker = path.join(home, "legacy");
	const release = path.join(home, "release");
	const r = createRoutine({ name: "legacy", cron: "", actionKind: "bash",
		actionBody: `echo start >> '${marker}'; until test -f '${release}'; do sleep .05; done; echo end >> '${marker}'` });
	getDb().prepare("UPDATE routines SET concurrency = 'queue' WHERE id = ?").run(r.id);
	const first = runner!.fire(r.id);
	for (let i = 0; i < 60 && !fs.existsSync(marker); i++) await Bun.sleep(25);
	expect(fs.existsSync(marker)).toBe(true);
	const second = runner!.fire(r.id);
	await Bun.sleep(80);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["start"]);
	fs.writeFileSync(release, "");
	await Promise.all([first, second]);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["start", "end", "start", "end"]);
	expect(runner!.busy).toBe(false);
});

test("skip leaves only the admitted run executing; parallel admits both", async () => {
	setup();
	const marker = path.join(home, "modes");
	const release = path.join(home, "release");
	const command = `echo start >> '${marker}'; until test -f '${release}'; do sleep .05; done; echo end >> '${marker}'`;
	const skip = routine(spec([{ id: "hold", type: "run", command }], "skip"));
	const first = runner!.fire(skip.id);
	for (let i = 0; i < 60 && !fs.existsSync(marker); i++) await Bun.sleep(25);
	await runner!.fire(skip.id);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["start"]);
	expect(listRuns(skip.id).some((run) => run.abortReason === "concurrency_skipped")).toBe(true);
	fs.writeFileSync(release, "");
	await first;
	fs.unlinkSync(release);
	fs.writeFileSync(marker, "");
	const parallel = routine(spec([{ id: "hold", type: "run", command }], "parallel"));
	const a = runner!.fire(parallel.id);
	const b = runner!.fire(parallel.id);
	for (let i = 0; i < 80 && fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).length < 2; i++) await Bun.sleep(25);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["start", "start"]);
	fs.writeFileSync(release, "");
	await Promise.all([a, b]);
	expect(runner!.busy).toBe(false);
});

test("cancel-previous kills the running child before the replacement finishes", async () => {
	setup();
	const marker = path.join(home, "cancel");
	const release = path.join(home, "release");
	const r = routine(spec([{ id: "hold", type: "run",
		command: `echo start >> '${marker}'; until test -f '${release}'; do sleep .05; done; echo end >> '${marker}'`,
	}], "cancel-previous"));
	const first = runner!.fire(r.id);
	for (let i = 0; i < 60 && !fs.existsSync(marker); i++) await Bun.sleep(25);
	expect(fs.existsSync(marker)).toBe(true);
	fs.writeFileSync(release, "");
	const second = runner!.fire(r.id);
	await Promise.all([first, second]);
	const lines = fs.readFileSync(marker, "utf8").trim().split("\n");
	expect(lines.filter((line) => line === "start")).toHaveLength(2);
	expect(listRuns(r.id).some((run) => run.abortReason === "cancelled")).toBe(true);
	expect(runner!.busy).toBe(false);
});

test("agent retry charges failed and successful attempts, and stops before the next attempt on budget excess", async () => {
	setup(() => [process.execPath, path.join(home, "backend/packages/coding-agent/src/cli.ts")]);
	const backend = path.join(home, "backend");
	const cli = path.join(backend, "packages/coding-agent/src/cli.ts");
	const counter = path.join(home, "attempts");
	const failUntil = path.join(home, "fail-until");
	fs.writeFileSync(failUntil, "1");
	fs.mkdirSync(path.dirname(cli), { recursive: true });
	fs.writeFileSync(cli, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const file = ${JSON.stringify(counter)};
const attempt = existsSync(file) ? Number(readFileSync(file, "utf8")) + 1 : 1;
writeFileSync(file, String(attempt));
const message = { role: "assistant", timestamp: attempt, model: "test", content: [{type:"text",text:"answer"}],
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: {total: 0.001} } };
process.stdout.write(JSON.stringify({type:"message_end", message}) + "\\n" +
  JSON.stringify({type:"agent_end", messages:[message]}) + "\\n");
if (attempt <= Number(readFileSync(${JSON.stringify(failUntil)}, "utf8"))) process.exitCode = 1;
`);
	const s = spec([{ id: "agent", type: "agent", prompt: "answer", on_failure: "retry",
		retry: { times: 2, backoff: "linear", max_delay_secs: 0 } }]);
	s.budget = { max_llm_cost_usd: 0.0015 };
	const r = routine(s);
	await runner!.fire(r.id);
	const run = listRuns(r.id)[0]!;
	const attempts = listStepRuns(run.id);
	expect(attempts.map(attempt => attempt.status)).toEqual(["failed", "success"]);
	expect(run.abortReason).toBe("budget");
	expect(run.totalLlmCostMicros).toBe(2000);
	expect(run.totalLlmTokens).toBe(30);
	fs.writeFileSync(counter, "0");
	fs.writeFileSync(failUntil, "2");
	const tokenSpec = spec([{ id: "agent", type: "agent", prompt: "answer", on_failure: "retry",
		retry: { times: 3, backoff: "linear", max_delay_secs: 0 } }]);
	tokenSpec.budget = { max_llm_tokens_input: 15 };
	const tokenRun = routine(tokenSpec);
	await runner!.fire(tokenRun.id);
	const stopped = listRuns(tokenRun.id)[0]!;
	expect(listStepRuns(stopped.id).map(attempt => attempt.status)).toEqual(["failed", "failed"]);
	expect(fs.readFileSync(counter, "utf8")).toBe("2");
	expect(stopped.abortReason).toBe("budget");
	expect(stopped.totalLlmCostMicros).toBe(2000);
	expect(stopped.totalLlmTokens).toBe(30);
}, 20_000);

test("a routine pins its agent backend before the first agent step", async () => {
	let selections = 0;
	const command = () => [process.execPath, path.join(home, ++selections === 1 ? "backend-a" : "backend-b", "cli.ts")];
	setup(command);
	const marker = path.join(home, "agents");
	for (const name of ["backend-a", "backend-b"]) {
		const cli = path.join(home, name, "cli.ts");
		fs.mkdirSync(path.dirname(cli), { recursive: true });
		fs.writeFileSync(cli, `
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name + "\n")});
const message = { role: "assistant", timestamp: 1, model: "test",
  content: [{type: "text", text: "answer"}],
  usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: {total: 0.001}} };
process.stdout.write(JSON.stringify({type: "agent_end", messages: [message]}) + "\\n");
`);
	}
	const r = routine(spec([
		{ id: "first", type: "agent", prompt: "one" },
		{ id: "second", type: "agent", prompt: "two" },
	]));
	await runner!.fire(r.id);
	const run = listRuns(r.id)[0]!;
	expect(listStepRuns(run.id).map((step) => step.status)).toEqual(["success", "success"]);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["backend-a", "backend-a"]);
	expect(selections).toBe(1);
	expect(run.backend).toEqual({ path: path.join(home, "backend-a", "cli.ts"), commit: null, version: null });
	const deckOnly = routine(spec([{ id: "local", type: "run", command: "true" }]));
	await runner!.fire(deckOnly.id);
	expect(listRuns(deckOnly.id)[0]?.backend).toBeUndefined();
});
