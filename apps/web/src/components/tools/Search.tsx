import type { ToolRendererProps } from "./ToolCallCard";
import { ArgRow, Pre, extractResultText } from "./shared";

export function SearchTool({ args, stream }: ToolRendererProps) {
	const pattern = (args.pattern as string | undefined) ?? "";
	const paths = Array.isArray(args.paths)
		? (args.paths as string[])
		: typeof args.path === "string"
			? [args.path]
			: [];
	const result = stream?.result ?? stream?.partialResult;
	const text = result ? extractResultText(result) : "";

	const matchCount = (() => {
		if (!result || typeof result !== "object") return undefined;
		const r = result as Record<string, unknown>;
		const summary = (r.summary as Record<string, unknown> | undefined) ?? undefined;
		if (summary && typeof summary.totalMatches === "number") return summary.totalMatches;
		if (typeof r.totalMatches === "number") return r.totalMatches;
		return undefined;
	})();

	return (
		<div className="space-y-1.5">
			{pattern ? (
				<ArgRow k="pattern" v={<code className="font-mono text-xs text-ink">{pattern}</code>} />
			) : null}
			{paths.length > 0 ? <ArgRow k="paths" v={paths.join(", ")} /> : null}
			{matchCount !== undefined ? <ArgRow k="matches" v={String(matchCount)} /> : null}
			{text ? <Pre>{text}</Pre> : null}
		</div>
	);
}
