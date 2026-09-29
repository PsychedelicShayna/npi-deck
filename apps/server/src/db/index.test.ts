import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ensurePrivateDataDir } from "../env-store.ts";
import { closeDb, getDb, openDb } from "./index.ts";

// deck.db holds webhook signing keys, so neither it, its WAL files, nor the
// data dir may be readable by other users.
const mode = (p: string) => fs.statSync(p).mode & 0o777;
let root = "";

afterEach(() => {
	closeDb();
	if (root) fs.rmSync(root, { recursive: true, force: true });
	root = "";
});

describe.skipIf(process.platform === "win32")("private data files", () => {
	test("a new database and its WAL files are created owner-only", () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "npi-deck-db-mode-"));
		const dbPath = path.join(root, "data", "deck.db");
		openDb({ path: dbPath });
		getDb().exec("CREATE TABLE IF NOT EXISTS mode_probe (x); INSERT INTO mode_probe VALUES (1);");

		expect(mode(path.dirname(dbPath))).toBe(0o700);
		expect(mode(dbPath)).toBe(0o600);
		expect(mode(`${dbPath}-wal`)).toBe(0o600);
		expect(mode(`${dbPath}-shm`)).toBe(0o600);
	});

	test("an existing world-readable database and WAL files are narrowed to the owner on open", () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "npi-deck-db-mode-"));
		const dbPath = path.join(root, "deck.db");
		openDb({ path: dbPath });
		getDb().exec("CREATE TABLE IF NOT EXISTS mode_probe (x); INSERT INTO mode_probe VALUES (1);");
		closeDb();
		for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
			if (!fs.existsSync(file)) fs.writeFileSync(file, "");
			fs.chmodSync(file, 0o644);
		}

		openDb({ path: dbPath });

		expect(mode(dbPath)).toBe(0o600);
		expect(mode(`${dbPath}-wal`)).toBe(0o600);
		expect(mode(`${dbPath}-shm`)).toBe(0o600);
	});

	test("the data dir is made owner-only, whether new or left at 0755 by an older deck", () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "npi-deck-dir-mode-"));
		const fresh = path.join(root, "fresh", ".npi-deck");
		ensurePrivateDataDir(fresh);
		expect(mode(fresh)).toBe(0o700);

		const existing = path.join(root, "existing");
		fs.mkdirSync(existing, { mode: 0o755 });
		fs.chmodSync(existing, 0o755);
		ensurePrivateDataDir(existing);
		expect(mode(existing)).toBe(0o700);
	});
});
