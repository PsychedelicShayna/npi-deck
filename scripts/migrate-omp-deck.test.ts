import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { migrate } from "./migrate-omp-deck.ts";
import { readManagedEnvFile } from "../apps/server/src/env-store.ts";

const fixtures: string[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true }); });

test("backs up WAL, migrates companion files and rewrites only legacy-root paths; a plain rerun is refused and a forced one changes nothing", async () => {
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
		const migratedHome = snapshot(target);
		await expect(migrate(["--from", home, "--apply"], { NPI_DECK_HOME: target })).rejects.toThrow("Already migrated");
		await migrate(["--from", home, "--apply", "--force"], { NPI_DECK_HOME: target });
		expect(output).toContain("Already migrated");
		expect(output).toContain("already matches the legacy source");
		expect(readFileSync(path.join(target, ".omp-deck-migration.json"), "utf8")).toBe(marker);
		expect(snapshot(target)).toEqual(migratedHome);
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
	mkdirSync(path.join(target, "neopi", "backend"), { recursive: true });
	mkdirSync(path.join(target, "run"), { recursive: true });
	writeFileSync(path.join(target, "config.yml"), "activeBackend: fixture\n");
	writeFileSync(path.join(target, "neopi", "backend", "native.node"), "backend");
	writeFileSync(path.join(target, "run", "launcher.lock"), "launcher");
	let dryRun = "";
	const oldLog = console.log;
	console.log = (...parts: unknown[]) => { dryRun += `${parts.join(" ")}\n`; };
	try { await migrate(["--from", home], { NPI_DECK_HOME: target }); }
	finally { console.log = oldLog; }
	expect(dryRun).toContain("No files changed");
	expect(dryRun).not.toContain("Existing deck state");
	await migrate(["--from", home, "--apply"], { NPI_DECK_HOME: target });
	const migrated = new Database(path.join(target, "deck.db"), { readonly: true });
	try {
		expect(migrated.query("SELECT body FROM tasks").get()).toEqual({ body: `file: ${target}/uploads/photo.png` });
	} finally { migrated.close(); }
	expect(readFileSync(path.join(target, "uploads", "photo.png"), "utf8")).toBe("external asset");
	expect(readManagedEnvFile(path.join(target, ".env")).values.get("NPI_DECK_UPLOADS_ROOT")).toBe(`${target}/uploads`);
	expect(readFileSync(path.join(target + ".unrelated"), "utf8")).toBe("leave alone");
	expect(readFileSync(path.join(target, "config.yml"), "utf8")).toBe("activeBackend: fixture\n");
	expect(readFileSync(path.join(target, "neopi", "backend", "native.node"), "utf8")).toBe("backend");
	expect(readFileSync(path.join(target, "run", "launcher.lock"), "utf8")).toBe("launcher");
	const secondTarget = path.join(base, "populated");
	mkdirSync(secondTarget);
	writeFileSync(path.join(secondTarget, "deck.db"), "preexisting database");
	let conflictPlan = "";
	const originalLog = console.log;
	console.log = (...parts: unknown[]) => { conflictPlan += `${parts.join(" ")}\n`; };
	try { await migrate(["--from", home], { NPI_DECK_HOME: secondTarget }); }
	finally { console.log = originalLog; }
	expect(conflictPlan).toContain("Existing deck state: deck.db");
	expect(conflictPlan).toContain("No files changed");
	await expect(migrate(["--from", home, "--apply"], { NPI_DECK_HOME: secondTarget })).rejects.toThrow("refusing to overwrite");
	expect(readdirSync(secondTarget)).toEqual(["deck.db"]);
	expect(readFileSync(path.join(secondTarget, "deck.db"), "utf8")).toBe("preexisting database");
	// --force installs the legacy database and keeps the one it displaced.
	await migrate(["--from", home, "--apply", "--force"], { NPI_DECK_HOME: secondTarget });
	const [stamp] = readdirSync(path.join(secondTarget, ".omp-deck-migration-replaced"));
	expect(readFileSync(path.join(secondTarget, ".omp-deck-migration-replaced", stamp!, "deck.db"), "utf8")).toBe("preexisting database");
	expect(readFileSync(path.join(secondTarget, "uploads", "photo.png"), "utf8")).toBe("external asset");
});

/** Relative path -> sha256 of every file under `root`, for byte-for-byte before/after comparisons. */
function snapshot(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const file = path.join(entry.parentPath, entry.name);
		out[path.relative(root, file)] = createHash("sha256").update(readFileSync(file)).digest("hex");
	}
	return out;
}

