/**
 * Starters: the skills and extensions bundled with the deck (`starter-skills/`,
 * `starter-extensions/`).
 *
 * Installation is opt-in, per starter. `NPI_DECK_STARTERS` lists the opted-in
 * ones as `skills/<name>` or `extensions/<name>`; unset means none, so a fresh
 * deck never writes into the NeoPi agent dir, which every `npi` session reads.
 * Opting in from Settings → Starters copies the starter right away, and each
 * launch with a loaded backend copies any opted-in starter that has gone
 * missing. The copy never overwrites: whatever occupies the destination,
 * a symlink included, belongs to the user. Opting out stops the launch-time
 * copy and leaves an installed copy in place.
 *
 * Each bundled starter carries a `source:` tag naming its origin: SKILL.md
 * frontmatter for skills, a line in the leading doc comment of index.ts for
 * extensions.
 */

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { cp, lstat, mkdir, realpath } from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";
import type { EnvBackedSetting, StarterGroup, StarterItem, StarterKind } from "@npi-deck/protocol";

import { starterExtensionsDir, starterSkillsDir } from "./assets.ts";
import { isEnvFlagOff, resolveEnvSetting } from "./env-schema.ts";
import { logger } from "./log.ts";

export type { StarterKind };

const log = logger("starters");

export const STARTER_KINDS: readonly StarterKind[] = ["skills", "extensions"];

/** The opt-in list: comma-separated `skills/<name>` and `extensions/<name>`. */
export const STARTERS_ENV = "NPI_DECK_STARTERS";

/** Switches from when every starter installed by default. The deck ignores them now. */
const RETIRED_STARTER_SWITCHES = ["NPI_DECK_INSTALL_STARTER_SKILLS", "NPI_DECK_INSTALL_STARTER_EXTENSIONS"];

export function starterId(kind: StarterKind, name: string): string {
	return `${kind}/${name}`;
}

/** Entries of an `NPI_DECK_STARTERS` value, trimmed, deduplicated and sorted. */
export function parseStarterList(value: string | undefined): string[] {
	return [...new Set((value ?? "").split(",").map((s) => s.trim()).filter(Boolean))].sort();
}

/** Starter ids opted in right now (`NPI_DECK_STARTERS` as the process sees it). */
export function optedInStarters(): Set<string> {
	return new Set(parseStarterList(process.env[STARTERS_ENV]));
}

function starterSourceDir(kind: StarterKind): string | undefined {
	return kind === "skills" ? starterSkillsDir() : starterExtensionsDir();
}

