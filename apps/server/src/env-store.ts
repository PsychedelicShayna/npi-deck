import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const MANAGED_ENV_KEYS_LOADED = new Set<string>();

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

export function getDataDir(): string {
	const explicit = process.env.NPI_DECK_DATA_DIR?.trim();
	if (explicit) return path.resolve(explicit);
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
		return path.join(local, "npi-deck");
	}
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	return path.join(xdg ? path.resolve(xdg) : path.join(os.homedir(), ".config"), "npi-deck");
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
 * `MANAGED_ENV_KEYS_LOADED`.
 */
export function applyManagedEnvUpdatesToProcess(updates: Record<string, string | null>): string[] {
	const propagated: string[] = [];
	for (const [key, value] of Object.entries(updates)) {
		const ownedByManaged = MANAGED_ENV_KEYS_LOADED.has(key) || process.env[key] === undefined;
		if (!ownedByManaged) continue;
		if (value === null) {
			delete process.env[key];
			MANAGED_ENV_KEYS_LOADED.delete(key);
		} else {
			process.env[key] = value;
			MANAGED_ENV_KEYS_LOADED.add(key);
		}
		propagated.push(key);
	}
	return propagated;
}

export async function writeManagedEnvUpdates(
	updates: Record<string, string | null>,
	filePath = getManagedEnvPath(),
): Promise<void> {
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
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(raw);
		if (!match) return { kind: "raw", raw };
		const key = match[1]!;
		const value = parseValue(match[2] ?? "");
		return { kind: "entry", key, value };
	});
}

function parseValue(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
		return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
		return trimmed.slice(1, -1);
	}
	const hash = trimmed.search(/\s#/);
	return (hash >= 0 ? trimmed.slice(0, hash) : trimmed).trim();
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

function quoteEnvValue(value: string): string {
	if (value === "") return '""';
	if (/^[A-Za-z0-9_./:@,+-]+$/.test(value)) return value;
	return JSON.stringify(value);
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.pending-${process.pid}-${Date.now()}`;
	const handle = await fs.promises.open(tmp, "w", 0o600);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	if (process.platform !== "win32") await fs.promises.chmod(tmp, 0o600);
	await fs.promises.rename(tmp, filePath);
}
