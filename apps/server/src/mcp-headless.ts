/**
 * NeoPi's MCP client without a chat, for routine `mcp` steps and the
 * Integrations page.
 *
 * A routine fires from cron, a webhook or an event, usually with no chat open,
 * and a chat's MCP manager belongs to that chat: its workspace, its per-chat
 * server selection, and a lifetime the idle reaper can end mid-call. So each
 * caller discovers servers for its own workspace exactly as a chat opened
 * there would (user and project `mcp.json`, other tools' configs, the deny and
 * force-enable lists, `mcp.enableProjectConfig`, `mcp.includeServers`),
 * connects the one server it needs, and closes it when done. NeoPi's manager
 * resolves `!command` values and stored OAuth tokens before connecting; the
 * resolved config only feeds the connection and the secret scrubber.
 *
 * Every message this module produces has already passed the scrubber, since
 * NeoPi's errors and a server's replies can quote a config's credentials.
 */
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type {
	MCPServerConfig,
	MCPServerConnection,
	MCPToolCallResult,
	MCPToolDefinition,
} from "@oh-my-pi/pi-coding-agent/mcp/types";

import { getDeckAuthStorage } from "./auth-singleton.ts";
import { activeBackend, feature, hasFeature, sdk } from "./backend/runtime.ts";
import { configSecrets, scrubberFor, type Scrub } from "./mcp-secrets.ts";

export interface DiscoveredMcpServer {
	name: string;
	config: MCPServerConfig;
	source: SourceMeta | undefined;
}

/** A failure whose message is already scrubbed; `aborted` when the caller's signal ended it. */
export class McpClientError extends Error {
	override name = "McpClientError";
	constructor(message: string, readonly aborted = false) {
		super(message);
	}
}

/** The deck can call MCP tools only when a backend is loaded and exposes NeoPi's MCP client. */
export function mcpCallsAvailable(): boolean {
	return activeBackend() !== undefined && hasFeature("mcp-calls");
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The servers a chat opened in `cwd` would start, by name. Exa and browser
 * servers are kept: a chat hides them only because NeoPi has native tools in
 * their place, and a routine has neither.
 */
export async function discoverMcpServers(cwd: string): Promise<DiscoveredMcpServer[]> {
	const calls = feature("mcp-calls");
	const core = sdk();
	// Discovery reads through a process-lifetime file cache; an edit made since
	// (in a terminal, or in Settings) must count, as `/mcp reload` makes it.
	calls.clearFsCache();
	const settings = await core.Settings.loadReadOnly({ cwd, agentDir: core.getAgentDir() });
	const includeServers = hasFeature("mcp-allowlist") ? feature("mcp-allowlist").cfgMcpIncludeServers.get(settings) : [];
	const { configs, sources } = await calls.loadAllMCPConfigs(cwd, {
		enableProjectConfig: calls.cfgMcpEnableProjectConfig.get(settings),
		filterExa: false,
		filterBrowser: false,
		...(includeServers.length > 0 ? { includeServers } : {}),
	});
	return Object.entries(configs)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, config]) => ({ name, config, source: sources[name] }));
}

const isStdio = (config: MCPServerConfig): config is Extract<MCPServerConfig, { command: string }> =>
	config.type === undefined || config.type === "stdio";

/** One connected server: its advertised tools, a call, and the scrubber for its credentials. */
export class McpToolClient {
	private closed = false;

	private constructor(
		readonly name: string,
		readonly tools: MCPToolDefinition[],
		readonly scrub: Scrub,
		private readonly connection: MCPServerConnection,
	) {}

	/** The server's own name and version from `initialize`. */
	get serverInfo(): { name: string; version: string } {
		return { name: this.connection.serverInfo.name, version: this.connection.serverInfo.version };
	}

	/**
	 * Connect `server` for `cwd` and list its tools. A stdio server without its
	 * own `cwd` starts in `cwd`, not wherever the deck process runs. Aborting
	 * `signal` stops the handshake and closes the transport.
	 */
	static async connect(cwd: string, server: DiscoveredMcpServer, signal: AbortSignal): Promise<McpToolClient> {
		const calls = feature("mcp-calls");
		let scrub = scrubberFor(configSecrets(server.config));
		const problems = calls.validateServerConfig(server.name, server.config);
		if (problems.length > 0) throw new McpClientError(scrub(`invalid config: ${problems.join("; ")}`));
		const stored = isStdio(server.config) && server.config.cwd === undefined ? { ...server.config, cwd } : server.config;
		const manager = new calls.MCPManager(cwd);
		manager.setAuthStorage(await getDeckAuthStorage());
		let resolved: MCPServerConfig;
		try {
			resolved = await manager.prepareConfig(stored);
		} catch (error) {
			throw new McpClientError(scrub(`could not resolve its config: ${message(error)}`));
		}
		scrub = scrubberFor([...configSecrets(server.config), ...configSecrets(resolved)]);
		if (signal.aborted) throw new McpClientError("aborted before connecting", true);

		let connection: MCPServerConnection;
		try {
			connection = await calls.connectToServer(server.name, resolved, { signal });
		} catch (error) {
			throw new McpClientError(scrub(message(error)), signal.aborted);
		}
		// Keep the stored config on the connection, as NeoPi's manager does,
		// so nothing downstream holds the resolved credentials.
		connection.config = server.config;
		try {
			const tools = await calls.listTools(connection, { signal });
			return new McpToolClient(server.name, tools, scrub, connection);
		} catch (error) {
			await calls.disconnectServer(connection).catch(() => {});
			throw new McpClientError(scrub(`tools/list failed: ${message(error)}`), signal.aborted);
		}
	}

	/** `tools/call`; the transport's own request timeout still applies. */
	async call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<MCPToolCallResult> {
		try {
			return await feature("mcp-calls").callTool(this.connection, tool, args, { signal });
		} catch (error) {
			throw new McpClientError(this.scrub(message(error)), signal.aborted);
		}
	}

	/** Close the transport; a stdio server's process group is terminated. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await feature("mcp-calls").disconnectServer(this.connection).catch(() => {});
	}
}
