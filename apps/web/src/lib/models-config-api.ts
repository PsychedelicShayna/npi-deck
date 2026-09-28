import type {
	ModelsConfigDocumentRequest,
	ModelsConfigResponse,
	ModelsConfigSaveResponse,
	ModelsConfigValidateResponse,
} from "@npi-deck/protocol";

async function request<T>(method: string, url: string, body?: ModelsConfigDocumentRequest): Promise<T> {
	const response = await fetch(url, {
		method,
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	if (!response.ok) {
		// NeoPi's own validation message (credentials masked by the server); surface it verbatim.
		const details = await response.json().catch(() => ({})) as { error?: string };
		throw new Error(details.error ?? `HTTP ${response.status}`);
	}
	return await response.json() as T;
}

export const modelsConfigApi = {
	load: () => request<ModelsConfigResponse>("GET", "/api/models-config"),
	/** Run the document through NeoPi's loader; nothing is written. */
	validate: (raw: string) => request<ModelsConfigValidateResponse>("POST", "/api/models-config/validate", { raw }),
	save: (raw: string, revision: string) => request<ModelsConfigSaveResponse>("PUT", "/api/models-config", { raw, revision }),
};
