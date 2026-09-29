import type { McpIntegrationsResponse } from "@npi-deck/protocol";

export const integrationsApi = {
	/** Connects every enabled MCP server once (up to 20 s) and lists its tools. */
	async mcp(): Promise<McpIntegrationsResponse> {
		const response = await fetch("/api/integrations/mcp");
		if (!response.ok) {
			const details = await response.json().catch(() => ({})) as { error?: string; reason?: string };
			throw new Error(details.reason ?? details.error ?? `HTTP ${response.status}`);
		}
		return await response.json() as McpIntegrationsResponse;
	},
};
