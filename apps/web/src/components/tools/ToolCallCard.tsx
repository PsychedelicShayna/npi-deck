import { useStore } from "@/lib/store";
import { ChevronRight, Loader2 } from "lucide-react";
import type { ToolCallStream } from "@/lib/types";
import { cn, formatDurationMs, truncate } from "@/lib/utils";

import { ReadTool } from "./Read";
import { WriteTool } from "./Write";
import { EditTool } from "./Edit";
import { BashTool } from "./Bash";
import { SearchTool } from "./Search";
import { LspTool } from "./Lsp";
import { TaskTool } from "./Task";
import { WebSearchTool } from "./WebSearch";
import { EvalTool } from "./Eval";
import { TodoTool, todoSummary } from "./Todo";
import { FieldsTool } from "./Fields";
import { GenerateImageTool } from "./GenerateImage";
import { BrowserTool } from "./Browser";
import { GenericTool } from "./Generic";

export interface ToolRendererProps {
	toolCallId: string;
	name: string;
	args: Record<string, unknown>;
	intent?: string;
	stream?: ToolCallStream;
}

const DOT_TONE = {
	running: "bg-line-strong",
	complete: "bg-success",
	error: "bg-danger",
} as const;

export function ToolCallCard(props: ToolRendererProps) {
	const { toolCallId, name, intent, stream, args } = props;
	const open = useStore(
		(s) => s.toolView.perCard[toolCallId] ?? !s.toolView.allCollapsed,
	);
	const setToolCardOpen = useStore((s) => s.setToolCardOpen);
	const status = stream?.status ?? "running";
	const isError = stream?.isError ?? false;
	const dot = isError ? DOT_TONE.error : DOT_TONE[status];
	const duration =
		stream?.endedAt && stream.startedAt ? stream.endedAt - stream.startedAt : undefined;

	const summary = summarizeArgs(name, args, intent);

	return (
		<div className="-mx-1">
			<button
				type="button"
				onClick={() => setToolCardOpen(toolCallId, !open)}
				className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left font-mono text-xs hover:bg-paper-3/60"
			>
				<ChevronRight
					className={cn("h-3 w-3 shrink-0 text-ink-3 transition-transform", open && "rotate-90")}
				/>
				<span
					className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)}
					aria-hidden="true"
				/>
				<span className="font-medium text-ink">{name}</span>
				{summary ? (
					<span className="truncate text-ink-3">{summary}</span>
				) : null}
				<span className="ml-auto flex items-center gap-2 text-ink-3">
					{status === "running" ? (
						<Loader2 className="h-3 w-3 animate-spin text-accent" />
					) : (
						<span className={isError ? "text-danger" : "text-ink-4"}>
							{isError ? "error" : "done"}
						</span>
					)}
					{duration !== undefined ? (
						<span className="text-ink-4">{formatDurationMs(duration)}</span>
					) : null}
				</span>
			</button>
			{open ? (
				<div className="ml-3 mt-1 border-l border-line pl-3">
					{renderTool(name, props)}
				</div>
			) : null}
		</div>
	);
}

/** Collapsed-header summary and expanded body for one tool. */
interface ToolCard {
	summary?: (args: Record<string, unknown>) => string;
	render?: (props: ToolRendererProps) => JSX.Element;
}

const str = (v: unknown, n = 60): string => (v === undefined || v === null ? "" : truncate(typeof v === "string" ? v : JSON.stringify(v), n));
const join = (...parts: unknown[]): string => parts.map((p) => str(p)).filter(Boolean).join(" · ");
const fields = (keys: readonly string[], body?: string) => (props: ToolRendererProps) => (
	<FieldsTool {...props} fields={keys} body={body} />
);

