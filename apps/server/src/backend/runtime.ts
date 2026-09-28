/**
 * Backend runtime: selects a NeoPi source tree and loads the manifest's SDK
 * values from it by absolute-path dynamic import. The deck's own
 * `node_modules` never contains `@oh-my-pi`; every SDK value reaches the rest
 * of the server through `sdk()` / `feature()` here.
 *
 * Selection (W12 extends this into the switch state machine):
 *   1. `NPI_DECK_BACKEND` pins the launch: a backend id from config.yml or an
 *      absolute tree path.
 *   2. Otherwise `activeBackend` in `<NPI_DECK_HOME|~/.npi-deck>/config.yml`,
 *      looked up in its `backends` list.
 *
 * Loading imports each manifest module once, checks every export, and
 * reports per-feature capability. A missing `required` export rejects the
 * backend with a diagnostic naming the module and export; a missing optional
 * export disables only its feature. Importing a tree has process-wide effects
 * (dotenv merge, native addon, router registrations), so this runs once per
 * process; probing a candidate belongs in a child process (plan C3).
 */
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import {
	MANIFEST,
	manifestRows,
	type FeatureExports,
	type FeatureName,
	type FeatureSpec,
	type ModuleSpecifier,
	type OptionalFeatureName,
	type Tier,
} from "./manifest.ts";

export interface BackendSelection {
	/** Id from config.yml, or null for an env-pinned raw path. */
	id: string | null;
	/** Absolute tree root. */
	path: string;
	source: "env" | "config";
}

export interface BackendIdentity {
	path: string;
	version: string | null;
	commit: string | null;
}

export interface ManifestDiagnostic {
	feature: FeatureName;
	tier: Tier;
	module: string;
	export: string | null;
	file: string | null;
	reason: string;
}

export interface FeatureStatus {
	tier: Tier;
	available: boolean;
	diagnostics: ManifestDiagnostic[];
}

export interface LoadedBackend {
	selection: BackendSelection;
	identity: BackendIdentity;
	features: Record<FeatureName, FeatureStatus>;
}

export class BackendConfigError extends Error {
	override name = "BackendConfigError";
}

export class BackendLoadError extends Error {
	override name = "BackendLoadError";
	constructor(
		message: string,
		readonly diagnostics: ManifestDiagnostic[],
	) {
		super(message);
	}
}

export class FeatureUnavailableError extends Error {
	override name = "FeatureUnavailableError";
	constructor(
		readonly feature: FeatureName,
		readonly diagnostics: ManifestDiagnostic[],
	) {
		super(`backend feature "${feature}" is unavailable: ${diagnostics.map(formatDiagnostic).join("; ")}`);
	}
}

export function formatDiagnostic(d: ManifestDiagnostic): string {
	const what = d.export ? `${d.module} → ${d.export}` : d.module;
	return `${what}${d.file ? ` (${d.file})` : ""}: ${d.reason}`;
}

export function npiDeckHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.NPI_DECK_HOME || path.join(os.homedir(), ".npi-deck");
}

interface BackendConfig {
	backends?: Array<{ id?: unknown; path?: unknown }>;
	activeBackend?: unknown;
}

function readBackendConfig(home: string): BackendConfig {
	const file = path.join(home, "config.yml");
	if (!existsSync(file)) {
		throw new BackendConfigError(`no backend configured: ${file} does not exist. Run \`bun scripts/neopi-setup.ts\`.`);
	}
	const parsed = parseYaml(readFileSync(file, "utf8")) as unknown;
	if (!parsed || typeof parsed !== "object") throw new BackendConfigError(`${file} is not a YAML mapping`);
	return parsed as BackendConfig;
}

function lookupBackend(config: BackendConfig, id: string, home: string): string {
	const entry = (config.backends ?? []).find((b) => b.id === id);
	if (!entry || typeof entry.path !== "string") {
		throw new BackendConfigError(`backend "${id}" is not listed under backends in ${path.join(home, "config.yml")}`);
	}
	return entry.path;
}

export function resolveBackendSelection(env: NodeJS.ProcessEnv = process.env): BackendSelection {
	const home = npiDeckHome(env);
	const pinned = env.NPI_DECK_BACKEND?.trim();
	if (pinned) {
		if (path.isAbsolute(pinned)) return { id: null, path: pinned, source: "env" };
		return { id: pinned, path: lookupBackend(readBackendConfig(home), pinned, home), source: "env" };
	}
	const config = readBackendConfig(home);
	if (typeof config.activeBackend !== "string" || !config.activeBackend) {
		throw new BackendConfigError(`no activeBackend set in ${path.join(home, "config.yml")}`);
	}
	return { id: config.activeBackend, path: lookupBackend(config, config.activeBackend, home), source: "config" };
}

type ModuleLoad = { ok: true; file: string; ns: Record<string, unknown> } | { ok: false; file: string | null; reason: string };

