import type { ToolRendererProps } from "./ToolCallCard";
import { ArgRow, Pre, ResultImages, extractResultText, summarizeArg } from "./shared";
import { MaybeJsonBlock } from "@/lib/code";

/**
 * Card for tools whose arguments are a few named scalars plus one optional
 * long-text argument (a query, code, a lesson). `fields` are shown as rows in
 * order, skipping absent ones; `body` is shown as a block. The result (or the
 * live partial/stream update while running) follows. NeoPi's refusals, e.g.
 * "background jobs unavailable", arrive as the error result and are shown
 * verbatim.
 */
export function FieldsTool({
	args,
	stream,
	fields,
	body,
}: ToolRendererProps & { fields: readonly string[]; body?: string }) {
	const result = stream?.result;
	const live = result ?? stream?.partialResult;
	const text = live !== undefined ? extractResultText(live) : "";
	const bodyText = body ? args[body] : undefined;
	const update = result === undefined && stream?.streamUpdate !== undefined ? stream.streamUpdate : undefined;

	return (
		<div className="space-y-1.5">
			{fields.map((k) =>
				args[k] === undefined || args[k] === null || args[k] === "" ? null : (
					<ArgRow key={k} k={k} v={summarizeArg(args[k], 120)} />
				),
			)}
			{typeof bodyText === "string" && bodyText ? <Pre>{bodyText}</Pre> : null}
			{update !== undefined ? <MaybeJsonBlock text={summarizeArg(update, 4000)} className="max-h-48" /> : null}
			<ResultImages result={live} />
			{text ? <Pre className={stream?.isError ? "text-danger" : undefined}>{text}</Pre> : null}
		</div>
	);
}
