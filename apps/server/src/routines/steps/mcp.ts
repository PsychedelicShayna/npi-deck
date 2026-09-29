/**
 * `mcp` step: call one tool on one MCP server, without a model in the loop.
 *
 * The server is resolved the way a chat opened in the routine's cwd would
 * resolve it (see mcp-headless.ts for why a routine does not borrow a live
 * chat's MCP runtime), connected for this attempt only, and closed when the
 * step ends, so a retry gets a fresh server process and nothing outlives the
 * run. The runner's timeout and the routine's cancel both abort the step's
 * signal, which stops the handshake or the call and closes the transport.
 *
 * `args` are templated like the http step's body, then validated against the
 * tool's advertised input schema before anything is sent. A schema Ajv cannot
 * compile is not the routine author's fault, so the call still goes out (the
 * server validates its own input) and stderr says local validation was skipped.
 *
 * Results land in `steps.<id>`: the text content joined in `stdout`, and
 * `{ content, structuredContent?, isError? }` in `json`, with binary payloads
 * replaced by their size. `isError: true` fails the step with the tool's text.
 * Everything recorded passes the server config's secret scrubber first.
 */

import type { RoutineStep } from "@npi-deck/protocol";
import type { MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";

import { logger } from "../../log.ts";
import { discoverMcpServers, McpClientError, mcpCallsAvailable, McpToolClient, type DiscoveredMcpServer } from "../../mcp-headless.ts";
import { scrubDeep } from "../../mcp-secrets.ts";
import { renderDeep } from "../template.ts";
import type { RunContext, StepResult } from "../types.ts";
import { checkStructuredOutput } from "./structured-output.ts";

const log = logger("routines:mcp");
const MAX_EXCERPT = 8 * 1024;
const MAX_LISTED = 20;

type McpStep = Extract<RoutineStep, { type: "mcp" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function clip(text: string): string {
	return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT)}\n…(truncated)` : text;
}

function listed(names: string[]): string {
	if (names.length === 0) return "none";
	const shown = names.slice(0, MAX_LISTED).join(", ");
	return names.length > MAX_LISTED ? `${shown} (+${names.length - MAX_LISTED} more)` : shown;
}

/**
 * The input schema as Ajv 2020 can take it. MCP servers commonly declare
 * `"$schema": "…draft-07/schema#"` (zod-to-json-schema does), which Ajv 2020
 * refuses by URI although the keywords tools use mean the same in both drafts.
 */
function inputSchemaOf(schema: MCPToolDefinition["inputSchema"]): Record<string, unknown> {
	const { $schema: _dialect, ...rest } = schema;
	return rest;
}

/** A content item without its base64 payload: runs keep text, not megabytes of image. */
function withoutBinary(item: unknown): unknown {
	if (!isRecord(item)) return item;
	const out: Record<string, unknown> = { ...item };
	if (typeof out.data === "string") {
		out.dataOmitted = `${out.data.length} base64 characters`;
		delete out.data;
	}
	if (isRecord(out.resource) && typeof out.resource.blob === "string") {
		const { blob, ...resource } = out.resource;
		out.resource = { ...resource, blobOmitted: `${blob.length} base64 characters` };
	}
	return out;
}

function textOf(content: unknown[]): string {
	return content
		.map(item => isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : undefined)
		.filter((text): text is string => text !== undefined)
		.join("\n");
}

export async function executeMcpStep(step: McpStep, context: RunContext, signal: AbortSignal, cwd: string): Promise<StepResult> {
	const startedMs = Date.now();
	const result = (status: StepResult["status"], fields: Partial<StepResult>): StepResult => ({
		status,
		stdoutExcerpt: "",
		stderrExcerpt: "",
		...fields,
		durationMs: Date.now() - startedMs,
	});
	const failed = (error: string, fields: Partial<StepResult> = {}) => result("failed", { error, ...fields });
	const target = `MCP server '${step.server}'`;

	if (!mcpCallsAvailable()) {
		return failed("mcp steps need a NeoPi backend that exposes its MCP client (manifest feature mcp-calls)");
	}

	let args: unknown;
	try {
		args = step.args === undefined ? {} : renderDeep(step.args, context as unknown as Record<string, unknown>);
	} catch (error) {
		return failed(`args: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(args)) return failed("args must render to a JSON object");

	let servers: DiscoveredMcpServer[];
	try {
		servers = await discoverMcpServers(cwd);
	} catch (error) {
		// NeoPi's parse errors quote the offending file text, which can be a
		// credential: neither the run nor the log gets the message.
		log.warn(`MCP discovery for ${cwd} failed (${error instanceof Error ? error.name : typeof error})`);
		return failed(`NeoPi could not read the MCP configuration for ${cwd}`);
	}
	const server = servers.find(candidate => candidate.name === step.server);
	if (!server) {
		return failed(
			`${target} is not configured, or is disabled, for ${cwd}. Available: ${listed(servers.map(s => s.name))}. ` +
				"Settings → MCP servers lists every server and why one does not run.",
		);
	}
	if (signal.aborted) return result("aborted", { error: "aborted before connecting" });

	let client: McpToolClient;
	try {
		client = await McpToolClient.connect(cwd, server, signal);
	} catch (error) {
		const aborted = signal.aborted || (error instanceof McpClientError && error.aborted);
		const detail = error instanceof McpClientError ? error.message : "connection failed";
		return result(aborted ? "aborted" : "failed", { error: `${target}: ${detail}` });
	}

	try {
		const tool = client.tools.find(candidate => candidate.name === step.tool);
		if (!tool) {
			return failed(client.scrub(`${target} has no tool '${step.tool}'. Tools: ${listed(client.tools.map(t => t.name))}`));
		}

		let stderr = "";
		const checked = await checkStructuredOutput(inputSchemaOf(tool.inputSchema), JSON.stringify(args), {
			subject: `args for ${step.server}/${step.tool}`,
		});
		if (!checked.ok) {
			if (checked.kind !== "schema") return failed(client.scrub(checked.error));
			stderr = client.scrub(`${checked.error}; args were not validated locally, the server validates them\n`);
		}
		if (signal.aborted) return result("aborted", { error: "aborted before the call", stderrExcerpt: stderr });

		const reply = await client.call(step.tool, args, signal);
		const content = Array.isArray(reply.content) ? reply.content.map(withoutBinary) : [];
		const json = scrubDeep({
			content,
			...(reply.structuredContent !== undefined ? { structuredContent: reply.structuredContent } : {}),
			...(reply.isError === true ? { isError: true } : {}),
		}, client.scrub);
		const text = client.scrub(textOf(content));
		if (reply.isError === true) {
			return failed(clip(text) || `${step.server}/${step.tool} reported an error without text`, {
				stdoutExcerpt: clip(text),
				stderrExcerpt: stderr,
				json,
			});
		}
		return result("success", { stdoutExcerpt: clip(text), stderrExcerpt: stderr, json });
	} catch (error) {
		const aborted = signal.aborted || (error instanceof McpClientError && error.aborted);
		const detail = error instanceof McpClientError ? error.message : client.scrub(String(error));
		return result(aborted ? "aborted" : "failed", { error: `${step.server}/${step.tool}: ${detail}` });
	} finally {
		await client.close();
	}
}
