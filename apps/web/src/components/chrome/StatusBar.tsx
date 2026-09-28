import { selectActiveSession, useStore } from "@/lib/store";
import { cn, formatTokens } from "@/lib/utils";

const STATUS_TONE: Record<string, string> = {
	idle: "text-ink-3",
	streaming: "text-accent",
	compacting: "text-warn",
	retrying: "text-warn",
};

export function StatusBar() {
	const wsStatus = useStore((s) => s.wsStatus);
	const session = useStore(selectActiveSession);

	const wsTone =
		wsStatus === "open"
			? "text-success"
			: wsStatus === "connecting"
				? "text-warn"
				: "text-danger";

	return (
		<div className="flex items-center gap-x-3 font-mono text-2xs uppercase tracking-meta">
			<span className={cn("flex items-center gap-1.5", wsTone)}>
				<Dot className={cn("h-1.5 w-1.5", wsTone)} />
				{wsStatus}
			</span>
			{session ? (
				<>
					<span className="text-ink-4">·</span>
					<span className={STATUS_TONE[session.status] ?? "text-ink-3"}>
						{session.status === "idle" ? "ready" : session.status}
					</span>
					{session.retry ? (
						<>
							<span className="text-ink-4">·</span>
							<span className="text-warn">
								retry {session.retry.attempt}/{session.retry.maxAttempts}
							</span>
						</>
					) : null}
					{session.compaction ? (
						<>
							<span className="text-ink-4">·</span>
							<span className="text-warn">compact·{session.compaction.action}</span>
						</>
					) : null}
					{session.ttsr && Date.now() - session.ttsr.at < 8000 ? (
						<>
							<span className="text-ink-4">·</span>
							<span className="text-thinking">ttsr·{session.ttsr.rules.length}</span>
						</>
					) : null}
					{session.usage.totalTokens > 0 ? (
						<>
							<span className="text-ink-4">·</span>
							<span className="text-ink-3 normal-case tracking-normal">
								{formatTokens(session.usage.totalTokens)} tok
							</span>
						</>
					) : null}
				</>
			) : null}
		</div>
	);
}

function Dot({ className }: { className?: string }) {
	return (
		<span
			className={cn("inline-block rounded-full bg-current", className)}
			aria-hidden="true"
		/>
	);
}
