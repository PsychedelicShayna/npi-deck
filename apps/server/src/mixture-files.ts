/**
 * The MIXTURES.toml files NeoPi reads for a workspace, and link-safe IO on
 * them. The editor names a file only by an id from `mixtureSources`; the
 * server recomputes the list and never accepts a path from a client.
 *
 * Writes never follow links: a MIXTURES.toml that is a symlink (dangling or
 * not) or any non-regular file is refused, the containing directory must
 * resolve to where the search path says it is, and the new content goes to an
 * O_EXCL temp file in that directory that is fsynced and renamed over the
 * target (rename replaces the directory entry; it does not follow it).
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MixtureScope } from "@npi-deck/protocol";

export const ABSENT = "absent";
const OPEN_READ = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);

/** One file on NeoPi's mixture search path. Later sources shadow earlier ones by mixture name. */
export interface MixtureSource {
	/** Opaque: a digest of the path, so clients never send paths. */
	id: string;
	path: string;
	kind: MixtureScope;
	/** Position in NeoPi's discovery order (user, then project ancestor → cwd). */
	order: number;
	/** Why the deck will not write this file; undefined when editable. */
	readOnly?: string;
	/** The directory the file must live in, canonicalized, when it is editable. */
	expectedDir?: string;
}

export function sourceId(file: string): string {
	return createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 16);
}

export function digest(text: string | null): string {
	return text === null ? ABSENT : createHash("sha256").update(text).digest("hex");
}

