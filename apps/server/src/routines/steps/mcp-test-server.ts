/**
 * Fake stdio MCP server for the `mcp` step and Integrations tests.
 *
 *   bun mcp-test-server.ts <event-log> [extra args…]
 *
 * Appends one JSON line per event (`start` with its pid, `call` with the tool
 * and arguments) to <event-log>, so a test can see what reached the server and
 * whether its process is still alive. `leak` and `fail` echo the server's own
 * env (`FAKE_TOKEN`) and argv back, as a careless or hostile server would.
 */
import { appendFileSync } from "node:fs";

const [logPath, ...extraArgs] = process.argv.slice(2);
const record = (event: Record<string, unknown>) => {
	if (logPath) appendFileSync(logPath, `${JSON.stringify(event)}\n`);
};
record({ event: "start", pid: process.pid });

const tools = [
	{
		name: "echo",
		description: "Repeat text",
		inputSchema: {
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: { text: { type: "string" }, times: { type: "integer", minimum: 1 } },
			required: ["text"],
			additionalProperties: false,
		},
	},
	// The description quotes the server's credentials, so listing tools must scrub too.
	{ name: "leak", description: `Echo ${process.env.FAKE_TOKEN ?? ""} ${extraArgs.join(" ")}`, inputSchema: { type: "object", properties: {} } },
	{ name: "fail", description: "Report a tool error", inputSchema: { type: "object", properties: {} } },
	{ name: "hang", description: "Never answer", inputSchema: { type: "object", properties: {} } },
	{ name: "picture", description: "Return an image", inputSchema: { type: "object", properties: {} } },
	{
		name: "odd-schema",
		description: "Advertise a schema Ajv cannot compile",
		inputSchema: { type: "object", properties: { value: { type: "no-such-type" } } },
	},
];

type Message = { id?: number | string; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } };

function reply(id: number | string, result: unknown): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function call(id: number | string, name: string, args: Record<string, unknown>): void {
	record({ event: "call", name, arguments: args });
	const secrets = `${process.env.FAKE_TOKEN ?? ""} ${extraArgs.join(" ")}`;
	switch (name) {
		case "echo": {
			const text = Array.from({ length: Number(args.times ?? 1) }, () => String(args.text)).join(" ");
			return reply(id, { content: [{ type: "text", text }], structuredContent: { echoed: text } });
		}
		case "leak":
			return reply(id, {
				content: [{ type: "text", text: `credentials: ${secrets}` }],
				structuredContent: { token: process.env.FAKE_TOKEN, argv: extraArgs },
			});
		case "fail":
			return reply(id, { content: [{ type: "text", text: `denied for ${secrets}` }], isError: true });
		case "hang":
			return;
		case "picture":
			return reply(id, { content: [{ type: "image", mimeType: "image/png", data: "A".repeat(4096) }, { type: "text", text: "a picture" }] });
		case "odd-schema":
			return reply(id, { content: [{ type: "text", text: `odd ${JSON.stringify(args)}` }] });
		default:
			return reply(id, { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true });
	}
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
	buffer += new TextDecoder().decode(chunk);
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (!line) continue;
		const message = JSON.parse(line) as Message;
		if (message.id === undefined) continue;
		if (message.method === "initialize") {
			reply(message.id, {
				protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "fake-mcp", version: "1.2.3" },
			});
		} else if (message.method === "tools/list") {
			reply(message.id, { tools });
		} else if (message.method === "tools/call") {
			call(message.id, message.params?.name ?? "", message.params?.arguments ?? {});
		} else {
			reply(message.id, {});
		}
	}
}
