import type { NpiConfigPatchRequest, NpiConfigPatchResponse, NpiConfigResponse, NpiModelRolesResponse } from "@npi-deck/protocol";

async function request<T>(method: string, body?: NpiConfigPatchRequest, url = "/api/npi-config"): Promise<T> {
	const response = await fetch(url, {
		method,
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	if (!response.ok) {
		// The server returns the setting's own validation message; surface it verbatim.
		const details = await response.json().catch(() => ({})) as { error?: string };
		throw new Error(details.error ?? `HTTP ${response.status}`);
	}
	return await response.json() as T;
}

export const npiConfigApi = {
	list: () => request<NpiConfigResponse>("GET"),
	set: (id: string, value: unknown) => request<NpiConfigPatchResponse>("PATCH", { id, value }),
	/** Set single record keys (null deletes one); the other keys are kept. */
	setEntries: (id: string, entries: Record<string, unknown>) => request<NpiConfigPatchResponse>("PATCH", { id, entries }),
	reset: (id: string) => request<NpiConfigPatchResponse>("PATCH", { id, unset: true }),
	modelRoles: () => request<NpiModelRolesResponse>("GET", undefined, "/api/npi-config/model-roles"),
};