/** Names of the bundled starters of `kind`: the subdirectories of its bundle. */
export function bundledStarterNames(kind: StarterKind): string[] {
	const sourceDir = starterSourceDir(kind);
	if (!sourceDir) return [];
	try {
		return readdirSync(sourceDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

/**
 * Create `<agentDir>/<kind>` if needed and return it, but only when it
 * resolves inside the resolved agent dir. A symlinked skills or extensions
 * dir pointing elsewhere would make the copy write outside the agent dir, so
 * it throws instead.
 */
export async function starterTargetRoot(agentDir: string, kind: StarterKind): Promise<string> {
	const targetRoot = path.join(agentDir, kind);
	await mkdir(targetRoot, { recursive: true });
	const [realAgent, realTarget] = await Promise.all([realpath(agentDir), realpath(targetRoot)]);
	if (path.dirname(realTarget) !== realAgent || !(await lstat(realTarget)).isDirectory()) {
		throw new Error(`${targetRoot} resolves to ${realTarget}, outside the agent dir ${realAgent}`);
	}
	return targetRoot;
}

/** True when anything, including a dangling symlink, occupies `p`: that entry is the user's. */
async function pathOccupied(p: string): Promise<boolean> {
	try {
		await lstat(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Copy the bundled starter `kind/name` into `<agentDir>/<kind>/<name>`.
 * Returns "present" without writing when anything already occupies the
 * destination. Throws when `name` is not bundled, the target root escapes the
 * agent dir, or the copy fails.
 */
export async function installStarter(agentDir: string, kind: StarterKind, name: string): Promise<"installed" | "present"> {
	const sourceDir = starterSourceDir(kind);
	if (!sourceDir || !bundledStarterNames(kind).includes(name)) {
		throw new Error(`${starterId(kind, name)} is not a bundled starter`);
	}
	const dst = path.join(await starterTargetRoot(agentDir, kind), name);
	if (await pathOccupied(dst)) return "present";
	await cp(path.join(sourceDir, name), dst, { recursive: true });
	log.info(`installed starter ${starterId(kind, name)} → ${dst}`);
	return "installed";
}

/**
 * Launch-time install: copy each opted-in starter that is missing from the
 * agent dir. With nothing opted in, the agent dir is not touched at all.
 * Failures are logged per starter; returns the ids it copied.
 */
export async function installOptedInStarters(agentDir: string): Promise<string[]> {
	const installed: string[] = [];
	for (const id of optedInStarters()) {
		const slash = id.indexOf("/");
		const kind = id.slice(0, slash) as StarterKind;
		const name = id.slice(slash + 1);
		if (!STARTER_KINDS.includes(kind) || !bundledStarterNames(kind).includes(name)) {
			log.warn(`${STARTERS_ENV} lists ${id}, which this deck does not bundle; skipping it`);
			continue;
		}
		try {
			if ((await installStarter(agentDir, kind, name)) === "installed") installed.push(id);
		} catch (err) {
			log.warn(`could not install starter ${id}`, err);
		}
	}
	return installed;
}

/**
 * Say at launch that the old per-kind install switches no longer do anything.
 * An off value already matches the new default; any other value asked for
 * installs the deck no longer makes without an opt-in.
 */
export function reportRetiredStarterSwitches(): void {
	for (const key of RETIRED_STARTER_SWITCHES) {
		const value = process.env[key];
		if (value === undefined) continue;
		const hint = `starters are opt-in now; choose them in Settings → Starters (${STARTERS_ENV})`;
		if (isEnvFlagOff(value)) log.info(`${key} is retired and ignored; nothing installs by default: ${hint}`);
		else log.warn(`${key}=${value} is retired and ignored, so no starter installs by default: ${hint}`);
	}
}

export function readStarterGroup(kind: StarterKind, agentDir: string, optedIn: ReadonlySet<string>): StarterGroup {
	const sourceDir = starterSourceDir(kind) ?? null;
	const targetDir = path.join(agentDir, kind);
	const items: StarterItem[] = [];
	if (sourceDir) {
		for (const name of bundledStarterNames(kind)) {
			const installedPath = path.join(targetDir, name);
			const tags = kind === "skills"
				? skillTags(path.join(sourceDir, name, "SKILL.md"))
				: extensionTags(path.join(sourceDir, name, "index.ts"));
			items.push({
				kind,
				name,
				...tags,
				optedIn: optedIn.has(starterId(kind, name)),
				// Same test the installer uses: a symlink here, even a dangling one, is the user's copy.
				installed: lstatSync(installedPath, { throwIfNoEntry: false }) !== undefined,
				installedPath,
			});
		}
	}
	return { sourceDir, targetDir, items };
}

/** The `NPI_DECK_STARTERS` setting as Settings shows it, and the opt-in set it resolves to. */
export function resolveStartersSetting(): { setting: EnvBackedSetting; optedIn: Set<string> } {
	const { value, setting } = resolveEnvSetting(STARTERS_ENV);
	return { setting, optedIn: new Set(parseStarterList(value)) };
}

type StarterTags = Pick<StarterItem, "description" | "origin">;

/** `description` and `source` from SKILL.md frontmatter; empty/null when absent or unreadable. */
function skillTags(file: string): StarterTags {
	try {
		const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"));
		const doc = match ? (YAML.parse(match[1] ?? "") as { description?: unknown; source?: unknown } | null) : null;
		return {
			description: typeof doc?.description === "string" ? doc.description.trim() : "",
			origin: typeof doc?.source === "string" && doc.source.trim() ? doc.source.trim() : null,
		};
	} catch {
		return { description: "", origin: null };
	}
}

/**
 * From the leading doc comment of an extension's index.ts: the first
 * paragraph after the one that names the extension is its description, and a
 * `source:` line is its origin (see starter-extensions/maintenance-gate/index.ts).
 */
function extensionTags(file: string): StarterTags {
	try {
		const match = /^\s*\/\*\*([\s\S]*?)\*\//.exec(readFileSync(file, "utf8"));
		if (!match) return { description: "", origin: null };
		const lines = (match[1] ?? "").split("\n").map((line) => line.replace(/^\s*\*\s?/, "").trim());
		const source = lines.find((line) => /^source:/.test(line))?.slice("source:".length).trim();
		const paragraphs = lines
			.filter((line) => !/^source:/.test(line))
			.join("\n")
			.split(/\n\s*\n/)
			.map((p) => p.replace(/\s*\n\s*/g, " ").trim())
			.filter(Boolean);
		return { description: paragraphs[1] ?? "", origin: source || null };
	} catch {
		return { description: "", origin: null };
	}
}
