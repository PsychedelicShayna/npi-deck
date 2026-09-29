/**
 * Test fixture: a small committed git tree shaped like a NeoPi checkout, enough for
 * scripts/neopi-setup.ts and the backend probe to reach their native-addon checks.
 * `build:native` (scripts/bazel-natives.ts) writes a fake addon carrying the version sentinel
 * and regenerates the tracked bindings (index.js, index.d.ts), as the real host build does.
 * No Rust is built.
 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const FAKE_VERSION = "18.3.2";
export const FAKE_SENTINEL = "__piNativesV18_3_2";
export const FAKE_PLATFORM = "linux-x64";

export interface FakeTreeOptions {
	/** CPU variant the fake loader selects (x64 AVX2 detection stand-in). */
	variant?: "modern" | "baseline";
	/** `engines.bun` of packages/utils/package.json. */
	bunEngine?: string;
	/** Contents of crates/pi-natives/src/lib.rs, a native input. */
	crate?: string;
	/** Addon filenames the fake loader fails to load, falling back to the next candidate. */
	failLoad?: string[];
}

const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@localhost",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@localhost",
};

export function git(root: string, ...args: string[]): string {
	const proc = Bun.spawnSync(["git", "-C", root, ...args], { env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
	return proc.stdout.toString().trim();
}

export function commitAll(root: string, message = "fixture"): void {
	git(root, "add", "-A");
	git(root, "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", message);
}

export function tempDir(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function put(root: string, file: string, content: string): void {
	mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	writeFileSync(path.join(root, file), content);
}

/** Addon bytes: the sentinel at an identifier boundary, plus a label that makes each build distinct. */
export function fakeAddon(label: string): string {
	return `\0${FAKE_SENTINEL}\0${label}\0`;
}

function bindingsJs(stamp: string): string {
	return `import { loadNative } from "./loader-state.js";\nexport const bindings = loadNative();\n// generated: ${stamp}\n`;
}

export function fakeNeoPiTree(root: string, options: FakeTreeOptions = {}): string {
	const variant = options.variant ?? "modern";
	const names =
		variant === "modern"
			? [`pi_natives.${FAKE_PLATFORM}-modern.node`, `pi_natives.${FAKE_PLATFORM}-baseline.node`, `pi_natives.${FAKE_PLATFORM}.node`]
			: [`pi_natives.${FAKE_PLATFORM}-baseline.node`, `pi_natives.${FAKE_PLATFORM}.node`];
	mkdirSync(root, { recursive: true });
	put(root, ".gitignore", "node_modules\n*.node\n");
	put(
		root,
		"package.json",
		JSON.stringify({
			name: "fake-neopi",
			private: true,
			scripts: { "gen:tool-views": "echo tool-views generated", "build:native": "bun scripts/bazel-natives.ts" },
		}),
	);
	put(root, "packages/coding-agent/package.json", JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }));
	put(root, "packages/utils/package.json", JSON.stringify({ name: "@oh-my-pi/pi-utils", engines: { bun: options.bunEngine ?? ">=1.3.14" } }));
	put(root, "packages/natives/package.json", JSON.stringify({ name: "@oh-my-pi/pi-natives", version: FAKE_VERSION }));
	put(
		root,
		"packages/natives/native/loader-state.js",
		`import { existsSync } from "node:fs";
import * as path from "node:path";
const names = ${JSON.stringify(names)};
/** Addon filenames the fake dlopen rejects, so the loader falls back to the next candidate. */
const failLoad = new Set(${JSON.stringify(options.failLoad ?? [])});
let loaded = null;
export function initLoaderContext() {
	const nativeDir = import.meta.dir;
	return { platformTag: ${JSON.stringify(FAKE_PLATFORM)}, selectedVariant: ${JSON.stringify(variant)}, nativeDir, addonFilenames: names, candidates: names.map(name => path.join(nativeDir, name)) };
}
export function loadNative() {
	const candidate = initLoaderContext().candidates.find(file => existsSync(file) && !failLoad.has(path.basename(file)));
	if (!candidate) throw new Error("fake loader: no loadable addon");
	loaded = { path: candidate };
	return {};
}
export function nativeAddonStatus() {
	return loaded;
}
`,
	);
	put(root, "packages/natives/native/index.js", bindingsJs("checked in"));
	put(root, "packages/natives/native/index.d.ts", "// generated: checked in\n");
	// Mirrors the real host build: it writes the addon and regenerates the tracked bindings.
	put(
		root,
		"scripts/bazel-natives.ts",
		`import * as path from "node:path";
const native = path.join(import.meta.dir, "../packages/natives/native");
const stamp = String(Date.now());
await Bun.write(path.join(native, "${names[0]}"), ${JSON.stringify(fakeAddon("built"))} + stamp);
await Bun.write(path.join(native, "index.js"), ${JSON.stringify(bindingsJs("STAMP"))}.replace("STAMP", stamp));
await Bun.write(path.join(native, "index.d.ts"), "// generated: " + stamp + "\\n");
`,
	);
	put(root, "scripts/host-detect.ts", "export const avx2 = true;\n");
	put(root, "BUILD.bazel", "# natives targets\n");
	put(root, ".bazelversion", "8.0.0\n");
	put(root, "crates/pi-natives/src/lib.rs", options.crate ?? "pub fn natives() {}\n");
	put(root, "Cargo.toml", "[workspace]\nmembers = [\"crates/*\"]\n");
	put(root, "Cargo.lock", "version = 4\n");
	put(root, "rust-toolchain.toml", "[toolchain]\nchannel = \"1.0.0\"\n");
	mkdirSync(path.join(root, "node_modules/@oh-my-pi"), { recursive: true });
	symlinkSync(path.join(root, "packages/coding-agent"), path.join(root, "node_modules/@oh-my-pi/pi-coding-agent"));
	git(root, "init", "-q");
	commitAll(root);
	return root;
}
