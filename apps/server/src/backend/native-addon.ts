/**
 * Provenance of a NeoPi tree's `pi_natives` addon and the Bun engine gate.
 *
 * The version sentinel (`__piNativesV18_3_2`) is shared by every commit of a release, so it
 * cannot tell a stale addon from a matching one. A fingerprint of the native build inputs
 * can: scripts/neopi-setup.ts records, per tree, which addon bytes were built (or reused)
 * for which inputs, platform and CPU variant, and the backend probe re-checks that record.
 *
 * The record is local bookkeeping, not authentication: anyone who can write the tree can
 * write a record. It catches stale and swapped addons, not forged records.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { spawnOwnedSync } from "../owned-process.ts";

/**
 * Tree-relative inputs of a host `build:native` (root `bun --cwd=packages/natives run build` →
 * scripts/bazel-natives.ts → packages/natives/scripts/build-bindings.ts → cargo/napi): the
 * sources, lockfile and toolchain, and the build recipe (driver scripts, Bazel and Cargo
 * config). The root `build:native` script text is hashed separately.
 */
export const NATIVE_INPUTS = [
	"packages/natives",
	"crates",
	"Cargo.toml",
	"Cargo.lock",
	"rust-toolchain.toml",
	".cargo",
	"scripts/bazel-natives.ts",
	"scripts/host-detect*",
	"BUILD.bazel",
	"MODULE.bazel",
	"MODULE.bazel.lock",
	"bazel",
	".bazelrc",
	".bazelversion",
	".bazelignore",
];
/** Tracked files build-bindings regenerates (napi `--dts`, gen-enums); a build must not change the fingerprint. */
export const GENERATED_BINDINGS = ["packages/natives/native/index.js", "packages/natives/native/index.d.ts"];
/** Per-tree record, under the ignored node_modules so the checkout stays clean. */
export const NATIVE_RECORD = "node_modules/.npi-deck/native-addon.json";

export type CpuVariant = "modern" | "baseline" | null;

export interface NativeRecord {
	/** sha256 over NATIVE_INPUTS of the checkout the addon was built from. */
	inputs: string;
	/** Platform tag and CPU variant the addon was built for, from its built filename. */
	platform: string;
	variant: CpuVariant;
	/** sha256 of the addon file. */
	sha256: string;
	packageVersion: string;
	/**
	 * `built`: neopi-setup ran build:native on those inputs.
	 * `derived`: an unrecorded addon inside a checkout whose inputs were fingerprinted; the
	 * build itself was not observed.
	 */
	provenance: "built" | "derived";
	/** Where the addon file lived when first recorded. */
	source: string;
}

/** What the loader of this tree accepts, for comparing against a record. */
export interface NativeExpectation {
	inputs: string;
	platformTag: string;
	addonFilenames: string[];
	packageVersion: string;
}

export function versionSentinel(packageVersion: string): string {
	return `__piNativesV${packageVersion.replace(/[^A-Za-z0-9]/g, "_")}`;
}

/** Exact identifier-boundary match, mirroring packages/natives/native/version-sentinel.js. */
export function containsSentinel(bytes: Uint8Array, expected: string): boolean {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 0;
	while (offset < buffer.length) {
		const index = buffer.indexOf(expected, offset, "latin1");
		if (index === -1) return false;
		const next = buffer[index + expected.length];
		const identifierByte =
			next !== undefined &&
			(next === 95 || (next >= 48 && next <= 57) || (next >= 65 && next <= 90) || (next >= 97 && next <= 122));
		if (!identifierByte) return true;
		offset = index + expected.length;
	}
	return false;
}

