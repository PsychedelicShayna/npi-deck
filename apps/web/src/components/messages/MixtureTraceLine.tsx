import type { MixtureTraceMsg } from "@/lib/types";

export function MixtureTraceLine({ msg }: { msg: MixtureTraceMsg }) {
	const details = msg.details;
	const kind = typeof details.kind === "string" ? details.kind : "trace";
	const mixture = typeof details.mixture === "string" ? details.mixture : "Mixture";
	const member = typeof details.memberId === "string" ? details.memberId : undefined;
	const output = typeof details.output === "string" && details.visible !== false ? details.output : undefined;
	const run = details.run && typeof details.run === "object" ? details.run as Record<string, unknown> : undefined;
	const status = typeof run?.status === "string" ? run.status : undefined;
	return (
		<details className="rounded border border-line bg-paper-2/60 px-3 py-2 text-xs text-ink-2">
			<summary className="cursor-pointer font-mono text-2xs text-ink-3">
				MoA · {mixture} · {kind.replaceAll("_", " ")}{member ? ` · ${member}` : ""}{status ? ` · ${status}` : ""}
			</summary>
			{output ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">{output}</pre> : null}
			{kind === "checkpoint" && typeof details.reason === "string" ? <p className="mt-2">{details.reason}</p> : null}
			{kind === "limit" && typeof details.limit === "string" ? <p className="mt-2">{details.limit} limit · {String(details.action ?? "stop")}</p> : null}
			{kind === "run_end" && typeof details.endReason === "string" ? <p className="mt-2">{details.endReason}</p> : null}
		</details>
	);
}
