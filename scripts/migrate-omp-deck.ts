#!/usr/bin/env bun
/** One-time, non-destructive migration of omp-deck's local state. Dry-run by default. */
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readManagedEnvFile, writeManagedEnvUpdates } from "../apps/server/src/env-store.ts";

const MARKER = ".omp-deck-migration.json";
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

export async function migrate(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
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
	if (target === source.data || target === source.config || target.startsWith(`${source.data}/`) || target.startsWith(`${source.config}/`)) throw new Error("Destination overlaps legacy source");
	if (source.data.startsWith(`${target}/`) || source.config.startsWith(`${target}/`)) throw new Error("Destination contains legacy source");
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
	for (const [origin] of source.extra) {
		if (target === origin || target.startsWith(`${origin}/`) || origin.startsWith(`${target}/`)) throw new Error(`Destination overlaps configured legacy source: ${origin}`);
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
	const marker = path.join(target, MARKER);
	const already = existsSync(marker);
	const stage = `${target}.omp-deck-staging`;
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
	const statePaths = ["deck.db", "deck.db-wal", "deck.db-shm", "telegram-bridge.db", "telegram-bridge.db-wal", "telegram-bridge.db-shm", "uploads", "routine-runs", ".env", "onboarding.json"];
	const conflicts = [...new Set([...transfer, ...statePaths].filter((file) => existsSync(path.join(target, file))))];
	console.log(`${apply ? "Apply" : "Dry run"}: ${source.data} + ${source.config} -> ${target}`);
	console.log(`SQLite backups: ${dbJobs.map(([file, dest]) => `${file} -> ${dest}`).join(", ") || "none"} (WAL included by backup API)`);
	console.log(`Data files: ${otherFiles.length + uploadFiles.length}; config files: ${configFiles.length}; env keys: ${Object.keys(settings).length}; dropped legacy keys: ${dropped.join(", ") || "none"}`);
	console.log(`Rewrites: absolute references under ${source.data}, ${source.config}${externalUploads ? `, ${externalUploads}` : ""}; external paths (including KB root) remain external.`);
	if (already) { console.log(`Already migrated (${marker}); no changes.`); return; }
	if (!dbJobs.length && !otherFiles.length && !uploadFiles.length && !configFiles.length && !existsSync(envFile)) throw new Error("No legacy state found");
	if (conflicts.length) console.log(`Existing deck state: ${conflicts.join(", ")}${partial ? " (partial migration can resume)" : " (apply refused)"}`);
	if (!apply) { console.log("No files changed (pass --apply to migrate)."); return; }
	if (conflicts.length && !partial) throw new Error(`Destination contains existing deck state: ${conflicts.join(", ")}; refusing to overwrite${force ? " even with --force" : ""}`);
	if (existsSync(stage)) {
		if (!partial) throw new Error(`Unrecognized staging directory: ${stage}`);
		rmSync(stage, { recursive: true, force: true });
	}
	mkdirSync(stage, { recursive: true });
	writeFileSync(stageMarker, stageIdentity);
	try {
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
		// Install only migration-owned state, preserving config.yml, neopi/, run/
		// and any other backend/launcher files already present in the deck home.
		mkdirSync(target, { recursive: true });
		for (const relative of transfer) {
			const staged = path.join(stage, relative);
			const destination = path.join(target, relative);
			if (existsSync(destination) && !partial) throw new Error(`Destination became populated during migration: ${destination}`);
			mkdirSync(path.dirname(destination), { recursive: true });
			renameSync(staged, destination);
		}
		writeFileSync(marker, `${JSON.stringify({ from: source.home, at: new Date().toISOString(), rewrittenFields: rewritten }, null, 2)}\n`);
		rmSync(stage, { recursive: true, force: true });
		console.log(`Migrated ${dbJobs.length} database(s), ${otherFiles.length + uploadFiles.length + configFiles.length} files; rewrote ${rewritten} database fields.`);
	} catch (error) { throw error; }
}

if (import.meta.main) {
	migrate(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
}
