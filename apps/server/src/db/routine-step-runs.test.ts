import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, getDb, openDb } from "./index.ts";
import {
	deleteWebhookSecret,
	ensureWebhookSecret,
	getWebhookSecretByPath,
	upsertWebhookSecret,
} from "./routine-step-runs.ts";

let dbDir: string | null = null;

afterEach(() => {
	closeDb();
	if (dbDir) {
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// SQLite handles can lag after close on some platforms; leaking a temp dir
			// is better than making an unrelated test fail.
		}
		dbDir = null;
	}
});

function bootDb(): void {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "npi-deck-webhook-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

function insertRoutine(id: string): void {
	const now = new Date().toISOString();
	getDb()
		.prepare<unknown, [string, string, string, string]>(
			`INSERT INTO routines (id, name, description, cron, action_kind, action_body, created_at, updated_at)
			 VALUES (?, ?, '', '', 'bash', '', ?, ?)`,
		)
		.run(id, id, now, now);
}

describe("routine webhook secrets", () => {
	test("upsert reports path conflicts instead of throwing SQLITE_CONSTRAINT_UNIQUE", () => {
		bootDb();
		insertRoutine("r_one");
		insertRoutine("r_two");

		expect(upsertWebhookSecret({ routineId: "r_one", path: "/hooks/shared", secretHash: "h1" })).toBe(true);
		expect(upsertWebhookSecret({ routineId: "r_two", path: "/hooks/shared", secretHash: "h2" })).toBe(false);

		expect(getWebhookSecretByPath("/hooks/shared")?.routine_id).toBe("r_one");
		expect(getWebhookSecretByPath("/hooks/shared")?.secret_hash).toBe("h1");
	});

	test("ensure is idempotent on save and does not rotate existing secrets", () => {
		bootDb();
		insertRoutine("r_one");

		expect(ensureWebhookSecret({ routineId: "r_one", path: "/hooks/one", secretHash: "initial" })).toBe(true);
		expect(ensureWebhookSecret({ routineId: "r_one", path: "/hooks/one", secretHash: "new-save-secret" })).toBe(true);

		expect(getWebhookSecretByPath("/hooks/one")?.secret_hash).toBe("initial");
	});

	test("ensure moves a routine registration to a new free path without changing the secret", () => {
		bootDb();
		insertRoutine("r_one");

		expect(ensureWebhookSecret({ routineId: "r_one", path: "/hooks/old", secretHash: "initial" })).toBe(true);
		expect(ensureWebhookSecret({ routineId: "r_one", path: "/hooks/new", secretHash: "ignored" })).toBe(true);

		expect(getWebhookSecretByPath("/hooks/old")).toBeUndefined();
		expect(getWebhookSecretByPath("/hooks/new")?.routine_id).toBe("r_one");
		expect(getWebhookSecretByPath("/hooks/new")?.secret_hash).toBe("initial");
	});

	test("delete removes stale registrations when a routine no longer has a webhook trigger", () => {
		bootDb();
		insertRoutine("r_one");

		expect(ensureWebhookSecret({ routineId: "r_one", path: "/hooks/one", secretHash: "initial" })).toBe(true);
		deleteWebhookSecret("r_one");

		expect(getWebhookSecretByPath("/hooks/one")).toBeUndefined();
	});
});
