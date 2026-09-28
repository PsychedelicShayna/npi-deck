import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { advisorsApi, type AdvisorNote, type AdvisorRuntimeStatus, type LiveAdvisorStatus, type SessionAdvisorRoster } from "@/lib/advisors-api";
import { readPanelMemory, useAdvisorPicker, writePanelMemory, type AdvisorPanelMemory } from "@/lib/advisor-ui";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const POLL_MS = 2500;
const SEVERITIES = [
	{ key: "blocker", label: "Blockers", tone: "text-danger" },
	{ key: "concern", label: "Concerns", tone: "text-warn" },
	{ key: "nit", label: "Nits", tone: "text-ink-3" },
] as const;

function statusLabel(status: AdvisorRuntimeStatus, yielded: boolean): { text: string; tone: string } {
	switch (status) {
		case "running": return yielded ? { text: "Caught up, waiting for the next turn", tone: "bg-success" } : { text: "Watching", tone: "bg-accent" };
		case "paused": return { text: "Not running", tone: "bg-ink-4" };
		case "no_model": return { text: "No model — set one in the roster or the advisor role", tone: "bg-warn" };
		case "quota_exhausted": return { text: "Quota exhausted", tone: "bg-danger" };
		case "error": return { text: "Error", tone: "bg-danger" };
	}
}

