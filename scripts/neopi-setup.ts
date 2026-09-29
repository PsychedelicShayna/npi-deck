#!/usr/bin/env bun
/**
 * Prepare a NeoPi source tree as an npi-deck backend.
 *
 *   bun scripts/neopi-setup.ts [<sha>]          worktree at ~/.npi-deck/neopi/<fullsha> (default: neopi.pin)
 *   bun scripts/neopi-setup.ts --path <dir>     prepare an existing tree in place
 *
 * Options:
 *   --source <repo>       NeoPi checkout to add worktrees from
 *                         (env NPI_DECK_NEOPI_SOURCE; default ~/source/github/PsychedelicShayna/neopi)
 *   --native-dir <dir>    where to look for a prebuilt pi_natives addon; repeatable
 *                         (env NPI_DECK_NATIVE_DIRS, ':'-separated; replaces the defaults)
 *   --copy                copy the addon into the tree instead of symlinking it
 *   --build-native        run the tree's build:native when no addon matches (also when the addon
 *                         in place was built from other native inputs)
 *   --tsconfig            write tsconfig.neopi.json even when the tree is not the pinned commit
 *   --skip-install        use an already prepared node_modules; no package fetch/install
 *
 * Env NPI_DECK_HOME overrides ~/.npi-deck.
 *
 * Steps: worktree (idempotent) → Bun engine gate → frozen install (unless skipped) → gen:tool-views →
 * native addon (version sentinel + fingerprint of its native inputs, platform, CPU variant and
 * file sha256, recorded in <tree>/node_modules/.npi-deck/native-addon.json) →
 * register in <home>/config.yml → tsconfig.neopi.json.
 *
 * An addon is reused only when its recorded (or, for an unrecorded addon inside another
 * checkout, that checkout's) native-input fingerprint equals this tree's; a mismatch needs
 * a matching --native-dir or --build-native, even when the version sentinel is the same.
 */
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { parseDocument, YAMLSeq, isMap, isSeq } from "yaml";
import {
	addonProvenance,
	addonTarget,
	bunEngineProblem,
	containsSentinel,
	NATIVE_RECORD,
	nativeInputsFingerprint,
	nativeRecordMismatches,
	readNativeRecord,
	sha256,
	versionSentinel,
	writeNativeRecord,
	type Evidence,
	type NativeExpectation,
	type NativeRecord,
} from "../apps/server/src/backend/native-addon.ts";

const DECK_ROOT = path.resolve(import.meta.dir, "..");
const HOME = os.homedir();
const DEFAULT_SOURCE = path.join(HOME, "source/github/PsychedelicShayna/neopi");
const DEFAULT_NATIVE_DIRS = [path.join(HOME, "source/github/PsychedelicShayna/neopi-sync-v18.3.2")];

function die(message: string): never {
	console.error(`neopi-setup: ${message}`);
	process.exit(1);
}

function step(message: string): void {
	console.log(`==> ${message}`);
}

function run(cmd: string[], cwd: string): void {
	console.log(`$ (cd ${cwd} && ${cmd.join(" ")})`);
	const proc = Bun.spawnSync(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] });
	if (proc.exitCode !== 0) die(`command failed (exit ${proc.exitCode}): ${cmd.join(" ")}`);
}

function capture(cmd: string[], cwd?: string): string | null {
	const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) return null;
	return proc.stdout.toString().trim();
}

