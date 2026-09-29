import type {
	CreateSessionRequest,
	CreateSessionResponse,
	ListFilePathsResponse,
	ListModelsResponse,
	ListSessionsResponse,
	ListSlashCommandsResponse,
	ListWorkspacesResponse,
	ModelRef,
	SessionFallbackChainResponse,
	SessionTranscriptResponse,
	SubagentTranscriptResponse,
} from "@npi-deck/protocol";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	if (!res.ok) {
		let body: string;
		try {
			body = await res.text();
		} catch {
			body = "(unreadable body)";
		}
		throw new Error(`HTTP ${res.status} ${path}: ${body}`);
	}
	return (await res.json()) as T;
}

export const api = {
	listWorkspaces(): Promise<ListWorkspacesResponse> {
		return request<ListWorkspacesResponse>("/workspaces");
	},
	listSessions(cwd?: string): Promise<ListSessionsResponse> {
		const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
		return request<ListSessionsResponse>(`/sessions${q}`);
	},
	/** Read-only transcript of a persisted session; creates no SDK session. `limit` keeps the newest messages. */
	getTranscript(path: string, limit?: number): Promise<SessionTranscriptResponse> {
		const q = limit === undefined ? "" : `&limit=${limit}`;
		return request<SessionTranscriptResponse>(`/sessions/transcript?path=${encodeURIComponent(path)}${q}`);
	},
	createSession(body: CreateSessionRequest): Promise<CreateSessionResponse> {
		return request<CreateSessionResponse>("/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	abortSession(id: string): Promise<{ ok: true }> {
		return request(`/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" });
	},
	getSubagentTranscript(sessionId: string, id: string, fromByte = 0): Promise<SubagentTranscriptResponse> {
		return request(`/subagents/${encodeURIComponent(sessionId)}/${encodeURIComponent(id)}/transcript?fromByte=${fromByte}`);
	},
	abortSubagent(sessionId: string, id: string): Promise<{ ok: true }> {
		return request(`/subagents/${encodeURIComponent(sessionId)}/${encodeURIComponent(id)}/abort`, { method: "POST" });
	},
	renameSession(id: string, name: string): Promise<{ ok: true; sessionId: string }> {
		return request(`/sessions/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ name }),
		});
	},
	listModels(sessionId?: string): Promise<ListModelsResponse> {
		const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
		return request<ListModelsResponse>(`/models${q}`);
	},
	setSessionModel(id: string, model: ModelRef): Promise<{ ok: true; sessionId: string }> {
		return request(`/sessions/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ model }),
		});
	},
	/** How retry.fallbackChains covers the chat's active model; edits go through npiConfigApi. */
	getSessionFallbackChain(id: string): Promise<SessionFallbackChainResponse> {
		return request(`/sessions/${encodeURIComponent(id)}/fallback-chain`);
	},
	compactSession(id: string, focus?: string): Promise<{ ok: true }> {
		const body = focus && focus.trim().length > 0 ? JSON.stringify({ focus: focus.trim() }) : "";
		const init: RequestInit = { method: "POST" };
		if (body) {
			init.body = body;
			init.headers = { "content-type": "application/json" };
		}
		return request(`/sessions/${encodeURIComponent(id)}/compact`, init);
	},
	disposeSession(id: string): Promise<{ ok: true }> {
		return request(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	listSlashCommands(cwd?: string): Promise<ListSlashCommandsResponse> {
		const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
		return request<ListSlashCommandsResponse>(`/slash-commands${q}`);
	},
	completeFilePath(cwd: string, q: string, limit = 20): Promise<ListFilePathsResponse> {
		const params = new URLSearchParams({ cwd, q, limit: String(limit) });
		return request<ListFilePathsResponse>(`/fs/complete?${params.toString()}`);
	},
};
