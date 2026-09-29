/**
 * The bundled `kb-orphan-census` template, run end to end by the routines
 * runner against a temp KB: what lands in the inbox, and when nothing does.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "../db/index.ts";
import { listInbox } from "../db/inbox.ts";
import { createV1Routine } from "../db/routines.ts";
import { RoutinesRunner } from "../routines-runner.ts";
import { loadTemplate } from "./templates.ts";

const savedRoot = process.env.NPI_DECK_KB_ROOT;
let home = "";
let runner: RoutinesRunner | undefined;

function setup(kb: Record<string, string>): string {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "npi-deck-census-routine-"));
	const kbRoot = path.join(home, "kb");
	for (const [rel, body] of Object.entries(kb)) {
		fs.mkdirSync(path.dirname(path.join(kbRoot, rel)), { recursive: true });
		fs.writeFileSync(path.join(kbRoot, rel), body);
	}
	process.env.NPI_DECK_HOME = home;
	process.env.NPI_DECK_DB_PATH = path.join(home, "deck.db");
	process.env.NPI_DECK_KB_ROOT = kbRoot;
	openDb({ path: process.env.NPI_DECK_DB_PATH });
	runner = new RoutinesRunner();
	// Same row the install endpoint creates: the template, disabled.
	const loaded = loadTemplate("kb-orphan-census");
	if (!loaded) throw new Error("kb-orphan-census template missing");
	return createV1Routine({
		name: loaded.spec.name,
		description: loaded.spec.description ?? "",
		specYaml: loaded.specYaml,
		spec: loaded.spec,
		enabled: false,
	}).id;
}

afterEach(async () => {
	await runner?.dispose();
	closeDb();
	delete process.env.NPI_DECK_HOME;
	delete process.env.NPI_DECK_DB_PATH;
	if (savedRoot === undefined) delete process.env.NPI_DECK_KB_ROOT;
	else process.env.NPI_DECK_KB_ROOT = savedRoot;
	if (home) fs.rmSync(home, { recursive: true, force: true });
	home = "";
	runner = undefined;
});

const reports = () => listInbox({}).filter((i) => i.source === "routine:kb-orphan-census");

test("a manual run files one inbox report of the orphans outside .kbignore; cron stays off until enabled", async () => {
	const id = setup({
		"README.md": "# Home\n\n[[tools/hub]]\n",
		"tools/hub.md": "---\nname: Tools hub\n---\n# Tools\n\n[[grep]]\n",
		"tools/grep.md": "# grep\n",
		"tools/stray.md": "---\nname: A stray note\n---\n# Stray\n",
		"writing/draft.md": "# Draft\n\n[[grep]]\n",
		"private/secret.md": "# Secret\n",
		".kbignore": "private/\n",
	});

	await runner!.fire(id, "cron");
	expect(reports()).toEqual([]);

	await runner!.fire(id, "manual");
	const [report, ...rest] = reports();
	expect(rest).toEqual([]);
	expect(report!.kind).toBe("investigation");
	expect(report!.title).toMatch(/^KB orphan census - \d{4}-\d{2}-\d{2}: 3 orphan note\(s\)$/);
	const body = report!.body;
	expect(body).toContain("3 of 5 notes under");
	expect(body).toContain("## Isolated: no links in or out (1)\n\n- `tools/stray.md` - A stray note");
	expect(body).toContain("## Links out, but nothing links in (2)\n\n- `README.md`\n- `writing/draft.md`");
	expect(body).not.toContain("private/secret.md");
	expect(body).not.toContain("tools/grep.md");

	// While that report is unprocessed, a second run files nothing new.
	await runner!.fire(id, "manual");
	expect(reports()).toHaveLength(1);
});

test("a KB with no orphans files nothing", async () => {
	const id = setup({
		"a.md": "# A\n\n[[b]]\n",
		"b.md": "# B\n\n[[a]]\n",
	});
	await runner!.fire(id, "manual");
	expect(reports()).toEqual([]);
});
