import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ListRoutineRunsResponse, RoutineSpec } from "@npi-deck/protocol";
import { closeDb, getDb, openDb } from "./db/index.ts";
import { getWebhookSecretByPath, hashSecretForStorage, upsertWebhookSecret } from "./db/routine-step-runs.ts";
import { createV1Routine, deleteRoutine, listRuns, updateV1Routine } from "./db/routines.ts";
import { initializeOwnedGeneration, stopOwnedProcesses } from "./owned-process.ts";
import { buildHooksRouter } from "./routes-hooks.ts";
import { buildRoutinesRouter } from "./routes-routines.ts";
import { RoutinesRunner } from "./routines-runner.ts";

const SECRET = "hook-secret";
const BODY = JSON.stringify({ key: "value" });
let home = "";
let runner: RoutinesRunner | undefined;

afterEach(async () => {
	await runner?.dispose();
	await stopOwnedProcesses();
	closeDb();
	if (home) fs.rmSync(home, { recursive: true, force: true });
	home = ""; runner = undefined;
});

const nowSecs = () => Math.floor(Date.now() / 1000);

/** Headers a conforming sender computes: HMAC-SHA256(secret, "<ts>.<raw body>"). */
function signed(body: string, secret = SECRET, timestamp = nowSecs()): Record<string, string> {
	const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
	return { "x-routine-signature": `sha256=${mac}`, "x-routine-timestamp": String(timestamp) };
}

/**
 * Put the webhook table back in its pre-HMAC shape and register a hash-only
 * secret there, as a deck from before signed deliveries left it. Reopening the
 * database then runs the upgrade migration over that row.
 */
function registerBeforeUpgrade(dbPath: string, routineId: string, hookPath: string): void {
	const db = getDb();
	db.exec(`
		ALTER TABLE routine_webhook_secrets DROP COLUMN signing_key;
		ALTER TABLE routine_webhook_secrets DROP COLUMN accept_bare_secret;
		ALTER TABLE routine_webhook_secrets DROP COLUMN last_bare_secret_at;
		DELETE FROM schema_migrations WHERE name = '006-webhook-hmac.sql';
	`);
	db.prepare<unknown, [string, string, string, string]>(
		"INSERT INTO routine_webhook_secrets (routine_id, path, secret_hash, created_at) VALUES (?, ?, ?, ?)",
	).run(routineId, hookPath, hashSecretForStorage(SECRET), new Date().toISOString());
	closeDb();
	openDb({ path: dbPath });
}

function setup(enabled: boolean, registration: "current" | "pre-upgrade" = "current") {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "npi-deck-hooks-route-"));
	const dbPath = path.join(home, "deck.db");
	openDb({ path: dbPath });
	initializeOwnedGeneration();
	const marker = path.join(home, "fired");
	const hookPath = `/hooks/test-${crypto.randomUUID()}`;
	const spec = {
		version: 1, name: "hooked", concurrency: "skip",
		trigger: [{ webhook: { path: hookPath, secret_env: "HOOK_SECRET" } }],
		steps: [{ id: "write", type: "run", command: `echo yes > '${marker}'` }],
	} as RoutineSpec;
	const routine = createV1Routine({ name: `hooked-${crypto.randomUUID()}`, spec, specYaml: JSON.stringify(spec), enabled });
	if (registration === "current") {
		expect(upsertWebhookSecret({ routineId: routine.id, path: hookPath, secret: SECRET })).toBe(true);
	} else {
		registerBeforeUpgrade(dbPath, routine.id, hookPath);
	}
	runner = new RoutinesRunner();
	const app = buildHooksRouter(runner);
	const routes = buildRoutinesRouter(runner);
	const deliver = (headers: Record<string, string>, body: string | ReadableStream<Uint8Array> = BODY) => app.request(hookPath, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
		duplex: "half",
	} as RequestInit);
	return { routine, marker, hookPath, deliver, routes };
}

/**
 * A request body whose bytes are held back until `release()`. `reading`
 * resolves once the receiver starts pulling the body, i.e. after it has
 * passed every check that runs before the body read.
 */
const LATE_BODY = JSON.stringify({ key: "late" });
function gatedBody() {
	let started!: () => void;
	let release!: () => void;
	const reading = new Promise<void>((resolve) => { started = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			started();
			await gate;
			controller.enqueue(new TextEncoder().encode(LATE_BODY));
			controller.close();
		},
	});
	return { body, reading, release };
}

async function waitFor(check: () => boolean, ms = 3000): Promise<boolean> {
	for (let waited = 0; waited < ms && !check(); waited += 25) await Bun.sleep(25);
	return check();
}

async function expectRejected(response: Response, routineId: string, marker: string): Promise<void> {
	expect(response.status).toBe(401);
	await Bun.sleep(300);
	expect(fs.existsSync(marker)).toBe(false);
	const runs = listRuns(routineId);
	expect(runs).toHaveLength(1);
	expect(runs[0]!.abortReason).toBe("signature_invalid");
}

