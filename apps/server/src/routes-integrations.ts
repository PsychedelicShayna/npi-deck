/**
 * `GET /api/integrations/mcp`: every enabled MCP server for the deck's default
 * workspace, connected once through the same path a routine `mcp` step uses,
 * with the tools it advertises, then closed. What a server fails with is
 * NeoPi's reason with every config credential scrubbed out; Settings → MCP
 * servers is where servers are added, edited and switched on or off.
 */
import { Hono } from "hono";
import type { McpIntegrationServer, McpIntegrationsResponse, McpTransport } from "@npi-deck/protocol";

import type { Config } from "./config.ts";
import { logger } from "./log.ts";
import { discoverMcpServers, McpClientError, mcpCallsAvailable, McpToolClient, type DiscoveredMcpServer } from "./mcp-headless.ts";
import { scrubDeep } from "./mcp-secrets.ts";

const log = logger("routes:integrations");
/** A listing waits this long for every server; one that has not answered by then is reported as failed. */
export const PROBE_TIMEOUT_MS = 20_000;
const LOAD_FAILED = "NeoPi could not read the MCP configuration; Settings → MCP servers shows each source.";

function transportOf(server: DiscoveredMcpServer): McpTransport {
	return server.config.type ?? "stdio";
}

async function probe(cwd: string, server: DiscoveredMcpServer, signal: AbortSignal, deadline: AbortSignal): Promise<McpIntegrationServer> {
	const row = {
		name: server.name,
		transport: transportOf(server),
		...(server.source ? { sourcePath: server.source.path, level: server.source.level, providerName: server.source.providerName } : {}),
	};
	let client: McpToolClient;
	try {
		client = await McpToolClient.connect(cwd, server, signal);
	} catch (error) {
		const reason = deadline.aborted
			? `no answer within ${PROBE_TIMEOUT_MS / 1000} s`
			: error instanceof McpClientError ? error.message : "connection failed";
		return { ...row, status: "failed", error: reason, tools: [] };
	}
	try {
		return {
			...row,
			status: "connected",
			serverInfo: scrubDeep(client.serverInfo, client.scrub),
			tools: scrubDeep(client.tools.map(tool => ({
				name: tool.name,
				...(tool.title !== undefined ? { title: tool.title } : {}),
				...(tool.description !== undefined ? { description: tool.description } : {}),
				inputSchema: tool.inputSchema,
			})), client.scrub),
		};
	} finally {
		await client.close();
	}
}

export function buildIntegrationsRouter(config: Config): Hono {
	const app = new Hono();

	app.get("/integrations/mcp", async c => {
		if (!mcpCallsAvailable()) {
			return c.json({ error: "This NeoPi backend does not expose its MCP client (manifest feature mcp-calls)." }, 503);
		}
		const cwd = config.defaultCwd;
		let servers: DiscoveredMcpServer[];
		try {
			servers = await discoverMcpServers(cwd);
		} catch (error) {
			// A parse error quotes file text, which can be a credential.
			log.warn(`MCP discovery for ${cwd} failed (${error instanceof Error ? error.name : typeof error})`);
			return c.json({ error: LOAD_FAILED }, 500);
		}
		const deadline = AbortSignal.timeout(PROBE_TIMEOUT_MS);
		const signal = AbortSignal.any([c.req.raw.signal, deadline]);
		const rows = await Promise.all(servers.map(server => probe(cwd, server, signal, deadline)));
		return c.json({ cwd, checkedAt: new Date().toISOString(), servers: rows } satisfies McpIntegrationsResponse);
	});

	return app;
}
