import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const MANAGED_ENV_KEYS_LOADED = new Set<string>();

/**
 * Values the deck generates for a key nobody set (the maintenance gate's
 * `NPI_DECK_ORG_ROOT` from the kb root), and the keys whose `process.env`
 * value is currently that generated one. A generated value is the deck's, not
 * the launching shell's: a managed .env value overrides it and propagates
 * live, and clearing that override brings the generated value back.
 */
const deckGeneratedValues = new Map<string, string>();
const deckGeneratedApplied = new Set<string>();

/** True while `process.env[key]` holds the value the deck generated for it. */
export function isDeckGeneratedEnv(key: string): boolean {
	return deckGeneratedApplied.has(key);
}

/**
 * Record the value the deck wants for `key` (undefined: none) and apply it to
 * `process.env` when the deck owns the key there, that is, when it holds the
 * deck's earlier generated value or nothing at all. A value from the shell or
 * the managed .env is never replaced or cleared.
 */
export function setDeckGeneratedEnv(key: string, value: string | undefined): void {
	if (value === undefined) deckGeneratedValues.delete(key);
	else deckGeneratedValues.set(key, value);
	if (!deckGeneratedApplied.has(key) && process.env[key] !== undefined) return;
	if (value === undefined) {
		delete process.env[key];
		deckGeneratedApplied.delete(key);
	} else {
		process.env[key] = value;
		deckGeneratedApplied.add(key);
	}
}

interface EntryLine {
	kind: "entry";
	key: string;
	value: string;
}
interface RawLine {
	kind: "raw";
	raw: string;
}
type EnvLine = EntryLine | RawLine;

export interface ManagedEnvFile {
	path: string;
	values: Map<string, string>;
	lines: EnvLine[];
}

/** The deck's single data dir: `NPI_DECK_HOME`, else `~/.npi-deck`. Holds the managed .env, the db, backend trees and run state. */
export function getDataDir(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.NPI_DECK_HOME?.trim();
	return explicit ? path.resolve(explicit) : path.join(os.homedir(), ".npi-deck");
}

/**
 * Create the data dir if needed and make it owner-only (0700). The db inside
 * holds webhook signing keys; an older deck created the dir at 0755.
 */
export function ensurePrivateDataDir(dir = getDataDir()): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

export function getManagedEnvPath(): string {
	return path.join(getDataDir(), ".env");
}

export function readManagedEnvFile(filePath = getManagedEnvPath()): ManagedEnvFile {
	let text = "";
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	const lines = parseEnvLines(text);
	const values = new Map<string, string>();
	for (const line of lines) {
		if (line.kind === "entry") values.set(line.key, line.value);
	}
	return { path: filePath, values, lines };
}

/** Load deck-managed env into process.env without overriding the launching shell. */
export function loadManagedEnvIntoProcess(): void {
	const file = readManagedEnvFile();
	for (const [key, value] of file.values) {
		if (process.env[key] === undefined) {
			process.env[key] = value;
			MANAGED_ENV_KEYS_LOADED.add(key);
		}
	}
}

/**
 * Propagate managed-env edits into `process.env` so in-process consumers
 * (bridge supervisor, log-level toggle, etc.) observe the change without a
 * server restart. We refuse to clobber values originally supplied by the
 * launching shell — those values are tracked by their absence from
 * `MANAGED_ENV_KEYS_LOADED` — but a deck-generated value yields to the
 * managed one, and returns when the managed one is cleared.
 */
function applyManagedEnvUpdatesToProcess(updates: Record<string, string | null>): string[] {
	const propagated: string[] = [];
	for (const [key, value] of Object.entries(updates)) {
		const ownedByManaged = MANAGED_ENV_KEYS_LOADED.has(key) || deckGeneratedApplied.has(key) || process.env[key] === undefined;
		if (!ownedByManaged) continue;
		deckGeneratedApplied.delete(key);
		if (value === null) {
			MANAGED_ENV_KEYS_LOADED.delete(key);
			const generated = deckGeneratedValues.get(key);
			if (generated === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = generated;
				deckGeneratedApplied.add(key);
			}
		} else {
			process.env[key] = value;
			MANAGED_ENV_KEYS_LOADED.add(key);
		}
		propagated.push(key);
	}
	return propagated;
}

/** Tail of the in-flight update chain per managed file (resolved path). */
const managedEnvWrites = new Map<string, Promise<void>>();

/**
 * Run `task` after every earlier task queued for the same file has settled, so each
 * read-modify-write starts from the previous one's result.
 */
async function serializeManagedEnvWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
	const lockKey = path.resolve(filePath);
	const previous = managedEnvWrites.get(lockKey) ?? Promise.resolve();
	const run = previous.then(task);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	managedEnvWrites.set(lockKey, tail);
	try {
		return await run;
	} finally {
		if (managedEnvWrites.get(lockKey) === tail) managedEnvWrites.delete(lockKey);
	}
}

/** Apply `updates` to the .env at `filePath`, serialized with every other write to that file. */
export function writeManagedEnvUpdates(
	updates: Record<string, string | null>,
	filePath = getManagedEnvPath(),
): Promise<void> {
	return serializeManagedEnvWrite(filePath, () => rewriteManagedEnvFile(updates, filePath));
}

/**
 * Persist `updates` to the managed .env, then mirror them into `process.env`, as one
 * serialized step: concurrent saves keep each other's keys, and the process sees
 * updates in the order the file received them. Returns the keys propagated into `process.env`.
 */
