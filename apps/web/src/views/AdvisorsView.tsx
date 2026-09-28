import { useEffect, useState } from "react";
import { Layout } from "@/components/Layout";
import { useStore } from "@/lib/store";
import { advisorsApi, type AdvisorConfig, type AdvisorConfiguration, type WatchdogDoc } from "@/lib/advisors-api";

export function AdvisorsView() {
	const workspaces = useStore(s => s.workspaces);
	const sessions = useStore(s => s.sessionsById);
	const activeId = useStore(s => s.activeId);
	const cwd = sessions[activeId ?? ""]?.cwd ?? workspaces[0]?.cwd ?? "";
	const [config, setConfig] = useState<AdvisorConfiguration | null>(null);
	const [scope, setScope] = useState<"user" | "project">("project");
	const [doc, setDoc] = useState<WatchdogDoc>({ advisors: [] });
	const [settings, setSettings] = useState<AdvisorConfiguration["settings"] | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const [workspace, setWorkspace] = useState(cwd);
	const currentCwd = workspace || cwd;
	async function reload(target = currentCwd) {
		if (!target) return;
		try {
			const value = await advisorsApi.config(target);
			setConfig(value);
			setDoc(structuredClone(value[scope].doc));
			setSettings(value.settings);
			setError("");
		} catch (e) { setError(String(e)); }
	}
	useEffect(() => { void reload(); }, [currentCwd]);
	function selectScope(next: "user" | "project") {
		setScope(next);
		if (config) setDoc(structuredClone(config[next].doc));
		setNotice("");
	}
	function updateAdvisor(index: number, patch: Partial<AdvisorConfig>) {
		setDoc(old => ({ ...old, advisors: old.advisors.map((a, i) => i === index ? { ...a, ...patch } : a) }));
	}
	async function saveRoster() {
		if (!config) return;
		setBusy(true); setError(""); setNotice("");
		try {
			await advisorsApi.saveWatchdog(config.cwd, scope, config[scope].hash, doc);
			await reload(config.cwd);
			setNotice("WATCHDOG saved and applied to live sessions.");
		} catch (e) { setError(`${String(e)} — changes remain in this editor; reload only after reconciling them.`); }
		finally { setBusy(false); }
	}
	async function saveSettings() {
		if (!config || !settings) return;
		setBusy(true); setError(""); setNotice("");
		try {
			const updates = Object.fromEntries(Object.entries(settings).filter(([key, value]) => value !== config.settings[key as keyof typeof settings]));
			if (Object.keys(updates).length > 0) await advisorsApi.saveSettings(config.cwd, updates);
			await reload(config.cwd);
			setNotice("Settings saved and applied to live sessions.");
		} catch (e) { setError(String(e)); }
		finally { setBusy(false); }
	}
	return <Layout sidebar={<div className="p-4 text-sm text-ink-3">Advisor configuration</div>} inspector={null} main={
		<div className="h-full overflow-y-auto p-6"><div className="mx-auto max-w-3xl space-y-7">
			<header><div className="meta">Configuration</div><h1 className="text-2xl font-semibold">Advisors</h1><p className="text-sm text-ink-3">Edit persistent settings and WATCHDOG rosters separately. Runtime switches live in each chat.</p></header>
			<label className="block text-sm">Live workspace <select className="field ml-3 px-2 py-1" value={currentCwd} onChange={e => setWorkspace(e.target.value)}>{workspaces.map(w => <option key={w.cwd} value={w.cwd}>{w.label} — {w.cwd}</option>)}</select></label>
			{error && <div role="alert" className="rounded border border-red-400 p-3 text-sm text-red-600">{error}</div>}
			{notice && <div role="status" className="rounded border border-line p-3 text-sm">{notice}</div>}
			{settings && <section className="space-y-3 rounded border border-line p-4"><h2 className="font-semibold">Global settings · config.yml</h2>
				<p className="text-xs text-ink-3">Saving rewrites config.yml; comments are not preserved.</p>
				<label className="flex gap-2 text-sm"><input type="checkbox" checked={settings.enabled} onChange={e => setSettings({ ...settings, enabled: e.target.checked })} /> Enable advisor by default (not the current session switch)</label>
				<label className="block text-sm">Advisor model role <input className="field ml-2 w-72 px-2 py-1" placeholder="provider/model" value={settings.model} onChange={e => setSettings({ ...settings, model: e.target.value })} /></label>
				<label className="block text-sm">Sync backlog <select className="field ml-2 px-2 py-1" value={settings.syncBacklog} onChange={e => setSettings({ ...settings, syncBacklog: e.target.value })}>{["off", "1", "3", "5"].map(v => <option key={v} value={v}>{v}</option>)}</select></label>
				<label className="block text-sm">Max notes per update <input type="number" min={1} max={32} className="field ml-2 w-20 px-2 py-1" value={settings.maxNotesPerUpdate} onChange={e => setSettings({ ...settings, maxNotesPerUpdate: Number(e.target.value) })} /></label>
				<label className="flex gap-2 text-sm"><input type="checkbox" checked={settings.evictStaleResults} onChange={e => setSettings({ ...settings, evictStaleResults: e.target.checked })} /> Evict stale advisor tool results</label>
				<button type="button" className="btn-primary px-3 py-1" disabled={busy} onClick={() => void saveSettings()}>Save settings</button>
			</section>}
			{config && <section className="space-y-4 rounded border border-line p-4"><h2 className="font-semibold">WATCHDOG roster</h2><div className="flex gap-2">{(["user", "project"] as const).map(v => <button type="button" key={v} className={scope === v ? "btn-primary px-3 py-1" : "btn-ghost px-3 py-1"} onClick={() => selectScope(v)}>{v === "user" ? "User" : "Project"}</button>)}</div>
				<div className="break-all font-mono text-xs text-ink-3" title={config[scope].file}>Editing {config[scope].file}</div>
				<p className="text-xs text-ink-3">Saving rewrites WATCHDOG.yml; comments and unknown fields are not preserved.</p>
				{doc.warnings?.map((warning, i) => <p key={i} role="alert" className="text-sm text-red-600">{warning}</p>)}
				<label className="block text-sm">Shared instructions<textarea className="field mt-1 min-h-24 w-full p-2" value={doc.instructions ?? ""} onChange={e => setDoc({ ...doc, instructions: e.target.value || undefined })} /></label>
				<label className="block text-sm">Shared max notes <input type="number" min={1} className="field ml-2 w-20 px-2 py-1" value={doc.maxNotesPerUpdate ?? ""} onChange={e => setDoc({ ...doc, maxNotesPerUpdate: e.target.value ? Number(e.target.value) : undefined })} /></label>
				{doc.advisors.map((advisor, index) => <div key={index} className="space-y-2 border-t border-line pt-4">
					<div className="flex items-center gap-3"><input aria-label="Advisor name" className="field flex-1 px-2 py-1" placeholder="Advisor name" value={advisor.name} onChange={e => updateAdvisor(index, { name: e.target.value })} /><button type="button" className="btn-ghost" onClick={() => setDoc({ ...doc, advisors: doc.advisors.filter((_, i) => i !== index) })}>Remove</button></div>
					<label className="flex gap-2 text-sm"><input type="checkbox" checked={advisor.enabled !== false} onChange={e => updateAdvisor(index, { enabled: e.target.checked })} /> Enabled in roster (independent of session master switch)</label>
					<label className="block text-sm">Model <input className="field ml-2 w-72 px-2 py-1" placeholder="Inherited advisor role" value={advisor.model ?? ""} onChange={e => updateAdvisor(index, { model: e.target.value || undefined })} /></label>
					<label className="block text-sm">Tools (comma separated) <input className="field ml-2 w-72 px-2 py-1" value={advisor.tools?.join(", ") ?? ""} onChange={e => updateAdvisor(index, { tools: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} /></label>
					<label className="block text-sm">Max notes <input type="number" min={1} className="field ml-2 w-20 px-2 py-1" value={advisor.maxNotesPerUpdate ?? ""} onChange={e => updateAdvisor(index, { maxNotesPerUpdate: e.target.value ? Number(e.target.value) : undefined })} /></label>
					<label className="block text-sm">Instructions<textarea className="field mt-1 min-h-24 w-full p-2" value={advisor.instructions ?? ""} onChange={e => updateAdvisor(index, { instructions: e.target.value || undefined })} /></label>
					<label className="block text-sm">System prompt override<textarea className="field mt-1 min-h-20 w-full p-2" value={advisor.systemPrompt ?? ""} onChange={e => updateAdvisor(index, { systemPrompt: e.target.value || undefined })} /></label>
				</div>)}
				<button type="button" className="btn-ghost px-3 py-1" onClick={() => setDoc({ ...doc, advisors: [...doc.advisors, { name: "" }] })}>Add advisor</button>
				<button type="button" className="btn-primary ml-2 px-3 py-1" disabled={busy || !!doc.warnings?.length} onClick={() => void saveRoster()}>Save WATCHDOG</button>
				<div className="border-t border-line pt-3"><h3 className="text-sm font-semibold">Effective roster · discovered precedence</h3>{config.merged.advisors.map((a, i) => <p key={i} className="py-1 text-sm">{a.name} · {a.enabled === false ? "disabled" : "enabled"}<span className="block break-all font-mono text-xs text-ink-3">{a.source ?? "Source unavailable"}</span></p>)}{config.merged.warnings.map((w, i) => <p key={i} className="text-sm text-red-600">{w}</p>)}</div>
			</section>}
		</div></div>} />;
}