/** First `[path#TAG]` or `*** … File: path` header in a hashline / apply-patch edit input. */
function editPath(args: Record<string, unknown>): string {
	if (typeof args.path === "string") return args.path;
	const input = typeof args.input === "string" ? args.input : "";
	const m = /^\[([^\]#]+)(?:#[0-9A-Fa-f]+)?\]/m.exec(input) ?? /^\*\*\* \w+ File: (.+)$/m.exec(input);
	return m?.[1] ?? "";
}

/**
 * NeoPi's tool set (pinned tree, `tools/index.ts` BUILTIN_TOOLS + HIDDEN_TOOLS,
 * plus `computer` from the eval prelude). Anything not listed, including MCP
 * and extension tools, falls through to the generic card.
 */
const TOOL_CARDS: Record<string, ToolCard> = {
	read: { summary: (a) => str(a.path), render: (p) => <ReadTool {...p} /> },
	write: { summary: (a) => str(a.path), render: (p) => <WriteTool {...p} /> },
	edit: { summary: (a) => str(editPath(a)), render: (p) => <EditTool {...p} args={{ ...p.args, path: editPath(p.args) }} /> },
	ast_edit: { summary: (a) => str(a.paths), render: fields(["paths", "ops"]) },
	ast_grep: { summary: (a) => join(a.pat, a.paths), render: fields(["pat", "paths", "lang"]) },
	bash: { summary: (a) => str(a.command), render: (p) => <BashTool {...p} /> },
	grep: { summary: (a) => join(a.pattern, a.path), render: (p) => <SearchTool {...p} /> },
	glob: { summary: (a) => str(a.path), render: fields(["path", "hidden", "gitignore", "limit"]) },
	find: { summary: (a) => str(a.pattern ?? a.path), render: (p) => <SearchTool {...p} /> },
	lsp: { summary: (a) => join(a.action, a.symbol ?? a.query), render: (p) => <LspTool {...p} /> },
	debug: { summary: (a) => join(a.action, a.program ?? a.file ?? a.expression), render: fields(["action", "program", "adapter", "file", "line", "expression"]) },
	ida: { summary: (a) => join(a.action, a.target ?? a.db), render: fields(["action", "db", "target", "name", "decl", "text"], "code") },
	eval: { render: (p) => <EvalTool {...p} /> },
	computer: { summary: (a) => str(a.action), render: fields(["action", "read_only", "timeout"], "code") },
	task: { summary: (a) => str(a.agent), render: (p) => <TaskTool {...p} /> },
	wait: { summary: () => "", render: fields([]) },
	todo: { summary: todoSummary, render: (p) => <TodoTool {...p} /> },
	ask: { summary: (a) => str(Array.isArray(a.questions) ? (a.questions[0] as { question?: unknown })?.question : a.question), render: fields(["questions", "question"]) },
	web_search: { summary: (a) => str(a.query), render: (p) => <WebSearchTool {...p} /> },
	github: { summary: (a) => join(a.op, a.repo ?? a.pr ?? a.query ?? a.run), render: fields(["op", "repo", "pr", "branch", "path", "query", "title", "run"], "body") },
	security_scan: { summary: (a) => join(a.action, a.target_kind), render: fields(["action", "target_kind", "include_paths", "plan_id", "operation_id"]) },
	checkpoint: { summary: (a) => str(a.goal), render: fields(["goal"]) },
	rewind: { summary: (a) => str(a.report), render: fields([], "report") },
	context_notes: { summary: (a) => (typeof a.text === "string" ? "write" : "read"), render: fields([], "text") },
	new_context: { summary: () => "", render: fields([]) },
	recall: { summary: (a) => str(a.query), render: fields(["query"]) },
	reflect: { summary: (a) => str(a.query), render: fields(["query", "context"]) },
	retain: { summary: (a) => (Array.isArray(a.items) ? `${a.items.length} item(s)` : ""), render: fields(["items"]) },
	memory_edit: { summary: (a) => join(a.op, a.id), render: fields(["op", "id"], "content") },
	learn: { summary: (a) => str(a.memory), render: fields(["context", "skill"], "memory") },
	manage_skill: { summary: (a) => join(a.action, a.name), render: fields(["action", "name", "description"], "body") },
	think: { summary: () => "", render: fields([], "thoughts") },
	goal: { summary: (a) => join(a.op, a.objective), render: fields(["op", "objective", "token_budget"]) },
	yield: { summary: (a) => str(a.type ?? (a.error ? "error" : "")), render: fields(["type", "error"]) },
	generate_image: { summary: (a) => str(a.subject), render: (p) => <GenerateImageTool {...p} /> },
	browser: { render: (p) => <BrowserTool {...p} /> },
};

/** Name-prefix families (e.g. extension-provided `gh_*` GitHub tools). */
const TOOL_CARD_PREFIXES: Array<[string, ToolCard]> = [
	["gh_", { summary: (a) => join(a.repo, a.pr ?? a.issue ?? a.query), render: fields(["repo", "pr", "issue", "query", "branch", "path"], "body") }],
];

export function toolCardFor(name: string): ToolCard | undefined {
	return TOOL_CARDS[name] ?? TOOL_CARD_PREFIXES.find(([prefix]) => name.startsWith(prefix))?.[1];
}

function summarizeArgs(name: string, args: Record<string, unknown>, intent?: string): string {
	if (intent) return intent;
	return toolCardFor(name)?.summary?.(args) ?? "";
}

function renderTool(name: string, props: ToolRendererProps) {
	const render = toolCardFor(name)?.render;
	return render ? render(props) : <GenericTool {...props} />;
}
