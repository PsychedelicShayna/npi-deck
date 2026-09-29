import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { broadcastBus, type BroadcastFrame } from "./broadcast-bus.ts";
import { KbService } from "./kb-service.ts";
import { startKbWatcher } from "./kb-watcher.ts";

let root: string;

function put(rel: string, content = `# ${rel}\n`): void {
	const abs = path.join(root, rel);
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, content, "utf8");
}

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "npi-deck-kbignore-"));
	put("notes/hub.md", "# Hub\n\nSee [[idea]], [[secret]], [[kept]] and [[tossed]]. needle\n");
	put("drafts/idea.md", "# Idea\n\nneedle\n");
	put("private/secret.md", "# Secret\n\nneedle\n");
	put("notes/private/public-after-all.md", "# Nested private\n");
	put("journal/today.tmp.md", "# Temp\n\nneedle\n");
	put("archive/kept.md", "# Kept\n");
	put("archive/tossed.md", "# Tossed\n\nneedle\n");
	put("node_modules/pkg/readme.md", "# Vendor\n\nneedle\n");
	writeFileSync(
		path.join(root, ".kbignore"),
		[
			"# kb-local exclusions",
			"drafts/",
			"/private",
			"*.tmp.md",
			"archive/**",
			"!archive/kept.md",
			"!node_modules/",
			"",
		].join("\n"),
		"utf8",
	);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("KbService with .kbignore", () => {
	test("tree hides ignored dirs and files but keeps negated ones", async () => {
		const kb = new KbService({ root });
		const top = await kb.getTree("");
		expect(top?.dirs.map((d) => d.name)).toEqual(["archive", "journal", "notes"]);
		expect((await kb.getTree("archive"))?.files.map((f) => f.name)).toEqual(["kept.md"]);
		expect((await kb.getTree("journal"))?.files).toEqual([]);
		// `/private` is anchored: a nested `private/` is still shown.
		expect((await kb.getTree("notes"))?.dirs.map((d) => d.name)).toEqual(["private"]);
		expect(await kb.getTree("drafts")).toBeUndefined();
		expect(await kb.getTree("private")).toBeUndefined();
		// Skip-set dirs stay hidden even when .kbignore negates them.
		expect(await kb.getTree("node_modules")).toBeUndefined();
		expect(top?.dirs.find((d) => d.name === "notes")?.mdCount).toBe(2);
	});

	test("ignored files are not readable, writable, searchable or graphed", async () => {
		const kb = new KbService({ root });
		expect(await kb.getFile("drafts/idea.md")).toBeUndefined();
		expect(await kb.getFile("journal/today.tmp.md")).toBeUndefined();
		expect(await kb.getFile("archive/kept.md")).toBeDefined();
		expect(await kb.saveFile("drafts/new.md", "# New\n", "create")).toEqual({ kind: "invalid-path" });

		const search = await kb.search("needle", 50);
		expect(search.results.map((r) => r.path)).toEqual(["notes/hub.md"]);

		const graph = await kb.getGraph();
		expect(graph.nodes.map((n) => n.path).sort()).toEqual([
			"archive/kept.md",
			"notes/hub.md",
			"notes/private/public-after-all.md",
		]);
		expect(graph.edges).toEqual([{ source: "notes/hub.md", target: "archive/kept.md" }]);
		const hub = await kb.getFile("notes/hub.md");
		expect(hub?.outgoingLinks.filter((l) => l.resolved).map((l) => l.target)).toEqual(["kept"]);
	});

	test("an edited .kbignore applies after the index is invalidated", async () => {
		const kb = new KbService({ root });
		expect((await kb.getTree(""))?.dirs.map((d) => d.name)).not.toContain("drafts");
		writeFileSync(path.join(root, ".kbignore"), "journal/\n", "utf8");
		kb.invalidate();
		const names = (await kb.getTree(""))?.dirs.map((d) => d.name);
		expect(names).toEqual(["archive", "drafts", "notes", "private"]);
		expect((await kb.search("needle", 50)).results.map((r) => r.path)).toContain("drafts/idea.md");
	});

	test("the watcher ignores excluded paths and reloads on .kbignore edits", async () => {
		const prev = process.env.NPI_DECK_WATCH_KB;
		delete process.env.NPI_DECK_WATCH_KB;
		const kb = new KbService({ root });
		await kb.ensureIndex();
		const frames: BroadcastFrame[] = [];
		const unsubscribe = broadcastBus.subscribe((f) => {
			if (f.type === "kb_changed") frames.push(f);
		});
		const dispose = startKbWatcher(kb);
		const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 700));
		try {
			await settle();
			frames.length = 0;
			put("drafts/another.md");
			put("private/more.md");
			put("node_modules/pkg/other.md");
			await settle();
			expect(frames).toHaveLength(0);

			writeFileSync(path.join(root, ".kbignore"), "", "utf8");
			await settle();
			expect(frames.length).toBeGreaterThan(0);
			expect((await kb.getTree(""))?.dirs.map((d) => d.name)).toContain("drafts");

			frames.length = 0;
			put("drafts/third.md");
			await settle();
			expect(frames.length).toBeGreaterThan(0);
		} finally {
			dispose();
			unsubscribe();
			if (prev === undefined) delete process.env.NPI_DECK_WATCH_KB;
			else process.env.NPI_DECK_WATCH_KB = prev;
		}
	});

	test("NPI_DECK_KB_EXCLUDE_DIRS still applies alongside .kbignore", async () => {
		const script = `
			import { KbService } from ${JSON.stringify(path.join(import.meta.dir, "kb-service.ts"))};
			const kb = new KbService({ root: ${JSON.stringify(root)} });
			const tree = await kb.getTree("");
			console.log(JSON.stringify(tree.dirs.map((d) => d.name)));
		`;
		const proc = Bun.spawn([process.execPath, "-e", script], {
			cwd: import.meta.dir,
			env: { ...process.env, NPI_DECK_KB_EXCLUDE_DIRS: "notes, journal" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual(["archive"]);
	});
});
