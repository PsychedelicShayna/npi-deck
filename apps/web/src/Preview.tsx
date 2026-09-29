/**
 * /preview — static gallery of every tool renderer with mock data.
 *
 * Exists so design + highlighting changes can be inspected without firing a
 * real omp turn. Mounted by App.tsx when `?preview=1` is in the URL.
 */

import type { AgentMessageJson } from "@npi-deck/protocol";
import type { AssistantContentBlock, AssistantMsg, ToolCallStream } from "@/lib/types";
import { applyEvent, initSession } from "@/lib/reducer";
import { AssistantMessage } from "./components/messages/AssistantMessage";
import { UserMessage } from "./components/messages/UserMessage";
import { ThinkingBlock } from "./components/messages/ThinkingBlock";
import { Notice } from "./components/messages/Notice";

const NOW = Date.now();

function tcStream(partial: Partial<ToolCallStream> & { id: string; name: string }): ToolCallStream {
	return {
		id: partial.id,
		name: partial.name,
		args: partial.args,
		intent: partial.intent,
		status: partial.status ?? "complete",
		isError: partial.isError ?? false,
		startedAt: partial.startedAt ?? NOW - 1200,
		endedAt: partial.endedAt ?? NOW - 1100,
		partialResult: partial.partialResult,
		result: partial.result,
		resultContent: partial.resultContent,
	};
}

// One assistant message per tool-renderer so we exercise the lifecycle shell
// (header + content + status badge) the same way real omp turns do.
function makeMsg(id: string, blocks: AssistantContentBlock[]): {
	id: string;
	role: "assistant";
	blocks: AssistantContentBlock[];
	isStreaming: boolean;
	model: string;
	provider: string;
	durationMs: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: number;
	};
} {
	return {
		id,
		role: "assistant",
		blocks,
		isStreaming: false,
		model: "claude-opus-4-7",
		provider: "anthropic",
		durationMs: 2400,
		usage: {
			input: 4200,
			output: 312,
			cacheRead: 18000,
			cacheWrite: 6400,
			totalTokens: 28912,
			cost: 0.024,
		},
	};
}

const toolCalls: Record<string, ToolCallStream> = {
	"tc-read": tcStream({
		id: "tc-read",
		name: "read",
		args: { path: "~/projects/sample/package.json" },
		result: {
			content: [
				{
					type: "text",
					text: `{\n  "name": "npi-deck",\n  "version": "0.1.0",\n  "scripts": {\n    "dev": "bun run --filter='@npi-deck/*' dev",\n    "build": "bun run --filter '@npi-deck/web' build"\n  }\n}`,
				},
			],
		},
	}),
	"tc-write": tcStream({
		id: "tc-write",
		name: "write",
		args: {
			path: "~/projects/sample/notes.md",
			content: "# Notes\n\nA new file.\n",
		},
		result: "Wrote 22 bytes",
	}),
	"tc-edit": tcStream({
		id: "tc-edit",
		name: "edit",
		args: {
			path: "src/server.ts",
			patch: `@@ src/server.ts\n= 3oo..3oo\n~  hostname: \"0.0.0.0\",\n+ 9xx\n~  // graceful shutdown\n- 12yz..12yz`,
		},
		result: "Applied 3 hunks: +2 -1",
	}),
	"tc-bash": tcStream({
		id: "tc-bash",
		name: "bash",
		args: { command: "bun run typecheck && bun run --filter '@npi-deck/web' build" },
		result: { exitCode: 0, output: "tsc -b — OK\nvite v5.4.21 building for production...\n✓ 2081 modules transformed.\n✓ built in 3.44s" },
	}),
	"tc-search": tcStream({
		id: "tc-search",
		name: "grep",
		args: { pattern: "ImageAttachment", paths: ["apps/web/src/**/*.tsx"] },
		result: {
			summary: { totalMatches: 4 },
			content: [{ type: "text", text: "apps/web/src/components/Composer.tsx:7\napps/web/src/components/Composer.tsx:18\napps/web/src/lib/store.ts:9\napps/web/src/lib/store.ts:115" }],
		},
	}),
	"tc-lsp": tcStream({
		id: "tc-lsp",
		name: "lsp",
		args: { action: "rename", file: "apps/web/src/lib/store.ts", symbol: "sendPrompt", new_name: "submitPrompt" },
		result: { content: [{ type: "text", text: "Renamed 6 references across 3 files." }] },
	}),
	"tc-task": tcStream({
		id: "tc-task",
		name: "task",
		args: {
			agent: "explore",
			tasks: [
				{ id: "MapTools", description: "Catalog every tool renderer under components/tools/" },
				{ id: "AuditChrome", description: "Audit chrome/ for inconsistent token usage" },
			],
		},
		result: {
			subagents: [
				{ id: "MapTools", status: "complete", durationMs: 8400, cost: 0.04 },
				{ id: "AuditChrome", status: "complete", durationMs: 6100, cost: 0.03 },
			],
		},
	}),
	"tc-web": tcStream({
		id: "tc-web",
		name: "web_search",
		args: { query: "tailwind 3 vs 4 migration", provider: "auto" },
		result: { content: [{ type: "text", text: "**Top result** — *Tailwind v4 alpha release notes*\nNew Oxide engine, native CSS variables. Breaking: `theme.extend` flattened." }] },
	}),
	"tc-eval-js": tcStream({
		id: "tc-eval-js",
		name: "eval",
		args: {
			cells: [
				{
					language: "js",
					code: `const x = 42;\nconsole.log("hello, " + new Date().toISOString());\nfor (const n of [1, 2, 3]) {\n  console.log(\`item \${n}\`);\n}`,
				},
				{
					language: "py",
					title: "math.pi",
					code: `import math\n\ndef ratio(a: float, b: float) -> float:\n    \"\"\"Compute a / b safely.\"\"\"\n    if b == 0:\n        return float(\"inf\")\n    return a / b\n\nprint(math.pi)\nprint(ratio(22, 7))`,
				},
			],
		},
		result: "[1/2] hello, 2026-05-19T20:00:00.000Z\nitem 1\nitem 2\nitem 3\n\n[2/2] 3.141592653589793\n3.142857142857143",
	}),
	"tc-todo": tcStream({
		id: "tc-todo",
		name: "todo",
		args: {
			op: "init",
			list: [{ phase: "Phase 1", items: ["Map renderer surface", "Wire highlight.js"] }],
		},
	}),
	"tc-gen": tcStream({
		id: "tc-gen",
		name: "generate_image",
		args: { subject: "A misty Scottish loch at dawn, hand-drawn ink wash style" },
		result: { content: [{ type: "text", text: "(image data omitted in preview)" }] },
	}),
	"tc-browser": tcStream({
		id: "tc-browser",
		name: "browser",
		args: { action: "goto", url: "https://omp.sh/docs", name: "main" },
		result: { content: [{ type: "text", text: "Loaded omp.sh/docs (title: \"omp documentation\")." }] },
	}),
	"tc-running": tcStream({
		id: "tc-running",
		name: "grep",
		args: { pattern: "still going" },
		status: "running",
		endedAt: undefined,
	}),
	"tc-err": tcStream({
		id: "tc-err",
		name: "bash",
		args: { command: "exit 1" },
		status: "error",
		isError: true,
		result: { exitCode: 1, output: "command exited 1" },
	}),
};

