#!/usr/bin/env bun
/** One-time, non-destructive migration of omp-deck's local state. Dry-run by default. */
import { Database } from "bun:sqlite";
import { closeSync, constants, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readManagedEnvFile, writeManagedEnvUpdates } from "../apps/server/src/env-store.ts";

const MARKER = ".omp-deck-migration.json";
/** Where `--force` moves deck-home files that differ from the legacy copy it installs. */
const REPLACED = ".omp-deck-migration-replaced";
const DROPPED = new Set(["AUTO_START", "DISABLE_UPDATE_CHECK", "INSTALL_STARTER_SKILLS", "INSTALL_STARTER_EXTENSIONS", "DATA_DIR", "DB", "DB_PATH", "WEB_DIST", "ORG_ROOT", "STARTER_SKILLS_DIR", "STARTER_EXTENSIONS_DIR", "AGENT_DIR"]);
const SKIP_FILES = new Set(["update-check.json"]);

type Source = { home: string; data: string; config: string; extra: Array<[string, string]> };

function sourceRoots(from?: string): Source {
	const home = path.resolve(from ?? os.homedir());
	return { home, data: path.join(home, ".omp-deck"), config: path.join(home, ".config", "omp-deck"), extra: [] };
}

function mapPath(value: string, source: Source, target: string): string {
	for (const [oldRoot, newRoot] of [...source.extra, [source.data, target], [source.config, target]]) {
		if (value === oldRoot || value.startsWith(`${oldRoot}${path.sep}`)) {
			return newRoot + value.slice(oldRoot.length);
		}
	}
	return value;
}

/** Text fields include YAML, JSON and markdown. Only absolute paths rooted in old state move. */
function rewrite(value: string, source: Source, target: string): string {
	for (const root of [...source.extra.map(([old]) => old), source.data, source.config]) {
		const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		value = value.replace(new RegExp(`(^|[^\\w/.-])(${escaped})(?=/|[\\s"'\\x60,;)}\\]\\}]|$)`, "g"), (_match, before: string, old: string) => before + mapPath(old, source, target));
	}
	return value;
}

