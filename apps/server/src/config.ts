import * as os from "node:os";
import * as path from "node:path";

import { webDistDir } from "./assets.ts";
import { getDataDir } from "./env-store.ts";

export const DEFAULT_PORT = 1701;

export interface Config {
	host: string;
	port: number;
	defaultCwd: string;
	extraWorkspaces: string[];
	webDist?: string;
	devMode: boolean;
	/** Ms a session may sit without WS subscribers before the reaper disposes it. 0 disables. */
	idleTimeoutMs: number;
	/** Absolute path to the sqlite database file. */
	dbPath: string;
	/** Absolute path to the uploads root (images pasted into task bodies). */
	uploadsRoot: string;
}

export function parseInt10(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : fallback;
}

export function splitList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function loadConfig(): Config {
	const home = os.homedir();
	const defaultCwd = process.env.NPI_DECK_DEFAULT_CWD?.trim() || home;
	const extra = splitList(process.env.NPI_DECK_WORKSPACES);
	const webDist = webDistDir();
	const dbPath = path.resolve(process.env.NPI_DECK_DB_PATH?.trim() || path.join(getDataDir(), "deck.db"));

	return {
		host: process.env.NPI_DECK_HOST?.trim() || "127.0.0.1",
		port: parseInt10(process.env.NPI_DECK_PORT, DEFAULT_PORT),
		defaultCwd: path.resolve(defaultCwd),
		extraWorkspaces: extra.map((p) => path.resolve(p)),
		webDist,
		devMode: process.env.NODE_ENV !== "production",
		// 5 minutes default. Set to 0 to disable reaping (kernels live until SIGINT).
		idleTimeoutMs: parseInt10(process.env.NPI_DECK_IDLE_TIMEOUT_MS, 5 * 60_000),
		dbPath,
		uploadsRoot: path.resolve(process.env.NPI_DECK_UPLOADS_ROOT?.trim() || path.join(path.dirname(dbPath), "uploads")),
	};
}
