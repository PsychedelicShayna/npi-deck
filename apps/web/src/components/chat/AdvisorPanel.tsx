import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { advisorsApi, type LiveAdvisorStatus } from "@/lib/advisors-api";

export function AdvisorPanel({ sessionId }: { sessionId: string }) {
	const [status, setStatus] = useState<LiveAdvisorStatus | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let active = true;
		async function refresh() {
			try { const value = await advisorsApi.status(sessionId); if (active) { setStatus(value); setError(""); } }
			catch (err) { if (active) setError(String(err)); }
		}
		void refresh();
		const timer = setInterval(() => void refresh(), 2500);
		return () => { active = false; clearInterval(timer); };
	}, [sessionId]);
	async function toggle() {
		if (!status) return;
		setBusy(true);
		try { setStatus(await advisorsApi.toggle(sessionId, !status.overview.configured)); setError(""); }
		catch (err) { setError(String(err)); }
		finally { setBusy(false); }
	}
	return <section className="border-b border-line bg-paper-2 px-5 py-2 text-xs" aria-label="Advisor status">
		<div className="mx-auto max-w-[760px]">
			<div className="flex flex-wrap items-center gap-3"><span className="font-semibold">Advisors</span>
				<span>{status?.overview.configured ? "Enabled for this session" : "Off for this session"}</span>
				<button type="button" className="btn-ghost px-2 py-0.5" disabled={busy || !status} onClick={() => void toggle()}>{status?.overview.configured ? "Turn off" : "Turn on"}</button>
				<Link to="/advisors" className="ml-auto text-accent hover:underline">Edit configuration</Link>
			</div>
			{error && <p role="alert" className="text-red-600">{error}</p>}
			{status && <><div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">{status.overview.advisors.map((a, i) => {
				const stat = status.stats.advisors.find(s => s.name === a.name);
				return <span key={i} title={stat?.model ? `${stat.model.provider}/${stat.model.id}` : undefined}>{a.name}: {a.status}{a.yielded ? " · yielded" : ""} · ${stat?.cost.toFixed(4) ?? "0.0000"} · {stat?.tokens.total ?? 0} tokens</span>;
			})}<span>Total ${status.stats.cost.toFixed(4)}</span></div>
				{status.notes.length > 0 && <div className="max-h-32 space-y-1 overflow-y-auto pt-2" aria-label="Advisor notes">{status.notes.map((n, i) => <div key={i}><strong className={n.severity === "blocker" ? "text-red-600" : n.severity === "concern" ? "text-amber-600" : "text-ink-3"}>{n.severity}</strong> · {n.advisor}: {n.note}</div>)}</div>}
				{status.events.length > 0 && <div className="text-ink-3" aria-label="Advisor events">{status.events.slice(-3).map((e, i) => <span key={i} className="mr-2">{e.type === "advisor_yielded" ? "Yielded" : "Cost updated"} · {new Date(e.timestamp).toLocaleTimeString()}</span>)}</div>}
			</>}
		</div>
	</section>;
}
