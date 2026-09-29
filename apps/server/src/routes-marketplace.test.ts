/**
 * Marketplace update checks and upgrades (#29) through the routes, against a
 * local fixture marketplace.
 *
 * These tests install plugins. The service is given temp registry paths, but
 * anything that fell back to NeoPi's defaults would write into the user's real
 * registry (`~/.omp/marketplaces.json`, `~/.omp/plugins/`), and NeoPi fixes its
 * home at load. So the fixture tests run in a child `bun test` whose HOME,
 * XDG_* and agent dir are temp dirs, and this process checks that its own
 * default registry paths were not touched while the child ran.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MarketplaceUpdatesResponse, UpgradePluginResponse } from "@npi-deck/protocol";
import { loadBackend, resolveBackendSelection, sdk } from "./backend/runtime.ts";
import { MarketplaceService } from "./marketplace-service.ts";
import { spawnOwnedSync } from "./owned-process.ts";
import { buildMarketplaceRouter } from "./routes-marketplace.ts";

const backend = resolveBackendSelection();
if (!backend) throw new Error("marketplace route tests require a configured NeoPi backend");
await loadBackend(backend);

/** NeoPi's default registry locations in this process. */
function defaultRegistryPaths() {
	return {
		marketplacesRegistryPath: sdk().getMarketplacesRegistryPath(),
		installedRegistryPath: sdk().getInstalledPluginsRegistryPath(),
		marketplacesCacheDir: sdk().getMarketplacesCacheDir(),
		pluginsCacheDir: sdk().getPluginsCacheDir(),
	};
}

const fixtureRoot = process.env.NPI_DECK_MARKETPLACE_TEST_ROOT;

