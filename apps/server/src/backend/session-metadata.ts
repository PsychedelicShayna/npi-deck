import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { getDataDir } from "../env-store.ts";
import { activeBackend } from "./runtime.ts";

export interface SessionBackend { path: string; commit: string | null; version: string | null }
function file(): string { return path.join(getDataDir(), "session-backends.json"); }
function entries(): Record<string, SessionBackend> {
	if (!existsSync(file())) return {};
	try { return JSON.parse(readFileSync(file(), "utf8")) as Record<string, SessionBackend>; }
	catch { return {}; }
}

export function sessionBackend(sessionFile: string): SessionBackend | undefined { return entries()[sessionFile]; }
export function listSessionBackends(): Record<string, SessionBackend> { return entries(); }

/** Recording happens only after creation/resume succeeds; browsing never starts SDK sessions. */
export function recordSessionBackend(sessionFile: string | undefined): void {
	const backend = activeBackend();
	if (!sessionFile || !backend) return;
	const target = file();
	mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	const next = entries();
	next[sessionFile] = { path: backend.identity.path, commit: backend.identity.commit, version: backend.identity.version };
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
	renameSync(tmp, target);
}
