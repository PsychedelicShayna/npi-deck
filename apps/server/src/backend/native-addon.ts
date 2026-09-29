/**
 * Provenance of a NeoPi tree's `pi_natives` addon and the Bun engine gate.
 *
 * The version sentinel (`__piNativesV18_3_2`) is shared by every commit of a release, so it
 * cannot tell a stale addon from a matching one. A fingerprint of the native build inputs
 * can: scripts/neopi-setup.ts records, per tree, which addon bytes were built (or reused)
 * for which inputs, platform and CPU variant, and the backend probe re-checks that record.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { spawnOwnedSync } from "../owned-process.ts";

/** Tree-relative sources a host `build:native` compiles from. */
export const NATIVE_INPUTS = ["packages/natives", "crates", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo"];
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
 * NATIVE_INPUTS, read from the working tree (so uncommitted edits count). Ignored build
 * outputs (`*.node`, `target/`) are excluded. Null unless `root` is a git work tree root.
 */
export function nativeInputsFingerprint(root: string): string | null {
	const top = git(root, ["rev-parse", "--show-toplevel"])?.trim();
	if (!top || realpathSync(top) !== realpathSync(root)) return null;
	const listing = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...NATIVE_INPUTS]);
	if (listing === null) return null;
	const files = [...new Set(listing.split("\0").filter(Boolean))].sort();
	const hasher = new Bun.CryptoHasher("sha256");
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

/**
 * Establish what an addon file was built from, without a record in the target tree:
 * a record in the checkout that holds it (for these exact bytes), else that checkout's
 * current native inputs. Returns a reason when neither is available.
 */
export function addonProvenance(file: string, bytesSha: string): NativeRecord | string {
	const real = realpathSync(file);
	const nativeDir = path.dirname(real);
	const owner = path.resolve(nativeDir, "../../..");
	if (path.relative(owner, nativeDir) !== path.join("packages", "natives", "native")) {
		return `cannot tell which sources built ${real}: it is not inside a checkout's packages/natives/native`;
	}
	const recorded = readNativeRecord(owner);
	if (recorded?.sha256 === bytesSha) return recorded;
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
	return { inputs, ...target, sha256: bytesSha, packageVersion, provenance: "derived", source: real };
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
		problems.push(`native inputs changed: built from ${record.inputs.slice(0, 12)}, the tree's are ${want.inputs.slice(0, 12)} (${NATIVE_INPUTS.join(", ")})`);
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
