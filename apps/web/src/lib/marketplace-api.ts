import type {
	AddMarketplaceRequest,
	InstallPluginRequest,
	InstallPluginResponse,
	ListMarketplaceResponse,
	MarketplaceSource,
	MarketplaceUpdatesResponse,
	UninstallPluginRequest,
	UpgradePluginRequest,
	UpgradePluginResponse,
} from "@npi-deck/protocol";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status} ${path}: ${body}`);
	}
	return (await res.json()) as T;
}

export const marketplaceApi = {
	list(): Promise<ListMarketplaceResponse> {
		return req<ListMarketplaceResponse>("/marketplace");
	},
	install(body: InstallPluginRequest): Promise<InstallPluginResponse> {
		return req<InstallPluginResponse>("/marketplace/install", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	uninstall(body: UninstallPluginRequest): Promise<{ ok: boolean }> {
		return req<{ ok: boolean }>("/marketplace/uninstall", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	refresh(): Promise<{ ok: boolean }> {
		return req<{ ok: boolean }>("/marketplace/refresh", { method: "POST" });
	},
	addMarketplace(source: string): Promise<{ ok: boolean; marketplace: MarketplaceSource }> {
		const body: AddMarketplaceRequest = { source };
		return req<{ ok: boolean; marketplace: MarketplaceSource }>("/marketplaces", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	removeMarketplace(name: string): Promise<{ ok: boolean }> {
		return req<{ ok: boolean }>(`/marketplaces/${encodeURIComponent(name)}`, { method: "DELETE" });
	},
	/** Installed plugins vs the cached catalogs; no network. */
	updates(): Promise<MarketplaceUpdatesResponse> {
		return req<MarketplaceUpdatesResponse>("/marketplace/updates");
	},
	/** Re-fetch every marketplace from its source, then compare. Never upgrades. */
	checkForUpdates(): Promise<MarketplaceUpdatesResponse> {
		return req<MarketplaceUpdatesResponse>("/marketplace/updates/check", { method: "POST" });
	},
	upgrade(id: string, body: UpgradePluginRequest = {}): Promise<UpgradePluginResponse> {
		return req<UpgradePluginResponse>(`/marketplace/plugins/${encodeURIComponent(id)}/upgrade`, {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
};