export function sha256(bytes: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** `pi_natives.linux-x64-modern.node` → { platform: "linux-x64", variant: "modern" }. */
export function addonTarget(filename: string): { platform: string; variant: CpuVariant } | null {
	const match = /^pi_natives\.(.+?)(?:-(modern|baseline))?\.node$/.exec(filename);
	if (!match) return null;
	return { platform: match[1]!, variant: (match[2] as CpuVariant | undefined) ?? null };
}

function addonFilename(platform: string, variant: CpuVariant): string {
	return `pi_natives.${platform}${variant ? `-${variant}` : ""}.node`;
}

function git(root: string, args: string[]): string | null {
	const proc = spawnOwnedSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
	return proc.exitCode === 0 ? proc.stdout.toString() : null;
}

/**
 * sha256 over the path and content of every tracked or untracked-but-not-ignored file under
 * NATIVE_INPUTS (minus GENERATED_BINDINGS), plus the root `build:native` script, read from the
 * working tree (so uncommitted edits count). Ignored build outputs (`*.node`, `target/`) are
 * excluded. Null unless `root` is a git work tree root.
 */
export function nativeInputsFingerprint(root: string): string | null {
	const top = git(root, ["rev-parse", "--show-toplevel"])?.trim();
	if (!top || realpathSync(top) !== realpathSync(root)) return null;
	const excludes = GENERATED_BINDINGS.map(file => `:(exclude)${file}`);
	const listing = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...NATIVE_INPUTS, ...excludes]);
	if (listing === null) return null;
	const files = [...new Set(listing.split("\0").filter(Boolean))].sort();
	const hasher = new Bun.CryptoHasher("sha256");
	let buildScript: unknown = null;
	try {
		buildScript = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts?.["build:native"] ?? null;
	} catch {
		return null;
	}
	hasher.update(`package.json#scripts.build:native\0${JSON.stringify(buildScript)}\n`);
	for (const file of files) {
		const full = path.join(root, file);
		let entry: string;
		if (!existsSync(full) && !isLink(full)) entry = "deleted";
		else if (isLink(full)) entry = `link ${readlinkSync(full)}`;
		else if (lstatSync(full).isDirectory()) entry = `dir ${git(full, ["rev-parse", "HEAD"])?.trim() ?? "?"}`;
		else entry = `file ${sha256(readFileSync(full))}`;
		hasher.update(`${file}\0${entry}\n`);
	}
	return hasher.digest("hex");
}

function isLink(file: string): boolean {
	try {
		return lstatSync(file).isSymbolicLink();
	} catch {
		return false;
	}
}

export function readNativeRecord(tree: string): NativeRecord | null {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path.join(tree, NATIVE_RECORD), "utf8"));
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const r = value as Record<string, unknown>;
	const strings = ["inputs", "platform", "sha256", "packageVersion", "source"].every(key => typeof r[key] === "string");
	const variant = r.variant === "modern" || r.variant === "baseline" || r.variant === null;
	const provenance = r.provenance === "built" || r.provenance === "derived";
	return strings && variant && provenance ? (value as NativeRecord) : null;
}

export function writeNativeRecord(tree: string, record: NativeRecord): void {
	const file = path.join(tree, NATIVE_RECORD);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(record, null, "\t")}\n`);
}

/** Where an addon's provenance came from, strongest first. */
export type Evidence = "own-record" | "donor-record" | "derived";

/**
 * Establish what an addon file was built from when `tree` has no record for its bytes: a
 * record in the other checkout that holds it (for these exact bytes), else, with
 * `allowDerived`, that checkout's current native inputs. `derived` never applies to an
 * addon inside `tree` itself: its own sources say nothing about bytes nobody recorded.
 * Returns a reason when there is no acceptable evidence.
 */
export function addonProvenance(
	file: string,
	bytesSha: string,
	tree: string,
	allowDerived: boolean,
): { record: NativeRecord; evidence: Exclude<Evidence, "own-record"> } | string {
	const real = realpathSync(file);
	const nativeDir = path.dirname(real);
	const owner = path.resolve(nativeDir, "../../..");
	if (path.relative(owner, nativeDir) !== path.join("packages", "natives", "native")) {
		return `cannot tell which sources built ${real}: it is not inside a checkout's packages/natives/native`;
	}
	if (owner === realpathSync(tree)) {
		return `${real} is inside this tree and not recorded for these bytes (sha256 ${bytesSha.slice(0, 12)}); its own sources cannot vouch for it`;
	}
	const recorded = readNativeRecord(owner);
	if (recorded?.sha256 === bytesSha) return { record: recorded, evidence: "donor-record" };
	if (!allowDerived) {
		return `${owner} has no record for these bytes; the addon in this tree changed after it was recorded, so only a recorded build or --build-native can replace it`;
	}
	const target = addonTarget(path.basename(real));
	if (!target) return `cannot tell which platform ${real} was built for from its filename`;
	const inputs = nativeInputsFingerprint(owner);
	if (!inputs) return `cannot fingerprint the native inputs of ${owner}: not a git work tree root`;
	let packageVersion: string;
	try {
		packageVersion = (JSON.parse(readFileSync(path.join(owner, "packages/natives/package.json"), "utf8")) as { version: string }).version;
	} catch {
		return `cannot read ${owner}/packages/natives/package.json`;
	}
	return { record: { inputs, ...target, sha256: bytesSha, packageVersion, provenance: "derived", source: real }, evidence: "derived" };
}

