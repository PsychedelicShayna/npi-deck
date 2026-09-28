#!/usr/bin/env bun
/** Preflight must execute in a disposable child: SDK imports have process-wide effects. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnOwned, terminateOwned } from "../owned-process.ts";
import { MANIFEST } from "./manifest.ts";
import { resolveManifest, formatDiagnostic, type BackendIdentity, type FeatureStatus } from "./runtime.ts";
import type { FeatureName } from "./manifest.ts";
export type ProbeResult =
	| { ok: true; pinned: boolean; identity: BackendIdentity; features: Record<FeatureName, FeatureStatus> }
	| { ok: false; pinned: false; reason: string };

const pin = readFileSync(path.resolve(import.meta.dir, "../../../../neopi.pin"), "utf8").trim();

function sentinelPresent(file: string, sentinel: string): boolean {
	const bytes = readFileSync(file);
	let at = 0;
	while ((at = bytes.indexOf(sentinel, at, "latin1")) !== -1) {
		const next = bytes[at + sentinel.length];
		if (next === undefined || !((next >= 48 && next <= 57) || (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 95)) return true;
		at += sentinel.length;
	}
	return false;
}

async function inspect(tree: string): Promise<ProbeResult> {
	const pkg = path.join(tree, "packages/coding-agent/package.json");
	if (!existsSync(pkg)) throw new Error("not a NeoPi source tree: packages/coding-agent/package.json missing");
	if (!existsSync(path.join(tree, "node_modules/@oh-my-pi/pi-coding-agent"))) throw new Error("tree not prepared: node_modules missing; run scripts/neopi-setup.ts");
	const nativePkg = JSON.parse(readFileSync(path.join(tree, "packages/natives/package.json"), "utf8")) as { version: string };
	const sentinel = `__piNativesV${nativePkg.version.replace(/[^A-Za-z0-9]/g, "_")}`;
	const loaderFile = path.join(tree, "packages/natives/native/loader-state.js");
	if (!existsSync(loaderFile)) throw new Error("tree not prepared: native loader-state.js missing");
	const loader = (await import(loaderFile)) as { initLoaderContext(): { candidates: string[] } };
	const candidate = loader.initLoaderContext().candidates.find(existsSync);
	if (!candidate) throw new Error(`tree not prepared: native addon missing (need ${sentinel})`);
	if (!sentinelPresent(candidate, sentinel)) throw new Error(`native addon ${candidate} lacks ${sentinel}`);
	const git = Bun.spawnSync(["git", "-C", tree, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
	if (git.exitCode !== 0) throw new Error(`cannot identify backend git HEAD: ${git.stderr.toString().trim()}`);
	const commit = git.stdout.toString().trim();
	const { features, values } = await resolveManifest(tree, MANIFEST);
	const failed = Object.values(features).flatMap(f => f.tier === "required" ? f.diagnostics : []);
	if (failed.length) throw new Error(`missing required SDK surface: ${failed.map(formatDiagnostic).join("; ")}`);
	let dirty: boolean | null = null;
	if (features["build-identity"].available) {
		const info = values.get("build-identity")?.BUILD_INFO as { version?: unknown; gitSha?: unknown; dirty?: unknown } | undefined;
		if (info?.gitSha !== commit || info.version !== values.get("core")?.VERSION) {
			throw new Error(`NeoPi BUILD_INFO disagrees with source tree ${commit}: ${JSON.stringify(info)}`);
		}
		dirty = info.dirty === true ? true : info.dirty === false ? false : null;
	}
	return { ok: true, pinned: commit === pin && (!features["build-identity"].available || dirty === false), identity: { path: tree, commit, version: typeof values.get("core")?.VERSION === "string" ? values.get("core")!.VERSION as string : null }, features };
}

export async function preflight(tree: string): Promise<ProbeResult> {
	const root = mkdtempSync(path.join(os.tmpdir(), "npi-deck-probe-"));
	const home = path.join(root, "home");
	mkdirSync(home, { recursive: true });
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		LANG: process.env.LANG ?? "C.UTF-8",
		NODE_ENV: "production",
		HOME: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
		XDG_DATA_HOME: path.join(home, ".local/share"),
		XDG_CACHE_HOME: path.join(home, ".cache"),
		PI_CODING_AGENT_DIR: path.join(root, "agent"),
	};
	mkdirSync(env.PI_CODING_AGENT_DIR!, { recursive: true });
	try {
		const child = spawnOwned([process.execPath, import.meta.path, "--child", path.resolve(tree)], { cwd: root, env, stdout: "pipe", stderr: "pipe" }, { replaceEnv: true });
		const timer = setTimeout(() => { void terminateOwned(child); }, 25_000);
		try {
			const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			if (code !== 0) return { ok: false, pinned: false, reason: stderr.trim() || stdout.trim() || `probe exited ${code}` };
			return JSON.parse(stdout) as ProbeResult;
		} finally { clearTimeout(timer); }
	} finally { rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) {
	try { console.log(JSON.stringify(await inspect(process.argv[3]!))); }
	catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
