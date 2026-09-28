/**
 * The one place that knows where the deck's shipped files live: the web
 * bundle, SQL migrations, routine templates, starter skills and extensions,
 * the Telegram bridge entry, the build stamp.
 *
 * Today they are read from the checkout this module sits in, so the server
 * works from any cwd. A future single-binary build (`npi deck`) replaces this
 * module with embedded blobs; nothing else in the server may locate shipped
 * files through `import.meta.dir`, `__dirname` or `process.cwd()`.
 *
 * Each function returns undefined when the asset is absent, so callers keep
 * their own "not installed" behavior.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Repo root: this file is apps/server/src/assets.ts. */
export const DECK_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const SERVER_ROOT = path.join(DECK_ROOT, "apps", "server");

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function explicitDir(envKey: string): string | undefined {
	const value = process.env[envKey]?.trim();
	return value ? path.resolve(value) : undefined;
}

/** Built web bundle. `NPI_DECK_WEB_DIST` overrides; otherwise `apps/web/dist` once it holds an index.html. */
export function webDistDir(): string | undefined {
	const explicit = explicitDir("NPI_DECK_WEB_DIST");
	if (explicit) return isDir(explicit) ? explicit : undefined;
	const dist = path.join(DECK_ROOT, "apps", "web", "dist");
	return fs.existsSync(path.join(dist, "index.html")) ? dist : undefined;
}

export function migrationsDir(): string {
	return path.join(SERVER_ROOT, "src", "db", "migrations");
}

export function routineTemplatesDir(): string {
	return path.join(SERVER_ROOT, "src", "templates");
}

export function starterSkillsDir(): string | undefined {
	const dir = explicitDir("NPI_DECK_STARTER_SKILLS_DIR") ?? path.join(DECK_ROOT, "starter-skills");
	return isDir(dir) ? dir : undefined;
}

export function starterExtensionsDir(): string | undefined {
	const dir = explicitDir("NPI_DECK_STARTER_EXTENSIONS_DIR") ?? path.join(DECK_ROOT, "starter-extensions");
	return isDir(dir) ? dir : undefined;
}

export function telegramBridgeEntry(): string {
	const explicit = process.env.NPI_DECK_TELEGRAM_BRIDGE_ENTRY?.trim();
	return explicit ? path.resolve(explicit) : path.join(DECK_ROOT, "apps", "bridges", "telegram", "src", "index.ts");
}

/** `.buildinfo` stamp written next to a server build. */
export function buildInfoFile(): string {
	return path.join(SERVER_ROOT, ".buildinfo");
}
