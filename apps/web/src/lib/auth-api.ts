import type {
	ListProvidersResponse,
	OAuthManualCodeRequest,
	OAuthPromptReplyRequest,
	StartOAuthResponse,
} from "@npi-deck/protocol";

const BASE = "/api/auth/oauth";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(body || `HTTP ${res.status} ${path}`);
	}
	return (await res.json()) as T;
}

export const authApi = {
	listProviders(): Promise<ListProvidersResponse> {
		return req<ListProvidersResponse>("/providers");
	},
	startOAuth(provider: string): Promise<StartOAuthResponse> {
		return req<StartOAuthResponse>(`/${encodeURIComponent(provider)}/start`, { method: "POST" });
	},
	cancelOAuth(provider: string): Promise<{ ok: boolean }> {
		return req<{ ok: boolean }>(`/${encodeURIComponent(provider)}/cancel`, { method: "POST" });
	},
	submitManualCode(flowId: string, code: string): Promise<{ ok: boolean }> {
		return req<{ ok: boolean }>(`/manual-code/${encodeURIComponent(flowId)}`, {
			method: "POST",
			body: JSON.stringify({ code } satisfies OAuthManualCodeRequest),
		});
	},
	replyPrompt(flowId: string, promptId: string, answer: string): Promise<{ ok: boolean }> {
		return req<{ ok: boolean }>(`/prompt-reply/${encodeURIComponent(flowId)}`, {
			method: "POST",
			body: JSON.stringify({ promptId, answer } satisfies OAuthPromptReplyRequest),
		});
	},
	revoke(provider: string): Promise<{ ok: boolean }> {
		return req<{ ok: boolean }>(`/${encodeURIComponent(provider)}`, { method: "DELETE" });
	},
};