test("a delivery signed with HMAC-SHA256 over its timestamp and raw body is accepted and runs", async () => {
	const { routine, marker, hookPath, deliver } = setup(true);
	const response = await deliver(signed(BODY));
	expect(response.status).toBe(202);
	expect(await waitFor(() => listRuns(routine.id)[0]?.endedAt !== undefined)).toBe(true);
	expect(fs.readFileSync(marker, "utf8").trim()).toBe("yes");
	expect(JSON.parse(listRuns(routine.id)[0]!.triggerPayload!)).toEqual({ key: "value" });
	expect(getWebhookSecretByPath(hookPath)?.last_used_at).not.toBeNull();
});

test("the MAC covers the exact raw bytes, not a re-serialization of the JSON", async () => {
	const { routine, deliver } = setup(true);
	const raw = '{ "key" :\n"value" }';
	expect((await deliver(signed(raw), raw)).status).toBe(202);
	expect(await waitFor(() => listRuns(routine.id)[0]?.endedAt !== undefined)).toBe(true);
});

test("a signature over a different body is refused, so a captured signature cannot carry a new payload", async () => {
	const { routine, marker, deliver } = setup(true);
	const headers = signed(BODY);
	await expectRejected(await deliver(headers, JSON.stringify({ key: "tampered" })), routine.id, marker);
});

test("a delivery signed with the wrong secret is refused", async () => {
	const { routine, marker, deliver } = setup(true);
	await expectRejected(await deliver(signed(BODY, "not-the-secret")), routine.id, marker);
});

test("a correctly signed delivery outside the five-minute window is refused as a replay", async () => {
	const { routine, marker, deliver } = setup(true);
	const stale = await deliver(signed(BODY, SECRET, nowSecs() - 301));
	await expectRejected(stale, routine.id, marker);
	expect(await stale.json()).toEqual({ error: "timestamp outside replay window" });
	expect((await deliver(signed(BODY, SECRET, nowSecs() + 301))).status).toBe(401);
});

test("a delivery just inside the replay window is accepted", async () => {
	const { deliver } = setup(true);
	expect((await deliver(signed(BODY, SECRET, nowSecs() - 290))).status).toBe(202);
});

test("a signature without its timestamp header is refused", async () => {
	const { routine, marker, deliver } = setup(true);
	const { "x-routine-timestamp": _dropped, ...headers } = signed(BODY);
	await expectRejected(await deliver(headers), routine.id, marker);
});

test("a timestamp moved into the window does not validate a MAC computed for another timestamp", async () => {
	const { routine, marker, deliver } = setup(true);
	const old = signed(BODY, SECRET, nowSecs() - 3600);
	await expectRejected(await deliver({ ...old, "x-routine-timestamp": String(nowSecs()) }), routine.id, marker);
});

test("a new registration refuses the bare secret as a signature", async () => {
	const { routine, marker, deliver } = setup(true);
	await expectRejected(await deliver({ "x-routine-signature": SECRET }), routine.id, marker);
});

test("a registration from before the upgrade keeps accepting its bare secret and learns it for signed deliveries", async () => {
	const { routine, marker, hookPath, deliver } = setup(true, "pre-upgrade");
	// Before any bare delivery the deck holds only the hash, so it cannot check a MAC yet.
	expect((await deliver(signed(BODY))).status).toBe(401);

	const bare = await deliver({ "x-routine-signature": SECRET });
	expect(bare.status).toBe(202);
	expect(await waitFor(() => fs.existsSync(marker))).toBe(true);
	expect(getWebhookSecretByPath(hookPath)?.last_bare_secret_at).not.toBeNull();
	expect((await deliver({ "x-routine-signature": "wrong" })).status).toBe(401);

	await waitFor(() => listRuns(routine.id).every((r) => r.endedAt !== undefined));
	fs.rmSync(marker);
	expect((await deliver(signed(BODY))).status).toBe(202);
	expect(await waitFor(() => fs.existsSync(marker))).toBe(true);
});

test("turning off the bare secret on an upgraded registration refuses it and keeps signed deliveries", async () => {
	const { routine, deliver, routes } = setup(true, "pre-upgrade");
	expect((await deliver({ "x-routine-signature": SECRET })).status).toBe(202);
	await waitFor(() => listRuns(routine.id)[0]?.endedAt !== undefined);

	const patched = await routes.request(`/routines/${routine.id}/webhook`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ acceptBareSecret: false }),
	});
	expect(patched.status).toBe(200);
	expect(((await patched.json()) as { acceptsBareSecret: boolean }).acceptsBareSecret).toBe(false);

	expect((await deliver({ "x-routine-signature": SECRET })).status).toBe(401);
	expect((await deliver(signed(BODY))).status).toBe(202);
});