// Reasoning as NeoPi's providers deliver it (shapes taken from real session
// transcripts), reduced through the same path as a live snapshot so the
// gallery exercises the reducer as well as the renderer.
function reasoningUsage(reasoningTokens?: number) {
	return {
		input: 4751,
		output: 49,
		cacheRead: 56320,
		cacheWrite: 0,
		totalTokens: 61120,
		...(reasoningTokens === undefined ? {} : { reasoningTokens }),
		cost: { input: 0.0095, output: 0.0005, cacheRead: 0.0113, cacheWrite: 0, total: 0.0213 },
	};
}

const reasoningShapes: Array<[string, AssistantMsg]> = (() => {
	const codexReasoningItem = JSON.stringify({
		type: "reasoning",
		id: "rs_0d95af9a1d5fb81f016aba21473dcc87",
		summary: [],
		encrypted_content: "gAAAAABqbkYz3Xk-preview-ciphertext",
	});
	const raw: Array<[string, AgentMessageJson]> = [
		["Readable thinking — Anthropic, signed", {
			role: "assistant", provider: "anthropic", model: "claude-opus-5-5", stopReason: "stop", usage: reasoningUsage(),
			content: [
				{ type: "thinking", thinking: "**Checking the pin**\n\nThe backend tree matches neopi.pin, so the contract run is valid.", thinkingSignature: "EqQBCkYIBxgCKkBpreviewsignature" },
				{ type: "text", text: "The pin matches." },
			],
		}],
		["Encrypted, no summary — OpenAI Codex (GPT-6 Sol) live", {
			role: "assistant", provider: "openai-codex", model: "gpt-6-sol", stopReason: "toolUse", usage: reasoningUsage(10),
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: codexReasoningItem },
				{ type: "text", text: "Checking the integrated typecheck." },
			],
		}],
		["Empty block after reload — signature dropped by session persistence", {
			role: "assistant", provider: "openai-codex", model: "gpt-6-sol", stopReason: "toolUse", usage: reasoningUsage(10),
			content: [
				{ type: "thinking", thinking: "" },
				{ type: "text", text: "Checking the integrated typecheck." },
			],
		}],
		["Redacted — Anthropic redacted_thinking", {
			role: "assistant", provider: "anthropic", model: "claude-opus-5-5", stopReason: "stop", usage: reasoningUsage(),
			content: [
				{ type: "redactedThinking", data: "EmwKAhgBEgy3preview" },
				{ type: "text", text: "Done." },
			],
		}],
		["Reasoning tokens, no block — nous-portal/openai/gpt-6-sol", {
			role: "assistant", provider: "nous-portal", model: "openai/gpt-6-sol", stopReason: "stop", usage: reasoningUsage(412),
			content: [{ type: "text", text: "Upstream PRs 159 and 160 are merged." }],
		}],
	];
	const snapshot = initSession({ sessionId: "preview", cwd: "/tmp", isStreaming: false, todoPhases: [], messages: raw.map(([, m]) => m) });
	const shapes: Array<[string, AssistantMsg]> = raw.map(([title], i) => [title, snapshot.messages[i] as AssistantMsg]);
	const live = applyEvent(initSession({ sessionId: "preview-live", cwd: "/tmp", isStreaming: true, todoPhases: [], messages: [] }), {
		type: "message_update",
		message: { role: "assistant", provider: "openai-codex", model: "gpt-6-sol", content: [{ type: "thinking", thinking: "" }] },
	} as never);
	shapes.push(["Streaming, no text yet", live.messages[0] as AssistantMsg]);
	return shapes;
})();