const { values: opts, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		path: { type: "string" },
		source: { type: "string" },
		"native-dir": { type: "string", multiple: true },
		copy: { type: "boolean", default: false },
		"build-native": { type: "boolean", default: false },
		"skip-install": { type: "boolean", default: false },
		tsconfig: { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

if (opts.help) {
	console.log(readFileSync(import.meta.path, "utf8").split("*/")[0]);
	process.exit(0);
}
if (opts.path && positionals.length > 0) die("pass either <sha> or --path <dir>, not both");
if (positionals.length > 1) die(`unexpected arguments: ${positionals.join(" ")}`);

const npiHome = process.env.NPI_DECK_HOME || path.join(HOME, ".npi-deck");
const pinFile = path.join(DECK_ROOT, "neopi.pin");
const pinned = existsSync(pinFile) ? readFileSync(pinFile, "utf8").trim() : null;

// ---- 1. Tree ---------------------------------------------------------------
let tree: string;
let fullSha: string;
if (opts.path) {
	tree = path.resolve(opts.path);
	if (!existsSync(path.join(tree, "packages/coding-agent/package.json"))) die(`${tree} is not a NeoPi source tree`);
	fullSha = capture(["git", "-C", tree, "rev-parse", "HEAD"]) ?? die(`cannot read the git HEAD of ${tree}`);
	step(`using existing tree ${tree} at ${fullSha}`);
} else {
	const source = path.resolve(opts.source || process.env.NPI_DECK_NEOPI_SOURCE || DEFAULT_SOURCE);
	const rev = positionals[0] ?? pinned ?? die("no <sha> given and neopi.pin is missing");
	fullSha =
		capture(["git", "-C", source, "rev-parse", "--verify", `${rev}^{commit}`]) ??
		die(`${rev} is not a commit in ${source}`);
	tree = path.join(npiHome, "neopi", fullSha);
	if (existsSync(tree)) {
		const head = capture(["git", "-C", tree, "rev-parse", "HEAD"]);
		if (head !== fullSha) die(`${tree} exists but is at ${head ?? "<not a git tree>"}, expected ${fullSha}`);
		step(`worktree already at ${fullSha}: ${tree}`);
	} else {
		step(`creating detached worktree ${tree}`);
		mkdirSync(path.dirname(tree), { recursive: true });
		run(["git", "-C", source, "worktree", "add", "--detach", tree, fullSha], DECK_ROOT);
	}
}
const shortSha = capture(["git", "-C", tree, "rev-parse", "--short=10", "HEAD"]) ?? fullSha.slice(0, 10);

// ---- 2. Bun engine and dependencies ----------------------------------------
// NeoPi declares its Bun floor in packages/utils/package.json; check it explicitly for the Bun
// running this script (which the deck also runs on) and for the `bun` the steps below spawn.
const bunVersions = new Map([[Bun.version, `this Bun (${process.execPath})`]]);
const pathBun = capture(["bun", "--version"]);
if (pathBun && !bunVersions.has(pathBun)) bunVersions.set(pathBun, "the bun on PATH");
for (const [version, label] of bunVersions) {
	const problem = bunEngineProblem(tree, version);
	if (problem) die(`${label}: ${problem}`);
}
step(`Bun ${[...bunVersions.keys()].join(", ")} satisfies the tree's engines.bun`);

// A caller can reuse a known dependency tree without contacting any package registry.
// Require the local workspace package to resolve into this tree, not an older pin.
if (opts["skip-install"]) {
	const workspace = path.join(tree, "node_modules/@oh-my-pi/pi-coding-agent");
	if (!existsSync(path.join(tree, "node_modules")) || !existsSync(workspace) ||
		realpathSync(workspace) !== path.join(tree, "packages/coding-agent")) {
		die("--skip-install requires prepared node_modules with workspace links into this tree");
	}
	step("reusing prepared dependencies (--skip-install)");
} else {
	step("installing the tree's dependencies");
	run(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], tree);
}
step("generating tool views");
run(["bun", "run", "gen:tool-views"], tree);

// ---- 3. Native addon -------------------------------------------------------
const packageVersion = (JSON.parse(readFileSync(path.join(tree, "packages/natives/package.json"), "utf8")) as {
	version: string;
}).version;
const sentinel = versionSentinel(packageVersion);
// Ask the tree's own loader which files it would try, in order (variant, platform tag, dirs).
const loaderState = (await import(path.join(tree, "packages/natives/native/loader-state.js"))) as {
	initLoaderContext(): {
		platformTag: string;
		selectedVariant: string | null;
		nativeDir: string;
		addonFilenames: string[];
		candidates: string[];
	};
};
const ctx = loaderState.initLoaderContext();
const treeInputs =
	nativeInputsFingerprint(tree) ?? die(`cannot fingerprint the native inputs of ${tree}: not a git work tree root`);
const want: NativeExpectation = {
	inputs: treeInputs,
	platformTag: ctx.platformTag,
	addonFilenames: ctx.addonFilenames,
	packageVersion,
};
step(
	`native addon: need sentinel ${sentinel}, native inputs ${treeInputs.slice(0, 12)}, ` +
		`${ctx.platformTag}${ctx.selectedVariant ? ` ${ctx.selectedVariant}` : ""}; loader tries ${ctx.addonFilenames.join(", ")}`,
);
const ownRecord = readNativeRecord(tree);

/** The first existing candidate is the one the loader will load. */
function effectiveAddon(): string | null {
	return ctx.candidates.find(candidate => existsSync(candidate)) ?? null;
}

interface Assessment {
	record: NativeRecord | null;
	evidence: Evidence | null;
	bytesSha: string;
	problems: string[];
}

/**
 * Whether `file`, loaded under `loadName`, may serve this tree, and on what evidence: this
 * tree's record for these exact bytes, else the record of the other checkout holding the
 * file, else (with `allowDerived`) that checkout's native inputs.
 */
function assess(file: string, loadName: string, allowDerived: boolean): Assessment {
	const bytes = readFileSync(file);
	const bytesSha = sha256(bytes);
	if (!containsSentinel(bytes, sentinel)) return { record: null, evidence: null, bytesSha, problems: [`lacks ${sentinel}`] };
	if (ownRecord?.sha256 === bytesSha) {
		const problems = nativeRecordMismatches(ownRecord, loadName, bytesSha, want);
		if (problems.length === 0) return { record: ownRecord, evidence: "own-record", bytesSha, problems };
		// The same bytes may still be current by the donor checkout's evidence, e.g. after the
		// fingerprint gained inputs; the tree's own sources are never asked (addonProvenance).
		const found = addonProvenance(file, bytesSha, tree, allowDerived);
		if (typeof found !== "string") {
			const donorProblems = nativeRecordMismatches(found.record, loadName, bytesSha, want);
			if (donorProblems.length === 0) return { ...found, bytesSha, problems: donorProblems };
		}
		return { record: ownRecord, evidence: "own-record", bytesSha, problems };
	}
	const found = addonProvenance(file, bytesSha, tree, allowDerived);
	if (typeof found === "string") {
		const changed = ownRecord ? [`the recorded addon is sha256 ${ownRecord.sha256.slice(0, 12)}, this file is ${bytesSha.slice(0, 12)}`] : [];
		return { record: null, evidence: null, bytesSha, problems: [...changed, found] };
	}
	return { ...found, bytesSha, problems: nativeRecordMismatches(found.record, loadName, bytesSha, want) };
}

function describe(record: NativeRecord, evidence: Evidence): string {
	if (evidence === "derived") {
		return `derived (unverified): ${record.source} sits in another checkout whose native inputs equal this tree's; its build was not observed`;
	}
	const where = evidence === "own-record" ? "this tree's record" : `the record beside ${record.source}`;
	return record.provenance === "built"
		? `built by neopi-setup from native inputs ${record.inputs.slice(0, 12)} (${where})`
		: `derived (unverified) from ${record.source}, per ${where}; its build was not observed`;
}

let verified: { file: string; record: NativeRecord; evidence: Evidence } | null = null;
/** An addon in the tree's native dir that no longer matches; replaced once a match is in hand. */
let stale: string | null = null;
/** Once the tree's recorded addon has been replaced by other bytes, only recorded evidence may replace it. */
let allowDerived = true;
const current = effectiveAddon();
if (current) {
	const { record, evidence, bytesSha, problems } = assess(current, path.basename(current), true);
	if (record && evidence && problems.length === 0) {
		verified = { file: current, record, evidence };
		step(`addon already in place: ${current}`);
	} else {
		console.log(`    stale    ${current}: ${problems.join("; ")}`);
		if (path.resolve(path.dirname(current)) !== path.resolve(ctx.nativeDir)) {
			die(`the loader would load ${current}, which does not match this tree. Remove or replace it, then re-run this script.`);
		}
		stale = current;
		if (ownRecord && bytesSha !== ownRecord.sha256) allowDerived = false;
	}
}
if (!verified) {
	const envDirs = process.env.NPI_DECK_NATIVE_DIRS?.split(":").filter(Boolean);
	const searchDirs = opts["native-dir"] ?? envDirs ?? DEFAULT_NATIVE_DIRS;
	let found: { file: string; name: string; record: NativeRecord; evidence: Evidence; bytesSha: string } | null = null;
	search: for (const name of ctx.addonFilenames) {
		for (const dir of searchDirs) {
			for (const candidateDir of [dir, path.join(dir, "packages/natives/native")]) {
				const file = path.join(candidateDir, name);
				if (!existsSync(file)) continue;
				const { record, evidence, bytesSha, problems } = assess(file, name, allowDerived);
				console.log(problems.length === 0 ? `    match    ${file}` : `    mismatch ${file}: ${problems.join("; ")}`);
				if (record && evidence && problems.length === 0) {
					found = { file: realpathSync(file), name, record, evidence, bytesSha };
					break search;
				}
			}
		}
	}
	const buildCmd = ["bun", "run", "build:native"];
	if (found) {
		if (stale) unlinkSync(stale);
		const dest = path.join(ctx.nativeDir, found.name);
		if (existsSync(dest) || isDanglingLink(dest)) unlinkSync(dest);
		if (opts.copy) {
			step(`copying ${found.file} -> ${dest}`);
			copyFileSync(found.file, dest);
		} else {
			step(`linking ${dest} -> ${found.file}`);
			symlinkSync(found.file, dest);
		}
		// The evidence was established for the donor's file; the loader must now reach those bytes.
		const file = effectiveAddon() ?? die(`the loader still finds no addon among ${ctx.candidates.join(", ")}`);
		const bytesSha = sha256(readFileSync(file));
		const problems = bytesSha === found.bytesSha
			? nativeRecordMismatches(found.record, path.basename(file), bytesSha, want)
			: [`it is not the file just installed (sha256 ${bytesSha.slice(0, 12)})`];
		if (problems.length > 0) die(`the loader would load ${file}, which does not match this tree: ${problems.join("; ")}`);
		verified = { file, record: found.record, evidence: found.evidence };
	} else if (opts["build-native"]) {
		step(`no addon matches this tree's native inputs; building it`);
		if (stale) unlinkSync(stale);
		const builtSince = Date.now();
		run(buildCmd, tree);
		const file = builtAddon(builtSince);
		const bytes = readFileSync(file);
		if (!containsSentinel(bytes, sentinel)) die(`build:native wrote ${file}, which lacks ${sentinel}`);
		// Same fingerprint, computed the same way, before and after: the build must not move its own inputs.
		const after = nativeInputsFingerprint(tree);
		if (after !== treeInputs) {
			die(`build:native changed the tree's native inputs (${treeInputs.slice(0, 12)} → ${after?.slice(0, 12) ?? "unreadable"}); not recording the addon`);
		}
		const target = addonTarget(path.basename(file)) ?? die(`cannot tell the platform of ${file} from its filename`);
		const bytesSha = sha256(bytes);
		const record: NativeRecord = { inputs: treeInputs, ...target, sha256: bytesSha, packageVersion, provenance: "built", source: file };
		const problems = nativeRecordMismatches(record, path.basename(file), bytesSha, want);
		if (problems.length > 0) die(`build:native wrote ${file}, which does not match this tree: ${problems.join("; ")}`);
		verified = { file, record, evidence: "own-record" };
	} else {
		die(
			`no pi_natives addon matching this tree (${sentinel}, native inputs ${treeInputs.slice(0, 12)}) in: ${searchDirs.join(", ") || "(no --native-dir)"}\n` +
				`Build one (cold Rust build) with:\n  (cd ${tree} && ${buildCmd.join(" ")})\n` +
				"or re-run with --build-native, or point --native-dir at a matching build.",
		);
	}
}
writeNativeRecord(tree, verified.record);
step(`addon verified: ${verified.file} — ${describe(verified.record, verified.evidence)}; recorded in ${path.join(tree, NATIVE_RECORD)}`);

/** The addon the loader will now load, which must be the file build:native just wrote. */
function builtAddon(since: number): string {
	const file = effectiveAddon() ?? die(`build:native left no addon among ${ctx.candidates.join(", ")}`);
	const stat = lstatSync(file);
	if (path.resolve(path.dirname(file)) !== path.resolve(ctx.nativeDir) || !stat.isFile() || stat.mtimeMs < since - 1000) {
		die(`the loader would load ${file}, not the addon build:native just wrote to ${ctx.nativeDir}`);
	}
	return file;
}

function isDanglingLink(file: string): boolean {
	try {
		return lstatSync(file).isSymbolicLink() && !existsSync(readlinkSync(file));
	} catch {
		return false;
	}
}

// ---- 4. Register the backend ----------------------------------------------
const configPath = path.join(npiHome, "config.yml");
mkdirSync(npiHome, { recursive: true });
const doc = parseDocument(existsSync(configPath) ? readFileSync(configPath, "utf8") : "");
if (doc.errors.length > 0) die(`cannot parse ${configPath}: ${doc.errors[0]?.message}`);
if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as typeof doc.contents;
let backends = doc.get("backends");
if (!isSeq(backends)) {
	backends = new YAMLSeq();
	doc.set("backends", backends);
}
const entry = { id: shortSha, kind: "source", path: tree };
const seq = backends as YAMLSeq;
const existing = seq.items.findIndex(item => isMap(item) && item.get("id") === shortSha);
if (existing === -1) seq.add(doc.createNode(entry));
else seq.items[existing] = doc.createNode(entry);
if (!doc.get("activeBackend")) doc.set("activeBackend", shortSha);
await Bun.write(configPath, doc.toString());
step(`registered backend ${shortSha} in ${configPath} (active: ${doc.get("activeBackend")})`);

// ---- 5. Typecheck config ---------------------------------------------------
const tsconfigPath = path.join(DECK_ROOT, "tsconfig.neopi.json");
if (fullSha === pinned || opts.tsconfig) {
	const tsconfig = {
		extends: path.join(tree, "tsconfig.base.json"),
		compilerOptions: {
			typeRoots: [path.join(tree, "types"), path.join(tree, "node_modules/@types")],
			paths: exportPaths(path.join(tree, "node_modules/@oh-my-pi")),
		},
	};
	const header =
		"// Generated by scripts/neopi-setup.ts for NeoPi " +
		`${fullSha}. Do not edit; re-run the script.\n` +
		"// NeoPi's .ts sources are part of the server's program, so the server extends NeoPi's base config.\n";
	await Bun.write(tsconfigPath, `${header}${JSON.stringify(tsconfig, null, "\t")}\n`);
	step(`wrote ${tsconfigPath}`);
} else {
	step(`tree is not the pinned commit (${pinned}); left tsconfig.neopi.json alone (pass --tsconfig to override)`);
}

/**
 * `paths` targets are file locations: TypeScript does not apply a package's `exports` map to them.
 * Translate each @oh-my-pi package's `exports` into equivalent `paths` entries so subpath
 * imports (`@oh-my-pi/pi-coding-agent/tools/resolve`) resolve the way Bun resolves them.
 */
function exportPaths(scopeDir: string): Record<string, string[]> {
	const pick = (value: unknown): string | null => {
		if (typeof value === "string") return value;
		if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
		const conditions = value as Record<string, unknown>;
		for (const key of ["types", "bun", "import", "default"]) {
			const target = pick(conditions[key]);
			if (target) return target;
		}
		return null;
	};
	const paths: Record<string, string[]> = {};
	for (const name of readdirSync(scopeDir).sort()) {
		const pkgDir = path.join(scopeDir, name);
		const pkgFile = path.join(pkgDir, "package.json");
		if (!existsSync(pkgFile)) continue;
		const { exports } = JSON.parse(readFileSync(pkgFile, "utf8")) as { exports?: unknown };
		const specifier = `@oh-my-pi/${name}`;
		if (exports === undefined) {
			paths[specifier] = [pkgDir];
			paths[`${specifier}/*`] = [path.join(pkgDir, "*")];
			continue;
		}
		const map =
			typeof exports === "object" && exports !== null && Object.keys(exports).some(key => key.startsWith("."))
				? (exports as Record<string, unknown>)
				: { ".": exports };
		for (const [subpath, value] of Object.entries(map)) {
			const target = pick(value);
			if (!target || subpath === "./package.json") continue;
			paths[subpath === "." ? specifier : `${specifier}${subpath.slice(1)}`] = [path.join(pkgDir, target)];
		}
	}
	return paths;
}

console.log(`\nbackend ${shortSha} ready: ${tree}`);