test("webhook status reports the migration state without the secret or its hash", async () => {
	const { routine, hookPath, deliver, routes } = setup(true, "pre-upgrade");
	const before = await (await routes.request(`/routines/${routine.id}/webhook`)).json();
	expect(before).toMatchObject({ path: hookPath, acceptsBareSecret: true, signingKeyStored: false, lastBareSecretAt: null });

	expect((await deliver({ "x-routine-signature": SECRET })).status).toBe(202);
	const response = await routes.request(`/routines/${routine.id}/webhook`);
	const text = await response.text();
	expect(text).not.toContain(SECRET);
	expect(text).not.toContain(hashSecretForStorage(SECRET));
	const after = JSON.parse(text);
	expect(after).toMatchObject({ acceptsBareSecret: true, signingKeyStored: true });
	expect(after.lastBareSecretAt).not.toBeNull();
});

test("rotating the secret stops accepting the bare secret and signs with the new one", async () => {
	const { routine, deliver, routes } = setup(true, "pre-upgrade");
	const rotated = (await (await routes.request(`/routines/${routine.id}/webhook-secret/rotate`, { method: "POST" })).json()) as { secret: string };
	expect((await deliver({ "x-routine-signature": SECRET })).status).toBe(401);
	expect((await deliver({ "x-routine-signature": rotated.secret })).status).toBe(401);
	expect((await deliver(signed(BODY, SECRET))).status).toBe(401);
	expect((await deliver(signed(BODY, rotated.secret))).status).toBe(202);
});

test("a signed webhook for a disabled routine is refused with 409 and runs nothing", async () => {
	const { routine, marker, deliver } = setup(false);
	const response = await deliver(signed(BODY));
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "routine disabled" });
	await Bun.sleep(300);
	expect(fs.existsSync(marker)).toBe(false);
	expect(listRuns(routine.id)).toHaveLength(0);
});

test("a disabled routine still answers a bad signature with 401, not its enabled state", async () => {
	const { deliver } = setup(false);
	expect((await deliver(signed(BODY, "wrong"))).status).toBe(401);
});

test("a rejected webhook's run lists which headers arrived but never a header value", async () => {
	const { routine, hookPath } = setup(true);
	const credentials = ["near-miss-hook-secret", "Bearer sender-token", "session=cookie-value", "api-key-value", "ua-embedded-token"];
	const response = await buildHooksRouter(runner!).request(hookPath, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"user-agent": `sender/1.0 (${credentials[4]!})`,
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
		headers: ["authorization", "content-type", "cookie", "user-agent", "x-api-key", "x-routine-signature"],
	});
});

test("a signed delivery refused after its body arrives also stores header names only", async () => {
	const { routine, hookPath, deliver } = setup(true);
	const headers = { ...signed(BODY), authorization: "Bearer sender-token" };
	expect((await deliver(headers, JSON.stringify({ key: "tampered" }))).status).toBe(401);
	const { runs } = await (await buildRoutinesRouter(runner!).request(`/routines/${routine.id}/runs`)).json() as ListRoutineRunsResponse;
	expect(runs).toHaveLength(1);
	for (const value of Object.values(headers)) expect(runs[0]!.triggerPayload).not.toContain(value);
	expect(JSON.parse(runs[0]!.triggerPayload!)).toEqual({
		path: hookPath,
		headers: ["authorization", "content-type", "x-routine-signature", "x-routine-timestamp"],
	});
});

test("a signed webhook's stored body redacts credential keys at any depth and keeps other values", async () => {
	const { routine, marker, deliver } = setup(true);
	const body = JSON.stringify({ access_token: "tok-live-1", key: "value", nested: { Password: "pw-live-2", list: [{ "api-key": "ak-live-3" }] } });
	expect((await deliver(signed(body), body)).status).toBe(202);
	expect(await waitFor(() => listRuns(routine.id)[0]?.endedAt !== undefined)).toBe(true);
	expect(fs.existsSync(marker)).toBe(true);
	const { runs } = await (await buildRoutinesRouter(runner!).request(`/routines/${routine.id}/runs`)).json() as ListRoutineRunsResponse;
	expect(JSON.parse(runs[0]!.triggerPayload!)).toEqual({
		access_token: "[redacted]", key: "value", nested: { Password: "[redacted]", list: [{ "api-key": "[redacted]" }] },
	});
});

test("a routine disabled while the webhook body streams is refused with 409 and not marked used", async () => {
	const { routine, marker, hookPath, deliver } = setup(true);
	const { body, reading, release } = gatedBody();
	const pending = deliver(signed(LATE_BODY), body);
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
	const pending = deliver(signed(LATE_BODY), body);
	await reading;
	expect(deleteRoutine(routine.id)).toBe(true);
	release();
	const response = await pending;
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({ error: "hook not registered" });
	await Bun.sleep(300);
	expect(fs.existsSync(marker)).toBe(false);
});
