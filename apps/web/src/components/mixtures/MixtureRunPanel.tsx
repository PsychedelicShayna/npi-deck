import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { MixtureDecision, MixtureDefinition, MixtureHopTrace, MixtureTrace } from "@npi-deck/protocol";
import { Badge } from "@/components/ui/Badge";
import { mixtureHops, mixtureRunPhase, type MixtureRunPhase, type MixtureRunUi } from "@/lib/mixture-reducer";
import { mixturesApi } from "@/lib/mixtures-api";
import { useStore } from "@/lib/store";
import type { SessionUi } from "@/lib/types";
import { edgeIdentity, edgeTargets } from "./document";

const time = (at: number) => new Date(at).toLocaleTimeString();
const usd = (value: number | undefined) => (typeof value === "number" ? `$${value.toFixed(4)}` : "—");

/** The conversation-side MoA view. Display only: no model calls, no checkpoint interpretation, no separate cost ledger. */
export function MixtureRunPanel({ session }: { session: SessionUi }) {
	const connected = useStore(state => state.wsStatus === "open");
	const abort = useStore(state => state.abort);
	const [pinnedRunId, setPinnedRunId] = useState<string | null>(null);
	const state = session.mixture;
	const currentRunId = state?.currentRunId ?? null;
	const run = state?.runs.find(item => item.runId === (pinnedRunId ?? currentRunId));
	const name = run?.mixture ?? (session.model?.provider === "mixture" ? session.model.id : undefined);
	const phase = run
		? mixtureRunPhase(run, { streaming: session.status === "streaming", connected, endedByRestart: !!session.endedByRestart, current: run.runId === currentRunId })
		: undefined;
	const definition = useDiscoveredDefinition(session.readOnly ? undefined : session.cwd, name);
	return (
		<section aria-label="Mixture run" className="space-y-4 px-4 py-4 text-sm">
			<header className="space-y-1">
				<div className="flex items-center justify-between gap-2">
					<div className="meta">Mixture of agents</div>
					<Link to={`/mixtures${name ? `?name=${encodeURIComponent(name)}` : ""}`} className="text-xs text-accent underline underline-offset-2">
						Edit mixture
					</Link>
				</div>
				{name ? <div className="break-all font-mono text-xs">mixture/{name}</div> : null}
			</header>
			<ConnectionNotes session={session} connected={connected} />
			{state && state.runs.length > 1 ? (
				<label className="block space-y-1 text-xs">
					<span>Run</span>
					<select className="field w-full px-2 py-1 text-xs" value={run?.runId ?? ""} onChange={event => setPinnedRunId(event.target.value === currentRunId ? null : event.target.value)}>
						{state.runs.map(item => (
							<option key={item.runId} value={item.runId}>
								{item.mixture} · …{item.runId.slice(-6)} · {time(item.traces[0]?.at ?? 0)}
							</option>
						))}
					</select>
				</label>
			) : null}
			{session.status === "streaming" && session.model?.provider === "mixture" && (!phase || phase.kind === "completed" || phase.kind === "interrupted" || phase.kind === "unrecorded") ? (
				<p role="status" className="rounded border border-accent/40 bg-accent-soft p-2 text-xs">
					A new mixture turn is running. NeoPi reports its first hop when that hop ends.
				</p>
			) : null}
			{run && phase ? (
				<>
					<PhaseLine phase={phase} />
					<Totals run={run} />
					<GraphProgress run={run} phase={phase} definition={definition} />
					<HopList run={run} />
					<Transitions run={run} />
				</>
			) : session.status === "streaming" ? null : (
				<p className="text-ink-3">
					No mixture run in this conversation yet.{name ? ` Send a message to run mixture/${name}.` : " Pick a mixture model to run one."}
				</p>
			)}
			{run && run.runId === currentRunId && session.status === "streaming" && connected && !session.readOnly && !session.endedByRestart ? (
				<button type="button" className="btn-ghost border border-danger/50 px-3 py-1 text-danger" onClick={abort}>
					Abort run
				</button>
			) : null}
			<p className="border-t border-line pt-3 text-2xs leading-relaxed text-ink-3">
				NeoPi reports each hop when it ends, plus limits, checkpoints and the run's end; it sends no run-start or hop-start event, streams no member tokens, and offers no graph snapshot. The member shown as working is the run's own next-member field after the last event. NeoPi records a run's end only when its answer is committed, so a run that stopped otherwise shows no outcome from history.
			</p>
		</section>
	);
}

