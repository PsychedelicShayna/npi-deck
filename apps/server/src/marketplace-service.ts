import type {
	InstalledPluginInfo,
	ListMarketplaceResponse,
	MarketplaceCatalogEntry,
	MarketplacePluginUpdate,
	MarketplaceSource,
	MarketplaceUpdatesResponse,
} from "@npi-deck/protocol";
import type {
	InstalledPluginEntry,
	MarketplaceManager,
	MarketplaceManagerOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";

import { sdk } from "./backend/runtime.ts";

import { logger } from "./log.ts";

type MarketplacePaths = Pick<
	MarketplaceManagerOptions,
	"marketplacesRegistryPath" | "installedRegistryPath" | "marketplacesCacheDir" | "pluginsCacheDir"
>;

const log = logger("marketplace");

/**
 * Lazy singleton wrapper around the SDK's `MarketplaceManager`. Built on first
 * request so the deck boot stays fast (no disk reads, no network discovery).
 * Routes share this instance so cached catalog reads are reused.
 *
 * Operations that write NeoPi's registry files run one at a time: the manager
 * reads, modifies and rewrites `marketplaces.json` / `installed_plugins.json`,
 * so two overlapping writers would drop one side's change.
 */
export class MarketplaceService {
	private manager: MarketplaceManager | undefined;
	private writes: Promise<unknown> = Promise.resolve();

	/** `paths` defaults to NeoPi's own registry locations. */
	constructor(private readonly paths?: MarketplacePaths) {}

	private getManager(): MarketplaceManager {
		if (this.manager) return this.manager;
		const {
			MarketplaceManager,
			clearPluginRootsAndCaches,
			getInstalledPluginsRegistryPath,
			getMarketplacesCacheDir,
			getMarketplacesRegistryPath,
			getPluginsCacheDir,
		} = sdk();
		this.manager = new MarketplaceManager({
			...(this.paths ?? {
				marketplacesRegistryPath: getMarketplacesRegistryPath(),
				installedRegistryPath: getInstalledPluginsRegistryPath(),
				marketplacesCacheDir: getMarketplacesCacheDir(),
				pluginsCacheDir: getPluginsCacheDir(),
			}),
			// Without this, NeoPi's skill discovery keeps serving the plugin roots it
			// saw before an install, upgrade or uninstall; an upgrade deletes them.
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});
		return this.manager;
	}

	private serialized<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.writes.then(fn, fn);
		this.writes = run.catch(() => undefined);
		return run;
	}

	/**
	 * Cheap variant of {@link listCatalog} that returns only the installed-plugin
	 * inventory. Skips `listAvailablePlugins` for each marketplace source (which
	 * can hit the cache layer / refresh), so this is safe to call frequently
	 * from SkillsService and watcher fan-outs.
	 */
	async listInstalled(): Promise<InstalledPluginInfo[]> {
		const mgr = this.getManager();
		const summaries = await mgr.listInstalledPlugins();
		const installed: InstalledPluginInfo[] = [];
		for (const summary of summaries) {
			const parsed = sdk().parsePluginId(summary.id);
			if (!parsed) continue;
			for (const entry of summary.entries) {
				installed.push({
					id: summary.id,
					name: parsed.name,
					marketplace: parsed.marketplace,
					scope: entry.scope,
					version: entry.version,
					installedAt: entry.installedAt,
					installPath: entry.installPath,
					...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
					...(summary.shadowedBy ? { shadowedBy: summary.shadowedBy } : {}),
				});
			}
		}
		return installed;
	}

	async listCatalog(): Promise<ListMarketplaceResponse> {
		const mgr = this.getManager();
		const [sources, installedSummaries] = await Promise.all([
			mgr.listMarketplaces(),
			mgr.listInstalledPlugins(),
		]);

		const installed: InstalledPluginInfo[] = [];
		for (const summary of installedSummaries) {
			const parsed = sdk().parsePluginId(summary.id);
			if (!parsed) continue;
			for (const entry of summary.entries) {
				installed.push({
					id: summary.id,
					name: parsed.name,
					marketplace: parsed.marketplace,
					scope: entry.scope,
					version: entry.version,
					installedAt: entry.installedAt,
					installPath: entry.installPath,
					...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
					...(summary.shadowedBy ? { shadowedBy: summary.shadowedBy } : {}),
				});
			}
		}

		// Index installed plugins by `name@marketplace` so catalog entries can
		// surface a `installed` marker without a second pass through the array.
		const installedIndex = new Map<string, InstalledPluginInfo>();
		for (const i of installed) {
			// Prefer project-scoped entry when both exist for the same plugin id.
			const prev = installedIndex.get(i.id);
			if (!prev || (prev.scope === "user" && i.scope === "project")) {
				installedIndex.set(i.id, i);
			}
		}

		const catalog: MarketplaceCatalogEntry[] = [];
		for (const source of sources) {
			let plugins;
			try {
				plugins = await mgr.listAvailablePlugins(source.name);
			} catch (err) {
				log.warn(`listAvailablePlugins(${source.name}) failed`, err);
				continue;
			}
			for (const plugin of plugins) {
				const id = `${plugin.name}@${source.name}`;
				const installedEntry = installedIndex.get(id);
				const entry: MarketplaceCatalogEntry = {
					id,
					name: plugin.name,
					marketplace: source.name,
					capabilities: {
						commands: plugin.commands !== undefined,
						agents: plugin.agents !== undefined,
						hooks: plugin.hooks !== undefined,
						mcpServers: plugin.mcpServers !== undefined,
						lspServers: plugin.lspServers !== undefined,
					},
				};
				if (plugin.description) entry.description = plugin.description;
				if (plugin.version) entry.version = plugin.version;
				if (plugin.author?.name) entry.author = plugin.author.name;
				if (plugin.homepage) entry.homepage = plugin.homepage;
				if (plugin.keywords && plugin.keywords.length > 0) entry.keywords = [...plugin.keywords];
				if (plugin.category) entry.category = plugin.category;
				if (plugin.tags && plugin.tags.length > 0) entry.tags = [...plugin.tags];
				if (installedEntry) {
					entry.installed = {
						scope: installedEntry.scope,
						version: installedEntry.version,
						installedAt: installedEntry.installedAt,
						...(installedEntry.enabled !== undefined ? { enabled: installedEntry.enabled } : {}),
					};
				}
				catalog.push(entry);
			}
		}

		const sourceList: MarketplaceSource[] = sources.map((s) => ({
			name: s.name,
			sourceType: s.sourceType,
			sourceUri: s.sourceUri,
			updatedAt: s.updatedAt,
		}));

		return { sources: sourceList, catalog, installed };
	}

	async install(opts: { name: string; marketplace: string; scope?: "user" | "project"; force?: boolean }): Promise<InstalledPluginInfo> {
		const mgr = this.getManager();
		const entry = await this.serialized(() =>
			mgr.installPlugin(opts.name, opts.marketplace, {
				...(opts.force ? { force: true } : {}),
				...(opts.scope ? { scope: opts.scope } : {}),
			}),
		);
		return installedInfo(opts.name, opts.marketplace, entry);
	}

	async uninstall(opts: { id: string; scope?: "user" | "project" }): Promise<void> {
		const mgr = this.getManager();
		await this.serialized(() => mgr.uninstallPlugin(opts.id, opts.scope));
	}

	async addMarketplace(source: string): Promise<MarketplaceSource> {
		const mgr = this.getManager();
		const entry = await this.serialized(() => mgr.addMarketplace(source));
		return {
			name: entry.name,
			sourceType: entry.sourceType,
			sourceUri: entry.sourceUri,
			updatedAt: entry.updatedAt,
		};
	}

	async removeMarketplace(name: string): Promise<void> {
		const mgr = this.getManager();
		await this.serialized(() => mgr.removeMarketplace(name));
	}

	async refresh(): Promise<void> {
		const mgr = this.getManager();
		await this.serialized(() => mgr.updateAllMarketplaces());
	}

	async setEnabled(id: string, enabled: boolean, scope?: "user" | "project"): Promise<void> {
		const mgr = this.getManager();
		await this.serialized(() => mgr.setPluginEnabled(id, enabled, scope));
	}

	/**
	 * Installed plugins whose marketplace catalog declares a newer version
	 * (NeoPi's `checkForUpdates`). With `refresh`, each registered marketplace
	 * is first re-fetched from its source (`updateMarketplace`); a source that
	 * cannot be fetched is reported in `refreshErrors` and its cached catalog
	 * is compared instead. Without it, only the cached catalogs are read.
	 * Nothing is upgraded here.
	 */
	async checkForUpdates(opts: { refresh: boolean }): Promise<MarketplaceUpdatesResponse> {
		const mgr = this.getManager();
		const refreshErrors: MarketplaceUpdatesResponse["refreshErrors"] = [];
		const raw = opts.refresh
			? await this.serialized(async () => {
				for (const market of await mgr.listMarketplaces()) {
					try {
						await mgr.updateMarketplace(market.name);
					} catch (err) {
						log.warn(`updateMarketplace(${market.name}) failed`, err);
						refreshErrors.push({ marketplace: market.name, error: errorMessage(err) });
					}
				}
				return mgr.checkForUpdates();
			})
			: await mgr.checkForUpdates();
		const updates: MarketplacePluginUpdate[] = [];
		for (const u of raw) {
			const parsed = sdk().parsePluginId(u.pluginId);
			if (!parsed) continue;
			updates.push({ pluginId: u.pluginId, name: parsed.name, marketplace: parsed.marketplace, scope: u.scope, from: u.from, to: u.to });
		}
		return { updates, refreshed: opts.refresh, refreshErrors, checkedAt: new Date().toISOString() };
	}

	/**
	 * Re-install a plugin at its catalog's current version: in `scope` only
	 * (NeoPi's `upgradePlugin`), or in every scope it is installed in
	 * (`upgradePluginAcrossScopes`). Throws {@link InvalidPluginIdError} when
	 * `id` is not `name@marketplace`, and NeoPi's error when the plugin is not
	 * installed there.
	 */
	async upgrade(id: string, scope?: "user" | "project"): Promise<InstalledPluginInfo[]> {
		const parsed = sdk().parsePluginId(id);
		if (!parsed) throw new InvalidPluginIdError(id);
		const mgr = this.getManager();
		const entries = await this.serialized(async () =>
			scope ? [await mgr.upgradePlugin(id, scope)] : await mgr.upgradePluginAcrossScopes(id),
		);
		return entries.map((entry) => installedInfo(parsed.name, parsed.marketplace, entry));
	}
}

export class InvalidPluginIdError extends Error {
	constructor(id: string) {
		super(`Invalid plugin ID: "${id}". Expected "name@marketplace".`);
		this.name = "InvalidPluginIdError";
	}
}

function installedInfo(name: string, marketplace: string, entry: InstalledPluginEntry): InstalledPluginInfo {
	return {
		id: `${name}@${marketplace}`,
		name,
		marketplace,
		scope: entry.scope,
		version: entry.version,
		installedAt: entry.installedAt,
		installPath: entry.installPath,
		...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
	};
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
