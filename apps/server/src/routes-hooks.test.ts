import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ListRoutineRunsResponse, RoutineSpec } from "@npi-deck/protocol";
import { closeDb, openDb } from "./db/index.ts";
import { getWebhookSecretByPath, upsertWebhookSecret } from "./db/routine-step-runs.ts";
import { createV1Routine, deleteRoutine, listRuns, updateV1Routine } from "./db/routines.ts";
import { initializeOwnedGeneration, stopOwnedProcesses } from "./owned-process.ts";
import { buildHooksRouter, hashSecretForStorage } from "./routes-hooks.ts";
import { buildRoutinesRouter } from "./routes-routines.ts";
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
	const deliver = (signature = SECRET, body: string | ReadableStream<Uint8Array> = JSON.stringify({ key: "value" })) => app.request(hookPath, {
		method: "POST",
		headers: { "content-type": "application/json", "x-routine-signature": signature },
		body,
		duplex: "half",
	} as RequestInit);
	return { routine, marker, hookPath, deliver };
}

/**
 * A request body whose bytes are held back until `release()`. `reading`
 * resolves once the receiver starts pulling the body, i.e. after it has
 * passed every check that runs before the body read.
 */
function gatedBody() {
	let started!: () => void;
	let release!: () => void;
	const reading = new Promise<void>((resolve) => { started = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			started();
			await gate;
			controller.enqueue(new TextEncoder().encode(JSON.stringify({ key: "late" })));
			controller.close();
		},
	});
	return { body, reading, release };
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

test("a rejected webhook's run shows which headers arrived but never a credential value", async () => {
	const { routine, hookPath } = setup(true);
	const credentials = ["near-miss-hook-secret", "Bearer sender-token", "session=cookie-value", "api-key-value"];
	const response = await buildHooksRouter(runner!).request(hookPath, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"user-agent": "sender/1.0",
			"x-routine-signature": credentials[0]!,
			authorization: credentials[1]!,
			cookie: credentials[2]!,
			"x-api-key": credentials[3]!,
		},
		body: JSON.stringify({ key: "value" }),
	});
	expect(response.status).toBe(401);
	const runsResponse = await buildRoutinesRouter(runner!).request(`/routines/${routine.id}/runs`);
	const { runs } = await runsResponse.json() as ListRoutineRunsResponse;
	expect(runs).toHaveLength(1);
	expect(runs[0]!.abortReason).toBe("signature_invalid");
	for (const credential of credentials) expect(runs[0]!.triggerPayload).not.toContain(credential);
	expect(JSON.parse(runs[0]!.triggerPayload!)).toEqual({
		path: hookPath,
		headers: {
			"content-type": "application/json",
			"user-agent": "sender/1.0",
			"x-routine-signature": "[redacted]",
			authorization: "[redacted]",
			cookie: "[redacted]",
			"x-api-key": "[redacted]",
		},
	});
});

test("a routine disabled while the webhook body streams is refused with 409 and not marked used", async () => {
	const { routine, marker, hookPath, deliver } = setup(true);
	const { body, reading, release } = gatedBody();
	const pending = deliver(SECRET, body);
	await reading;
	updateV1Routine(routine.id, { enabled: false });
	release();
	const response = await pending;
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "routine disabled" });
	expect(getWebhookSecretByPath(hookPath)?.last_used_at).toBeNull();
	await Bun.sleep(300);
	expect(fs.existsSync(marker)).toBe(false);
	expect(listRuns(routine.id)).toHaveLength(0);
});

test("a routine deleted while the webhook body streams answers 404 like an unregistered hook", async () => {
	const { routine, marker, deliver } = setup(true);
	const { body, reading, release } = gatedBody();
	const pending = deliver(SECRET, body);
	await reading;
	expect(deleteRoutine(routine.id)).toBe(true);
	release();
	const response = await pending;
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({ error: "hook not registered" });
	await Bun.sleep(300);
	expect(fs.existsSync(marker)).toBe(false);
});