async function realpathOrNull(target: string): Promise<string | null> {
	try {
		return await fs.realpath(target);
	} catch {
		return null;
	}
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * NeoPi's search path in its precedence order, restricted to files that
 * exist plus the two files the editor may create (the user file and the
 * project root's). `candidates` is `configCandidatePaths(cwd, agentDir,
 * ["MIXTURES.toml"])`, `projectDir` the workspace root the deck edits within.
 */
export async function mixtureSources(
	cwd: string,
	candidates: { candidates: readonly string[]; userPaths: ReadonlySet<string> },
	dirs: { projectDir: string; agentDir: string },
): Promise<MixtureSource[]> {
	const userFile = path.resolve(dirs.agentDir, "MIXTURES.toml");
	const rootFile = path.resolve(dirs.projectDir, "MIXTURES.toml");
	const [realAgent, realRoot] = await Promise.all([realpathOrNull(dirs.agentDir), realpathOrNull(dirs.projectDir)]);
	const listed: Array<MixtureSource & { depth: number; probe: number }> = [];
	for (const [probe, candidate] of candidates.candidates.entries()) {
		const file = path.resolve(candidate);
		const parent = path.dirname(file);
		const base = path.basename(parent);
		const isUser = candidates.userPaths.has(candidate);
		const ownerDir = base === ".omp" ? path.dirname(parent) : parent;
		// NeoPi skips files in dot-directories other than `.omp`.
		if (!isUser && path.basename(ownerDir).startsWith(".") && base !== ".omp") continue;
		if (file !== userFile && file !== rootFile && !(await exists(file))) continue;
		const relative = path.relative(cwd, ownerDir);
		const depth = relative === "" ? 0 : relative.split(path.sep).filter(Boolean).length;
		let readOnly: string | undefined;
		let expectedDir: string | undefined;
		if (isUser) {
			if (realAgent) expectedDir = realAgent;
			else readOnly = "the agent directory does not exist";
		} else {
			const inside = path.relative(dirs.projectDir, parent);
			if (inside.startsWith("..") || path.isAbsolute(inside)) readOnly = `outside the workspace root ${dirs.projectDir}`;
			else if (realRoot) expectedDir = path.join(realRoot, inside);
			else readOnly = "the workspace root does not exist";
		}
		listed.push({ id: sourceId(file), path: file, kind: isUser ? "user" : "project", order: 0, readOnly, expectedDir, depth, probe });
	}
	// NeoPi: user first, then project levels by depth descending (ancestors first); ties keep probe order.
	listed.sort((a, b) => (a.kind !== b.kind ? (a.kind === "user" ? -1 : 1) : b.depth - a.depth || a.probe - b.probe));
	return listed.map(({ depth: _depth, probe: _probe, ...source }, order) => ({ ...source, order }));
}

export type SourceRead =
	| { state: "absent" }
	| { state: "file"; text: string; mode: number }
	/** A link or special file: never read through for editing, never written. */
	| { state: "refused"; reason: string };

/**
 * Read a source without following a final symlink. A dangling link reads as
 * refused, not absent, so it cannot pass as a new file.
 */
export async function readSource(file: string, maxBytes: number): Promise<SourceRead> {
	let info: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		info = await fs.lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
		return { state: "refused", reason: `cannot inspect (${(error as NodeJS.ErrnoException).code ?? "error"})` };
	}
	if (info.isSymbolicLink()) return { state: "refused", reason: "is a symbolic link; the deck does not edit through links" };
	if (!info.isFile()) return { state: "refused", reason: "is not a regular file" };
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, OPEN_READ);
	} catch (error) {
		return { state: "refused", reason: `cannot open (${(error as NodeJS.ErrnoException).code ?? "error"})` };
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) return { state: "refused", reason: "is not a regular file" };
		if (stat.size > maxBytes) return { state: "refused", reason: `is ${stat.size} bytes; the cap is ${maxBytes}` };
		const buffer = Buffer.alloc(maxBytes + 1);
		let total = 0;
		while (total <= maxBytes) {
			const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		if (total > maxBytes) return { state: "refused", reason: `grew past the ${maxBytes}-byte cap` };
		return { state: "file", text: buffer.subarray(0, total).toString("utf8"), mode: stat.mode & 0o777 };
	} finally {
		await handle.close();
	}
}

export function readHash(read: SourceRead): string | null {
	return read.state === "absent" ? ABSENT : read.state === "file" ? digest(read.text) : null;
}

export class SourceConflictError extends Error {}

async function assertDirectory(source: MixtureSource): Promise<string> {
	const dir = path.dirname(source.path);
	if (source.readOnly || !source.expectedDir) throw new SourceConflictError(`${source.path} is not editable: ${source.readOnly ?? "no expected directory"}`);
	const real = await realpathOrNull(dir);
	if (real !== source.expectedDir) throw new SourceConflictError(`${dir} does not resolve to ${source.expectedDir}; refusing to write through a linked directory`);
	return dir;
}

async function fsyncDir(dir: string): Promise<void> {
	const handle = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * Replace (or, with `content === null`, remove) a source whose current hash
 * must still be `expectedHash`. The caller holds the cross-process lock; this
 * rechecks the target right before the rename, which narrows but cannot close
 * the window against a writer that does not take that lock.
 */
export async function writeSource(source: MixtureSource, content: string | null, expectedHash: string, maxBytes: number): Promise<void> {
	const dir = await assertDirectory(source);
	const recheck = async () => {
		const now = await readSource(source.path, maxBytes);
		if (now.state === "refused") throw new SourceConflictError(`${source.path} ${now.reason}`);
		if (readHash(now) !== expectedHash) throw new SourceConflictError(`${source.path} changed while saving; reload before saving`);
		return now;
	};
	const before = await recheck();
	if (content === null) {
		if (before.state === "file") {
			await assertDirectory(source);
			await recheck();
			await fs.unlink(source.path);
			await fsyncDir(dir);
		}
		return;
	}
	const temp = path.join(dir, `.MIXTURES.toml.${randomUUID()}.tmp`);
	const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	let renamed = false;
	try {
		try {
			await handle.writeFile(content, "utf8");
			// Keep an existing file's permissions; a new file stays 0600.
			if (before.state === "file") await handle.chmod(before.mode);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await assertDirectory(source);
		await recheck();
		await fs.rename(temp, source.path);
		renamed = true;
		await fsyncDir(dir);
	} finally {
		if (!renamed) await fs.rm(temp, { force: true });
	}
}