function walk(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	function visit(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in legacy state: ${file}`);
			if (entry.isDirectory()) visit(file);
			else if (entry.isFile()) files.push(file);
		}
	}
	visit(root);
	return files.sort();
}

function quote(name: string): string { return `"${name.replaceAll('"', '""')}"`; }

function rewriteDatabase(file: string, source: Source, target: string): number {
	const db = new Database(file);
	let changed = 0;
	try {
		const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
		db.exec("BEGIN IMMEDIATE");
		for (const { name } of tables) {
			const columns = db.query<{ name: string; type: string; pk: number }, []>(`PRAGMA table_info(${quote(name)})`).all();
			const text = columns.filter((col) => /TEXT|CHAR|CLOB|^$/i.test(col.type));
			if (!text.length) continue;
			const pk = columns.filter((col) => col.pk).sort((a, b) => a.pk - b.pk);
			if (!pk.length) throw new Error(`No primary key on ${name}; refusing ambiguous row rewrite`);
			const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM ${quote(name)}`).all();
			for (const row of rows) {
				const edits = text.flatMap((col) => {
					const old = row[col.name];
					if (typeof old !== "string") return [];
					const next = rewrite(old, source, target);
					return next === old ? [] : [[col.name, next] as const];
				});
				if (!edits.length) continue;
				const sql = `UPDATE ${quote(name)} SET ${edits.map(([key]) => `${quote(key)} = ?`).join(", ")} WHERE ${pk.map((col) => `${quote(col.name)} = ?`).join(" AND ")}`;
				db.query(sql).run(...edits.map(([, value]) => value), ...pk.map((col) => row[col.name]));
				changed += edits.length;
			}
		}
		db.exec("COMMIT");
	} catch (error) {
		if (db.inTransaction) db.exec("ROLLBACK");
		throw error;
	} finally { db.close(); }
	return changed;
}

function backup(source: string, dest: string): void {
	mkdirSync(path.dirname(dest), { recursive: true });
	const proc = Bun.spawnSync(["sqlite3", "-readonly", source, `.backup ${JSON.stringify(dest)}`], { stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`SQLite backup failed for ${source}: ${proc.stderr.toString()}`);
}

/** Existing entries at `relatives` under `root`, directories expanded to what they hold; symlinks and other non-directories count as themselves. */
function existingFiles(root: string, relatives: string[]): string[] {
	const found = new Set<string>();
	for (const relative of relatives) {
		let stat;
		try { stat = lstatSync(path.join(root, relative)); } catch (error) {
			if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
			throw error;
		}
		if (!stat.isDirectory()) { found.add(relative); continue; }
		for (const entry of readdirSync(path.join(root, relative), { recursive: true, withFileTypes: true })) {
			if (!entry.isDirectory()) found.add(path.relative(root, path.join(entry.parentPath, entry.name)));
		}
	}
	return [...found].sort();
}

function sameFile(a: string, b: string): boolean {
	const target = lstatSync(b);
	return target.isFile() && target.size === statSync(a).size && readFileSync(a).equals(readFileSync(b));
}

function lexists(file: string): boolean {
	try { lstatSync(file); return true; } catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

/** `file` with every symlink in its longest existing ancestor resolved; a missing tail is appended as is. A dangling symlink is refused. */
function physical(file: string): string {
	let existing = path.resolve(file);
	const tail: string[] = [];
	for (;;) {
		try { return path.join(realpathSync(existing), ...tail); } catch (error) {
			if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			if (lexists(existing)) throw new Error(`Dangling symlink in path: ${existing}`);
		}
		const parent = path.dirname(existing);
		if (parent === existing) return path.join(existing, ...tail);
		tail.unshift(path.basename(existing));
		existing = parent;
	}
}

function within(inner: string, outer: string): boolean {
	return inner === outer || inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);
}

/** Creates `relative` under `root` one component at a time. Any existing component that is not a real directory (a symlink included) is refused. */
function ensureDir(root: string, relative: string): string {
	if (!lstatSync(root).isDirectory()) throw new Error(`Destination path component is not a directory: ${root}`);
	let dir = root;
	for (const part of relative.split(path.sep)) {
		if (!part || part === ".") continue;
		dir = path.join(dir, part);
		try { mkdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		if (!lstatSync(dir).isDirectory()) throw new Error(`Destination path component is not a directory: ${dir}`);
	}
	return dir;
}

/** Test seam: `afterInstall` runs after each migrated file lands in the deck home, so a test can stop the run there like a crash. */
export type MigrateHooks = { afterInstall?: (relative: string) => void };

export async function migrate(args: string[], env: NodeJS.ProcessEnv = process.env, hooks: MigrateHooks = {}): Promise<void> {
	let from: string | undefined;
	let apply = false;
	let force = false;
	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--from": if (!args[i + 1]) throw new Error("--from requires a legacy home directory"); from = args[++i]; break;
			case "--apply": apply = true; break;
			case "--dry-run": apply = false; break;
			case "--force": force = true; break;
			default: throw new Error(`Unknown argument: ${args[i]}`);
		}
	}
	const source = sourceRoots(from);
	const target = path.resolve(env.NPI_DECK_HOME?.trim() || path.join(os.homedir(), ".npi-deck"));
	const envFile = path.join(source.config, ".env");
	const legacyEnv = readManagedEnvFile(envFile).values;
	const configuredPath = (key: string): string | undefined => {
		const value = legacyEnv.get(key)?.trim();
		return value ? path.resolve(source.home, value) : undefined;
	};
	source.data = configuredPath("OMP_DECK_DATA_DIR") ?? source.data;
	const configuredDb = configuredPath("OMP_DECK_DB_PATH") ?? configuredPath("OMP_DECK_DB");
	const configuredUploads = configuredPath("OMP_DECK_UPLOADS_ROOT");
	const configuredBridgeDb = configuredPath("TELEGRAM_BRIDGE_DB_PATH");
	if (from) {
		const fixtureBoundary = path.dirname(source.home);
		for (const configured of [source.data, configuredDb, configuredUploads, configuredBridgeDb]) {
			if (configured && configured !== fixtureBoundary && !configured.startsWith(`${fixtureBoundary}/`)) {
				throw new Error(`--from fixture references a path outside its parent directory: ${configured}`);
			}
		}
	}
	const extraDbs: Array<[string, string]> = [];
	for (const [origin, filename] of [[configuredDb, "deck.db"], [configuredBridgeDb, "telegram-bridge.db"]] as const) {
		if (!origin) continue;
		if (!existsSync(origin)) throw new Error(`Configured SQLite database missing: ${origin}`);
		extraDbs.push([origin, filename]);
		source.extra.push([origin, path.join(target, filename)]);
	}
	const externalUploads = configuredUploads && !configuredUploads.startsWith(`${source.data}/`) && configuredUploads !== source.data ? configuredUploads : undefined;
	if (externalUploads) source.extra.push([externalUploads, path.join(target, "uploads")]);
	// Compare where the paths physically lead, so a symlinked deck home (or any
	// symlinked ancestor) cannot reach into the legacy state, or the reverse.
	// `target` stays the path the deck is configured with; files go to `root`.
	const root = physical(target);
	const stage = `${root}.omp-deck-staging`;
	for (const [label, legacy] of [["legacy source", source.data], ["legacy source", source.config], ...source.extra.map(([origin]) => ["configured legacy source", origin] as const)] as const) {
		const real = physical(legacy);
		for (const destination of [root, stage]) {
			if (within(destination, real)) throw new Error(`Destination overlaps ${label}: ${destination} is inside ${legacy}`);
			if (within(real, destination)) throw new Error(`Destination contains ${label}: ${legacy} is inside ${destination}`);
		}
	}
	const dataFiles = walk(source.data).filter((file) => !SKIP_FILES.has(path.basename(file)) && !/-wal$|-shm$/.test(file));
	const uploadFiles = externalUploads ? walk(externalUploads) : [];
	const configFiles = walk(source.config).filter((file) => path.basename(file) !== ".env");
	const settings: Record<string, string> = {};
	const dropped: string[] = [];
	for (const [key, value] of legacyEnv) {
		if (key.startsWith("OMP_DECK_")) {
			const suffix = key.slice("OMP_DECK_".length);
			if (DROPPED.has(suffix)) { dropped.push(key); continue; }
			settings[`NPI_DECK_${suffix}`] = rewrite(value, source, target);
		} else settings[key] = rewrite(value, source, target);
	}
	// Starter installs are opt-in after migration, regardless of old configuration.
	settings.NPI_DECK_INSTALL_STARTER_SKILLS = "0";
	settings.NPI_DECK_INSTALL_STARTER_EXTENSIONS = "0";
	const dbs = dataFiles.filter((file) => file.endsWith(".db") && (!configuredDb || path.basename(file) !== "deck.db" || file === configuredDb) && (!configuredBridgeDb || path.basename(file) !== "telegram-bridge.db" || file === configuredBridgeDb));
	const dbJobs: Array<[string, string]> = dbs.map((file) => [file, file === configuredDb ? "deck.db" : file === configuredBridgeDb ? "telegram-bridge.db" : path.relative(source.data, file)]);
	for (const [file, filename] of extraDbs) {
		if (!dbJobs.some(([origin]) => origin === file)) dbJobs.push([file, filename]);
	}
	if (new Set(dbJobs.map(([, filename]) => filename)).size !== dbJobs.length) throw new Error("Multiple legacy databases map to the same destination");
	const otherFiles = dataFiles.filter((file) => !file.endsWith(".db"));
	const marker = path.join(root, MARKER);
	const already = existsSync(marker);
	if (lexists(stage) && !lstatSync(stage).isDirectory()) throw new Error(`Staging path is not a directory: ${stage}`);
	const stageMarker = path.join(stage, ".migration-staging");
	const partial = existsSync(stageMarker);
	const transfer = [
		...dbJobs.map(([, filename]) => filename),
		...otherFiles.map((file) => path.relative(source.data, file)),
		...uploadFiles.map((file) => path.join("uploads", path.relative(externalUploads!, file))),
		...configFiles.map((file) => path.relative(source.config, file)),
		".env",
	];
	const stageIdentity = JSON.stringify({ source: source.home, target, transfer });
	if (partial && readFileSync(stageMarker, "utf8") !== stageIdentity) throw new Error(`Staging directory belongs to another migration: ${stage}`);
	const sidecars = new Set(dbJobs.flatMap(([, filename]) => [`${filename}-wal`, `${filename}-shm`, `${filename}-journal`]));
	const statePaths = [...new Set(["deck.db", "deck.db-wal", "deck.db-shm", "telegram-bridge.db", "telegram-bridge.db-wal", "telegram-bridge.db-shm", "uploads", "routine-runs", ".env", "onboarding.json", ...transfer, ...sidecars])];
	const conflicts = existingFiles(root, statePaths);
	console.log(`${apply ? "Apply" : "Dry run"}: ${source.data} + ${source.config} -> ${target}`);
	console.log(`SQLite backups: ${dbJobs.map(([file, dest]) => `${file} -> ${dest}`).join(", ") || "none"} (WAL included by backup API)`);
	console.log(`Data files: ${otherFiles.length + uploadFiles.length}; config files: ${configFiles.length}; env keys: ${Object.keys(settings).length}; dropped legacy keys: ${dropped.join(", ") || "none"}`);
	console.log(`Rewrites: absolute references under ${source.data}, ${source.config}${externalUploads ? `, ${externalUploads}` : ""}; external paths (including KB root) remain external.`);
	if (already && !apply) { console.log(`Already migrated (${marker}); no changes.`); return; }
	if (already && !force) throw new Error(`Already migrated (${marker}); refusing to rerun (pass --force to re-check the deck home against the legacy source)`);
	if (already) console.log(`Already migrated (${marker}); --force re-checks every migrated file against the legacy source.`);
	if (!dbJobs.length && !otherFiles.length && !uploadFiles.length && !configFiles.length && !existsSync(envFile)) throw new Error("No legacy state found");
	if (conflicts.length) console.log(`Existing deck state: ${conflicts.join(", ")} (apply skips files identical to the migrated copy; anything else ${force ? "that the migration writes is moved aside first" : "refuses apply without --force"})`);
	if (!apply) { console.log("No files changed (pass --apply to migrate)."); return; }
	if (existsSync(stage)) {
		if (!partial) throw new Error(`Unrecognized staging directory: ${stage}`);
		rmSync(stage, { recursive: true, force: true });
	}
	mkdirSync(stage, { recursive: true });
	writeFileSync(stageMarker, stageIdentity);
	let rewritten = 0;
	for (const [file, filename] of dbJobs) {
		const dest = path.join(stage, filename);
		if (existsSync(dest)) throw new Error(`Duplicate destination database: ${dest}`);
		backup(file, dest);
		rewritten += rewriteDatabase(dest, source, target);
	}
	for (const file of otherFiles) {
		const dest = path.join(stage, path.relative(source.data, file));
		mkdirSync(path.dirname(dest), { recursive: true });
		cpSync(file, dest);
	}
	for (const file of uploadFiles) {
		const dest = path.join(stage, "uploads", path.relative(externalUploads!, file));
		if (existsSync(dest)) throw new Error(`Upload destination collision: ${dest}`);
		mkdirSync(path.dirname(dest), { recursive: true });
		cpSync(file, dest);
	}
	for (const file of configFiles) {
		const dest = path.join(stage, path.relative(source.config, file));
		if (existsSync(dest)) throw new Error(`Config/data collision: ${dest}`);
		mkdirSync(path.dirname(dest), { recursive: true });
		cpSync(file, dest);
	}
	await writeManagedEnvUpdates(settings, path.join(stage, ".env"));
	// A retry after a crash finds the files the first attempt installed. Skip
	// only those still byte-identical to the fresh staged copy; anything the
	// deck (or anyone) changed in between is never silently replaced.
	const transferSet = new Set(transfer);
	// Opening a migrated database, even read-only, leaves a shared-memory index
	// and an empty WAL beside it; neither holds data of its own.
	const inert = (relative: string) => sidecars.has(relative) && (relative.endsWith("-shm") || lstatSync(path.join(root, relative)).size === 0);
	const identical = new Set(conflicts.filter((relative) => transferSet.has(relative) && sameFile(path.join(stage, relative), path.join(root, relative))));
	const differing = conflicts.filter((relative) => !identical.has(relative) && !inert(relative));
	if (differing.length && !force) {
		rmSync(stage, { recursive: true, force: true });
		throw new Error(`Destination holds deck state that differs from the legacy source: ${differing.join(", ")}; refusing to overwrite (pass --force to move it aside and install the legacy copy)`);
	}
	const owned = (relative: string) => sidecars.has(relative) || transfer.some((file) => file === relative || relative.startsWith(`${file}/`) || file.startsWith(`${relative}/`));
	const displaced = new Set(differing.filter(owned));
	// A database moves aside together with its journal files, whichever of them differed.
	for (const [, filename] of dbJobs) {
		const family = [filename, `${filename}-wal`, `${filename}-shm`, `${filename}-journal`].filter((relative) => conflicts.includes(relative));
		if (!family.some((relative) => displaced.has(relative))) continue;
		for (const relative of family) { identical.delete(relative); displaced.add(relative); }
	}
	const kept = differing.filter((relative) => !displaced.has(relative));
	// Install only migration-owned state, preserving config.yml, neopi/, run/
	// and any other backend/launcher files already present in the deck home.
	// Every directory on the way is checked at use time: a symlink swapped in
	// after the scan must not carry a write out of the deck home.
	mkdirSync(root, { recursive: true });
	let aside: string | undefined;
	if (displaced.size) {
		// mkdtemp: two forced runs in the same millisecond never share (and overwrite) an archive.
		aside = mkdtempSync(path.join(ensureDir(root, REPLACED), `${new Date().toISOString().replaceAll(":", "-")}-`));
		for (const relative of [...displaced].sort()) {
			ensureDir(root, path.dirname(relative));
			const archived = path.join(ensureDir(aside, path.dirname(relative)), path.basename(relative));
			if (lexists(archived)) throw new Error(`Archive entry already exists: ${archived}`);
			renameSync(path.join(root, relative), archived);
		}
	}
	let installed = 0;
	for (const relative of transfer) {
		if (identical.has(relative)) continue;
		const dir = ensureDir(root, path.dirname(relative));
		const destination = path.join(dir, path.basename(relative));
		// link() never replaces an existing entry, unlike rename().
		try { linkSync(path.join(stage, relative), destination); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Destination became populated during migration: ${destination}`);
			throw error;
		}
		// A directory swapped for a symlink between the check and the link: undo and stop.
		if (realpathSync(dir) !== dir) {
			unlinkSync(destination);
			throw new Error(`Destination path component is not a directory: ${dir} changed during migration`);
		}
		installed++;
		hooks.afterInstall?.(relative);
	}
	if (!already || installed || displaced.size) {
		const record = `${JSON.stringify({ from: source.home, at: new Date().toISOString(), rewrittenFields: rewritten, ...(aside ? { movedAside: aside } : {}) }, null, 2)}\n`;
		const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
		try { writeFileSync(fd, record); } finally { closeSync(fd); }
	}
	rmSync(stage, { recursive: true, force: true });
	if (displaced.size) console.log(`Moved aside (differing from the legacy source): ${[...displaced].sort().join(", ")} -> ${aside}`);
	if (kept.length) console.log(`Left in place (not written by the migration): ${kept.join(", ")}`);
	if (!installed && !displaced.size) console.log("Deck home already matches the legacy source; no changes.");
	else console.log(`Migrated ${dbJobs.length} database(s), ${otherFiles.length + uploadFiles.length + configFiles.length} files; installed ${installed}, skipped ${identical.size} identical; rewrote ${rewritten} database fields.`);
}

if (import.meta.main) {
	migrate(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
}