/** The definition this workspace registers under `name`, for drawing progress. */
function useDiscoveredDefinition(cwd: string | undefined, name: string | undefined): MixtureDefinition | null | undefined {
	const [definition, setDefinition] = useState<MixtureDefinition | null | undefined>(undefined);
	useEffect(() => {
		if (!cwd || !name) return setDefinition(undefined);
		const controller = new AbortController();
		mixturesApi
			.discovered(cwd, controller.signal)
			.then(result => {
				if (!controller.signal.aborted) setDefinition(result.mixtures.find(item => item.name === name)?.definition ?? null);
			})
			.catch(() => {
				if (!controller.signal.aborted) setDefinition(null);
			});
		return () => controller.abort();
	}, [cwd, name]);
	return definition;
}

function ConnectionNotes({ session, connected }: { session: SessionUi; connected: boolean }) {
	const state = session.mixture;
	return (
		<>
			{session.endedByRestart ? (
				<p role="status" className="rounded border border-danger/40 bg-danger/10 p-2 text-xs">
					The deck worker restarted: this chat's live session ended and any running mixture run with it.
				</p>
			) : !connected && !session.readOnly ? (
				<p role="status" className="rounded border border-warn/40 bg-warn/10 p-2 text-xs">
					Disconnected. Showing the last observed state; it updates when the connection returns.
				</p>
			) : null}
			{state?.reconnectedAt ? (
				<p role="status" className="rounded border border-line p-2 text-xs">
					Reconnected at {time(state.reconnectedAt)}: the panel reloaded this branch's hop, limit and checkpoint cards and each ended run's outcome from the session file, and kept what this page saw live.
				</p>
			) : null}
			{state?.resets.map(reset => (
				<p key={reset.at} role="status" className="rounded border border-warn/40 bg-warn/10 p-2 text-xs">
					Conversation reset at {time(reset.at)} (a new or cleared conversation, or a move to another branch): {reset.runIds.length} run{reset.runIds.length === 1 ? "" : "s"} no longer on this branch dropped. NeoPi never resumes a run across a reset.
				</p>
			))}
			{state?.dropped ? <p className="text-xs text-warn">{state.dropped} mixture event(s) could not be read and are not shown.</p> : null}
		</>
	);
}

function PhaseLine({ phase }: { phase: MixtureRunPhase }) {
	const [tone, label, detail] = (() => {
		switch (phase.kind) {
			case "running":
				return ["accent", "running", phase.activeMemberId ? `${phase.activeMemberId} is working (${phase.phase})` : phase.phase] as const;
			case "completed":
				return ["success", "completed", `ended: ${phase.endReason}`] as const;
			case "interrupted":
				return ["danger", "interrupted", phase.reason] as const;
			case "paused":
				return ["warn", "paused", phase.reason] as const;
			case "disconnected":
				return ["warn", "disconnected", phase.activeMemberId ? `last seen: ${phase.activeMemberId} working` : "last seen running"] as const;
			case "unrecorded":
				return ["muted", "not live", "history: no recorded outcome for this run"] as const;
		}
	})();
	return (
		<div aria-live="polite" className="flex flex-wrap items-center gap-2">
			<Badge tone={tone}>{label}</Badge>
			<span className="text-xs text-ink-2">{detail}</span>
		</div>
	);
}

