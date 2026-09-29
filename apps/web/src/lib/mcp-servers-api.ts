import type {
	McpServerCreateRequest,
	McpServerDeleteRequest,
	McpServerEnabledRequest,
	McpServerMutationResponse,
	McpServersResponse,
	McpServerUpdateRequest,
} from "@npi-deck/protocol";

/** A refused request, with its HTTP status so a stale draft (409) can reload. */
export class McpServersApiError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(`/api${path}`, {
		method,
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	if (!response.ok) {
		// The server returns NeoPi's own validation message; surface it verbatim.
		const details = await response.json().catch(() => ({})) as { error?: string };
		throw new McpServersApiError(details.error ?? `HTTP ${response.status}`, response.status);
	}
	return await response.json() as T;
}

const named = (name: string) => `/mcp-servers/${encodeURIComponent(name)}`;

export const mcpServersApi = {
	list: () => request<McpServersResponse>("GET", "/mcp-servers"),
	create: (body: McpServerCreateRequest) => request<McpServerMutationResponse>("POST", "/mcp-servers", body),
	update: (name: string, body: McpServerUpdateRequest) => request<McpServerMutationResponse>("PUT", named(name), body),
	remove: (name: string, body: McpServerDeleteRequest) => request<McpServerMutationResponse>("DELETE", named(name), body),
	setEnabled: (name: string, body: McpServerEnabledRequest) =>
		request<McpServerMutationResponse>("POST", `${named(name)}/enabled`, body),
};
