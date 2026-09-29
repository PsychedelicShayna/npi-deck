/**
 * npi-deck local data store.
 *
 * Backed by Bun's built-in sqlite (`bun:sqlite`). Single-process write model —
 * we don't expect concurrent writers because the server is one Bun process.
 *
 * Migration model: numbered .sql files in `./migrations/`. The runner records
 * applied filenames in a `schema_migrations` table and skips anything already
 * applied. Each file is executed atomically inside a transaction.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

import { migrationsDir } from "../assets.ts";
import { logger } from "../log.ts";

const log = logger("db");

const MIGRATIONS_DIR = migrationsDir();

let instance: Database | null = null;

export interface DbOpenOpts {
	/** Absolute path to the sqlite file. Created if missing. */
	path: string;
}

export function openDb(opts: DbOpenOpts): Database {
	if (instance) return instance;
	const dbPath = path.resolve(opts.path);
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });

	const db = new Database(dbPath, { create: true, strict: true });
	trackTransactions(db);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA synchronous = NORMAL");

	applyMigrations(db);
	seedWelcomeTaskIfEmpty(db);

	instance = db;
	log.info(`db ready at ${dbPath}`);
	return db;
}

export function getDb(): Database {
	if (!instance) throw new Error("db not opened — call openDb() at boot");
	return instance;
}

export function closeDb(): void {
	if (instance) {
		instance.close();
		instance = null;
	}
}

// ─── Commit hooks ──────────────────────────────────────────────────────────

/**
 * Callbacks deferred by `afterCommit`, one set per open `db.transaction`
 * level (outermost first). Sets coalesce repeats of the same callback, so
 * several mutations in one commit still fire it once.
 */
const commitFrames: Set<() => void>[] = [];

/**
 * Run `cb` once the current write is durable: immediately outside a
 * transaction, otherwise when the outermost `db.transaction` commits. A
 * rollback, at any nesting level, drops what was deferred inside it.
 *
 * Only transactions opened through `db.transaction(...)` are tracked; a raw
 * `BEGIN` would run `cb` before its commit.
 */
export function afterCommit(cb: () => void): void {
	const frame = commitFrames.at(-1);
	if (frame) frame.add(cb);
	else runCommitCallback(cb);
}

function runCommitCallback(cb: () => void): void {
	try {
		cb();
	} catch (err) {
		// The write already committed; a failing observer must not report it as failed.
		log.error("afterCommit callback failed", err);
	}
}

/**
 * Wrap `db.transaction` (and its deferred/immediate/exclusive variants) so each
 * call opens a commit frame. On success an inner frame merges into its parent
 * and the outermost frame flushes; on throw the frame is discarded.
 */
function trackTransactions(db: Database): void {
	const original = db.transaction.bind(db);
	const track =
		<A extends unknown[], R>(run: (...args: A) => R) =>
		(...args: A): R => {
			commitFrames.push(new Set());
			let committed = false;
			try {
				const result = run(...args);
				committed = true;
				return result;
			} finally {
				const frame = commitFrames.pop()!;
				if (committed) {
					const parent = commitFrames.at(-1);
					for (const cb of frame) {
						if (parent) parent.add(cb);
						else runCommitCallback(cb);
					}
				}
			}
		};
	db.transaction = ((fn: (...args: unknown[]) => unknown) => {
		const tx = original(fn);
		return Object.assign(track(tx), {
			deferred: track(tx.deferred),
			immediate: track(tx.immediate),
			exclusive: track(tx.exclusive),
			database: db,
		});
	}) as Database["transaction"];
}

// ─── Migrations ────────────────────────────────────────────────────────────

function applyMigrations(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			name        TEXT PRIMARY KEY,
			applied_at  TEXT NOT NULL
		)
	`);

	const applied = new Set<string>(
		(db.query<{ name: string }, []>("SELECT name FROM schema_migrations").all() as { name: string }[])
			.map((r) => r.name),
	);

	const files = fs
		.readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();

	const recordStmt = db.prepare<unknown, [string, string]>(
		"INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
	);

	for (const file of files) {
		if (applied.has(file)) continue;
		const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
		log.info(`applying migration ${file}`);
		db.transaction(() => {
			db.exec(sql);
			recordStmt.run(file, new Date().toISOString());
		})();
	}
}

// ─── First-boot seed ───────────────────────────────────────────────────────

/**
 * When the deck boots against an empty `tasks` table — fresh install, no
 * archived rows either — insert a single backlog task that orients the user.
 * Idempotent: any existing row (archived or not) makes this a no-op so we
 * never spam a returning user.
 */
function seedWelcomeTaskIfEmpty(db: Database): void {
	const count = (db
		.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks")
		.get() as { n: number } | null)?.n ?? 0;
	if (count > 0) return;

	const taskId = `t_${id().toLowerCase().slice(0, 18)}`;
	const now = nowIso();
	const title = "Welcome to NPI deck";
	const body = WELCOME_BODY;

	db.transaction(() => {
		const seqRow = db
			.query<{ value: number }, []>(
				"UPDATE sequences SET value = value + 1 WHERE name = 'tasks' RETURNING value",
			)
			.get() as { value: number } | null;
		const displayId = seqRow?.value ?? 1;
		db.prepare<unknown, [string, number, string, string, string, number, string | null, string, string]>(
			`INSERT INTO tasks (id, display_id, title, body, state_id, order_in_state, cwd, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(taskId, displayId, title, body, "s_backlog", 1000, null, now, now);
	})();
	log.info(`seeded welcome task (T-1) on empty kanban`);
}

const WELCOME_BODY = `Welcome to NPI deck, a browser front end for the NeoPi agent. Mark this task done when you've had a look around.

The nav rail on the left edge holds:
- **Chat** — multi-session conversations with the agent. A new session starts as an empty thread.
- **Tasks** — this kanban. \`T-N\` ids stay stable; columns are user-configurable.
- **Knowledge** — browse, search, and edit your markdown knowledge base.
- **Settings** — env vars, themes, messaging bridges, appearance.

More in \`docs/\`, starting with \`docs/install.md\` and \`docs/configuration.md\`.
`;

// ─── Small id helper ───────────────────────────────────────────────────────

/**
 * App-side id generator. ULID-ish: 26 chars, time-sortable prefix, base32
 * crockford alphabet. Good enough for primary keys, no monotonic guarantee
 * within the same millisecond (we accept rare collisions; PRIMARY KEY catches
 * them).
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function id(): string {
	const ts = Date.now();
	let out = "";
	let n = ts;
	for (let i = 0; i < 10; i++) {
		out = ALPHABET[n % 32]! + out;
		n = Math.floor(n / 32);
	}
	for (let i = 0; i < 16; i++) {
		out += ALPHABET[Math.floor(Math.random() * 32)]!;
	}
	return out;
}

export function nowIso(): string {
	return new Date().toISOString();
}
