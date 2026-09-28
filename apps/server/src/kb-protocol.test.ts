import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";

import { loadBackend, sdk } from "./backend/runtime.ts";
import { KbProtocolHandler } from "./kb-protocol.ts";

const ENV_KEYS = ["NPI_DECK_KB_ROOT", "HOME", "USERPROFILE"];

let saved: Record<string, string | undefined>;
let kbRoot: string;
let router: InternalUrlRouter;

beforeAll(async () => {
	await loadBackend();
});

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	kbRoot = mkdtempSync(path.join(os.tmpdir(), "npi-deck-kb-proto-"));
	process.env.NPI_DECK_KB_ROOT = kbRoot;
	// Wall off homedir as a safety net even though NPI_DECK_KB_ROOT wins.
	const tmpHome = mkdtempSync(path.join(os.tmpdir(), "npi-deck-kb-home-"));
	process.env.HOME = tmpHome;
	process.env.USERPROFILE = tmpHome;

	// Seed a small wiki.
	mkdirSync(path.join(kbRoot, "system"), { recursive: true });
	mkdirSync(path.join(kbRoot, "tools"), { recursive: true });
	writeFileSync(
		path.join(kbRoot, "system", "working-voice.md"),
		"# Working voice\n\nbody\n",
		"utf8",
	);
	writeFileSync(
		path.join(kbRoot, "system", "deck-orientation.md"),
		"# Deck orientation\n\nbody — with em-dash\n",
		"utf8",
	);
	writeFileSync(path.join(kbRoot, "tools", "x.md"), "x\n", "utf8");

	sdk().InternalUrlRouter.resetForTests();
	router = sdk().InternalUrlRouter.instance();
	router.register(new KbProtocolHandler());
});

afterEach(() => {
	sdk().InternalUrlRouter.resetForTests();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("kb:// resolution", () => {
	test("resolves an explicit `.md` path verbatim", async () => {
		const res = await router.resolve("kb://system/working-voice.md");
		expect(res.content).toContain("# Working voice");
		expect(res.contentType).toBe("text/markdown");
		expect(res.immutable).toBe(true);
		expect(res.sourcePath?.endsWith(path.join("system", "working-voice.md"))).toBe(true);
	});

	test("UTF-8 content (em-dash etc.) round-trips byte-exact", async () => {
		const res = await router.resolve("kb://system/deck-orientation.md");
		expect(res.content).toContain("with em-dash");
		expect(res.content.includes("\u2014")).toBe(true);
	});

	test("falls back to `.md` suffix when caller omits the extension", async () => {
		const res = await router.resolve("kb://system/working-voice");
		expect(res.content).toContain("# Working voice");
	});

	test("directory path returns a markdown index of entries", async () => {
		const res = await router.resolve("kb://system/");
		expect(res.contentType).toBe("text/markdown");
		expect(res.content).toContain("# kb://system/");
		expect(res.content).toContain("[working-voice.md](kb://system/working-voice.md)");
	});

	test("bare `kb://` lists the root", async () => {
		const res = await router.resolve("kb://");
		expect(res.content).toContain("# kb://");
		expect(res.content).toContain("[system/](kb://system/)");
		expect(res.content).toContain("[tools/](kb://tools/)");
	});

	test("missing file produces an actionable error mentioning the .md fallback", async () => {
		await expect(router.resolve("kb://system/nope")).rejects.toThrow(/\.md/);
	});

	test("path traversal is rejected", async () => {
		await expect(router.resolve("kb://../etc/passwd")).rejects.toThrow(/traversal/);
	});

	test("absolute / drive-letter paths are rejected", async () => {
		await expect(router.resolve("kb:///etc/passwd")).rejects.toThrow();
		await expect(router.resolve("kb://C:/Windows/System32")).rejects.toThrow();
	});

	test("NPI_DECK_KB_ROOT override is honored on every resolve", async () => {
		const altRoot = mkdtempSync(path.join(os.tmpdir(), "npi-deck-kb-alt-"));
		mkdirSync(path.join(altRoot, "system"), { recursive: true });
		writeFileSync(path.join(altRoot, "system", "x.md"), "ALT\n", "utf8");
		process.env.NPI_DECK_KB_ROOT = altRoot;
		const res = await router.resolve("kb://system/x.md");
		expect(res.content).toBe("ALT\n");
	});

	test("missing KB root yields an actionable error", async () => {
		process.env.NPI_DECK_KB_ROOT = path.join(os.tmpdir(), "does-not-exist-here", String(Math.random()));
		await expect(router.resolve("kb://anything")).rejects.toThrow(/NPI_DECK_KB_ROOT/);
	});
});