async function importModule(tree: string, specifier: ModuleSpecifier): Promise<ModuleLoad> {
	let file: string;
	try {
		file = Bun.resolveSync(specifier, tree);
	} catch (err) {
		return { ok: false, file: null, reason: `cannot resolve from ${tree}: ${errorMessage(err)}` };
	}
	try {
		return { ok: true, file, ns: (await import(file)) as Record<string, unknown> };
	} catch (err) {
		return { ok: false, file, reason: `import failed: ${errorMessage(err)}` };
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function readIdentity(tree: string, version: unknown): BackendIdentity {
	const git = Bun.spawnSync(["git", "-C", tree, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
	return {
		path: tree,
		version: typeof version === "string" ? version : null,
		commit: git.exitCode === 0 ? git.stdout.toString().trim() : null,
	};
}

let active: { backend: LoadedBackend; values: Map<FeatureName, Record<string, unknown>> } | undefined;

/**
 * Import the manifest from `selection` and make it the process's backend.
 * Throws BackendLoadError (every required diagnostic) without activating
 * anything when a required export is missing. Idempotent for the same tree;
 * a second, different tree is refused because module effects can't be undone.
 */
export async function loadBackend(selection: BackendSelection = resolveBackendSelection()): Promise<LoadedBackend> {
	const tree = path.resolve(selection.path);
	if (active) {
		if (active.backend.identity.path === tree) return active.backend;
		throw new BackendLoadError(
			`backend already loaded from ${active.backend.identity.path}; switching to ${tree} needs a restart`,
			[],
		);
	}
	if (!existsSync(path.join(tree, "packages/coding-agent/package.json"))) {
		throw new BackendConfigError(`${tree} is not a NeoPi source tree (packages/coding-agent/package.json missing)`);
	}

	const specifiers = new Set<ModuleSpecifier>(manifestRows().map((r) => r.module));
	const loads = new Map<ModuleSpecifier, ModuleLoad>();
	await Promise.all([...specifiers].map(async (s) => loads.set(s, await importModule(tree, s))));

	const features = {} as Record<FeatureName, FeatureStatus>;
	const values = new Map<FeatureName, Record<string, unknown>>();
	for (const [name, spec] of Object.entries(MANIFEST) as [FeatureName, FeatureSpec][]) {
		const diagnostics: ManifestDiagnostic[] = [];
		const featureValues: Record<string, unknown> = {};
		for (const [key, ref] of Object.entries(spec.exports)) {
			const load = loads.get(ref.module)!;
			const base = { feature: name, tier: spec.tier, module: ref.module, export: ref.export };
			if (!load.ok) {
				diagnostics.push({ ...base, file: load.file, reason: load.reason });
			} else if (!(ref.export in load.ns)) {
				diagnostics.push({ ...base, file: load.file, reason: "export missing" });
			} else {
				featureValues[key] = load.ns[ref.export];
			}
		}
		for (const rel of spec.files ?? []) {
			const file = path.join(tree, rel);
			if (!existsSync(file)) {
				diagnostics.push({ feature: name, tier: spec.tier, module: rel, export: null, file, reason: "file missing" });
			}
		}
		features[name] = { tier: spec.tier, available: diagnostics.length === 0, diagnostics };
		values.set(name, featureValues);
	}

	const requiredFailures = Object.values(features).flatMap((f) => (f.tier === "required" ? f.diagnostics : []));
	if (requiredFailures.length > 0) {
		throw new BackendLoadError(
			`backend ${tree} is missing required SDK surface:\n  ${requiredFailures.map(formatDiagnostic).join("\n  ")}`,
			requiredFailures,
		);
	}

	const backend: LoadedBackend = {
		selection: { ...selection, path: tree },
		identity: readIdentity(tree, values.get("core")?.VERSION),
		features,
	};
	active = { backend, values };
	return backend;
}

export function activeBackend(): LoadedBackend | undefined {
	return active?.backend;
}

function requireActive(): NonNullable<typeof active> {
	if (!active) throw new BackendConfigError("no NeoPi backend loaded; loadBackend() must run before SDK access");
	return active;
}

/** Required SDK surface. Throws until loadBackend() has succeeded. */
export function sdk(): FeatureExports<"core"> {
	return requireActive().values.get("core") as FeatureExports<"core">;
}

export function hasFeature(name: OptionalFeatureName): boolean {
	return requireActive().backend.features[name].available;
}

/** An optional feature's exports; throws FeatureUnavailableError naming what's missing. */
export function feature<F extends OptionalFeatureName>(name: F): FeatureExports<F> {
	const { backend, values } = requireActive();
	const status = backend.features[name];
	if (!status.available) throw new FeatureUnavailableError(name, status.diagnostics);
	return values.get(name) as FeatureExports<F>;
}
