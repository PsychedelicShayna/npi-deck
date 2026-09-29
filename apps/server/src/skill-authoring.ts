/**
 * Authoring OMP user skills from the Skills view (#32).
 *
 * The deck writes only `<agentDir>/skills/<name>/SKILL.md`: the directory NeoPi's
 * native provider scans for user skills. Plugin, marketplace, project and other
 * providers' skills stay read-only.
 *
 * Guards:
 * - The skills root must resolve inside the resolved agent dir
 *   (`starterTargetRoot`, the same guard starter installs use).
 * - A skill directory must resolve to a direct child of that root, so a
 *   symlinked skill pointing elsewhere is refused. SKILL.md itself must be a
 *   regular file, never a symlink.
 * - A new name must pass NeoPi's Agent Skills validator (lowercase letters,
 *   digits and single hyphens), which rules out separators and dot segments,
 *   and nothing may already occupy its directory.
 * - Every write is read back through NeoPi's frontmatter parser, so the file
 *   says what the deck meant to write.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";

import { feature, hasFeature } from "./backend/runtime.ts";
import { starterTargetRoot } from "./starters.ts";

export const SKILL_FILE = "SKILL.md";

/** Upper bound on a SKILL.md the deck writes. Skill bodies are prose; this is generous. */
export const MAX_SKILL_BYTES = 256 * 1024;

export class SkillAuthoringError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 403 | 404 | 409 | 500 | 503,
	) {
		super(message);
		this.name = "SkillAuthoringError";
	}
}

function neopi() {
	if (!hasFeature("skill-authoring")) {
		throw new SkillAuthoringError(
			"This NeoPi backend does not expose its skill validator (manifest feature skill-authoring).",
			503,
		);
	}
	return feature("skill-authoring");
}

/** Drop NeoPi's capability read cache so the next listing reads SKILL.md from disk. */
export function forgetCachedSkillReads(): void {
	if (hasFeature("skill-authoring")) feature("skill-authoring").clearFsCache();
}