/**
 * Which addon the tree's native loader actually loaded in this process, checked against the
 * record. The loader falls back through its candidates, so the first existing candidate is not
 * necessarily the one in use. Loads the addon if nothing has yet. `hashed` skips re-hashing a
 * file the caller already hashed. Null when the loaded file is the recorded one.
 */
export async function loadedAddonProblem(
	tree: string,
	record: NativeRecord,
	hashed?: { file: string; sha256: string },
): Promise<string | null> {
	const nativeDir = path.join(tree, "packages/natives/native");
	type Status = { path: string } | null;
	const loader = (await import(path.join(nativeDir, "loader-state.js"))) as { nativeAddonStatus?: () => Status };
	if (typeof loader.nativeAddonStatus !== "function") {
		return "the tree's native loader has no nativeAddonStatus(); cannot tell which addon it loaded";
	}
	let status = loader.nativeAddonStatus();
	if (!status) {
		await import(path.join(nativeDir, "index.js"));
		status = loader.nativeAddonStatus();
	}
	if (!status) return "the tree's native loader reports no loaded addon";
	const loaded = realpathSync(status.path);
	const sha = hashed && realpathSync(hashed.file) === loaded ? hashed.sha256 : sha256(readFileSync(loaded));
	if (sha === record.sha256) return null;
	return `the loader loaded ${status.path} (sha256 ${sha.slice(0, 12)}), not the recorded addon (sha256 ${record.sha256.slice(0, 12)})`;
}

/**
 * Every way `record` fails to describe the addon at `loadName` with bytes `bytesSha` for
 * this tree. Empty when it may be loaded.
 */
export function nativeRecordMismatches(record: NativeRecord, loadName: string, bytesSha: string, want: NativeExpectation): string[] {
	const problems: string[] = [];
	if (record.sha256 !== bytesSha) problems.push(`the recorded addon is sha256 ${record.sha256.slice(0, 12)}, this file is ${bytesSha.slice(0, 12)}`);
	if (record.packageVersion !== want.packageVersion) problems.push(`built for pi-natives ${record.packageVersion}, the tree is ${want.packageVersion}`);
	if (record.inputs !== want.inputs) {
		problems.push(`native inputs changed: built from ${record.inputs.slice(0, 12)}, the tree's are ${want.inputs.slice(0, 12)}`);
	}
	if (record.platform !== want.platformTag) problems.push(`built for ${record.platform}, this machine is ${want.platformTag}`);
	const loaded = addonTarget(loadName);
	if (loaded && loaded.variant !== record.variant) {
		problems.push(`wrong CPU variant: built as ${record.variant ?? "generic"}, loaded as ${loaded.variant ?? "generic"} (${loadName})`);
	} else if (!want.addonFilenames.includes(addonFilename(record.platform, record.variant))) {
		problems.push(`CPU variant ${record.variant ?? "generic"} is not usable here; the loader accepts ${want.addonFilenames.join(", ")}`);
	}
	return problems;
}

/** The tree's declared Bun engine (packages/utils/package.json), checked explicitly. Null when satisfied. */
export function bunEngineProblem(tree: string, version: string = Bun.version): string | null {
	const file = path.join(tree, "packages/utils/package.json");
	let range: unknown;
	try {
		range = (JSON.parse(readFileSync(file, "utf8")) as { engines?: { bun?: unknown } }).engines?.bun;
	} catch {
		return `cannot read ${file} to check the Bun engine`;
	}
	if (typeof range !== "string") return `${file} declares no engines.bun; cannot check the Bun version`;
	return Bun.semver.satisfies(version, range) ? null : `Bun ${version} does not satisfy NeoPi's engines.bun "${range}" (${file})`;
}
