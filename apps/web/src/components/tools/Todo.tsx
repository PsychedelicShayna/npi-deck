import type { ToolRendererProps } from "./ToolCallCard";
import { extractResultText } from "./shared";
import { cn } from "@/lib/utils";

/** NeoPi's `todo` tool takes one op per call. */
interface TodoArgs {
	op?: string;
	list?: Array<{ phase?: string; items?: string[] }>;
	task?: string;
	phase?: string;
	items?: string[];
	reason?: string;
}

const OP_TONE: Record<string, string> = {
	init: "text-accent",
	start: "text-accent",
	done: "text-success",
	rm: "text-ink-3",
	drop: "text-warn",
	block: "text-warn",
	unblock: "text-accent",
	append: "text-accent",
	view: "text-ink-3",
};

export function todoSummary(args: Record<string, unknown>): string {
	const a = args as TodoArgs;
	return [a.op, a.task ?? a.phase].filter(Boolean).join(" · ");
}

export function TodoTool({ args, stream }: ToolRendererProps) {
	const a = args as TodoArgs;
	const result = stream?.result;
	const resultText = result ? extractResultText(result) : "";
	const phases = a.list ?? (a.items ? [{ phase: a.phase, items: a.items }] : []);

	return (
		<div className="space-y-1">
			<div className="flex items-start gap-2 text-[13px]">
				<span className={cn("min-w-[44px] shrink-0 font-mono text-2xs uppercase tracking-meta", OP_TONE[a.op ?? ""] ?? "text-ink-3")}>
					{a.op ?? "?"}
				</span>
				<div className="min-w-0 flex-1">
					{a.task ? <span className="text-ink">{a.task}</span> : null}
					{a.reason ? <span className="text-ink-3"> — {a.reason}</span> : null}
					{phases.map((p, i) => (
						<div key={i}>
							{p.phase ? <span className="text-thinking font-mono text-xs">{p.phase}</span> : null}
							{p.items ? (
								<ul className="ml-3 mt-0.5 list-disc text-ink-2">
									{p.items.map((it, j) => (
										<li key={j}>{it}</li>
									))}
								</ul>
							) : null}
						</div>
					))}
				</div>
			</div>
			{resultText ? <div className="whitespace-pre-wrap font-mono text-2xs text-ink-3">{resultText}</div> : null}
		</div>
	);
}
