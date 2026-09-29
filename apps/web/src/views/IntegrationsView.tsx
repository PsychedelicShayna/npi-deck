import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plug, RotateCcw, Settings } from "lucide-react";
import type { McpIntegrationServer, McpIntegrationsResponse, McpIntegrationTool } from "@npi-deck/protocol";

import { Layout } from "@/components/Layout";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { integrationsApi } from "@/lib/integrations-api";

const SETTINGS_MCP = "/settings?section=mcp";

/**
 * /integrations — the MCP servers a routine's `mcp` step can call, and their
 * tools. Each enabled server for the deck's workspace is connected once for
 * the listing and closed again; adding, editing and switching servers on or
 * off happens in Settings → MCP servers.
 */
export function IntegrationsView() {
	const [data, setData] = useState<McpIntegrationsResponse | null>(null);
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(false);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			setData(await integrationsApi.mcp());
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => { void refresh(); }, [refresh]);

	const connected = data?.servers.filter(server => server.status === "connected") ?? [];
	const toolCount = connected.reduce((sum, server) => sum + server.tools.length, 0);

	return (
		<Layout
			sidebar={
				<div className="space-y-2 p-3">
					<div className="meta">Integrations</div>
					{data ? (
						<div className="text-sm text-ink-3">
							{connected.length} of {data.servers.length} MCP server{data.servers.length === 1 ? "" : "s"} connected,{" "}
							{toolCount} tool{toolCount === 1 ? "" : "s"}.
						</div>
					) : null}
					<Link to={SETTINGS_MCP} className="flex items-center gap-1 text-sm text-accent hover:underline">
						<Settings className="h-3.5 w-3.5" />
						Settings → MCP servers
					</Link>
				</div>
			}
			main={
				<div className="flex h-full min-h-0 flex-col">
					<div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
						<Plug className="h-4 w-4 text-accent" />
						<div className="meta">Integrations</div>
						<div className="flex-1" />
						<Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}>
							<RotateCcw className="h-3.5 w-3.5" />
							{loading ? "Checking…" : "Check again"}
						</Button>
					</div>
					<div className="min-h-0 flex-1 overflow-auto p-4">
						<div className="mx-auto max-w-5xl space-y-4">
							<div>
								<h1 className="text-xl font-semibold tracking-tight">MCP servers and tools</h1>
								<p className="mt-1 max-w-3xl text-sm text-ink-3">
									Every MCP server enabled for the deck's workspace, connected once to list the tools it offers
									and closed again. A routine's <code className="paper-code px-1 py-0.5 text-xs">mcp</code> step
									calls one of these tools by server and tool name, with <code className="paper-code px-1 py-0.5 text-xs">args</code>{" "}
									checked against the tool's input schema. Add, edit or switch servers off in{" "}
									<Link to={SETTINGS_MCP} className="text-accent hover:underline">Settings → MCP servers</Link>.
								</p>
							</div>

							{error ? (
								<div role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{error}</div>
							) : null}

							{data ? (
								<>
									<div className="rounded-md border border-line bg-paper-2 px-3 py-2 font-mono text-2xs text-ink-3">
										<div>workspace: {data.cwd}</div>
										<div>checked: {new Date(data.checkedAt).toLocaleString()}</div>
									</div>
									{data.servers.length === 0 ? (
										<div className="text-sm text-ink-3">
											No MCP server is enabled for this workspace.{" "}
											<Link to={SETTINGS_MCP} className="text-accent hover:underline">Add one in Settings → MCP servers</Link>.
										</div>
									) : null}
									{data.servers.map(server => <ServerCard key={server.name} server={server} />)}
								</>
							) : error ? null : (
								<div className="text-sm text-ink-3">Connecting to each enabled server…</div>
							)}
						</div>
					</div>
				</div>
			}
			inspector={null}
			topBar={null}
		/>
	);
}

function ServerCard({ server }: { server: McpIntegrationServer }) {
	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="space-y-1 border-b border-line bg-paper-2 px-3 py-2">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="font-medium text-ink">{server.name}</span>
					<Badge tone="muted">{server.transport}</Badge>
					<Badge tone={server.status === "connected" ? "success" : "danger"}>{server.status}</Badge>
					{server.serverInfo ? (
						<span className="font-mono text-2xs text-ink-4">{server.serverInfo.name} {server.serverInfo.version}</span>
					) : null}
				</div>
				{server.sourcePath ? (
					<div className="break-all font-mono text-2xs text-ink-4">
						{server.providerName ? `${server.providerName} · ` : ""}{server.level ? `${server.level} · ` : ""}{server.sourcePath}
					</div>
				) : null}
			</div>
			{server.error ? (
				<div className="px-3 py-2 font-mono text-xs text-danger">{server.error}</div>
			) : server.tools.length === 0 ? (
				<div className="px-3 py-2 text-sm text-ink-3">This server offers no tools.</div>
			) : (
				<div className="divide-y divide-line">
					{server.tools.map(tool => <ToolRow key={tool.name} server={server.name} tool={tool} />)}
				</div>
			)}
		</div>
	);
}

function ToolRow({ server, tool }: { server: string; tool: McpIntegrationTool }) {
	const step = `- id: ${tool.name.replace(/[^A-Za-z0-9_]/g, "_")}\n  type: mcp\n  server: ${JSON.stringify(server)}\n  tool: ${JSON.stringify(tool.name)}\n  args: {}`;
	return (
		<details className="group px-3 py-2 text-sm">
			<summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-2">
				<span className="font-mono text-xs text-ink">{tool.name}</span>
				{tool.title ? <span className="text-ink-2">{tool.title}</span> : null}
				{tool.description ? <span className="line-clamp-1 flex-1 text-xs text-ink-3 group-open:line-clamp-none">{tool.description}</span> : null}
			</summary>
			<div className="mt-2 grid gap-2 md:grid-cols-2">
				<div>
					<div className="meta mb-1">Input schema</div>
					<pre className="max-h-64 overflow-auto rounded bg-paper-2 p-2 font-mono text-2xs text-ink-2">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
				</div>
				<div>
					<div className="meta mb-1">Routine step</div>
					<pre className="overflow-auto rounded bg-paper-2 p-2 font-mono text-2xs text-ink-2">{step}</pre>
				</div>
			</div>
		</details>
	);
}
