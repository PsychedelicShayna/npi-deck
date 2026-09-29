import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { commitAll, fakeAddon, fakeNeoPiTree, FAKE_PLATFORM, tempDir, type FakeTreeOptions } from "./fake-neopi-tree.ts";

const SETUP = path.join(import.meta.dir, "neopi-setup.ts");
const RECORD = "node_modules/.npi-deck/native-addon.json";
const MODERN = `packages/natives/native/pi_natives.${FAKE_PLATFORM}-modern.node`;
const BASELINE = `packages/natives/native/pi_natives.${FAKE_PLATFORM}-baseline.node`;

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
	const root = tempDir("npi-deck-setup-");
	roots.push(root);
	return root;
}

function tree(root: string, name: string, options?: FakeTreeOptions): string {
	return fakeNeoPiTree(path.join(root, name), options);
}

/** Run the setup script against a prepared tree; never installs packages. */
function setup(root: string, target: string, ...args: string[]): { code: number; out: string } {
	const proc = Bun.spawnSync([process.execPath, SETUP, "--path", target, "--skip-install", ...args], {
		env: { ...process.env, NPI_DECK_HOME: path.join(root, "home"), NPI_DECK_NATIVE_DIRS: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode ?? -1, out: proc.stdout.toString() + proc.stderr.toString() };
}

function record(target: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path.join(target, RECORD), "utf8")) as Record<string, unknown>;
}

/** A donor checkout whose addon was built (and recorded) by the setup script from its own sources. */
function builtDonor(root: string, options?: FakeTreeOptions): string {
	const donor = tree(root, "donor", options);
	const built = setup(root, donor, "--build-native");
	if (built.code !== 0) throw new Error(`donor build failed:\n${built.out}`);
	return donor;
}

describe.skipIf(process.platform === "win32")("neopi-setup native addon provenance", () => {
	test("reuses a donor addon whose checkout has the same native inputs, and records its fingerprint", () => {
		const root = scratch();
		const donor = builtDonor(root);
		const target = tree(root, "target");
		const result = setup(root, target, "--native-dir", donor);
		expect(result.code).toBe(0);
		expect(lstatSync(path.join(target, MODERN)).isSymbolicLink()).toBe(true);
		expect(readlinkSync(path.join(target, MODERN))).toBe(path.join(donor, MODERN));
		expect(record(target)).toMatchObject({
			inputs: record(donor).inputs,
			platform: FAKE_PLATFORM,
			variant: "modern",
			sha256: record(donor).sha256,
			provenance: "built",
		});
	});

	test("an unrecorded donor addon is reused on source equality and labelled derived", () => {
		const root = scratch();
		const donor = tree(root, "donor");
		writeFileSync(path.join(donor, MODERN), fakeAddon("prebuilt elsewhere"));
		const target = tree(root, "target");
		const result = setup(root, target, "--native-dir", donor);
		expect(result.code).toBe(0);
		expect(result.out).toContain("derived");
		expect(record(target)).toMatchObject({ provenance: "derived", source: path.join(donor, MODERN) });
	});

	test("refuses an addon with the same version sentinel when a native input differs, and rebuilds on request", () => {
		const root = scratch();
		const donor = builtDonor(root, { crate: "pub fn natives() { /* older */ }\n" });
		const target = tree(root, "target");

		const refused = setup(root, target, "--native-dir", donor);
		expect(refused.code).not.toBe(0);
		expect(refused.out).toContain("native inputs");
		expect(existsSync(path.join(target, MODERN))).toBe(false);

		const rebuilt = setup(root, target, "--native-dir", donor, "--build-native");
		expect(rebuilt.code).toBe(0);
		expect(lstatSync(path.join(target, MODERN)).isFile()).toBe(true);
		expect(record(target)).toMatchObject({ provenance: "built", variant: "modern" });
		expect(record(target).inputs).not.toBe(record(donor).inputs);
	});

	test("an in-place addon stops matching once the tree's native sources change", () => {
		const root = scratch();
		const target = tree(root, "target");
		expect(setup(root, target, "--build-native").code).toBe(0);
		const before = readFileSync(path.join(target, MODERN));
		expect(setup(root, target).code).toBe(0);

		writeFileSync(path.join(target, "crates/pi-natives/src/lib.rs"), "pub fn natives() { changed(); }\n");
		commitAll(target, "change a crate");
		const stale = setup(root, target);
		expect(stale.code).not.toBe(0);
		expect(stale.out).toContain("native inputs changed");
		// Nothing was replaced without a rebuild or a matching donor.
		expect(readFileSync(path.join(target, MODERN))).toEqual(before);

		const rebuilt = setup(root, target, "--build-native");
		expect(rebuilt.code).toBe(0);
		expect(readFileSync(path.join(target, MODERN))).not.toEqual(before);
	});

	test("refuses an addon recorded for another CPU variant even under the right filename", () => {
		const root = scratch();
		const donor = builtDonor(root, { variant: "modern" });
		// A modern (AVX2) build renamed to the baseline filename.
		copyFileSync(path.join(donor, MODERN), path.join(donor, BASELINE));
		const target = tree(root, "target", { variant: "baseline" });
		const result = setup(root, target, "--native-dir", donor);
		expect(result.code).not.toBe(0);
		expect(result.out).toContain("CPU variant");
		expect(existsSync(path.join(target, BASELINE))).toBe(false);
	});

	test("refuses a Bun older than the tree's engines.bun before touching dependencies", () => {
		const root = scratch();
		const target = tree(root, "target", { bunEngine: ">=99.0.0" });
		const result = setup(root, target, "--build-native");
		expect(result.code).not.toBe(0);
		expect(result.out).toContain(`Bun ${Bun.version} does not satisfy`);
		expect(result.out).not.toContain("generating tool views");
		expect(existsSync(path.join(target, MODERN))).toBe(false);
	});
});
