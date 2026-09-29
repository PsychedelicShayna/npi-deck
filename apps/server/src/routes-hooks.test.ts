import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RoutineSpec } from "@npi-deck/protocol";
import { closeDb, openDb } from "./db/index.ts";
import { upsertWebhookSecret } from "./db/routine-step-runs.ts";
import { createV1Routine, listRuns } from "./db/routines.ts";
import { initializeOwnedGeneration, stopOwnedProcesses } from "./owned-process.ts";
import { buildHooksRouter, hashSecretForStorage } from "./routes-hooks.ts";
import { RoutinesRunner } from "./routines-runner.ts";

const SECRET = "hook-secret";
let home = "";
let runner: RoutinesRunner | undefined;

afterEach(async () => {
	await runner?.dispose();
	await stopOwnedProcesses();
	closeDb();
	if (home) fs.rmSync(home, { recursive: true, force: true });
	home = ""; runner = undefined;
});

function setup(enabled: boolean) {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "npi-deck-hooks-route-"));
	openDb({ path: path.join(home, "deck.db") });
	initializeOwnedGeneration();
	runner = new RoutinesRunner();
	const marker = path.join(home, "fired");
	const hookPath = `/hooks/test-${crypto.randomUUID()}`;
	const spec = {
		version: 1, name: "hooked", concurrency: "skip",
		trigger: [{ webhook: { path: hookPath, secret_env: "HOOK_SECRET" } }],
		steps: [{ id: "write", type: "run", command: `echo yes > '${marker}'` }],
	} as RoutineSpec;
	const routine = createV1Routine({ name: `hooked-${crypto.randomUUID()}`, spec, specYaml: JSON.stringify(spec), enabled });
	expect(upsertWebhookSecret({ routineId: routine.id, path: hookPath, secretHash: hashSecretForStorage(SECRET) })).toBe(true);
	const app = buildHooksRouter(runner);
	const deliver = (signature = SECRET) => app.request(hookPath, {
		method: "POST",
		headers: { "content-type": "application/json", "x-routine-signature": signature },
		body: JSON.stringify({ key: "value" }),
	});
	return { routine, marker, deliver };
}

async function waitFor(check: () => boolean, ms = 3000): Promise<boolean> {
	for (let waited = 0; waited < ms && !check(); waited += 25) await Bun.sleep(25);
	return check();
}

test("a signed webhook for a disabled routine is refused with 409 and runs nothing", async () => {
	const { routine, marker, deliver } = setup(false);
	const response = await deliver();
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "routine disabled" });
	await Bun.sleep(300);
	expect(fs.existsSync(marker)).toBe(false);
	expect(listRuns(routine.id)).toHaveLength(0);
});

test("a disabled routine still answers a bad signature with 401, not its enabled state", async () => {
	const { deliver } = setup(false);
	expect((await deliver("wrong")).status).toBe(401);
});

test("a signed webhook for an enabled routine is accepted and runs", async () => {
	const { routine, marker, deliver } = setup(true);
	const response = await deliver();
	expect(response.status).toBe(202);
	expect(await waitFor(() => listRuns(routine.id)[0]?.endedAt !== undefined)).toBe(true);
	expect(fs.readFileSync(marker, "utf8").trim()).toBe("yes");
	expect(JSON.parse(listRuns(routine.id)[0]!.triggerPayload!)).toEqual({ key: "value" });
});