function legacyFixture(prefix: string): { base: string; home: string; target: string } {
	const base = mkdtempSync(path.join(os.tmpdir(), prefix));
	fixtures.push(base);
	const home = path.join(base, "legacy");
	const data = path.join(home, ".omp-deck");
	const config = path.join(home, ".config", "omp-deck");
	mkdirSync(path.join(data, "routine-runs", "run-1"), { recursive: true });
	mkdirSync(config, { recursive: true });
	writeFileSync(path.join(data, "routine-runs", "run-1", "result.json"), "result");
	writeFileSync(path.join(config, "onboarding.json"), '{"version":1}\n');
	writeFileSync(path.join(config, ".env"), "OMP_DECK_PORT=4000\n");
	const db = new Database(path.join(data, "deck.db"));
	db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY, cwd TEXT)");
	db.query("INSERT INTO tasks VALUES (?, ?)").run("t1", `${data}/routine-runs/run-1`);
	db.close();
	return { base, home, target: path.join(base, "deck") };
}

const crashAfterDeckDb = { afterInstall: (relative: string) => { if (relative === "deck.db") throw new Error("simulated crash"); } };

test("a crashed migration never overwrites deck state changed before the retry", async () => {
	const { home, target } = legacyFixture("npi-migration-crash-test-");
	const env = { NPI_DECK_HOME: target };
	const source = snapshot(home);
	await expect(migrate(["--from", home, "--apply"], env, crashAfterDeckDb)).rejects.toThrow("simulated crash");
	expect(existsSync(path.join(target, "deck.db"))).toBe(true);
	expect(existsSync(path.join(target, "onboarding.json"))).toBe(false);
	// The deck opens the half-migrated home and records new work before the retry.
	const live = new Database(path.join(target, "deck.db"));
	live.query("INSERT INTO tasks VALUES (?, ?)").run("t2", "written after the crash");
	live.close();
	const changed = snapshot(target);
	await expect(migrate(["--from", home, "--apply"], env)).rejects.toThrow("refusing to overwrite");
	expect(snapshot(target)).toEqual(changed);
	expect(snapshot(home)).toEqual(source);
	// --force installs the legacy copy and keeps the changed database, byte for byte, beside it.
	await migrate(["--from", home, "--apply", "--force"], env);
	const replaced = path.join(target, ".omp-deck-migration-replaced");
	const [stamp] = readdirSync(replaced);
	expect(snapshot(path.join(replaced, stamp!))).toEqual({ "deck.db": changed["deck.db"] });
	const migrated = new Database(path.join(target, "deck.db"), { readonly: true });
	try { expect(migrated.query("SELECT id FROM tasks").all()).toEqual([{ id: "t1" }]); } finally { migrated.close(); }
	expect(readFileSync(path.join(target, "onboarding.json"), "utf8")).toBe('{"version":1}\n');
	expect(snapshot(home)).toEqual(source);
	// A completed migration refuses a plain rerun; a forced rerun is idempotent.
	const done = snapshot(target);
	await expect(migrate(["--from", home, "--apply"], env)).rejects.toThrow("Already migrated");
	await migrate(["--from", home, "--apply", "--force"], env);
	expect(snapshot(target)).toEqual(done);
	expect(snapshot(home)).toEqual(source);
});

test("a crashed migration resumes over the files it already installed", async () => {
	const { home, target } = legacyFixture("npi-migration-resume-test-");
	const env = { NPI_DECK_HOME: target };
	await expect(migrate(["--from", home, "--apply"], env, crashAfterDeckDb)).rejects.toThrow("simulated crash");
	const installed = snapshot(target)["deck.db"];
	await migrate(["--from", home, "--apply"], env);
	expect(snapshot(target)["deck.db"]).toBe(installed!);
	expect(readFileSync(path.join(target, "routine-runs", "run-1", "result.json"), "utf8")).toBe("result");
	expect(readManagedEnvFile(path.join(target, ".env")).values.get("NPI_DECK_PORT")).toBe("4000");
	expect(existsSync(path.join(target, ".omp-deck-migration.json"))).toBe(true);
	expect(existsSync(path.join(target, ".omp-deck-migration-replaced"))).toBe(false);
	expect(existsSync(`${target}.omp-deck-staging`)).toBe(false);
});