if (!fixtureRoot) {
	/** Existence and mtime of each default registry path and of every entry beside or under it. */
	function snapshotDefaults(): Record<string, string> {
		const d = defaultRegistryPaths();
		const paths = new Set<string>(Object.values(d));
		for (const dir of [path.dirname(d.marketplacesRegistryPath), path.dirname(d.installedRegistryPath), d.marketplacesCacheDir, d.pluginsCacheDir]) {
			paths.add(dir);
			try {
				for (const name of readdirSync(dir)) paths.add(path.join(dir, name));
			} catch {
				// Missing directory: recorded as absent below.
			}
		}
		const out: Record<string, string> = {};
		for (const p of [...paths].sort()) {
			try {
				const st = lstatSync(p);
				out[p] = `${st.mtimeMs}:${st.size}`;
			} catch {
				out[p] = "absent";
			}
		}
		return out;
	}

	test("update checks and upgrades, run in an isolated home, leave the default registry untouched", () => {
		const before = snapshotDefaults();
		const root = mkdtempSync(path.join(os.tmpdir(), "deck-marketplace-"));
		try {
			const home = path.join(root, "home");
			mkdirSync(home, { recursive: true });
			const env: Record<string, string> = {};
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined && !/(_API_KEY|_TOKEN|_SECRET)$/.test(key) && !/^(PI_|OMP_|NPI_DECK_)/.test(key)) env[key] = value;
			}
			Object.assign(env, {
				HOME: home,
				XDG_CONFIG_HOME: path.join(home, ".config"),
				XDG_DATA_HOME: path.join(home, ".local/share"),
				XDG_STATE_HOME: path.join(home, ".local/state"),
				XDG_CACHE_HOME: path.join(home, ".cache"),
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
				NPI_DECK_HOME: path.join(root, "deck"),
				NPI_DECK_BACKEND: backend.path,
				NPI_DECK_MARKETPLACE_TEST_ROOT: root,
			});
			const child = spawnOwnedSync([process.execPath, "test", import.meta.path], { cwd: root, env, stdout: "pipe", stderr: "pipe" }, { replaceEnv: true });
			const output = `${child.stdout.toString()}${child.stderr.toString()}`;
			if (child.exitCode !== 0) console.error(output);
			expect(child.exitCode).toBe(0);
			expect(output).toContain("7 pass");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
		expect(snapshotDefaults()).toEqual(before);
	}, 120_000);
} else {
	const defaults = defaultRegistryPaths();
	for (const [key, value] of Object.entries(defaults)) {
		if (!value.startsWith(fixtureRoot)) throw new Error(`fixture child is not isolated: NeoPi's default ${key} is ${value}`);
	}

	const root = await mkdtemp(path.join(fixtureRoot, "fixture-"));
	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	let app: ReturnType<typeof buildMarketplaceRouter>;
	let source: string;
	let installedRegistryPath: string;
	let run = 0;

	/** A local marketplace source directory, standing in for a remote catalog. */
	async function writeSource(dir: string, market: string, plugins: Record<string, string>): Promise<void> {
		await mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
		for (const [name, version] of Object.entries(plugins)) {
			const pluginDir = path.join(dir, "plugins", name);
			await mkdir(path.join(pluginDir, "skills", name), { recursive: true });
			await writeFile(path.join(pluginDir, "package.json"), JSON.stringify({ name, version }));
			await writeFile(
				path.join(pluginDir, "skills", name, "SKILL.md"),
				`---\nname: ${name}\ndescription: ${name} at ${version}\n---\nBody ${version}.\n`,
			);
		}
		await writeFile(
			path.join(dir, ".claude-plugin", "marketplace.json"),
			JSON.stringify({
				name: market,
				owner: { name: "Deck tests" },
				plugins: Object.entries(plugins).map(([name, version]) => ({ name, source: `./plugins/${name}`, version })),
			}),
		);
	}

	const request = (url: string, init?: RequestInit) => app.request(`http://127.0.0.1${url}`, init);
	const post = (url: string, body?: unknown) =>
		request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
		});
	const cachedUpdates = async () => (await (await request("/marketplace/updates")).json()) as MarketplaceUpdatesResponse;

	beforeEach(async () => {
		const dir = path.join(root, `run-${++run}`);
		source = path.join(dir, "source");
		installedRegistryPath = path.join(dir, "plugins", "installed_plugins.json");
		await writeSource(source, "fixture", { alpha: "1.0.0", beta: "2.0.0" });
		const service = new MarketplaceService({
			marketplacesRegistryPath: path.join(dir, "plugins", "marketplaces.json"),
			installedRegistryPath,
			marketplacesCacheDir: path.join(dir, "plugins", "cache", "marketplaces"),
			pluginsCacheDir: path.join(dir, "plugins", "cache", "plugins"),
		});
		app = buildMarketplaceRouter(service);
		expect((await post("/marketplaces", { source })).status).toBe(200);
		expect((await post("/marketplace/install", { name: "alpha", marketplace: "fixture" })).status).toBe(200);
		expect((await post("/marketplace/install", { name: "beta", marketplace: "fixture" })).status).toBe(200);
	});

	test("the service writes to the paths it is given, not NeoPi's default registry", async () => {
		const installed = JSON.parse(await readFile(installedRegistryPath, "utf8")) as { plugins: Record<string, unknown> };
		expect(Object.keys(installed.plugins).sort()).toEqual(["alpha@fixture", "beta@fixture"]);
		for (const file of [defaults.marketplacesRegistryPath, defaults.installedRegistryPath]) {
			const text = (await Bun.file(file).exists()) ? await readFile(file, "utf8") : "";
			expect(text).not.toContain("fixture");
		}
	});

	test("an installed set that matches its source reports no updates", async () => {
		const res = await post("/marketplace/updates/check");
		expect(res.status).toBe(200);
		const body = (await res.json()) as MarketplaceUpdatesResponse;
		expect(body.updates).toEqual([]);
		expect(body.refreshed).toBe(true);
		expect(body.refreshErrors).toEqual([]);
	});

	test("a newer version at the source is found by a check, and only by a check", async () => {
		await writeSource(source, "fixture", { alpha: "1.1.0", beta: "2.0.0" });

		// The cached catalog still says 1.0.0: reading it must not fetch the source.
		const cached = await cachedUpdates();
		expect(cached.refreshed).toBe(false);
		expect(cached.updates).toEqual([]);

		const checked = (await (await post("/marketplace/updates/check")).json()) as MarketplaceUpdatesResponse;
		expect(checked.updates).toEqual([
			{ pluginId: "alpha@fixture", name: "alpha", marketplace: "fixture", scope: "user", from: "1.0.0", to: "1.1.0" },
		]);
		// The check refreshed the cache, so the cheap read now agrees.
		expect((await cachedUpdates()).updates.map((u) => u.pluginId)).toEqual(["alpha@fixture"]);

		// Checking never upgrades: the installed copy is still 1.0.0.
		const listed = (await (await request("/marketplace")).json()) as { installed: Array<{ id: string; version: string }> };
		expect(listed.installed.find((p) => p.id === "alpha@fixture")?.version).toBe("1.0.0");
	});

	test("upgrading one plugin installs the source's version and clears only its update", async () => {
		await writeSource(source, "fixture", { alpha: "1.1.0", beta: "2.1.0" });
		await post("/marketplace/updates/check");

		const res = await post(`/marketplace/plugins/${encodeURIComponent("alpha@fixture")}/upgrade`, { scope: "user" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as UpgradePluginResponse;
		expect(body.upgraded.map((p) => [p.id, p.scope, p.version])).toEqual([["alpha@fixture", "user", "1.1.0"]]);
		const skill = await readFile(path.join(body.upgraded[0]!.installPath, "skills", "alpha", "SKILL.md"), "utf8");
		expect(skill).toContain("Body 1.1.0.");

		expect((await cachedUpdates()).updates.map((u) => [u.pluginId, u.from, u.to])).toEqual([["beta@fixture", "2.0.0", "2.1.0"]]);
	});

	test("upgrading without a scope upgrades every scope the plugin is installed in", async () => {
		await writeSource(source, "fixture", { alpha: "1.2.0", beta: "2.0.0" });
		await post("/marketplace/updates/check");

		const res = await post(`/marketplace/plugins/${encodeURIComponent("alpha@fixture")}/upgrade`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as UpgradePluginResponse;
		expect(body.upgraded.map((p) => [p.scope, p.version])).toEqual([["user", "1.2.0"]]);
		expect((await cachedUpdates()).updates).toEqual([]);
	});

	test("an unreachable marketplace is reported without hiding updates from the others", async () => {
		const brokenSource = path.join(root, `broken-${run}`);
		await writeSource(brokenSource, "broken", { gamma: "0.1.0" });
		expect((await post("/marketplaces", { source: brokenSource })).status).toBe(200);
		await rm(brokenSource, { recursive: true, force: true });
		await writeSource(source, "fixture", { alpha: "1.0.0", beta: "3.0.0" });

		const res = await post("/marketplace/updates/check");
		expect(res.status).toBe(200);
		const body = (await res.json()) as MarketplaceUpdatesResponse;
		expect(body.updates.map((u) => [u.pluginId, u.to])).toEqual([["beta@fixture", "3.0.0"]]);
		expect(body.refreshErrors.map((e) => e.marketplace)).toEqual(["broken"]);
		expect(body.refreshErrors[0]!.error.length).toBeGreaterThan(0);
	});

	test("upgrade rejects a malformed id, a bad scope and a plugin that is not installed", async () => {
		expect((await post("/marketplace/plugins/no-marketplace/upgrade")).status).toBe(400);
		expect((await post(`/marketplace/plugins/${encodeURIComponent("alpha@fixture")}/upgrade`, { scope: "global" })).status).toBe(400);
		expect((await post(`/marketplace/plugins/${encodeURIComponent("alpha@fixture")}/upgrade`, "[1]")).status).toBe(400);

		const missing = await post(`/marketplace/plugins/${encodeURIComponent("zeta@fixture")}/upgrade`);
		expect(missing.status).toBe(500);
		expect(((await missing.json()) as { error: string }).error).toContain("not installed");
	});
}
