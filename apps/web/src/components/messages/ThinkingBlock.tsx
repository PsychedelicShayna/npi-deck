import { useState } from "react";
import { ChevronRight, EyeOff } from "lucide-react";
import { Markdown } from "@/lib/markdown";
import { withheldReasoningNote, type ReasoningView } from "@/lib/reasoning";
import { cn, formatTokens } from "@/lib/utils";

/** One reasoning block: readable text expands; hidden reasoning says why instead. */
export function ReasoningBlock({ view, streaming }: { view: ReasoningView; streaming?: boolean }) {
	if (view.kind === "text") return <ThinkingBlock text={view.text} streaming={streaming} />;
	const redacted = view.kind === "withheld" && view.reason === "redacted";
	return (
		<div className="border-l-2 border-line-strong pl-2 py-0.5">
			<div className="flex items-center gap-1.5 font-mono text-2xs uppercase tracking-meta text-thinking">
				<EyeOff className="h-3 w-3 shrink-0" aria-hidden />
				<span>{view.kind === "pending" ? "thinking" : redacted ? "redacted thinking" : "reasoning hidden"}</span>
				{view.kind === "withheld" && view.tokens !== undefined ? (
					<span className="text-ink-3 normal-case tracking-normal">
						· {formatTokens(view.tokens)} reasoning tok this turn
					</span>
				) : null}
				{view.kind === "pending" ? <span className="text-accent">· live</span> : null}
			</div>
			<div className="pt-0.5 text-xs text-ink-3">
				{view.kind === "pending" ? "Waiting for reasoning text…" : withheldReasoningNote(view.reason)}
			</div>
		</div>
	);
}

export function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
	const [open, setOpen] = useState(Boolean(streaming));
	const lines = text.split(/\r?\n/).length;
	return (
		<div className="border-l-2 border-line-strong">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-1.5 pl-2 py-0.5 text-left font-mono text-2xs uppercase tracking-meta text-thinking hover:text-thinking/80"
			>
				<ChevronRight
					className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")}
				/>
				<span>thinking</span>
				<span className="text-ink-3 normal-case tracking-normal">
					· {lines} line{lines === 1 ? "" : "s"}
				</span>
				{streaming ? <span className="text-accent">· live</span> : null}
			</button>
			{open ? (
				<div className="pl-2 pt-1 pb-2">
					<Markdown className="text-[13px] text-ink-2" streaming={streaming}>
						{text}
					</Markdown>
				</div>
			) : null}
		</div>
	);
}