export function commitManagedEnvUpdates(updates: Record<string, string | null>): Promise<string[]> {
	const filePath = getManagedEnvPath();
	return serializeManagedEnvWrite(filePath, async () => {
		await rewriteManagedEnvFile(updates, filePath);
		return applyManagedEnvUpdatesToProcess(updates);
	});
}

async function rewriteManagedEnvFile(updates: Record<string, string | null>, filePath: string): Promise<void> {
	const parsed = readManagedEnvFile(filePath);
	const pending = new Map(Object.entries(updates));
	const nextLines: EnvLine[] = [];

	for (const line of parsed.lines) {
		if (line.kind !== "entry" || !pending.has(line.key)) {
			nextLines.push(line);
			continue;
		}
		const value = pending.get(line.key);
		pending.delete(line.key);
		if (value === undefined || value === null) continue;
		nextLines.push({ kind: "entry", key: line.key, value });
	}

	const additions = Array.from(pending.entries()).filter(([, value]) => value !== null) as Array<[
		string,
		string,
	]>;
	if (additions.length > 0) {
		if (nextLines.length > 0 && nextLines[nextLines.length - 1]?.kind !== "raw") {
			nextLines.push({ kind: "raw", raw: "" });
		}
		if (!nextLines.some((line) => line.kind === "raw" && line.raw === "# npi-deck managed")) {
			nextLines.push({ kind: "raw", raw: "# npi-deck managed" });
		}
		for (const [key, value] of additions) nextLines.push({ kind: "entry", key, value });
	}

	await atomicWrite(filePath, stringifyEnvLines(nextLines));
}

export async function appendEnvAudit(action: string, keys: string[], filePath = getManagedEnvPath()): Promise<void> {
	const auditPath = path.join(path.dirname(filePath), "env-audit.log");
	await fs.promises.mkdir(path.dirname(auditPath), { recursive: true });
	const stamp = new Date().toISOString();
	const rows = keys.map((key) => `${stamp} | ${key} | ${action}\n`).join("");
	await fs.promises.appendFile(auditPath, rows, { encoding: "utf8", mode: 0o600 });
}

function parseEnvLines(text: string): EnvLine[] {
	if (!text) return [];
	return text.split(/\r?\n/).map((raw) => {
		// `s`: JSON.stringify leaves U+2028/U+2029 unescaped, and a bare `.` stops at them.
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/s.exec(raw);
		if (!match) return { kind: "raw", raw };
		const key = match[1]!;
		const value = parseValue(match[2] ?? "");
		return { kind: "entry", key, value };
	});
}

function parseValue(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
		return unescapeDoubleQuoted(trimmed.slice(1, -1));
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
		return trimmed.slice(1, -1);
	}
	const hash = trimmed.search(/\s#/);
	return (hash >= 0 ? trimmed.slice(0, hash) : trimmed).trim();
}

const SIMPLE_ESCAPES: Record<string, string> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

/**
 * Decode the body of a double-quoted value in one left-to-right pass. Every escape
 * `JSON.stringify` emits decodes to what it encoded, so `quoteEnvValue` round-trips
 * exactly. Hand-written dotenv lines stay readable: an unknown escape such as `\p`
 * in `"C:\path"` is kept as written, and so is an unescaped `"`.
 */
function unescapeDoubleQuoted(body: string): string {
	let out = "";
	for (let i = 0; i < body.length; i++) {
		const ch = body[i]!;
		if (ch !== "\\" || i + 1 >= body.length) {
			out += ch;
			continue;
		}
		const next = body[i + 1]!;
		const simple = SIMPLE_ESCAPES[next];
		if (simple !== undefined) {
			out += simple;
			i++;
			continue;
		}
		const hex = next === "u" ? body.slice(i + 2, i + 6) : "";
		if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
			out += String.fromCharCode(Number.parseInt(hex, 16));
			i += 5;
			continue;
		}
		out += ch;
	}
	return out;
}

function stringifyEnvLines(lines: EnvLine[]): string {
	const text = lines
		.map((line) => {
			if (line.kind === "raw") return line.raw;
			if (!KEY_RE.test(line.key)) throw new Error(`invalid env key: ${line.key}`);
			return `${line.key}=${quoteEnvValue(line.value)}`;
		})
		.join("\n");
	return text.endsWith("\n") ? text : `${text}\n`;
}

/** Bare when unambiguous, else JSON-quoted; `unescapeDoubleQuoted` is its inverse. */
function quoteEnvValue(value: string): string {
	if (value === "") return '""';
	if (/^[A-Za-z0-9_./:@,+-]+$/.test(value)) return value;
	return JSON.stringify(value);
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.pending-${process.pid}-${crypto.randomUUID()}`;
	// "wx" is O_CREAT|O_EXCL: never reuse or follow an existing path.
	const handle = await fs.promises.open(tmp, "wx", 0o600);
	try {
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (process.platform !== "win32") await fs.promises.chmod(tmp, 0o600);
		await fs.promises.rename(tmp, filePath);
	} catch (err) {
		await fs.promises.rm(tmp, { force: true });
		throw err;
	}
	if (process.platform !== "win32") {
		// Make the rename itself durable before reporting success.
		const dir = await fs.promises.open(path.dirname(filePath), "r");
		try {
			await dir.sync();
		} finally {
			await dir.close();
		}
	}
}
