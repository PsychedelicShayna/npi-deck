import type { BridgeInfo, BridgeLogsResponse, BridgeName, ListBridgesResponse } from "@npi-deck/protocol";

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

export const bridgesApi = {
	list(): Promise<ListBridgesResponse> {
		return req<ListBridgesResponse>("/bridges");
	},
	get(name: BridgeName): Promise<BridgeInfo> {
		return req<BridgeInfo>(`/bridges/${encodeURIComponent(name)}`);
	},
	start(name: BridgeName): Promise<BridgeInfo> {
		return req<BridgeInfo>(`/bridges/${encodeURIComponent(name)}/start`, { method: "POST" });
	},
	stop(name: BridgeName): Promise<BridgeInfo> {
		return req<BridgeInfo>(`/bridges/${encodeURIComponent(name)}/stop`, { method: "POST" });
	},
	restart(name: BridgeName): Promise<BridgeInfo> {
		return req<BridgeInfo>(`/bridges/${encodeURIComponent(name)}/restart`, { method: "POST" });
	},
	logs(name: BridgeName): Promise<BridgeLogsResponse> {
		return req<BridgeLogsResponse>(`/bridges/${encodeURIComponent(name)}/logs`);
	},
};
