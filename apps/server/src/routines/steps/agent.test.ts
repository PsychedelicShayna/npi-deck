import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
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
			{ type: "advisor_progress", message: "reading: " + "x".repeat(9000) },
			{ type: "message_end", message: last }, { type: "agent_end", messages: [first, last] },
		);
		expect(adapter.result()).toEqual({ answer: "x".repeat(9000), error: undefined, tokensIn: 54, tokensOut: 14, costMicros: 5400 });
	});

	test("reports an incomplete terminal stream while preserving incurred usage", () => {
		const adapter = events({ type: "message_end", message: message(3, "partial", 20, 4, 0.001) });
		expect(adapter.result()).toMatchObject({ error: "NeoPi JSON stream ended without agent_end", tokensIn: 30, tokensOut: 4, costMicros: 1000 });
	});

	test("an advisor pause is not a terminal answer, even if both messages share a millisecond", () => {
		const interim = message(5, "advisor is still working", 11, 2, 0.001);
		const answer = message(5, "the final answer", 13, 4, 0.002);
		const adapter = events(
			{ type: "message_end", message: interim },
			{ type: "agent_end", isTerminal: false, messages: [interim] },
			{ type: "advisor_progress", message: "waiting for advisor" },
			{ type: "message_end", message: answer },
			{ type: "agent_end", isTerminal: true, messages: [interim, answer] },
		);
		expect(adapter.result()).toEqual({
			answer: "the final answer", error: undefined, tokensIn: 44, tokensOut: 6, costMicros: 3000,
		});
		const incomplete = events({ type: "agent_end", isTerminal: false, messages: [interim] });
		expect(incomplete.result()).toMatchObject({ error: "NeoPi JSON stream ended without agent_end", tokensIn: 21 });
	});

	test("rejects MCP restrictions on an unverified backend before spawning", async () => {
		for (const names of [["server"], []]) {
			const step = { id: "agent", type: "agent", prompt: "hello", mcp_servers_allowed: names } as Extract<RoutineStep, { type: "agent" }>;
			const result = await executeAgentStep(step, context, new AbortController().signal, "/tmp", ["bun", "/nonexistent/packages/coding-agent/src/cli.ts"]);
			expect(result.status).toBe("failed");
			expect(result.error).toContain("MCP allowlist requires a backend supporting");
		}
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
		expect(invalid.error).toContain("structured_output does not match schema: /answer must be equal to constant");
		expect(invalid.llmCostMicros).toBe(2000);
		expect(readFileSync(argsFile, "utf8")).toContain('"--skills","alpha,beta"');
		expect(readFileSync(argsFile, "utf8")).toContain('"--model","openrouter/openai/gpt-4o-mini"');
		unlinkSync(argsFile);
		const unsupported = await executeAgentStep({ ...step, mcp_servers_allowed: [], skills_allowed: [],
			structured_output: { schema: { type: "object" } } }, context, new AbortController().signal, dir, [process.execPath, script]);
		expect(unsupported.status).toBe("failed");
		expect(unsupported.error).toContain("MCP allowlist requires a backend supporting");
		expect(existsSync(argsFile)).toBe(false);
		const disabled = await executeAgentStep({ ...step, skills_allowed: [],
			structured_output: { schema: { type: "object" } } }, context, new AbortController().signal, dir, [process.execPath, script]);
		expect(disabled.status).toBe("success");
		expect(readFileSync(argsFile, "utf8")).toContain('"--no-skills"');
		for (const names of [["*"], ["!alpha"], ["alpha,beta"], ["alpha\\*"]]) {
			if (existsSync(argsFile)) unlinkSync(argsFile);
			const widened = await executeAgentStep({ ...step, skills_allowed: names }, context, new AbortController().signal, dir, [process.execPath, script]);
			expect(widened.status).toBe("failed");
			expect(widened.error).toContain("not a literal skill name");
			expect(existsSync(argsFile)).toBe(false);
		}
		const warned = await executeAgentStep({ ...step, prompt: "warn", structured_output: { schema: { type: "object" } } }, context, new AbortController().signal, dir, [process.execPath, script]);
		expect(warned.status).toBe("failed");
		expect(warned.error).toContain("agent rejected CLI flag");
	} finally {
		if (previousHome === undefined) delete process.env.NPI_DECK_HOME;
		else process.env.NPI_DECK_HOME = previousHome;
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("structured_output", () => {
	const schema = {
		type: "object",
		properties: { name: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
		required: ["name"],
		additionalProperties: false,
	};

	async function withAnswer(answer: string, structured: { schema: unknown; strict?: boolean }) {
		const dir = mkdtempSync(path.join(tmpdir(), "npi-agent-structured-"));
		const previousHome = process.env.NPI_DECK_HOME;
		process.env.NPI_DECK_HOME = dir;
		const script = path.join(dir, "cli.ts");
		writeFileSync(script, `
const msg = {role:"assistant",timestamp:1,model:"test",content:[{type:"text",text:${JSON.stringify(answer)}}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}};
process.stdout.write(JSON.stringify({type:"message_end",message:msg})+"\\n"+JSON.stringify({type:"agent_end",messages:[msg]})+"\\n");
`);
		try {
			const step = { id: "agent", type: "agent", prompt: "reply", structured_output: structured } as Extract<RoutineStep, { type: "agent" }>;
			return await executeAgentStep(step, context, new AbortController().signal, dir, [process.execPath, script]);
		} finally {
			if (previousHome === undefined) delete process.env.NPI_DECK_HOME;
			else process.env.NPI_DECK_HOME = previousHome;
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("schema-conforming output reaches steps.<id>.json unchanged", async () => {
		const value = { name: "deck", tags: ["a", "b"] };
		const result = await withAnswer(JSON.stringify(value), { schema });
		expect(result.status).toBe("success");
		expect(result.error).toBeUndefined();
		expect(result.json).toEqual(value);
	});

	test("syntactically valid JSON that violates the schema fails strict mode with instance paths", async () => {
		const cases: Array<[string, string[]]> = [
			["null", ["/ must be object"]],
			["{}", ["/ must have required property 'name'"]],
			['{"name":5,"tags":["ok",7]}', ["/name must be string", "/tags/1 must be string"]],
			['{"name":"deck","extra":true}', ["/ must NOT have additional properties 'extra'"]],
		];
		for (const [answer, messages] of cases) {
			const result = await withAnswer(answer, { schema, strict: true });
			expect(result.status).toBe("failed");
			expect(result.json).toBeUndefined();
			expect(result.error).toStartWith("structured_output does not match schema: ");
			for (const message of messages) expect(result.error).toContain(message);
		}
	});

	test("invalid JSON fails as a parse error distinct from schema mismatch", async () => {
		const result = await withAnswer("Sure! Here is the JSON: {name: deck}", { schema });
		expect(result.status).toBe("failed");
		expect(result.json).toBeUndefined();
		expect(result.error).toStartWith("structured_output is not valid JSON: ");
		expect(result.error).not.toContain("schema");
	});

	test("an uncompilable schema fails in either mode as a schema error, not a parse error", async () => {
		for (const [answer, strict] of [['{"name":"deck"}', true], ["not json", false]] as const) {
			const result = await withAnswer(answer, { schema: { type: "no-such-type" }, strict });
			expect(result.status).toBe("failed");
			expect(result.error).toStartWith("structured_output schema could not be compiled: ");
		}
	});

	test("$async schemas are refused in either mode instead of passing as a Promise", async () => {
		const schemas = [
			{ $async: true, type: "object", required: ["name"] },
			{ $async: true, type: "object", properties: { name: { $async: true, type: "string" } }, required: ["name"] },
			{ type: "object", properties: { name: { $async: true, type: "string" } }, required: ["name"] },
		];
		for (const asyncSchema of schemas) {
			for (const strict of [true, false]) {
				const result = await withAnswer('{"name":5}', { schema: asyncSchema, strict });
				expect(result.status).toBe("failed");
				expect(result.json).toBeUndefined();
				expect(result.error).toStartWith("structured_output schema could not be compiled: ");
			}
		}
	});

	test("a catastrophically backtracking pattern times out without blocking the event loop", async () => {
		const redos = { type: "array", items: { type: "string", pattern: "^(a+)+$" } };
		const answer = JSON.stringify(Array.from({ length: 30 }, () => "a".repeat(30) + "b"));
		let ticks = 0;
		const ticker = setInterval(() => ticks++, 25);
		const started = performance.now();
		try {
			const result = await withAnswer(answer, { schema: redos, strict: false });
			expect(result.status).toBe("failed");
			expect(result.error).toStartWith("structured_output validation timed out after 2000 ms");
		} finally {
			clearInterval(ticker);
		}
		expect(performance.now() - started).toBeLessThan(6_000);
		// ~2 s of validation at a 25 ms interval; an event loop blocked by the regex would not tick at all meanwhile.
		expect(ticks).toBeGreaterThanOrEqual(40);
	}, 20_000);

	test("answers over the size cap are refused before validation", async () => {
		const answer = JSON.stringify({ name: "x".repeat(300 * 1024) });
		const strict = await withAnswer(answer, { schema });
		expect(strict.status).toBe("failed");
		expect(strict.error).toBe(`structured_output answer is ${answer.length} characters; the limit is ${256 * 1024}`);
		const lenient = await withAnswer(answer, { schema, strict: false });
		expect(lenient.status).toBe("success");
		expect(lenient.json).toBeUndefined();
	});

	test("strict: false keeps the raw answer and withholds invalid JSON from later steps", async () => {
		for (const answer of ['{"name":5}', "not json"]) {
			const result = await withAnswer(answer, { schema, strict: false });
			expect(result.status).toBe("success");
			expect(result.json).toBeUndefined();
			expect(result.stdoutExcerpt).toBe(answer);
		}
		const valid = await withAnswer('{"name":"deck"}', { schema, strict: false });
		expect(valid.status).toBe("success");
		expect(valid.json).toEqual({ name: "deck" });
	});
});

test("aborting a streaming agent retains usage emitted before the terminal event", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "npi-agent-abort-"));
	const previousHome = process.env.NPI_DECK_HOME;
	process.env.NPI_DECK_HOME = dir;
	const script = path.join(dir, "cli.ts");
	const ready = path.join(dir, "ready");
	writeFileSync(script, `
import { writeFileSync } from "node:fs";
const message = { role: "assistant", timestamp: 1, model: "test",
  content: [{ type: "text", text: "partial" }],
  usage: { input: 5, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.002 } } };
process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1000);
`);
	try {
		const abort = new AbortController();
		const pending = executeAgentStep(
			{ id: "agent", type: "agent", prompt: "reply" } as Extract<RoutineStep, { type: "agent" }>,
			context, abort.signal, dir, [process.execPath, script],
		);
		for (let i = 0; i < 100 && !existsSync(ready); i++) await Bun.sleep(10);
		abort.abort();
		expect(existsSync(ready)).toBe(true);
		const result = await pending;
		expect(result).toMatchObject({
			status: "aborted", llmTokensIn: 8, llmTokensOut: 4, llmCostMicros: 2000,
		});
	} finally {
		if (previousHome === undefined) delete process.env.NPI_DECK_HOME;
		else process.env.NPI_DECK_HOME = previousHome;
		rmSync(dir, { recursive: true, force: true });
	}
});
