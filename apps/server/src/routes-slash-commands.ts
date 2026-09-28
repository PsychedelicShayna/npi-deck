import * as path from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

import { Hono } from "hono";
import { sdk } from "./backend/runtime.ts";
import type {
	ListSlashCommandsResponse,
	SlashCommand,
	SlashCommandScope,
	SlashSubcommand,
} from "@omp-deck/protocol";

import { deckSlashCommandEntries } from "./deck-slash-commands.ts";

import { logger } from "./log.ts";

const log = logger("slash-commands");

/**
 * `GET /api/slash-commands?cwd=<absolute path>` enumerates the slash commands
 * available to a session, merging the user-global directory with the
 * project-local override directory.
 *
 * Resolution order matches the omp SDK's own:
 *
 * - **User scope**: `~/.omp/agent/commands/*.md`
 * - **Project scope** (only when `cwd` is supplied): `<cwd>/.omp/agent/commands/*.md`
 *
 * A project-scope file with the same basename as a user-scope file shadows the
 * user one, so the UI can show a single "winning" entry per command name.
 *
 * Each file is parsed for `description:` / `argument-hint:` in its YAML
 * frontmatter; missing/malformed frontmatter is tolerated — the command still
 * appears in the picker, just without help text. We never read the body since
 * the picker only needs the metadata.
 */
export function buildSlashCommandsRouter(): Hono {
	const app = new Hono();

	app.get("/slash-commands", (c) => {
		const cwd = c.req.query("cwd")?.trim();

		const userDir = path.join(sdk().getAgentDir(), "commands");
		// Map keyed by command name so project entries can shadow user entries.
		const byName = new Map<string, SlashCommand>();

		// Deck-native commands win on name. SDK builtins land next, then
		// user-global, then project-local — most-specific wins on conflict.
		for (const entry of deckSlashCommandEntries()) {
			byName.set(entry.name, entry);
		}
		for (const entry of loadBuiltinSlashCommands()) {
			if (!byName.has(entry.name)) byName.set(entry.name, entry);
		}

		for (const entry of readCommandDir(userDir, "user")) {
			byName.set(entry.name, entry);
		}
		if (cwd && path.isAbsolute(cwd)) {
			const projectDir = path.join(cwd, ".omp", "agent", "commands");
			// Skip when the cwd's `.omp/agent/commands/` resolves to the exact
			// same directory as the user-global one — happens when the active
			// session's cwd is the user's home dir (or a junction/link that
			// points there). Without this, the project pass would relabel every
			// user entry as "project" in the picker badge.
			if (path.resolve(projectDir) !== path.resolve(userDir)) {
				for (const entry of readCommandDir(projectDir, "project")) {
					byName.set(entry.name, entry);
				}
			}
		}

		const commands = [...byName.values()].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		const body: ListSlashCommandsResponse = { commands };
		return c.json(body);
	});

	return app;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function readCommandDir(dir: string, scope: SlashCommandScope): SlashCommand[] {
	let entries: string[];
	try {
		// statSync first so a non-directory path (file, symlink to nothing) is
		// caught explicitly instead of throwing inside readdirSync.
		if (!statSync(dir).isDirectory()) return [];
		entries = readdirSync(dir);
	} catch {
		return [];
	}

	const out: SlashCommand[] = [];
	for (const file of entries) {
		if (!file.endsWith(".md")) continue;
		const full = path.join(dir, file);
		try {
			const text = readFileSync(full, "utf8");
			const { description, argumentHint } = parseFrontmatter(text);
			const name = file.slice(0, -3); // strip ".md"
			const cmd: SlashCommand = { name, scope };
			if (description) cmd.description = description;
			if (argumentHint) cmd.argumentHint = argumentHint;
			out.push(cmd);
		} catch (err) {
			// One bad file shouldn't suppress the whole directory.
			log.warn(`failed to read slash command ${full}: ${String(err)}`);
		}
	}
	return out;
}

/**
 * Minimal YAML-frontmatter extractor for the two fields the picker uses.
 * Avoids pulling in a YAML dep for what is effectively a header-grep.
 *
 * Returns `{}` if the file doesn't start with `---`, or if no relevant keys
 * are present. Values are trimmed; surrounding single/double quotes are
 * stripped to match the omp SDK's own loader (which uses YAML proper).
 */
function parseFrontmatter(text: string): {
	description?: string;
	argumentHint?: string;
} {
	if (!text.startsWith("---")) return {};
	// Match `---\n…\n---` at the top of the file. The closing `---` must sit on
	// its own line, otherwise we treat the file as having no frontmatter.
	const end = text.indexOf("\n---", 3);
	if (end < 0) return {};
	const block = text.slice(3, end);

	const out: { description?: string; argumentHint?: string } = {};
	for (const rawLine of block.split(/\r?\n/)) {
		const line = rawLine.trimStart();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		let value = line.slice(colon + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (!value) continue;
		if (key === "description") out.description = value;
		else if (key === "argument-hint" || key === "argumenthint") out.argumentHint = value;
	}
	return out;
}

/**
 * Project the omp SDK's `BUILTIN_SLASH_COMMAND_DEFS` into deck `SlashCommand`
 * entries. Parents land with `scope: "builtin"` and carry their subcommand
 * inventory verbatim; each subcommand is ALSO flattened into its own
 * top-level entry named `<parent> <sub>` so the picker can surface them
 * directly when the user types e.g. `/copy last`. TUI-only commands (selectors,
 * wizards) are filtered out because the deck composer cannot drive them.
 */
function loadBuiltinSlashCommands(): SlashCommand[] {
	const out: SlashCommand[] = [];
	const { ACP_BUILTIN_SLASH_COMMANDS, BUILTIN_SLASH_COMMAND_DEFS } = sdk();
	const acpEnabled = new Set<string>(ACP_BUILTIN_SLASH_COMMANDS.map((c) => c.name));
	for (const def of BUILTIN_SLASH_COMMAND_DEFS) {
		// Skip TUI-only commands (selectors, wizards) — they'd land in the
		// picker as dead entries that fall through to the model as plain text.
		if (!acpEnabled.has(def.name)) continue;
		const parent: SlashCommand = { name: def.name, scope: "builtin" };
		if (def.description) parent.description = def.description;
		if (def.inlineHint) parent.argumentHint = def.inlineHint;
		if (def.subcommands && def.subcommands.length > 0) {
			const projected: SlashSubcommand[] = def.subcommands.map((sub) => {
				const s: SlashSubcommand = { name: sub.name, description: sub.description };
				if (sub.usage) s.usage = sub.usage;
				return s;
			});
			parent.subcommands = projected;
		}
		out.push(parent);
		if (def.subcommands) {
			for (const sub of def.subcommands) {
				const entry: SlashCommand = {
					name: `${def.name} ${sub.name}`,
					scope: "builtin",
					description: sub.description,
				};
				if (sub.usage) entry.argumentHint = sub.usage;
				out.push(entry);
			}
		}
	}
	return out;
}
