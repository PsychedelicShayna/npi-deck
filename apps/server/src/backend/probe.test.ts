import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preflight } from "./probe.ts";

test("refuses unprepared candidate before importing SDK modules", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "npi-deck-unprepared-"));
	try {
		mkdirSync(path.join(root, "packages/coding-agent"), { recursive: true });
		writeFileSync(path.join(root, "packages/coding-agent/package.json"), "{}\n");
		const result = await preflight(root);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("tree not prepared: node_modules missing");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
