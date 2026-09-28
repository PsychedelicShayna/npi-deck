import { validateStructuredOutput, type RoutineStep } from "@npi-deck/protocol";
import { spawnOwned, terminateOwned } from "../../owned-process.ts";
import { isLiteralAllowlistName } from "../../literal-allowlist-name.ts";
import { feature } from "../../backend/runtime.ts";
import { routineAgentCommand, routineAgentSupportsMcpAllowlist } from "../agent-command.ts";
import { renderString } from "../template.ts";
import type { RunContext, StepResult } from "../types.ts";

const MAX_EXCERPT = 8 * 1024;
const MAX_PROMPT_CHARS = 30 * 1024;
const UNKNOWN_FLAG = /(?:unrecognized|unknown|unsupported|invalid)\s+(?:command.line\s+)?(?:option|flag|argument)/i;

type AgentStep = Extract<RoutineStep, { type: "agent" }>;

/** Each assistant message is counted once, not once per message_end/turn_end/agent_end. */
export class AgentJsonStream {
	private readonly seen = new Set<string>();
	private buffer = "";
	private readonly decoder = new TextDecoder();
	private lastAnswer: string | undefined;
	private terminal = false;
	private streamError: string | undefined;
	private tokensIn = 0;
	private tokensOut = 0;
	private costUsd = 0;

	feed(bytes: Uint8Array): void {
		this.buffer += this.decoder.decode(bytes, { stream: true });
		this.drain(false);
	}

	finish(): void {
		this.buffer += this.decoder.decode();
		this.drain(true);
	}

	private drain(final: boolean): void {
		let newline: number;
		while ((newline = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) this.record(line);
		}
		if (final && this.buffer.trim()) this.record(this.buffer.trim());
		if (final) this.buffer = "";
	}

	private record(line: string): void {
		let event: Record<string, unknown>;
		try {
			const value: unknown = JSON.parse(line);
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an event object");
			event = value as Record<string, unknown>;
		} catch {
			this.streamError ??= "invalid NeoPi JSON event stream";
			return;
		}
		if (event.type === "message_end") this.count(event.message);
		if (event.type === "agent_end") {
			this.terminal = true;
			if (Array.isArray(event.messages)) {
				for (const message of event.messages) this.count(message);
				// agent_end is authoritative for the terminal answer; never return a
				// tool-call preamble from an earlier assistant message.
				const finalAssistant = event.messages.findLast(isAssistant);
				if (finalAssistant?.stopReason === "error" || finalAssistant?.stopReason === "aborted") {
					this.streamError ??= `NeoPi assistant stopped with ${finalAssistant.stopReason}: ${String(finalAssistant.errorMessage ?? "")}`;
				}
				this.lastAnswer = finalAssistant ? textOf(finalAssistant) : undefined;
			}
		}
	}

	private count(message: unknown): void {
		if (!isAssistant(message)) return;
		const key = `${message.timestamp}:${message.responseId ?? ""}:${message.model}`;
		if (this.seen.has(key)) return;
		this.seen.add(key);
		const usage = message.usage;
		if (!usage || typeof usage !== "object") {
			this.streamError ??= "NeoPi assistant message omitted usage";
			return;
		}
		const u = usage as Record<string, unknown>;
		const orchestration = u.orchestration && typeof u.orchestration === "object" ? u.orchestration as Record<string, unknown> : {};
		const cost = u.cost && typeof u.cost === "object" ? (u.cost as Record<string, unknown>).total : undefined;
		if (![u.input, u.output, u.cacheRead, u.cacheWrite, cost].every(isAmount)) {
			this.streamError ??= "NeoPi assistant message has incomplete token/cost usage";
			return;
		}
		this.tokensIn += amount(u.input) + amount(u.cacheRead) + amount(u.cacheWrite) + amount(orchestration.input) + amount(orchestration.cacheRead);
		this.tokensOut += amount(u.output) + amount(orchestration.output);
		this.costUsd += amount(cost);
	}

	result(): { answer?: string; error?: string; tokensIn: number; tokensOut: number; costMicros: number } {
		return {
			answer: this.lastAnswer,
			error: this.streamError ?? (!this.terminal ? "NeoPi JSON stream ended without agent_end" : undefined),
			tokensIn: this.tokensIn,
			tokensOut: this.tokensOut,
			costMicros: Math.round(this.costUsd * 1_000_000),
		};
	}
}

function amount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function isAmount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isAssistant(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value) && (value as { role?: unknown }).role === "assistant";
}

function textOf(message: Record<string, unknown>): string {
	if (!Array.isArray(message.content)) return "";
	return message.content.filter((part): part is { type: "text"; text: string } =>
		!!part && part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
}

async function drainStderr(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let excerpt = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (excerpt.length < MAX_EXCERPT) excerpt += decoder.decode(value, { stream: true }).slice(0, MAX_EXCERPT - excerpt.length);
	}
	return excerpt + decoder.decode();
}

