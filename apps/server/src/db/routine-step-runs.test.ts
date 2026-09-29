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

		expect(upsertWebhookSecret({ routineId: "r_one", path: "/hooks/shared", secret: "h1" })).toBe(true);
		expect(upsertWebhookSecret({ routineId: "r_two", path: "/hooks/shared", secret: "h2" })).toBe(false);

		expect(getWebhookSecretByPath("/hooks/shared")?.routine_id).toBe("r_one");
		expect(getWebhookSecretByPath("/hooks/shared")?.signing_key).toBe("h1");
	});

	test("ensure is idempotent on save and does not rotate existing secrets", () => {
		bootDb();
		insertRoutine("r_one");

		expect(ensureWebhookSecret({ routineId: "r_one", path: "/hooks/one", secret: "initial" })).toBe(true);
		expect(ensureWebhookSecret({ routineId: "r_one", path: "/hooks/one", secret: "new-save-secret" })).toBe(true);

		expect(getWebhookSecretByPath("/hooks/one")?.signing_key).toBe("initial");
	});

	test("ensure moves a routine registration to a new free path without changing the secret", () => {
		bootDb();
		insertRoutine("r_one");

		expect(ensureWebhookSecret({ routineId: "r_one", path: "/hooks/old", secret: "initial" })).toBe(true);
		expect(ensureWebhookSecret({ routineId: "r_one", path: "/hooks/new", secret: "ignored" })).toBe(true);

		expect(getWebhookSecretByPath("/hooks/old")).toBeUndefined();
		expect(getWebhookSecretByPath("/hooks/new")?.routine_id).toBe("r_one");
		expect(getWebhookSecretByPath("/hooks/new")?.signing_key).toBe("initial");
	});

	test("delete removes stale registrations when a routine no longer has a webhook trigger", () => {
		bootDb();
		insertRoutine("r_one");

		expect(ensureWebhookSecret({ routineId: "r_one", path: "/hooks/one", secret: "initial" })).toBe(true);
		deleteWebhookSecret("r_one");

		expect(getWebhookSecretByPath("/hooks/one")).toBeUndefined();
	});
});