test("a write-ahead log left by the deck counts as changed state and moves aside with its database", async () => {
	const { home, target } = legacyFixture("npi-migration-wal-test-");
	const env = { NPI_DECK_HOME: target };
	await migrate(["--from", home, "--apply"], env);
	// A deck killed mid-write leaves committed frames in the WAL, not in deck.db.
	writeFileSync(path.join(target, "deck.db-wal"), "uncheckpointed frames");
	writeFileSync(path.join(target, "deck.db-shm"), "index");
	const live = snapshot(target);
	// Without the completion marker (a crash before it was written) a plain retry names the WAL and refuses.
	rmSync(path.join(target, ".omp-deck-migration.json"));
	await expect(migrate(["--from", home, "--apply"], env)).rejects.toThrow("deck.db-wal");
	await migrate(["--from", home, "--apply", "--force"], env);
	const [stamp] = readdirSync(path.join(target, ".omp-deck-migration-replaced"));
	const aside = snapshot(path.join(target, ".omp-deck-migration-replaced", stamp!));
	expect(aside).toEqual({ "deck.db": live["deck.db"], "deck.db-wal": live["deck.db-wal"], "deck.db-shm": live["deck.db-shm"] });
	expect(existsSync(path.join(target, "deck.db-wal"))).toBe(false);
	expect(snapshot(target)["deck.db"]).toBe(live["deck.db"]!);
});

test("refuses a deck home that reaches the legacy state through a symlink", async () => {
	const { base, home } = legacyFixture("npi-migration-symlink-home-test-");
	const source = snapshot(home);
	symlinkSync(path.join(home, ".omp-deck"), path.join(base, "deck-link"));
	symlinkSync(home, path.join(base, "home-link"));
	// The home itself, a not-yet-existing directory under a symlinked ancestor, and a home containing the legacy state.
	for (const target of [path.join(base, "deck-link"), path.join(base, "home-link", ".omp-deck", "nested"), path.join(base, "home-link")]) {
		await expect(migrate(["--from", home, "--apply", "--force"], { NPI_DECK_HOME: target })).rejects.toThrow("legacy source");
	}
	expect(snapshot(home)).toEqual(source);
	expect(readdirSync(base).sort()).toEqual(["deck-link", "home-link", "legacy"]);
});

test("forced runs in the same millisecond keep every file they move aside", async () => {
	const { home, target } = legacyFixture("npi-migration-same-stamp-test-");
	const env = { NPI_DECK_HOME: target };
	await migrate(["--from", home, "--apply"], env);
	setSystemTime(new Date("2026-09-29T00:00:00.000Z"));
	try {
		const displaced: string[] = [];
		for (const row of ["first", "second"]) {
			const live = new Database(path.join(target, "deck.db"));
			live.query("INSERT INTO tasks VALUES (?, ?)").run(row, row);
			live.close();
			displaced.push(snapshot(target)["deck.db"]!);
			await migrate(["--from", home, "--apply", "--force"], env);
		}
		const replaced = path.join(target, ".omp-deck-migration-replaced");
		expect(readdirSync(replaced).map((dir) => snapshot(path.join(replaced, dir))["deck.db"]).sort()).toEqual(displaced.sort());
	} finally { setSystemTime(); }
});

test("never writes through a deck-home directory that is a symlink", async () => {
	const { base, home, target } = legacyFixture("npi-migration-symlink-dir-test-");
	const outside = path.join(base, "outside");
	mkdirSync(outside);
	const env = { NPI_DECK_HOME: target };
	// Swapped in after the conflict scan, between two installs.
	const plant = { afterInstall: (relative: string) => { if (relative === "deck.db") symlinkSync(outside, path.join(target, "routine-runs")); } };
	await expect(migrate(["--from", home, "--apply"], env, plant)).rejects.toThrow("not a directory");
	expect(readdirSync(outside)).toEqual([]);
	// The archive directory --force moves changed state into.
	rmSync(path.join(target, "routine-runs"));
	await migrate(["--from", home, "--apply"], env);
	const live = new Database(path.join(target, "deck.db"));
	live.query("INSERT INTO tasks VALUES (?, ?)").run("t2", "after");
	live.close();
	const changed = snapshot(target);
	symlinkSync(outside, path.join(target, ".omp-deck-migration-replaced"));
	await expect(migrate(["--from", home, "--apply", "--force"], env)).rejects.toThrow("not a directory");
	expect(readdirSync(outside)).toEqual([]);
	expect(snapshot(target)).toEqual(changed);
});
