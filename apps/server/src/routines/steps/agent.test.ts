import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { RoutineStep } from "@npi-deck/protocol";
import { AgentJsonStream, executeAgentStep } from "./agent.ts";
import type { RunContext } from "../types.ts";

const message = (timestamp: number, answer: string, input: number, output: number, cost: number) => ({
	role: "assistant", timestamp, model: "test", content: [{ type: "text", text: answer }],
	usage: { input, output, cacheRead: 7, cacheWrite: 3, cost: { total: cost } },
});
const context: RunContext = {
	run: { id: "run", date: "2026-01-01", started: "2026-01-01", iso_started: "2026-01-01", trigger_kind: "manual" },
	trigger: {}, steps: {}, env: {}, secrets: {}, state: {},
};

function events(...records: unknown[]): AgentJsonStream {
	const adapter = new AgentJsonStream();
	const bytes = new TextEncoder().encode(records.map(record => JSON.stringify(record)).join("\n") + "\n");
	for (let pos = 0; pos < bytes.length; pos += 13) adapter.feed(bytes.slice(pos, pos + 13));
	adapter.finish();
	return adapter;
}

describe("NeoPi JSON agent stream", () => {
	test("counts each assistant turn once, including cached input, without clipping a long terminal answer", () => {
		const first = message(1, "tool-call preamble", 11, 5, 0.002);
		const last = message(2, "x".repeat(9000), 23, 9, 0.0034);
		const adapter = events(
			{ type: "message_end", message: first }, { type: "turn_end", message: first },
			{ type: "message_end", message: last }, { type: "agent_end", messages: [first, last] },
		);
		expect(adapter.result()).toEqual({ answer: "x".repeat(9000), error: undefined, tokensIn: 54, tokensOut: 14, costMicros: 5400 });
	});

	test("reports an incomplete terminal stream while preserving incurred usage", () => {
		const adapter = events({ type: "message_end", message: message(3, "partial", 20, 4, 0.001) });
		expect(adapter.result()).toMatchObject({ error: "NeoPi JSON stream ended without agent_end", tokensIn: 30, tokensOut: 4, costMicros: 1000 });
	});

	test("rejects nonempty MCP allowlist before spawning on the current backend", async () => {
		const step = { id: "agent", type: "agent", prompt: "hello", mcp_servers_allowed: ["server"] } as Extract<RoutineStep, { type: "agent" }>;
		const result = await executeAgentStep(step, context, new AbortController().signal, "/tmp", ["bun", "/nonexistent/packages/coding-agent/src/cli.ts"]);
		expect(result.status).toBe("failed");
		expect(result.error).toContain("mcp.includeServers and --mcp");
	});
});

test("headless CLI applies exact model and skills flags, validates the terminal answer, and refuses flag warnings", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "npi-agent-flags-"));
	const previousHome = process.env.NPI_DECK_HOME;
	process.env.NPI_DECK_HOME = dir;
	const script = path.join(dir, "cli.ts");
	const argsFile = path.join(dir, "args.json");
	writeFileSync(script, `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
const msg = {role:"assistant",timestamp:1,model:"test",content:[{type:"text",text:'{"answer":17}'}],usage:{input:5,output:4,cacheRead:2,cacheWrite:1,cost:{total:0.002}}};
process.stdout.write(JSON.stringify({type:"message_end",message:msg})+"\\n"+JSON.stringify({type:"agent_end",messages:[msg]})+"\\n");
if (process.argv.some(arg => arg.startsWith("warn"))) process.stderr.write("Unrecognized flags: --skills\\n");
`);
	try {
		const step = {
			id: "agent", type: "agent", prompt: "reply", model: "openrouter/openai/gpt-4o-mini",
			skills_allowed: ["alpha", "beta"], structured_output: { schema: { type: "object", properties: { answer: { const: 18 } }, required: ["answer"] } },
		} as Extract<RoutineStep, { type: "agent" }>;
		const invalid = await executeAgentStep(step, context, new AbortController().signal, dir, [process.execPath, script]);
		expect(invalid.status).toBe("failed");
		expect(invalid.error).toContain("structured_output schema failure");
		expect(invalid.llmCostMicros).toBe(2000);
		expect(readFileSync(argsFile, "utf8")).toContain('"--skills","alpha,beta"');
		expect(readFileSync(argsFile, "utf8")).toContain('"--model","openrouter/openai/gpt-4o-mini"');
		const disabled = await executeAgentStep({ ...step, mcp_servers_allowed: [], skills_allowed: [],
			structured_output: { schema: { type: "object" } } }, context, new AbortController().signal, dir, [process.execPath, script]);
		expect(disabled.status).toBe("success");
		expect(readFileSync(argsFile, "utf8")).toContain('"--no-mcp"');
		expect(readFileSync(argsFile, "utf8")).toContain('"--no-skills"');
		const warned = await executeAgentStep({ ...step, prompt: "warn", structured_output: { schema: { type: "object" } } }, context, new AbortController().signal, dir, [process.execPath, script]);
		expect(warned.status).toBe("failed");
		expect(warned.error).toContain("agent rejected CLI flag");
	} finally {
		if (previousHome === undefined) delete process.env.NPI_DECK_HOME;
		else process.env.NPI_DECK_HOME = previousHome;
		rmSync(dir, { recursive: true, force: true });
	}
});