function Totals({ run }: { run: MixtureRunUi }) {
	const header = run.latest.run;
	return (
		<dl className="grid grid-cols-2 gap-x-2 gap-y-1 font-mono text-2xs">
			<dt className="text-ink-3">hops</dt>
			<dd className="text-right">{header.hops}</dd>
			<dt className="text-ink-3">settled cost</dt>
			<dd className="text-right">{usd(header.usd)}</dd>
		</dl>
	);
}

type NodeState = "done" | "active" | "failed" | "pending";

/** Members in the order execution reaches them from the entry; unreachable members last. */
function orderedMembers(definition: MixtureDefinition): string[] {
	const order: string[] = [];
	const queue = [definition.entry];
	while (queue.length) {
		const id = queue.shift()!;
		if (order.includes(id) || !definition.members.some(member => member.id === id)) continue;
		order.push(id);
		for (const edge of definition.edges) if (edge.from === id) queue.push(...edgeTargets(edge));
	}
	for (const member of definition.members) if (!order.includes(member.id)) order.push(member.id);
	return order;
}

function GraphProgress({ run, phase, definition }: { run: MixtureRunUi; phase: MixtureRunPhase; definition: MixtureDefinition | null | undefined }) {
	const hops = mixtureHops(run);
	const traversed = useMemo(() => new Set(hops.flatMap(hop => [hop.edgeInId, hop.edgeOutId]).filter((id): id is string => !!id)), [hops]);
	if (definition === undefined) return null;
	if (definition === null)
		return <p className="text-xs text-ink-3">mixture/{run.mixture} is not in this workspace's discovered mixtures now (renamed, removed or refused), so its graph cannot be drawn.</p>;
	const active = phase.kind === "running" || phase.kind === "disconnected" ? phase.activeMemberId : undefined;
	const stateOf = (id: string): NodeState => {
		const visits = hops.filter(hop => hop.memberId === id);
		if (visits.some(hop => hop.status === "failed" || hop.status === "aborted")) return "failed";
		if (id === active) return "active";
		return visits.length ? "done" : "pending";
	};
	const styles: Record<NodeState, string> = {
		done: "border-success/60 bg-success/10",
		active: "border-accent bg-accent-soft animate-pulse",
		failed: "border-danger/60 bg-danger/10",
		pending: "border-line bg-paper-2 text-ink-3",
	};
	return (
		<section aria-label="Graph progress" className="space-y-1">
			<h3 className="meta">Graph</h3>
			<ol className="space-y-1">
				{orderedMembers(definition).map(id => {
					const member = definition.members.find(item => item.id === id)!;
					const nodeState = stateOf(id);
					const visits = hops.filter(hop => hop.memberId === id).map(hop => hop.hop);
					const out = definition.edges.filter(edge => edge.from === id);
					return (
						<li key={id}>
							<div className={`rounded border px-2 py-1 text-xs ${styles[nodeState]}`}>
								<div className="flex items-center justify-between gap-2">
									<span className="font-medium">
										{definition.entry === id ? "▶ " : ""}
										{id}
									</span>
									<span className="font-mono text-2xs">{nodeState === "active" ? "working" : nodeState === "done" ? `hop ${visits.join(", ")}` : nodeState}</span>
								</div>
								<div className="truncate font-mono text-2xs text-ink-3">{member.kind === "verdict" ? "verdict" : member.model}</div>
							</div>
							{out.map(edge => (
								<div key={edgeIdentity(edge)} className={`pl-3 font-mono text-2xs ${traversed.has(edgeIdentity(edge)) ? "text-success" : "text-ink-3"}`}>
									↓ {edgeIdentity(edge)}
								</div>
							))}
						</li>
					);
				})}
			</ol>
			<p className="text-2xs text-ink-3">Drawn from the definition this workspace registers now; an edit since the run started is not reflected in what ran.</p>
		</section>
	);
}

