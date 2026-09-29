import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fakeAddon, fakeNeoPiTree, FAKE_PLATFORM, FAKE_VERSION, tempDir, type FakeTreeOptions } from "../../../../scripts/fake-neopi-tree.ts";
import { loadedAddonProblem, nativeInputsFingerprint, sha256, type NativeRecord } from "./native-addon.ts";

const NATIVE = "packages/natives/native";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeTree(options?: FakeTreeOptions): string {
	const root = tempDir("npi-deck-native-");
	roots.push(root);
	return fakeNeoPiTree(path.join(root, "tree"), options);
}

function edit(tree: string, file: string, change: (text: string) => string): void {
	const full = path.join(tree, file);
	writeFileSync(full, change(readFileSync(full, "utf8")));
}

describe.skipIf(process.platform === "win32")("native input fingerprint", () => {
	test("covers the build recipe: the native build driver, host detection, Bazel config and the build:native script", () => {
		for (const [file, change] of [
			["scripts/bazel-natives.ts", (text: string) => `${text}// tweak\n`],
			["scripts/host-detect.ts", (text: string) => `${text}// tweak\n`],
			["BUILD.bazel", (text: string) => `${text}# tweak\n`],
			[".bazelversion", () => "9.0.0\n"],
			["package.json", (text: string) => text.replace("bun scripts/bazel-natives.ts", "bun scripts/bazel-natives.ts --release")],
		] as const) {
			const tree = fakeTree();
			const before = nativeInputsFingerprint(tree);
			edit(tree, file, change);
			expect([file, nativeInputsFingerprint(tree)]).not.toEqual([file, before]);
		}
	});

	test("ignores the bindings build:native regenerates and unrelated root package.json fields", () => {
		const tree = fakeTree();
		const before = nativeInputsFingerprint(tree);
		edit(tree, `${NATIVE}/index.js`, text => `${text}// regenerated\n`);
		edit(tree, `${NATIVE}/index.d.ts`, text => `${text}// regenerated\n`);
		edit(tree, "package.json", text => text.replace("echo tool-views generated", "echo other"));
		expect(nativeInputsFingerprint(tree)).toBe(before);
	});
});

describe.skipIf(process.platform === "win32")("loaded addon check", () => {
	function recorded(tree: string, name: string): NativeRecord {
		return {
			inputs: nativeInputsFingerprint(tree)!,
			platform: FAKE_PLATFORM,
			variant: "modern",
			sha256: sha256(readFileSync(path.join(tree, NATIVE, name))),
			packageVersion: FAKE_VERSION,
			provenance: "built",
			source: path.join(tree, NATIVE, name),
		};
	}

	test("validates the addon the loader fell back to, not the first candidate", async () => {
		const modern = `pi_natives.${FAKE_PLATFORM}-modern.node`;
		const baseline = `pi_natives.${FAKE_PLATFORM}-baseline.node`;
		const tree = fakeTree({ failLoad: [modern] });
		writeFileSync(path.join(tree, NATIVE, modern), fakeAddon("recorded"));
		writeFileSync(path.join(tree, NATIVE, baseline), fakeAddon("fallback"));
		const problem = await loadedAddonProblem(tree, recorded(tree, modern));
		expect(problem).toContain(path.join(tree, NATIVE, baseline));
	});

	test("accepts the recorded addon when the loader loads it", async () => {
		const modern = `pi_natives.${FAKE_PLATFORM}-modern.node`;
		const tree = fakeTree();
		writeFileSync(path.join(tree, NATIVE, modern), fakeAddon("recorded"));
		expect(await loadedAddonProblem(tree, recorded(tree, modern))).toBeNull();
	});
});
