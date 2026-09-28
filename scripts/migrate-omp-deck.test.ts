import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { migrate } from "./migrate-omp-deck.ts";
import { readManagedEnvFile } from "../apps/server/src/env-store.ts";

const fixtures: string[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true }); });

test("backs up WAL, migrates companion files and rewrites only legacy-root paths; reruns are no-ops", async () => {
	const base = mkdtempSync(path.join(os.tmpdir(), "npi-migration-test-"));
	fixtures.push(base);
	const home = path.join(base, "legacy");
	const data = path.join(home, ".omp-deck");
	const config = path.join(home, ".config", "omp-deck");
	const target = path.join(base, "new-deck");
	mkdirSync(path.join(data, "uploads"), { recursive: true });
	mkdirSync(path.join(data, "routine-runs", "run-1"), { recursive: true });
	mkdirSync(config, { recursive: true });
	writeFileSync(path.join(data, "uploads", "image.png"), "image bytes");
	writeFileSync(path.join(data, "routine-runs", "run-1", "result.json"), "result");
	writeFileSync(path.join(config, "onboarding.json"), '{"version":1,"completedAt":"2026-01-01"}\n');
	writeFileSync(path.join(config, ".env"), `OMP_DECK_AUTO_START=/start\nOMP_DECK_KB_ROOT=/home/someone/wiki\nOMP_DECK_UPLOADS_ROOT=${data}/uploads\nOMP_DECK_INSTALL_STARTER_SKILLS=1\nTELEGRAM_BOT_TOKEN=secret\n`);
	const dbFile = path.join(data, "deck.db");
	const db = new Database(dbFile);
	db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE tasks(id TEXT PRIMARY KEY, body TEXT, cwd TEXT); CREATE TABLE routines(id TEXT PRIMARY KEY, spec_yaml TEXT); CREATE TABLE inbox_items(id TEXT PRIMARY KEY, body TEXT)");
	db.query("INSERT INTO tasks VALUES (?, ?, ?)").run("t1", `![image](${data}/uploads/image.png) and /home/someone/wiki`, `${data}/routine-runs/run-1`);
	db.query("INSERT INTO routines VALUES (?, ?)").run("r1", `steps:\n  - file: ${data}/routine-runs/run-1/result.json\n`);
	db.query("INSERT INTO inbox_items VALUES (?, ?)").run("i1", `see ${config}/onboarding.json`);
	// Keep the writer open: a plain file copy would miss these WAL-only rows.
	let output = "";
	const originalLog = console.log;
	console.log = (...parts: unknown[]) => { output += `${parts.join(" ")}\n`; };
	try {
		await migrate(["--from", home], { NPI_DECK_HOME: target });
		expect(output).toContain("Dry run");
		expect(readdirSync(base)).not.toContain("new-deck");
		await migrate(["--from", home, "--apply"], { NPI_DECK_HOME: target });
		const migrated = new Database(path.join(target, "deck.db"), { readonly: true });
		try {
			expect(migrated.query("SELECT body, cwd FROM tasks WHERE id='t1'").get()).toEqual({ body: `![image](${target}/uploads/image.png) and /home/someone/wiki`, cwd: `${target}/routine-runs/run-1` });
			expect(migrated.query("SELECT spec_yaml FROM routines WHERE id='r1'").get()).toEqual({ spec_yaml: `steps:\n  - file: ${target}/routine-runs/run-1/result.json\n` });
			expect(migrated.query("SELECT body FROM inbox_items WHERE id='i1'").get()).toEqual({ body: `see ${target}/onboarding.json` });
		} finally { migrated.close(); }
		expect(readFileSync(path.join(target, "uploads", "image.png"), "utf8")).toBe("image bytes");
		expect(readFileSync(path.join(target, "routine-runs", "run-1", "result.json"), "utf8")).toBe("result");
		const settings = readManagedEnvFile(path.join(target, ".env")).values;
		expect(settings.get("NPI_DECK_UPLOADS_ROOT")).toBe(`${target}/uploads`);
		expect(settings.get("NPI_DECK_KB_ROOT")).toBe("/home/someone/wiki");
		expect(settings.get("NPI_DECK_INSTALL_STARTER_SKILLS")).toBe("0");
		expect(settings.get("TELEGRAM_BOT_TOKEN")).toBe("secret");
		expect(settings.has("OMP_DECK_AUTO_START")).toBe(false);
		const marker = readFileSync(path.join(target, ".omp-deck-migration.json"), "utf8");
		await migrate(["--from", home, "--apply", "--force"], { NPI_DECK_HOME: target });
		expect(output).toContain("Already migrated");
		expect(readFileSync(path.join(target, ".omp-deck-migration.json"), "utf8")).toBe(marker);
		expect(db.query("SELECT cwd FROM tasks WHERE id='t1'").get()).toEqual({ cwd: `${data}/routine-runs/run-1` });
	} finally { console.log = originalLog; db.close(); }
});

test("honors effective external database and upload paths without overwriting another installation", async () => {
	const base = mkdtempSync(path.join(os.tmpdir(), "npi-custom-migration-test-"));
	fixtures.push(base);
	const home = path.join(base, "legacy");
	const config = path.join(home, ".config", "omp-deck");
	const external = path.join(base, "external");
	const target = path.join(base, "migrated");
	mkdirSync(config, { recursive: true });
	mkdirSync(path.join(external, "images"), { recursive: true });
	writeFileSync(path.join(external, "images", "photo.png"), "external asset");
	const dbFile = path.join(external, "legacy.db");
	const db = new Database(dbFile);
	db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY, body TEXT)");
	db.query("INSERT INTO tasks VALUES (?, ?)").run("t", `file: ${external}/images/photo.png`);
	db.close();
	writeFileSync(path.join(config, ".env"), `OMP_DECK_DB_PATH=${dbFile}\nOMP_DECK_UPLOADS_ROOT=${external}/images\n`);
	writeFileSync(path.join(target + ".unrelated"), "leave alone");
	await migrate(["--from", home, "--apply"], { NPI_DECK_HOME: target });
	const migrated = new Database(path.join(target, "deck.db"), { readonly: true });
	try {
		expect(migrated.query("SELECT body FROM tasks").get()).toEqual({ body: `file: ${target}/uploads/photo.png` });
	} finally { migrated.close(); }
	expect(readFileSync(path.join(target, "uploads", "photo.png"), "utf8")).toBe("external asset");
	expect(readManagedEnvFile(path.join(target, ".env")).values.get("NPI_DECK_UPLOADS_ROOT")).toBe(`${target}/uploads`);
	expect(readFileSync(path.join(target + ".unrelated"), "utf8")).toBe("leave alone");
	const secondTarget = path.join(base, "populated");
	mkdirSync(secondTarget);
	writeFileSync(path.join(secondTarget, "existing"), "keep");
	expect(migrate(["--from", home, "--apply", "--force"], { NPI_DECK_HOME: secondTarget })).rejects.toThrow("refusing to overwrite");
	expect(readFileSync(path.join(secondTarget, "existing"), "utf8")).toBe("keep");
});
