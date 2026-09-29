import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commitAll, fakeAddon, fakeNeoPiTree, FAKE_PLATFORM, FAKE_VERSION, tempDir, type FakeTreeOptions } from "../../../../scripts/fake-neopi-tree.ts";
import { NATIVE_RECORD, nativeInputsFingerprint, sha256, writeNativeRecord } from "./native-addon.ts";
import { preflight } from "./probe.ts";

const MODERN = `packages/natives/native/pi_natives.${FAKE_PLATFORM}-modern.node`;
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fake tree with an addon in place and a record matching it, as neopi-setup leaves it. */
function recordedTree(options?: FakeTreeOptions): string {
	const root = tempDir("npi-deck-probe-tree-");
	roots.push(root);
	const tree = fakeNeoPiTree(path.join(root, "tree"), options);
	writeFileSync(path.join(tree, MODERN), fakeAddon("probe"));
	writeNativeRecord(tree, {
		inputs: nativeInputsFingerprint(tree)!,
		platform: FAKE_PLATFORM,
		variant: "modern",
		sha256: sha256(readFileSync(path.join(tree, MODERN))),
		packageVersion: FAKE_VERSION,
		provenance: "built",
		source: path.join(tree, MODERN),
	});
	return tree;
}

async function refusal(tree: string): Promise<string> {
	const result = await preflight(tree);
	if (result.ok) throw new Error("backend unexpectedly passed preflight");
	return result.reason;
}

test("refuses unprepared candidate before importing SDK modules", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "npi-deck-unprepared-"));
	try {
		mkdirSync(path.join(root, "packages/coding-agent"), { recursive: true });
		writeFileSync(path.join(root, "packages/coding-agent/package.json"), "{}\n");
		const result = await preflight(root);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unprepared backend unexpectedly passed preflight");
		expect(result.reason).toContain("tree not prepared: node_modules missing");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("refuses a Bun older than the tree's engines.bun", async () => {
	const tree = recordedTree({ bunEngine: ">=99.0.0" });
	expect(await refusal(tree)).toContain(`Bun ${Bun.version} does not satisfy NeoPi's engines.bun ">=99.0.0"`);
});

test("refuses an addon without a fingerprint record", async () => {
	const tree = recordedTree();
	rmSync(path.join(tree, NATIVE_RECORD));
	expect(await refusal(tree)).toContain("no fingerprint record");
});

test("refuses a recorded addon once the tree's native inputs change, though its sentinel still matches", async () => {
	const tree = recordedTree();
	writeFileSync(path.join(tree, "Cargo.lock"), "version = 4\n# bumped\n");
	commitAll(tree, "bump lock");
	expect(await refusal(tree)).toContain("native inputs changed");
});

test("refuses an addon replaced after it was recorded", async () => {
	const tree = recordedTree();
	writeFileSync(path.join(tree, MODERN), fakeAddon("swapped"));
	expect(await refusal(tree)).toContain("the recorded addon is sha256");
});
