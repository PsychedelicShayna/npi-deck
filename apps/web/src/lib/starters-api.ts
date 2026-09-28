import type { MaintenanceGateState, UpdateMaintenanceGateRequest } from "@npi-deck/protocol";

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

export const startersApi = {
	getMaintenanceGate(): Promise<MaintenanceGateState> {
		return req<MaintenanceGateState>("/starters/maintenance-gate");
	},
	putMaintenanceGate(body: UpdateMaintenanceGateRequest): Promise<MaintenanceGateState> {
		return req<MaintenanceGateState>("/starters/maintenance-gate", {
			method: "PUT",
			body: JSON.stringify(body),
		});
	},
};
