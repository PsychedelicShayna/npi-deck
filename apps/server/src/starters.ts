/**
 * What the Starters settings panel shows: the skills and extensions bundled
 * with the deck, where the launch-time installers copy them, whether each is
 * there, and the switch that turns each installer off.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { StarterGroup, StarterItem } from "@npi-deck/protocol";

import { starterExtensionsDir, starterSkillsDir } from "./assets.ts";
import { isEnvFlagOff, resolveEnvSetting } from "./env-schema.ts";

export type StarterKind = "skills" | "extensions";

export const STARTER_AUTO_INSTALL_ENV: Record<StarterKind, string> = {
	skills: "NPI_DECK_INSTALL_STARTER_SKILLS",
	extensions: "NPI_DECK_INSTALL_STARTER_EXTENSIONS",
};

/** False when the kind's install switch is set to an off value (0, false, no, off). */
export function starterAutoInstallEnabled(kind: StarterKind): boolean {
	return !isEnvFlagOff(process.env[STARTER_AUTO_INSTALL_ENV[kind]]);
}

export function readStarterGroup(kind: StarterKind, agentDir: string): StarterGroup {
	const sourceDir = (kind === "skills" ? starterSkillsDir() : starterExtensionsDir()) ?? null;
	const targetDir = path.join(agentDir, kind);
	const { setting } = resolveEnvSetting(STARTER_AUTO_INSTALL_ENV[kind]);
	const items: StarterItem[] = [];
	if (sourceDir) {
		for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const installedPath = path.join(targetDir, entry.name);
			items.push({
				name: entry.name,
				description: kind === "skills"
					? skillDescription(path.join(sourceDir, entry.name, "SKILL.md"))
					: extensionDescription(path.join(sourceDir, entry.name, "index.ts")),
				installed: existsSync(installedPath),
				installedPath,
			});
		}
		items.sort((a, b) => a.name.localeCompare(b.name));
	}
	return { autoInstall: starterAutoInstallEnabled(kind), setting, sourceDir, targetDir, items };
}

/** `description` from SKILL.md frontmatter; empty when absent or unreadable. */
function skillDescription(file: string): string {
	try {
		const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"));
		const doc = match ? (YAML.parse(match[1] ?? "") as { description?: unknown } | null) : null;
		return typeof doc?.description === "string" ? doc.description.trim() : "";
	} catch {
		return "";
	}
}

/**
 * First paragraph of the leading doc comment after its title line, which
 * names the extension (see starter-extensions/maintenance-gate/index.ts).
 */
function extensionDescription(file: string): string {
	try {
		const match = /^\s*\/\*\*([\s\S]*?)\*\//.exec(readFileSync(file, "utf8"));
		if (!match) return "";
		const lines = (match[1] ?? "").split("\n").map((line) => line.replace(/^\s*\*\s?/, "").trim());
		const paragraphs = lines.join("\n").split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
		return paragraphs[1] ?? "";
	} catch {
		return "";
	}
}