const money = (cost: number) => `$${cost.toFixed(cost > 0 && cost < 0.01 ? 4 : 2)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Advisors for one live chat. Renders nothing unless advisors are switched on
 * for the session, it has undismissed advisor notes, or the picker is open.
 * Live status is polled only while the panel is on screen; otherwise it is
 * fetched once on open and again when an advisor event reaches the chat.
 */
export function AdvisorPanel({ sessionId }: { sessionId: string }) {
	const activity = useStore(s => s.sessionsById[sessionId]?.advisorActivity ?? 0);
	const pickerOpen = useAdvisorPicker(s => s.openFor === sessionId);
	const openPicker = useAdvisorPicker(s => s.open);
	const closePicker = useAdvisorPicker(s => s.close);
	const [status, setStatus] = useState<LiveAdvisorStatus | null>(null);
	const [memory, setMemory] = useState<AdvisorPanelMemory>(() => readPanelMemory(sessionId));
	const [error, setError] = useState("");
	const current = useRef(sessionId);

	useEffect(() => {
		current.current = sessionId;
		setStatus(null);
		setError("");
		setMemory(readPanelMemory(sessionId));
	}, [sessionId]);

	const remember = useCallback((next: AdvisorPanelMemory) => {
		setMemory(next);
		writePanelMemory(sessionId, next);
	}, [sessionId]);

	const refresh = useCallback(async () => {
		try {
			const value = await advisorsApi.status(sessionId);
			if (current.current === sessionId) { setStatus(value); setError(""); }
		} catch (err) {
			if (current.current === sessionId) setError(err instanceof Error ? err.message : String(err));
		}
	}, [sessionId]);

	const notes = status?.notes ?? [];
	const latestNote = notes.reduce((latest, note) => Math.max(latest, note.timestamp), 0);
	const running = status?.overview.configured ?? false;
	const dismissed = memory.dismissedThrough !== null && latestNote <= memory.dismissedThrough;
	const visible = !!status && !dismissed && (running || latestNote > 0);
	const expanded = visible && !memory.collapsed;

	useEffect(() => { void refresh(); }, [refresh, activity]);
	useEffect(() => {
		if (!visible) return;
		const timer = setInterval(() => void refresh(), POLL_MS);
		return () => clearInterval(timer);
	}, [visible, refresh]);
	useEffect(() => {
		if (expanded && latestNote > memory.seenThrough) remember({ ...memory, seenThrough: latestNote });
	}, [expanded, latestNote, memory, remember]);

	const applied = (next: LiveAdvisorStatus) => {
		setStatus(next);
		setError("");
		// A deliberate choice brings a dismissed panel back.
		remember({ ...memory, dismissedThrough: null, collapsed: false });
		closePicker();
	};

	if (pickerOpen) return <AdvisorPicker sessionId={sessionId} status={status} onApplied={applied} onCancel={closePicker} />;
	if (!visible || !status) return null;

	const liveNames = new Set(status.overview.advisors.filter(a => a.status !== "paused").map(a => a.name));
	const shown = status.overview.advisors.filter(a => liveNames.has(a.name) || status.selection?.includes(a.name));
	const idle = status.overview.advisors.filter(a => !shown.includes(a));
	const counts = SEVERITIES.map(s => ({ ...s, count: notes.filter(n => n.severity === s.key).length })).filter(s => s.count > 0);
	const unseen = notes.filter(n => n.timestamp > memory.seenThrough).length;
	const summary = running
		? shown.length ? shown.map(a => a.name).join(", ") : "On, nothing selected"
		: "Stopped";

	return <section className="border-t border-line bg-paper-2 px-5 py-2 text-sm" aria-label="Advisors">
		<div className="mx-auto max-w-[760px]">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="meta">Advisors</span>
				<span className="min-w-0 truncate text-ink-2">{summary}</span>
				<span className="font-mono text-2xs text-ink-3" title="Advisor spend in this session">{money(status.stats.cost)}</span>
				{!expanded && counts.map(c => <span key={c.key} className={cn("font-mono text-2xs", c.tone)}>{c.count} {c.count === 1 ? c.label.slice(0, -1).toLowerCase() : c.label.toLowerCase()}</span>)}
				{!expanded && unseen > 0 && <span className="chip bg-accent-soft text-ink">{unseen} new</span>}
				<span className="ml-auto flex items-center gap-1">
					<button type="button" className="btn-ghost px-2 py-0.5 text-xs" onClick={() => openPicker(sessionId)}>Choose advisors</button>
					<button type="button" className="btn-ghost h-6 w-6 p-0" aria-label={expanded ? "Collapse advisors" : "Expand advisors"} title={expanded ? "Collapse" : "Expand"}
						onClick={() => remember({ ...memory, collapsed: expanded })}>{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}</button>
					<button type="button" className="btn-ghost h-6 w-6 p-0" aria-label="Dismiss advisors panel" title="Hide until new advisor notes arrive"
						onClick={() => remember({ ...memory, dismissedThrough: latestNote })}><X className="h-4 w-4" /></button>
				</span>
			</div>
			{error && <p role="alert" className="pt-1 text-xs text-danger">{error}</p>}
			{expanded && <div className="max-h-[40vh] space-y-3 overflow-y-auto pb-1 pt-2">
				{shown.length > 0 && <ul className="space-y-1" aria-label="Advisor status">
					{shown.map(a => {
						const stat = status.stats.advisors.find(s => s.name === a.name);
						const label = statusLabel(a.status, a.yielded);
						return <li key={a.name} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
							<span className={cn("h-2 w-2 shrink-0 rounded-full", label.tone)} aria-hidden />
							<span className="font-medium text-ink">{a.name}</span>
							<span className="text-ink-2">{running ? label.text : "Stopped"}</span>
							{stat?.model && <span className="font-mono text-2xs text-ink-3">{stat.model.provider}/{stat.model.id}</span>}
							<span className="ml-auto font-mono text-2xs text-ink-3">{money(stat?.cost ?? 0)} · {(stat?.tokens.total ?? 0).toLocaleString()} tokens</span>
						</li>;
					})}
				</ul>}
				{idle.length > 0 && <p className="text-xs text-ink-3">Not running in this chat: {idle.map(a => a.name).join(", ")}</p>}
				{notes.length === 0
					? <p className="text-xs text-ink-3">No advisor notes yet.</p>
					: SEVERITIES.map(s => <NoteGroup key={s.key} label={s.label} tone={s.tone} notes={notes.filter(n => n.severity === s.key)} />)}
			</div>}
		</div>
	</section>;
}

function NoteGroup({ label, tone, notes }: { label: string; tone: string; notes: AdvisorNote[] }) {
	if (notes.length === 0) return null;
	return <div aria-label={`Advisor ${label.toLowerCase()}`}>
		<h3 className={cn("meta", tone)}>{label} · {notes.length}</h3>
		<ul className="mt-1 space-y-1.5">
			{[...notes].reverse().map((n, i) => <li key={`${n.timestamp}-${i}`} className="border-l-2 border-line pl-2">
				<div className="font-mono text-2xs text-ink-3">{n.advisor} · {new Date(n.timestamp).toLocaleTimeString()}</div>
				<div className="whitespace-pre-wrap text-ink">{n.note}</div>
			</li>)}
		</ul>
	</div>;
}

function AdvisorPicker({ sessionId, status, onApplied, onCancel }: {
	sessionId: string;
	status: LiveAdvisorStatus | null;
	onApplied(status: LiveAdvisorStatus): void;
	onCancel(): void;
}) {
	const [roster, setRoster] = useState<SessionAdvisorRoster | null>(null);
	const [chosen, setChosen] = useState<Set<string>>(() => new Set(status?.selection ?? []));
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let active = true;
		advisorsApi.roster(sessionId).then(
			value => { if (active) setRoster(value); },
			err => { if (active) setError(err instanceof Error ? err.message : String(err)); },
		);
		return () => { active = false; };
	}, [sessionId]);
	const running = status?.overview.configured ?? false;
	async function apply(names: string[]) {
		setBusy(true);
		try { onApplied(await advisorsApi.select(sessionId, names)); }
		catch (err) { setError(err instanceof Error ? err.message : String(err)); }
		finally { setBusy(false); }
	}
	const toggle = (name: string) => setChosen(old => {
		const next = new Set(old);
		if (next.has(name)) next.delete(name); else next.add(name);
		return next;
	});
	// Keep roster order for the request and the status list.
	const ordered = roster?.advisors.filter(a => chosen.has(a.name)).map(a => a.name) ?? [];
	return <section className="border-t border-line bg-paper-2 px-5 py-3 text-sm" aria-label="Choose advisors">
		<div className="mx-auto max-w-[760px] space-y-2">
			<div className="flex items-baseline gap-3">
				<span className="meta">Advisors for this chat</span>
				<span className="text-xs text-ink-3">Only the checked advisors run here. The roster files are not changed.</span>
				<button type="button" className="btn-ghost ml-auto h-6 w-6 p-0" aria-label="Close advisor picker" onClick={onCancel}><X className="h-4 w-4" /></button>
			</div>
			{error && <p role="alert" className="text-xs text-danger">{error}</p>}
			{!roster && !error && <p className="text-xs text-ink-3">Loading roster…</p>}
			{roster && roster.advisors.length === 0 && <p className="text-xs text-ink-3">This workspace has no WATCHDOG advisors. <Link to="/advisors" className="text-accent hover:underline">Add advisors to the roster</Link>.</p>}
			{roster && roster.advisors.length > 0 && <ul className="space-y-1">
				{roster.advisors.map(a => <li key={a.name}>
					<label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-paper-3">
						<input type="checkbox" checked={chosen.has(a.name)} onChange={() => toggle(a.name)} />
						<span className="font-medium text-ink">{a.name}</span>
						<span className="font-mono text-2xs text-ink-3">{a.model ?? "advisor role model"}</span>
						{a.enabled === false && <span className="chip bg-paper-3 text-ink-3" title="enabled: false in WATCHDOG; choosing it here still runs it in this chat">off in roster</span>}
					</label>
				</li>)}
			</ul>}
			{roster?.warnings.map((w, i) => <p key={i} className="text-xs text-warn">{w}</p>)}
			<div className="flex flex-wrap items-center gap-2 pt-1">
				<button type="button" className="btn-primary px-3 py-1 text-xs" disabled={busy || ordered.length === 0} onClick={() => void apply(ordered)}>
					{ordered.length === 0 ? "Choose at least one" : `Run ${plural(ordered.length, "advisor")}`}
				</button>
				{running && <button type="button" className="btn-ghost px-3 py-1 text-xs" disabled={busy} onClick={() => void apply([])}>Stop all advisors</button>}
				<button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={onCancel}>Cancel</button>
				<Link to="/advisors" className="ml-auto text-xs text-accent hover:underline">Edit roster</Link>
			</div>
		</div>
	</section>;
}