async function drainEvents(stream: ReadableStream<Uint8Array> | null, adapter: AgentJsonStream): Promise<void> {
	if (!stream) return;
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		adapter.feed(value);
	}
	adapter.finish();
}

function skillsFlags(step: AgentStep): string[] {
	const names = step.skills_allowed;
	if (!names) return [];
	if (!names.length) return ["--no-skills"];
	for (const name of names) {
		if (!isLiteralAllowlistName(name)) {
			throw new Error(`Skills allowlist ${JSON.stringify(name)} is not a literal skill name expressible by --skills`);
		}
	}
	return ["--skills", names.join(",")];
}

async function mcpFlags(step: AgentStep, command: string[], cwd: string): Promise<string[]> {
	const names = step.mcp_servers_allowed;
	if (!names) return [];
	if (!routineAgentSupportsMcpAllowlist(command)) {
		throw new Error("MCP allowlist requires a backend supporting mcp.includeServers and --mcp/--no-mcp (neopi#120)");
	}
	if (!names.length) return ["--no-mcp"];
	for (const name of names) {
		if (!isLiteralAllowlistName(name)) {
			throw new Error(`MCP allowlist server ${JSON.stringify(name)} is not a literal server name expressible by --mcp`);
		}
	}
	const { unmatchedIncludes } = await feature("mcp-allowlist").loadAllMCPConfigs(cwd, { includeServers: names });
	if (unmatchedIncludes?.length) throw new Error(`MCP allowlist names no available server: ${unmatchedIncludes.join(", ")}`);
	return ["--mcp", names.join(",")];
}

export async function executeAgentStep(
	step: AgentStep,
	context: RunContext,
	signal: AbortSignal,
	defaultCwd: string,
	pinnedCommand?: string[],
): Promise<StepResult> {
	const startedMs = Date.now();
	let prompt = renderString(step.prompt, context as unknown as Record<string, unknown>);
	if (step.structured_output) {
		prompt += `\n\nRespond with ONLY JSON matching this schema (no prose, no fences):\n${JSON.stringify(step.structured_output.schema)}`;
	}
	if (prompt.length > MAX_PROMPT_CHARS) prompt = prompt.slice(0, MAX_PROMPT_CHARS) + `\n[prompt truncated at ${MAX_PROMPT_CHARS} chars]`;
	const adapter = new AgentJsonStream();
	let stderr = "";
	const result = (status: StepResult["status"], error?: string, json?: unknown): StepResult => {
		const usage = adapter.result();
		return {
			status, stdoutExcerpt: (usage.answer ?? "").slice(0, MAX_EXCERPT), stderrExcerpt: stderr.slice(0, MAX_EXCERPT),
			...(error ? { error } : {}), ...(json !== undefined ? { json } : {}),
			durationMs: Date.now() - startedMs, model: step.model,
			llmTokensIn: usage.tokensIn, llmTokensOut: usage.tokensOut, llmCostMicros: usage.costMicros,
		};
	};
	try {
		const command = pinnedCommand ?? routineAgentCommand([]);
		const args = ["-p", "--mode", "json", "--no-session", ...(step.model ? ["--model", step.model] : []),
			...skillsFlags(step),
			...await mcpFlags(step, command, defaultCwd), prompt];
		const proc = spawnOwned([...command, ...args], {
			cwd: defaultCwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
		});
		const onAbort = () => { void terminateOwned(proc); };
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		try {
			const [, capturedStderr, exitCode] = await Promise.all([drainEvents(proc.stdout, adapter), drainStderr(proc.stderr), proc.exited]);
			stderr = capturedStderr;
			if (signal.aborted) return result("aborted", "aborted");
			if (exitCode !== 0) return result("failed", `agent exit code ${exitCode}: ${stderr.slice(0, 300)}`);
			if (UNKNOWN_FLAG.test(stderr)) return result("failed", `agent rejected CLI flag: ${stderr.slice(0, 300)}`);
			const usage = adapter.result();
			if (usage.error) return result("failed", usage.error);
			if (usage.answer === undefined) return result("failed", "NeoPi agent_end has no assistant answer");
			let json: unknown;
			if (step.structured_output) {
				try {
					json = JSON.parse(usage.answer);
					const validation = validateStructuredOutput(step.structured_output.schema, json);
					if (!validation.valid) return result("failed", `structured_output schema failure: ${JSON.stringify(validation.errors)}`);
				} catch (error) {
					return result("failed", `structured_output parse/validation failure: ${String(error)}`);
				}
			}
			return result("success", undefined, json);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	} catch (error) {
		return result("failed", String(error));
	}
}