export function PreviewPage() {
	return (
		<div className="h-full w-full overflow-y-auto bg-paper">
			<div className="mx-auto max-w-[920px] space-y-10 px-6 py-10">
				<header className="space-y-2 border-b border-line pb-4">
					<div className="meta">npi-deck preview</div>
					<h1 className="font-mono text-lg text-ink">Renderer gallery</h1>
					<p className="text-sm text-ink-3">
						Static fixtures for every message + tool renderer. Use this to inspect
						design tokens, syntax highlighting, and lifecycle states without firing a
						real omp turn.
					</p>
				</header>

				<Section title="Messages">
					<UserMessage
						msg={{
							id: "u-1",
							role: "user",
							text: "Run a quick eval and tell me the pi value. Use the read tool first to grab `package.json` for context.",
							timestamp: NOW - 60000,
						}}
					/>
					<AssistantMessage
						msg={makeMsg("a-1", [
							{
								type: "thinking",
								thinking:
									"Plan:\n1. Read package.json to know the project shape\n2. Run a tiny eval cell with math.pi\n3. Stop after one turn",
							},
							{ type: "text", text: "Reading the manifest first." },
							{
								type: "toolCall",
								id: "tc-read",
								name: "read",
								arguments: { path: "~/projects/sample/package.json" },
							},
							{ type: "text", text: "Now the eval:" },
							{
								type: "toolCall",
								id: "tc-eval-js",
								name: "eval",
								arguments: (toolCalls["tc-eval-js"]?.args ?? {}) as Record<string, unknown>,
							},
							{
								type: "text",
								text: "**Pi is** `3.141592653589793`. Inline `code`, **bold**, _italic_, and a fenced block:\n\n```rust\nfn main() {\n    println!(\"hello, world\");\n    let xs: Vec<i32> = (1..=5).collect();\n    for x in xs { println!(\"{x}\"); }\n}\n```",
							},
						])}
						toolCalls={toolCalls}
					/>
				</Section>

				<Section title="Thinking — collapsed by default">
					<ThinkingBlock
						text={`Reasoning step by step\n1. Plan\n2. Execute\n3. Report\n\n**Sub-plan:** explore, then act.`}
					/>
				</Section>

				<Section title="Reasoning shapes — every provider variant">
					{reasoningShapes.map(([title, msg]) => (
						<div key={title} className="space-y-2">
							<div className="font-mono text-2xs text-ink-4">{title}</div>
							<AssistantMessage msg={msg} toolCalls={{}} />
						</div>
					))}
				</Section>

				<Section title="Notices">
					<Notice msg={{ id: "n1", role: "notice", level: "info", source: "ttsr", message: "Fallback applied: gpt-4o → claude-opus-4-7 (default)", timestamp: NOW }} />
					<Notice msg={{ id: "n2", role: "notice", level: "warning", message: "Auto-compaction starting (context > 80%)", timestamp: NOW }} />
					<Notice msg={{ id: "n3", role: "notice", level: "error", source: "provider", message: "429 rate limit — backing off 4s", timestamp: NOW }} />
				</Section>

				<Section title="Tools — each in its own assistant frame">
					{(
						[
							["tc-read", "read"],
							["tc-write", "write"],
							["tc-edit", "edit"],
							["tc-bash", "bash"],
							["tc-search", "grep"],
							["tc-lsp", "lsp"],
							["tc-task", "task"],
							["tc-web", "web_search"],
							["tc-eval-js", "eval"],
							["tc-todo", "todo"],
							["tc-gen", "generate_image"],
							["tc-browser", "browser"],
							["tc-running", "grep"],
							["tc-err", "bash"],
						] as Array<[keyof typeof toolCalls, string]>
					).map(([id, name]) => (
						<AssistantMessage
							key={id as string}
							msg={makeMsg(`a-${id as string}`, [
								{
									type: "toolCall",
									id: id as string,
									name,
									arguments: (toolCalls[id as string]?.args ?? {}) as Record<string, unknown>,
								},
							])}
							toolCalls={toolCalls}
						/>
					))}
				</Section>
			</div>
		</div>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="space-y-4">
			<div className="meta">{title}</div>
			<div className="space-y-6">{children}</div>
		</section>
	);
}
