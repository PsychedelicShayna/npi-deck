/**
 * Webhook receiver for V1 routine triggers. Mounted at `/hooks/*` on the
 * main router. Looks up the routine by path slug, verifies the presented
 * secret against the stored sha256 hash, and fires the routine.
 *
 * A disabled routine refuses correctly signed deliveries with 409 Conflict:
 * the request is valid, but the routine's current state forbids running it,
 * and the sender can retry once the routine is enabled again. The signature
 * is checked first so an unauthenticated caller cannot probe that state.
 *
 * Security note (V1 local-only): the deck has no user auth and runs loopback-
 * only. Webhook secret verification is sha256-hash-compare via timing-safe
 * comparison; sufficient for V1's threat model. Managed hosting (Layer 2)
 * upgrades to argon2id + per-request body HMAC.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { Hono } from "hono";

import { getWebhookSecretByPath, insertAbortedRun, touchWebhookSecret } from "./db/routine-step-runs.ts";
import { getRoutine } from "./db/routines.ts";
import { logger } from "./log.ts";
import type { RoutinesRunner } from "./routines-runner.ts";

const log = logger("routes:hooks");

const SIG_HEADER = "x-routine-signature";

export function buildHooksRouter(runner: RoutinesRunner): Hono {
	const app = new Hono();

	app.all("/hooks/*", async (c) => {
		const path = c.req.path; // e.g. /hooks/inbox-triager-manual
		const record = getWebhookSecretByPath(path);
		if (!record) {
			return c.json({ error: "hook not registered" }, 404);
		}

		const presented = c.req.header(SIG_HEADER) ?? "";
		if (!verifySecret(presented, record.secret_hash)) {
			insertAbortedRun({
				routineId: record.routine_id,
				triggerKind: "webhook",
				// Header names only: any value, `user-agent` included, may carry a credential.
				triggerPayload: { path, headers: Object.keys(c.req.header()).map((name) => name.toLowerCase()).sort() },
				abortReason: "signature_invalid",
				error: `bad ${SIG_HEADER} on ${path}`,
			});
			return c.json({ error: "signature invalid" }, 401);
		}

		// Parse body as JSON when possible; otherwise pass through as raw string.
		let payload: Record<string, unknown> = {};
		const ct = c.req.header("content-type") ?? "";
		try {
			if (ct.includes("application/json")) {
				const json = await c.req.json();
				payload = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : { body: json };
			} else {
				const text = await c.req.text();
				payload = { body: text };
			}
		} catch {
			payload = { body: "<unparsable>" };
		}

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

		touchWebhookSecret(record.routine_id);
		// Fire async; webhook returns 202 immediately.
		void runner.fire(record.routine_id, "webhook", payload).catch((err) => {
			log.warn(`webhook fire failed for ${record.routine_id}`, err);
		});
		return c.json({ ok: true, accepted: true }, 202);
	});

	return app;
}

function verifySecret(presented: string, storedHash: string): boolean {
	if (!presented) return false;
	const presentedHash = createHash("sha256").update(presented).digest("hex");
	if (presentedHash.length !== storedHash.length) return false;
	try {
		return timingSafeEqual(Buffer.from(presentedHash, "hex"), Buffer.from(storedHash, "hex"));
	} catch {
		return false;
	}
}

export function hashSecretForStorage(plain: string): string {
	return createHash("sha256").update(plain).digest("hex");
}
