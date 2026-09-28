import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RoutineSpec } from "@npi-deck/protocol";
import { openDb, closeDb } from "../db/index.ts";
import { createV1Routine, listRuns } from "../db/routines.ts";
import { RoutinesRunner } from "../routines-runner.ts";
import { initializeOwnedGeneration, stopOwnedProcesses } from "../owned-process.ts";

const root = "/home/shayna/tmp";
let home = "";
let runner: RoutinesRunner | undefined;
function setup(): void {
	fs.mkdirSync(root, { recursive: true });
	home = fs.mkdtempSync(path.join(root, "npi-routine-test-"));
	process.env.NPI_DECK_HOME = home;
	process.env.NPI_DECK_DB_PATH = path.join(home, "deck.db");
	openDb({ path: process.env.NPI_DECK_DB_PATH });
	initializeOwnedGeneration();
	runner = new RoutinesRunner();
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
	const status = fs.existsSync(`/proc/${pid}/stat`) ? fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] : undefined;
	expect(status === undefined || status === "Z").toBe(true);
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
