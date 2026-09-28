import type {
	McpServerCreateRequest,
	McpServerEnabledRequest,
	McpServerMutationResponse,
	McpServersResponse,
	McpServerTargetRequest,
	McpServerWriteRequest,
} from "@npi-deck/protocol";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(`/api${path}`, {
		method,
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	if (!response.ok) {
		// The server returns NeoPi's own validation message; surface it verbatim.
		const details = await response.json().catch(() => ({})) as { error?: string };
		throw new Error(details.error ?? `HTTP ${response.status}`);
	}
	return await response.json() as T;
}

const named = (name: string) => `/mcp-servers/${encodeURIComponent(name)}`;

export const mcpServersApi = {
	list: () => request<McpServersResponse>("GET", "/mcp-servers"),
	create: (body: McpServerCreateRequest) => request<McpServerMutationResponse>("POST", "/mcp-servers", body),
	update: (name: string, body: McpServerWriteRequest) => request<McpServerMutationResponse>("PUT", named(name), body),
	remove: (name: string, target: McpServerTargetRequest) => request<McpServerMutationResponse>("DELETE", named(name), target),
	setEnabled: (name: string, body: McpServerEnabledRequest) =>
		request<McpServerMutationResponse>("POST", `${named(name)}/enabled`, body),
};