function HopList({ run }: { run: MixtureRunUi }) {
	const hops = mixtureHops(run);
	if (!hops.length) return null;
	return (
		<section aria-label="Member activity" className="space-y-2">
			<h3 className="meta">Members</h3>
			<ol className="space-y-2">
				{hops.map(hop => (
					<HopRow
						key={`${hop.hop}:${hop.branchOf ?? ""}:${hop.memberId}`}
						hop={hop}
						decisions={run.traces.filter((trace): trace is Extract<MixtureTrace, { kind: "decision" }> => trace.kind === "decision" && trace.hop === hop.hop && trace.memberId === hop.memberId)}
					/>
				))}
			</ol>
		</section>
	);
}

function HopRow({ hop, decisions }: { hop: MixtureHopTrace; decisions: Array<Extract<MixtureTrace, { kind: "decision" }>> }) {
	const tone = hop.status === "done" ? "success" : hop.status === "failed" || hop.status === "aborted" ? "danger" : "accent";
	return (
		<li className="rounded border border-line bg-paper-2/50">
			<details>
				<summary className="cursor-pointer space-y-1 p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
					<span className="inline-flex items-center gap-2">
						<span className="font-medium">
							Hop {hop.hop}: {hop.memberId}
						</span>
						<Badge tone={tone}>{hop.status}</Badge>
					</span>
					<span className="block font-mono text-2xs text-ink-3">
						{hop.model} · {typeof hop.elapsedMs === "number" ? `${(hop.elapsedMs / 1000).toFixed(1)}s` : "—"} · {usd(hop.usage?.cost?.total)}
					</span>
				</summary>
				<div className="space-y-2 border-t border-line p-2 text-xs">
					{hop.edgeInId ? <p>In: <code>{hop.edgeInId}</code></p> : <p>Entry hop</p>}
					{hop.edgeOutId ? <p>Out: <code>{hop.edgeOutId}</code></p> : null}
					{hop.usage ? <p>Tokens: {hop.usage.input} in · {hop.usage.output} out</p> : null}
					{hop.visible ? (
						<>
							{hop.output !== undefined ? <TraceText label="Output" text={hop.output} /> : null}
							{hop.reasoning !== undefined ? <TraceText label="Reasoning" text={hop.reasoning} /> : null}
						</>
					) : (
						<p className="text-ink-3">Output hidden by the member's show policy.</p>
					)}
					{decisions.map(trace => (
						<DecisionRow key={trace.seq} decision={trace.decision} />
					))}
				</div>
			</details>
		</li>
	);
}

function TraceText({ label, text }: { label: string; text: string }) {
	return (
		<section className="space-y-1">
			<h4 className="font-medium">{label}</h4>
			<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed">{text}</pre>
		</section>
	);
}

function DecisionRow({ decision }: { decision: MixtureDecision }) {
	const answer = decision.answer;
	const result = answer.type === "choice" ? answer.choice : answer.type === "noul" ? String(answer.noul) : String(answer.score);
	return (
		<section className="space-y-1 border-t border-line pt-2">
			<h4 className="font-medium">
				{decision.kind}: {result}
			</h4>
			<p className="break-all">Judge: {decision.judge}</p>
		</section>
	);
}

function Transitions({ run }: { run: MixtureRunUi }) {
	const notices = run.traces.filter(trace => trace.kind === "limit" || trace.kind === "checkpoint" || trace.kind === "steering" || trace.kind === "run_end");
	if (!notices.length) return null;
	return (
		<section aria-label="Run transitions" className="space-y-1">
			<h3 className="meta">Transitions</h3>
			{notices.map(trace => (
				<div key={trace.seq} className="border-l-2 border-line-strong pl-2 text-xs">
					{time(trace.at)} · {transitionText(trace)}
				</div>
			))}
		</section>
	);
}

function transitionText(trace: MixtureTrace): string {
	switch (trace.kind) {
		case "limit":
			return `${trace.limit} limit reached (${trace.value}); ${trace.action}`;
		case "checkpoint":
			return `checkpoint: ${trace.reason}${trace.note ? ` — ${trace.note}` : ""}`;
		case "steering":
			return `steering to ${trace.targetMemberId}`;
		case "run_end":
			return `run ended: ${trace.endReason}`;
		default:
			return trace.kind;
	}
}