/** Short content hash of a SKILL.md, carried as the detail's `revision`. */
export function skillRevision(raw: string): string {
	return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/** The skills root, created if missing; throws when it resolves outside the agent dir. */
export async function userSkillsRoot(agentDir: string): Promise<string> {
	try {
		return await starterTargetRoot(agentDir, "skills");
	} catch (err) {
		throw new SkillAuthoringError((err as Error).message, 409);
	}
}

/** Name and description of a new skill, normalized the way NeoPi's validator reads them. */
export function checkNewSkill(rawName: unknown, rawDescription: unknown): { name: string; description: string } {
	if (typeof rawName !== "string") throw new SkillAuthoringError("name must be a string", 400);
	const name = rawName.trim().normalize("NFKC");
	const description = typeof rawDescription === "string" ? rawDescription.trim() : rawDescription;
	// The directory is the name, so the validator's name-matches-directory rule holds by construction.
	const violation = neopi().validateAgentSkillFrontmatter({ name, description }, name);
	if (violation !== null) throw new SkillAuthoringError(violation, 400);
	return { name, description: description as string };
}

/**
 * A skill keeps its name once it exists, so an edit is checked against the
 * description rules only: a conforming stand-in name keeps NeoPi's validator
 * from judging a hand-made skill's own name, which the deck never rewrites.
 */
export function checkDescription(rawDescription: unknown): string {
	const description = typeof rawDescription === "string" ? rawDescription.trim() : rawDescription;
	const standIn = "skill";
	const violation = neopi().validateAgentSkillFrontmatter({ name: standIn, description }, standIn);
	if (violation !== null) throw new SkillAuthoringError(violation, 400);
	return description as string;
}

function checkBody(body: unknown): string {
	if (typeof body !== "string") throw new SkillAuthoringError("body must be a string", 400);
	const text = body.replace(/\r\n?/g, "\n").replace(/^\n+/, "");
	return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

function render(frontmatter: YAML.Document, body: string): string {
	const yaml = frontmatter.toString({ lineWidth: 0, flowCollectionPadding: false });
	const content = `---\n${yaml}---\n\n${body}`;
	if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
		throw new SkillAuthoringError(`SKILL.md would exceed ${MAX_SKILL_BYTES / 1024} KiB`, 400);
	}
	return content;
}

/** Read `content` back through NeoPi's parser and confirm it carries what the deck wrote. */
function verifyReadsBack(content: string, expected: { name?: string; description: string }): void {
	const { frontmatter } = neopi().parseFrontmatter(content, { source: "npi-deck skill write", level: "off" });
	const readName = expected.name === undefined || frontmatter.name === expected.name;
	if (!readName || frontmatter.description !== expected.description) {
		throw new SkillAuthoringError("NeoPi would not read this SKILL.md back as written; nothing was saved", 500);
	}
}

/** Split a SKILL.md into its frontmatter YAML text (undefined when absent) and body. */
function splitFrontmatter(raw: string): { yaml: string | undefined; body: string } {
	const text = raw.replace(/\r\n?/g, "\n");
	if (!text.startsWith("---")) return { yaml: undefined, body: text };
	const end = text.indexOf("\n---", 3);
	if (end < 0) return { yaml: undefined, body: text };
	return { yaml: text.slice(4, end), body: text.slice(end + 4) };
}

/** Content of a new skill's SKILL.md. */
export function renderNewSkill(name: string, description: string, body: unknown): string {
	const content = render(new YAML.Document({ name, description }), checkBody(body));
	verifyReadsBack(content, { name, description });
	return content;
}

/**
 * Content of an edited SKILL.md: the new description and body, every other
 * frontmatter key (and its comments) kept as it was.
 */
export function renderEditedSkill(raw: string, description: string, body: unknown): string {
	const { yaml } = splitFrontmatter(raw);
	const doc: YAML.Document = yaml === undefined ? new YAML.Document({}) : YAML.parseDocument(yaml);
	if (doc.errors.length > 0) {
		throw new SkillAuthoringError(
			`SKILL.md frontmatter is not valid YAML (${doc.errors[0]!.message.split("\n")[0]}); fix it by hand first`,
			409,
		);
	}
	if (doc.contents === null) doc.contents = doc.createNode({});
	if (!YAML.isMap(doc.contents)) throw new SkillAuthoringError("SKILL.md frontmatter is not a mapping; fix it by hand first", 409);
	doc.set("description", description);
	const content = render(doc, checkBody(body));
	verifyReadsBack(content, { description });
	return content;
}

/** Where an existing user skill lives, after the containment checks. */
export interface UserSkillTarget {
	/** `<root>/<dirName>`: the directory entry the listing shows (may be a symlink inside the root). */
	entry: string;
	/** SKILL.md inside the resolved skill directory; always a regular file. */
	file: string;
}

/**
 * Resolve a listed SKILL.md path to a writable user skill. Returns undefined
 * when the path is not `<agentDir>/skills/<dir>/SKILL.md`; throws when it is
 * but resolves outside the skills root or SKILL.md is not a regular file.
 */
export async function resolveUserSkill(agentDir: string, skillPath: string): Promise<UserSkillTarget | undefined> {
	if (path.basename(skillPath) !== SKILL_FILE) return undefined;
	const entry = path.dirname(skillPath);
	if (path.dirname(entry) !== path.join(agentDir, "skills")) return undefined;
	const realRoot = await realpath(await userSkillsRoot(agentDir));
	let realDir: string;
	try {
		realDir = await realpath(entry);
	} catch {
		throw new SkillAuthoringError(`${entry} no longer exists`, 404);
	}
	if (path.dirname(realDir) !== realRoot) {
		throw new SkillAuthoringError(`${entry} resolves to ${realDir}, outside the skills root ${realRoot}; edit it where it lives`, 409);
	}
	const file = path.join(realDir, SKILL_FILE);
	let info;
	try {
		info = await lstat(file);
	} catch {
		throw new SkillAuthoringError(`${file} no longer exists`, 404);
	}
	if (!info.isFile()) throw new SkillAuthoringError(`${file} is a symlink or not a regular file; edit it where it lives`, 409);
	return { entry, file };
}

/** True when `skillPath` is a user skill the deck may edit. */
export async function isEditableUserSkill(agentDir: string, skillPath: string): Promise<boolean> {
	try {
		return (await resolveUserSkill(agentDir, skillPath)) !== undefined;
	} catch {
		return false;
	}
}

/** Write a new skill directory; returns the SKILL.md path the listing will show. */
export async function createUserSkill(agentDir: string, name: string, content: string): Promise<string> {
	const root = await userSkillsRoot(agentDir);
	const dir = path.join(root, name);
	try {
		await mkdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			throw new SkillAuthoringError(`${dir} already exists; pick another name`, 409);
		}
		throw err;
	}
	const file = path.join(dir, SKILL_FILE);
	try {
		await writeFile(file, content, { flag: "wx" });
	} catch (err) {
		await rm(dir, { recursive: true, force: true });
		throw err;
	}
	forgetCachedSkillReads();
	return file;
}

/** Replace SKILL.md atomically when it still has `revision`; the old file's mode is kept. */
export async function updateUserSkill(
	target: UserSkillTarget,
	revision: unknown,
	edit: (raw: string) => string,
): Promise<void> {
	if (typeof revision !== "string" || revision === "") {
		throw new SkillAuthoringError("revision required: send the revision from the skill detail", 400);
	}
	const raw = await readFile(target.file, "utf8");
	if (skillRevision(raw) !== revision) {
		throw new SkillAuthoringError("SKILL.md changed since the editor loaded it; reload and apply your change again", 409);
	}
	const content = edit(raw);
	const { mode } = await stat(target.file);
	const tmp = path.join(path.dirname(target.file), `.${SKILL_FILE}.${randomBytes(6).toString("hex")}.tmp`);
	await writeFile(tmp, content, { flag: "wx", mode: mode & 0o777 });
	try {
		await rename(tmp, target.file);
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
	forgetCachedSkillReads();
}

/**
 * Remove a skill's directory entry. A symlinked entry (which resolves inside
 * the root) loses only the link; the directory it points at stays listed.
 */
export async function deleteUserSkill(target: UserSkillTarget): Promise<void> {
	await rm(target.entry, { recursive: true });
	forgetCachedSkillReads();
}
