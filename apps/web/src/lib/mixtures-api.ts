import type {
	MixtureDiscovered,
	MixtureDraftRequest,
	MixtureDraftResponse,
	MixtureSaveRequest,
	MixtureSaveResponse,
	MixturesResponse,
} from "@npi-deck/protocol";

/** A failed mixtures request; `details` is the server's JSON body (validation reports, conflict state). */
export class MixturesApiError extends Error {
	constructor(
		readonly status: number,
		readonly details: Record<string, unknown>,
		message: string,
	) {
		super(message);
		this.name = "MixturesApiError";
	}
}

async function request<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
	const response = await fetch(`/api/mixtures${path}`, {
		method: init.method ?? (init.body === undefined ? "GET" : "POST"),
		signal: init.signal,
		...(init.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
	});
	if (!response.ok) {
		const raw = await response.text();
		let details: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed as Record<string, unknown>;
		} catch {
			details = { error: raw };
		}
		throw new MixturesApiError(response.status, details, typeof details.error === "string" ? details.error : `HTTP ${response.status}`);
	}
	return (await response.json()) as T;
}

export const mixturesApi = {
	load(cwd: string, signal?: AbortSignal) {
		return request<MixturesResponse>(`?cwd=${encodeURIComponent(cwd)}`, { signal });
	},
	draft(body: MixtureDraftRequest, signal?: AbortSignal) {
		return request<MixtureDraftResponse>("/draft", { body, signal });
	},
	save(body: MixtureSaveRequest) {
		return request<MixtureSaveResponse>("", { method: "PUT", body });
	},
	discovered(cwd: string, signal?: AbortSignal) {
		return request<MixtureDiscovered>(`/discovered?cwd=${encodeURIComponent(cwd)}`, { signal });
	},
};
