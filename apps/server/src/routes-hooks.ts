/**
 * Webhook receiver for V1 routine triggers. Mounted at `/hooks/*` on the
 * main router. Looks up the routine by path slug, verifies the delivery's
 * signature, and fires the routine.
 *
 * A delivery is signed with two headers:
 *
 *   X-Routine-Timestamp: <unix seconds>
 *   X-Routine-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 *
 * The MAC covers the exact request bytes, so a captured signature cannot
 * carry another body, and the timestamp must be within five minutes of the
 * deck's clock, so a captured delivery cannot be replayed after that. The
 * comparison is constant-time. The timestamp and signature shape are checked
 * before the body is read; the MAC after.
 *
 * Registrations made before signed deliveries (migration 006) also accept
 * the bare secret as X-Routine-Signature until the user turns that off in
 * the routine's Settings tab or rotates the secret. Each such delivery is
 * logged as deprecated and stamped on the registration so the UI can warn.
 *
 * A disabled routine refuses correctly signed deliveries with 409 Conflict:
 * the request is valid, but the routine's current state forbids running it,
 * and the sender can retry once the routine is enabled again. The signature
 * is checked first so an unauthenticated caller cannot probe that state.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { Hono } from "hono";

import {
	getWebhookSecretByPath,
	insertAbortedRun,
	recordWebhookDelivery,
	type WebhookSecretRow,
} from "./db/routine-step-runs.ts";
import { getRoutine } from "./db/routines.ts";
import { logger } from "./log.ts";
import type { RoutinesRunner } from "./routines-runner.ts";

const log = logger("routes:hooks");

const SIG_HEADER = "x-routine-signature";
const TS_HEADER = "x-routine-timestamp";
const SIG_PREFIX = "sha256=";
/** How far X-Routine-Timestamp may be from the deck's clock, either way. */
export const REPLAY_WINDOW_SECS = 5 * 60;

type Credential =
	| { kind: "hmac"; key: string; mac: Buffer; timestamp: string }
	| { kind: "bare"; secret: string };

export function buildHooksRouter(runner: RoutinesRunner): Hono {
	const app = new Hono();

	app.all("/hooks/*", async (c) => {
		const path = c.req.path; // e.g. /hooks/inbox-triager-manual
		const record = getWebhookSecretByPath(path);
		if (!record) {
			return c.json({ error: "hook not registered" }, 404);
		}

		const reject = (reason: string, error = "signature invalid") => {
			insertAbortedRun({
				routineId: record.routine_id,
				triggerKind: "webhook",
				// Header names only: any value, `user-agent` included, may carry a credential.
				triggerPayload: { path, headers: Object.keys(c.req.header()).map((name) => name.toLowerCase()).sort() },
				abortReason: "signature_invalid",
				error: `${reason} on ${path}`,
			});
			return c.json({ error }, 401);
		};

		const credential = readCredential(
			record,
			c.req.header(SIG_HEADER) ?? "",
			c.req.header(TS_HEADER) ?? "",
		);
		if ("rejected" in credential) return reject(credential.rejected, credential.error);

		let raw: Uint8Array;
		try {
			raw = new Uint8Array(await c.req.arrayBuffer());
		} catch {
			return c.json({ error: "body unreadable" }, 400);
		}

		if (credential.kind === "hmac" && !macMatches(credential, raw)) {
			return reject(`bad ${SIG_HEADER}`);
		}

		const payload = parsePayload(raw, c.req.header("content-type") ?? "");

		// Re-read the routine after the body arrives: it may have been disabled
		// or deleted while the body streamed. Everything from here to the
		// runner's own enabled guard in `fire` is synchronous.
		const routine = getRoutine(record.routine_id);
		if (!routine) {
			// Deletion cascades the webhook registration, so answer exactly as a
			// request arriving after the deletion would.
			return c.json({ error: "hook not registered" }, 404);
		}
		if (!routine.enabled) {
			log.info(`refused webhook ${path}: routine ${record.routine_id} is disabled`);
			return c.json({ error: "routine disabled" }, 409);
		}

		if (credential.kind === "bare") {
			log.warn(
				`deprecated: webhook ${path} was authenticated by its bare secret; sign deliveries with ${SIG_HEADER}: sha256=<HMAC> and ${TS_HEADER}`,
			);
		}
		recordWebhookDelivery(record.routine_id, credential.kind === "bare" ? credential.secret : undefined);
		// Fire async; webhook returns 202 immediately.
		void runner.fire(record.routine_id, "webhook", payload).catch((err) => {
			log.warn(`webhook fire failed for ${record.routine_id}`, err);
		});
		return c.json({ ok: true, accepted: true }, 202);
	});

	return app;
}

/** Everything that can be checked before the body is read. */
function readCredential(
	record: WebhookSecretRow,
	signature: string,
	timestamp: string,
): Credential | { rejected: string; error?: string } {
	if (signature.startsWith(SIG_PREFIX)) {
		const hex = signature.slice(SIG_PREFIX.length);
		if (!/^[0-9a-fA-F]{64}$/.test(hex)) return { rejected: `malformed ${SIG_HEADER}` };
		if (!/^\d{1,15}$/.test(timestamp)) {
			return { rejected: `missing or malformed ${TS_HEADER}`, error: "timestamp outside replay window" };
		}
		if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > REPLAY_WINDOW_SECS) {
			return { rejected: `${TS_HEADER} outside the replay window`, error: "timestamp outside replay window" };
		}
		// A pre-upgrade registration holds only the secret's hash until its
		// first bare-secret delivery; without the key no MAC can match.
		if (!record.signing_key) return { rejected: `no signing key stored; rotate the secret` };
		return { kind: "hmac", key: record.signing_key, mac: Buffer.from(hex, "hex"), timestamp };
	}
	if (record.accept_bare_secret && bareSecretMatches(signature, record.secret_hash)) {
		return { kind: "bare", secret: signature };
	}
	return { rejected: `bad ${SIG_HEADER}` };
}

function macMatches(credential: { key: string; mac: Buffer; timestamp: string }, raw: Uint8Array): boolean {
	const expected = createHmac("sha256", credential.key).update(`${credential.timestamp}.`).update(raw).digest();
	return timingSafeEqual(expected, credential.mac);
}

function bareSecretMatches(presented: string, storedHash: string): boolean {
	if (!presented) return false;
	const presentedHash = createHash("sha256").update(presented).digest();
	const stored = Buffer.from(storedHash, "hex");
	return stored.length === presentedHash.length && timingSafeEqual(presentedHash, stored);
}

/** JSON bodies become the payload object; anything else is passed as `{ body: text }`. */
function parsePayload(raw: Uint8Array, contentType: string): Record<string, unknown> {
	try {
		const text = new TextDecoder().decode(raw);
		if (!contentType.includes("application/json")) return { body: text };
		const json: unknown = JSON.parse(text);
		return typeof json === "object" && json !== null ? (json as Record<string, unknown>) : { body: json };
	} catch {
		return { body: "<unparsable>" };
	}
}
