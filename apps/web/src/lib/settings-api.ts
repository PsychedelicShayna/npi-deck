import type { BackendStatusResponse, BackendSwitchResponse } from "@npi-deck/protocol";
import type {
	ListEnvSettingsResponse,
	PatchEnvSettingsRequest,
	PatchEnvSettingsResponse,
	RestartServerResponse,
	RevealEnvValueResponse,
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

export const settingsApi = {
	listEnv(): Promise<ListEnvSettingsResponse> {
		return req<ListEnvSettingsResponse>("/settings/env");
	},
	patchEnv(updates: PatchEnvSettingsRequest["updates"]): Promise<PatchEnvSettingsResponse> {
		return req<PatchEnvSettingsResponse>("/settings/env", {
			method: "PATCH",
			body: JSON.stringify({ updates } satisfies PatchEnvSettingsRequest),
		});
	},
	revealEnv(key: string): Promise<RevealEnvValueResponse> {
		return req<RevealEnvValueResponse>(`/settings/env/${encodeURIComponent(key)}?reveal=1`);
	},
	restartServer(): Promise<RestartServerResponse> {
		return req<RestartServerResponse>("/server/restart", { method: "POST" });
	},
	backendStatus(): Promise<BackendStatusResponse> {
		return req<BackendStatusResponse>("/backend");
	},
	probeBackend(id: string): Promise<{ ok: boolean; reason?: string; pinned?: boolean; identity?: { version: string | null; commit: string | null } }> {
		return req("/backend/probe", { method: "POST", body: JSON.stringify({ id }) });
	},
	switchBackend(id: string, force = false): Promise<BackendSwitchResponse> {
		return req("/backend/switch", { method: "POST", body: JSON.stringify({ id, force }) });
	},
};
