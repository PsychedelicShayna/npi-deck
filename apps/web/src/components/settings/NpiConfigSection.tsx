import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { ArrowDown, ArrowUp, RotateCcw, Save, Search, X } from "lucide-react";
import type { NpiConfigPatchResponse, NpiConfigProvenance, NpiConfigResponse, NpiConfigSetting } from "@npi-deck/protocol";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { npiConfigApi } from "@/lib/npi-config-api";
import { cn } from "@/lib/utils";

/** An editor's pending change: nothing, a value to send, or input it cannot send yet. */
type Draft = { dirty: false } | { dirty: true; value: unknown } | { dirty: true; error: string };
type EditorProps = { setting: NpiConfigSetting; disabled: boolean; onChange: (draft: Draft) => void };

const CLEAN: Draft = { dirty: false };

/**
 * Every setting NeoPi registers, grouped by the registry's own tabs and groups.
 * Saves write the global config.yml through NeoPi and reload live chats.
 */
export function NpiConfigSection() {
	const [data, setData] = useState<NpiConfigResponse | null>(null);
	const [error, setError] = useState<string | undefined>();
	const [query, setQuery] = useState("");
	const [tab, setTab] = useState("");

	const refresh = useCallback(async () => {
		try {
			const next = await npiConfigApi.list();
			setData(next);
			setTab(current => current || next.tabs[0]?.id || "");
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);
	useEffect(() => { void refresh(); }, [refresh]);

	const replace = useCallback((setting: NpiConfigSetting) => {
		setData(current => current && { ...current, settings: current.settings.map(s => s.id === setting.id ? setting : s) });
	}, []);

	const sections = useMemo(() => {
		if (!data) return [];
		const needle = query.trim().toLowerCase();
		const matches = (s: NpiConfigSetting) =>
			[s.id, s.label, s.description, s.group].some(text => text.toLowerCase().includes(needle));
		return data.tabs
			.filter(t => needle !== "" || t.id === tab)
			.flatMap(t => t.groups.map(group => ({
				key: `${t.id}/${group}`,
				title: needle ? `${t.label} › ${group}` : group,
				settings: data.settings.filter(s => s.tab === t.id && s.group === group && (needle === "" || matches(s))),
			})))
			.filter(section => section.settings.length > 0);
	}, [data, query, tab]);

	return (
		<div className="mx-auto max-w-6xl space-y-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h1 className="text-xl font-semibold tracking-tight">NeoPi configuration</h1>
					<p className="mt-1 max-w-3xl text-sm text-ink-3">
						Every registered NeoPi setting. Saving writes the global config file and reloads each live
						chat's settings, so changes apply without a restart. Provenance is resolved for the default
						workspace.
					</p>
				</div>
				<Button variant="outline" size="sm" onClick={() => void refresh()}>
					<RotateCcw className="h-3.5 w-3.5" />
					Reload
				</Button>
			</div>
			{error ? (
				<div role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{error}</div>
			) : null}
			{data ? (
				<>
					<div className="rounded-md border border-line bg-paper-2 px-3 py-2 font-mono text-2xs text-ink-3">
						<div>config: {data.configPath}</div>
						<div>workspace: {data.cwd}</div>
						<div>{data.settings.length} settings</div>
					</div>
					<label className="flex items-center gap-2 rounded-md border border-line bg-paper px-2">
						<Search className="h-3.5 w-3.5 text-ink-4" />
						<input
							value={query}
							onChange={e => setQuery(e.target.value)}
							placeholder="Search every setting by id, label or description"
							className="h-8 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-4"
						/>
						{query ? (
							<button type="button" aria-label="Clear search" className="text-ink-4 hover:text-ink" onClick={() => setQuery("")}>
								<X className="h-3.5 w-3.5" />
							</button>
						) : null}
					</label>
					{query.trim() === "" ? (
						<div className="flex flex-wrap gap-1" role="tablist">
							{data.tabs.map(t => (
								<button
									key={t.id}
									type="button"
									role="tab"
									aria-selected={tab === t.id}
									onClick={() => setTab(t.id)}
									className={cn(
										"rounded-md px-2 py-1 font-mono text-2xs uppercase tracking-meta transition-colors",
										tab === t.id ? "bg-accent-soft text-accent" : "text-ink-3 hover:bg-paper-3",
									)}
								>
									{t.label} <span className="text-ink-4">{data.settings.filter(s => s.tab === t.id).length}</span>
								</button>
							))}
						</div>
					) : null}
					{sections.length === 0 ? <div className="text-sm text-ink-3">No setting matches “{query}”.</div> : null}
					{sections.map(section => (
						<div key={section.key} className="overflow-hidden rounded-md border border-line bg-paper">
							<div className="border-b border-line bg-paper-2 px-3 py-2">
								<div className="meta">{section.title}</div>
							</div>
							<div className="divide-y divide-line">
								{section.settings.map(setting => (
									<SettingRow key={setting.id} setting={setting} cwd={data.cwd} onSaved={replace} />
								))}
							</div>
						</div>
					))}
				</>
			) : error ? null : <div className="text-sm text-ink-3">Loading...</div>}
		</div>
	);
}

function SettingRow({ setting, cwd, onSaved }: { setting: NpiConfigSetting; cwd: string; onSaved: (setting: NpiConfigSetting) => void }) {
	const [draft, setDraft] = useState<Draft>(CLEAN);
	const [generation, setGeneration] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [status, setStatus] = useState<{ text: string; complete: boolean } | undefined>();
	const locked = setting.lockedReason !== undefined;

	const discard = () => { setDraft(CLEAN); setGeneration(g => g + 1); };
	// A saved or reloaded setting remounts its editor from the new value.
	const [shown, setShown] = useState(setting);
	if (shown !== setting) {
		setShown(setting);
		discard();
	}

	async function run(action: () => Promise<NpiConfigPatchResponse>): Promise<void> {
		setBusy(true);
		setError(undefined);
		setStatus(undefined);
		try {
			const result = await action();
			onSaved(result.setting);
			setStatus(liveSummary(result));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	const invalid = draft.dirty && "error" in draft ? draft.error : undefined;
	const Editor = editorFor(setting);
	return (
		<div className="grid grid-cols-1 gap-3 px-3 py-3 text-sm lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
			<div className="min-w-0 space-y-1">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="font-medium text-ink">{setting.label}</span>
					<Badge tone={provenanceTone(setting.provenance)} title="Layer supplying the effective value">{setting.provenance}</Badge>
					{setting.secret ? <Badge tone="danger">secret</Badge> : null}
					{locked ? <Badge tone="warn">locked</Badge> : null}
				</div>
				<div className="break-all font-mono text-2xs text-ink-4">{setting.id} · {setting.type}</div>
				{setting.warning ? <p className="text-xs text-warn">{setting.warning}</p> : null}
				<p className="text-xs text-ink-3">{setting.description || "Config-file setting without panel metadata."}</p>
				{notes(setting, cwd).map(note => <p key={note} className="text-xs text-ink-3">{note}</p>)}
			</div>
			<div className="min-w-0 space-y-2">
				{locked ? <p role="note" className="rounded-md border border-warn/30 bg-warn/10 px-2 py-1 text-xs text-warn">{setting.lockedReason}</p> : null}
				<Editor key={generation} setting={setting} disabled={locked || busy} onChange={setDraft} />
				{invalid ? <p className="font-mono text-2xs text-danger">{invalid}</p> : null}
				{error ? <p role="alert" className="font-mono text-2xs text-danger">{error}</p> : null}
				{status ? <p role="status" className={cn("text-2xs", status.complete ? "text-success" : "text-warn")}>{status.text}</p> : null}
				<div className="flex flex-wrap items-center gap-2">
					<Button
						variant="primary"
						size="sm"
						disabled={locked || busy || !draft.dirty || invalid !== undefined}
						onClick={() => { if (draft.dirty && "value" in draft) void run(() => npiConfigApi.set(setting.id, draft.value)); }}
					>
						<Save className="h-3.5 w-3.5" />
						Save
					</Button>
					{draft.dirty ? <Button variant="ghost" size="sm" disabled={busy} onClick={discard}>Discard</Button> : null}
					<Button
						variant="outline"
						size="sm"
						disabled={locked || busy || !setting.inGlobalConfig}
						title={setting.inGlobalConfig ? "Remove this key from config.yml" : "config.yml does not set this key"}
						onClick={() => void run(() => npiConfigApi.reset(setting.id))}
					>
						<RotateCcw className="h-3.5 w-3.5" />
						Reset to default
					</Button>
					{!setting.secret ? <span className="truncate font-mono text-2xs text-ink-4">default {preview(setting.defaultValue)}</span> : null}
				</div>
			</div>
		</div>
	);
}

function notes(setting: NpiConfigSetting, cwd: string): string[] {
	const out: string[] = [];
	if (setting.invalidGlobalValue) out.push("config.yml holds a value this setting rejects; NeoPi ignores it and uses the default. Save a valid value or reset.");
	if (setting.provenance === "project" || setting.provenance === "overlay" || setting.provenance === "runtime")
		out.push(`A ${setting.provenance} layer overrides the global value in ${cwd}.`);
	if (setting.env?.active && setting.env.fallback)
		out.push(setting.provenance === "env" ? `Using $${setting.env.name} until a config value is saved.` : `Config overrides $${setting.env.name}.`);
	if (setting.secret) out.push(setting.configured ? "A value is configured; it is never shown. Saving replaces it." : "No value is configured.");
	else if (setting.provenance !== "global" && setting.provenance !== "default") out.push(`Effective: ${preview(setting.effectiveValue)}`);
	return out;
}

/** Whether every live chat now resolves the saved value, and which ones a higher layer or failed reload holds back. */
function liveSummary(result: NpiConfigPatchResponse): { text: string; complete: boolean } {
	const saved = `Saved; resolves from ${result.setting.provenance}.`;
	if (result.live.length === 0) return { text: `${saved} No live chats to reload.`, complete: true };
	const failed = result.live.filter(l => l.error);
	const shadowed = new Map<string, number>();
	for (const l of result.live) {
		if (!l.error && l.provenance !== "global" && l.provenance !== "default") shadowed.set(l.provenance, (shadowed.get(l.provenance) ?? 0) + 1);
	}
	const held = [...shadowed.values()].reduce((sum, n) => sum + n, 0);
	const chats = (n: number) => `${n} live chat${n === 1 ? "" : "s"}`;
	const parts = [`${saved} ${result.live.length - failed.length - held} of ${chats(result.live.length)} now use it.`];
	for (const [provenance, n] of shadowed) parts.push(`${chats(n)} keep a ${provenance} value.`);
	for (const l of failed) parts.push(`Chat ${l.sessionId} failed to reload: ${l.error}`);
	return { text: parts.join(" "), complete: failed.length === 0 && held === 0 };
}

function provenanceTone(provenance: NpiConfigProvenance): "accent" | "default" | "muted" | "warn" {
	if (provenance === "env") return "accent";
	if (provenance === "global") return "default";
	if (provenance === "default") return "muted";
	return "warn";
}

function preview(value: unknown): string {
	if (value === null || value === undefined) return "unset";
	const text = JSON.stringify(value);
	return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every(entry => typeof entry === "string" && !entry.includes("\n"));

function editorFor(setting: NpiConfigSetting): ComponentType<EditorProps> {
	switch (setting.type) {
		case "boolean": return BooleanEditor;
		case "enum": return EnumEditor;
		case "number": return NumberEditor;
		case "string": return setting.secret ? SecretTextEditor : StringEditor;
		case "array":
			if (setting.options || setting.items) return ChoiceListEditor;
			return isStringList(setting.value) && isStringList(setting.defaultValue) ? StringListEditor : JsonEditor;
		case "record":
			return setting.secret ? JsonEditor : RecordEditor;
	}
}

function BooleanEditor({ setting, disabled, onChange }: EditorProps) {
	const [checked, setChecked] = useState(setting.value === true);
	return (
		<label className="flex items-center gap-2 text-xs text-ink-2">
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={e => {
					setChecked(e.target.checked);
					onChange(e.target.checked === setting.value ? CLEAN : { dirty: true, value: e.target.checked });
				}}
			/>
			{checked ? "On" : setting.value === null ? "Off (unset)" : "Off"}
		</label>
	);
}

function EnumEditor({ setting, disabled, onChange }: EditorProps) {
	const [value, setValue] = useState(String(setting.value ?? ""));
	const labels = new Map(setting.options?.map(o => [o.value, o.label]));
	return (
		<select
			value={value}
			disabled={disabled}
			onChange={e => {
				setValue(e.target.value);
				onChange(e.target.value === setting.value ? CLEAN : { dirty: true, value: e.target.value });
			}}
			className="field h-7 w-full px-2 font-mono text-2xs"
		>
			{(setting.enumValues ?? []).map(v => <option key={v} value={v}>{labels.get(v) && labels.get(v) !== v ? `${labels.get(v)} (${v})` : v}</option>)}
		</select>
	);
}

/** Text goes to the server as typed, so the setting's own parser judges it. */
function NumberEditor({ setting, disabled, onChange }: EditorProps) {
	const initial = setting.value === null ? "" : String(setting.value);
	const [text, setText] = useState(initial);
	const list = setting.options ? `npi-options-${setting.id}` : undefined;
	return (
		<>
			<input
				value={text}
				disabled={disabled}
				inputMode="decimal"
				list={list}
				placeholder={setting.value === null ? "unset" : undefined}
				onChange={e => {
					const next = e.target.value;
					setText(next);
					if (next.trim() === initial) onChange(CLEAN);
					else if (next.trim() === "") onChange({ dirty: true, error: "Enter a number, or reset to default." });
					else onChange({ dirty: true, value: next });
				}}
				className="field h-7 w-full px-2 font-mono text-2xs"
			/>
			<OptionList id={list} setting={setting} />
		</>
	);
}

function StringEditor({ setting, disabled, onChange }: EditorProps) {
	const initial = typeof setting.value === "string" ? setting.value : "";
	const [text, setText] = useState(initial);
	const list = setting.options ? `npi-options-${setting.id}` : undefined;
	const update = (next: string) => {
		setText(next);
		onChange(next === initial ? CLEAN : { dirty: true, value: next });
	};
	return initial.includes("\n") || initial.length > 120 ? (
		<textarea value={text} disabled={disabled} rows={4} onChange={e => update(e.target.value)} className="field w-full resize-y px-2 py-1.5 font-mono text-2xs" />
	) : (
		<>
			<input
				value={text}
				disabled={disabled}
				list={list}
				placeholder={setting.value === null ? "unset" : setting.runtimeOptions ? "name provided at runtime" : undefined}
				onChange={e => update(e.target.value)}
				className="field h-7 w-full px-2 font-mono text-2xs"
			/>
			<OptionList id={list} setting={setting} />
		</>
	);
}

function OptionList({ id, setting }: { id: string | undefined; setting: NpiConfigSetting }) {
	if (!id || !setting.options) return null;
	return (
		<datalist id={id}>
			{setting.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
		</datalist>
	);
}

/** Write-only: starts empty and never shows the configured value. */
function SecretTextEditor({ setting, disabled, onChange }: EditorProps) {
	const [text, setText] = useState("");
	return (
		<input
			type="password"
			autoComplete="off"
			value={text}
			disabled={disabled}
			placeholder={setting.configured ? "configured; type to replace" : "not set"}
			onChange={e => {
				setText(e.target.value);
				onChange(e.target.value === "" ? CLEAN : { dirty: true, value: e.target.value });
			}}
			className="field h-7 w-full px-2 font-mono text-2xs"
		/>
	);
}

/** Membership among the registry's choices; ordered settings also reorder. */
function ChoiceListEditor({ setting, disabled, onChange }: EditorProps) {
	const initial = Array.isArray(setting.value) ? setting.value.map(String) : [];
	const choices = setting.options ?? (setting.items ?? []).map(value => ({ value, label: value, description: undefined }));
	const [selected, setSelected] = useState(initial);
	const update = (next: string[]) => {
		setSelected(next);
		onChange(same(next, initial) ? CLEAN : { dirty: true, value: next });
	};
	const label = (value: string) => choices.find(c => c.value === value)?.label ?? `${value} (unknown)`;
	if (setting.ordered) {
		const remaining = choices.filter(c => !selected.includes(c.value));
		const move = (index: number, by: number) => {
			const next = selected.slice();
			const [entry] = next.splice(index, 1);
			next.splice(index + by, 0, entry!);
			update(next);
		};
		return (
			<div className="space-y-1">
				{selected.length === 0 ? <div className="font-mono text-2xs text-ink-4">none</div> : null}
				{selected.map((value, index) => (
					<div key={value} className="flex items-center gap-1 rounded bg-paper-2 px-1.5 py-0.5 text-2xs">
						<span className="w-5 font-mono text-ink-4">{index + 1}</span>
						<span className="flex-1 truncate font-mono">{label(value)}</span>
						<button type="button" aria-label={`Move ${value} up`} disabled={disabled || index === 0} onClick={() => move(index, -1)} className="text-ink-4 hover:text-ink disabled:opacity-30"><ArrowUp className="h-3 w-3" /></button>
						<button type="button" aria-label={`Move ${value} down`} disabled={disabled || index === selected.length - 1} onClick={() => move(index, 1)} className="text-ink-4 hover:text-ink disabled:opacity-30"><ArrowDown className="h-3 w-3" /></button>
						<button type="button" aria-label={`Remove ${value}`} disabled={disabled} onClick={() => update(selected.filter(v => v !== value))} className="text-ink-4 hover:text-danger"><X className="h-3 w-3" /></button>
					</div>
				))}
				{remaining.length > 0 ? (
					<select
						value=""
						disabled={disabled}
						onChange={e => { if (e.target.value) update([...selected, e.target.value]); }}
						className="field h-7 w-full px-2 font-mono text-2xs"
					>
						<option value="">+ add…</option>
						{remaining.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
					</select>
				) : null}
			</div>
		);
	}
	const unknown = selected.filter(value => !choices.some(c => c.value === value));
	return (
		<div className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-2">
			{[...choices, ...unknown.map(value => ({ value, label: `${value} (unknown)`, description: undefined }))].map(choice => (
				<label key={choice.value} className="flex items-center gap-1.5 text-2xs text-ink-2" title={choice.description}>
					<input
						type="checkbox"
						disabled={disabled}
						checked={selected.includes(choice.value)}
						onChange={e => {
							const on = new Set(e.target.checked ? [...selected, choice.value] : selected.filter(v => v !== choice.value));
							// Keep the registry's choice order; unknown entries stay last.
							update([...choices.map(c => c.value), ...unknown].filter(v => on.has(v)));
						}}
					/>
					<span className="truncate font-mono">{choice.label}</span>
				</label>
			))}
		</div>
	);
}

/** Free string entries, one per line. */
function StringListEditor({ setting, disabled, onChange }: EditorProps) {
	const initial = setting.value as string[];
	const [text, setText] = useState(initial.join("\n"));
	return (
		<textarea
			value={text}
			disabled={disabled}
			rows={Math.min(8, Math.max(2, initial.length + 1))}
			placeholder="one entry per line"
			onChange={e => {
				setText(e.target.value);
				const next = e.target.value.split("\n").map(line => line.trim()).filter(Boolean);
				onChange(same(next, initial) ? CLEAN : { dirty: true, value: next });
			}}
			className="field w-full resize-y px-2 py-1.5 font-mono text-2xs"
		/>
	);
}

/** Validated JSON for arrays and records with non-string entries (and write-only secret records). */
function JsonEditor({ setting, disabled, onChange }: EditorProps) {
	const initial = setting.secret ? "" : JSON.stringify(setting.value ?? (setting.type === "array" ? [] : {}), null, 2);
	const [text, setText] = useState(initial);
	return (
		<textarea
			value={text}
			disabled={disabled}
			rows={Math.min(14, Math.max(3, initial.split("\n").length))}
			placeholder={setting.secret ? (setting.configured ? "configured; paste a JSON object to replace it" : "JSON object") : undefined}
			onChange={e => {
				setText(e.target.value);
				if (e.target.value === initial) return onChange(CLEAN);
				const parsed = parseJsonShape(e.target.value, setting.type === "array" ? "array" : "object");
				onChange("error" in parsed ? { dirty: true, error: parsed.error } : { dirty: true, value: parsed.value });
			}}
			className="field w-full resize-y px-2 py-1.5 font-mono text-2xs"
		/>
	);
}

function parseJsonShape(text: string, shape: "array" | "object"): { value: unknown } | { error: string } {
	let value: unknown;
	try { value = JSON.parse(text); } catch (err) { return { error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` }; }
	const ok = shape === "array" ? Array.isArray(value) : typeof value === "object" && value !== null && !Array.isArray(value);
	return ok ? { value } : { error: shape === "array" ? "Expected a JSON array." : "Expected a JSON object." };
}

type EntryKind = "text" | "list" | "json";
type Entry = { key: string; kind: EntryKind; text: string };

const kindOf = (value: unknown): EntryKind => typeof value === "string" ? "text" : isStringList(value) ? "list" : "json";
const entryText = (kind: EntryKind, value: unknown) =>
	kind === "text" ? String(value) : kind === "list" ? (value as string[]).join("\n") : JSON.stringify(value);

function entriesOf(record: Record<string, unknown>): Entry[] {
	return Object.entries(record).map(([key, value]) => {
		const kind = kindOf(value);
		return { key, kind, text: entryText(kind, value) };
	});
}

/** Rows back to a record in row order (NeoPi reads record order as precedence), or the first problem. */
function recordOf(entries: Entry[]): { value: Record<string, unknown> } | { error: string } {
	const value: Record<string, unknown> = {};
	for (const [index, entry] of entries.entries()) {
		const key = entry.key.trim();
		if (!key) return { error: `Row ${index + 1} needs a key.` };
		if (key in value) return { error: `Duplicate key: ${key}` };
		if (entry.kind === "text") value[key] = entry.text;
		else if (entry.kind === "list") value[key] = entry.text.split("\n").map(line => line.trim()).filter(Boolean);
		else {
			try { value[key] = JSON.parse(entry.text); } catch { return { error: `Invalid JSON for ${key}.` }; }
		}
	}
	return { value };
}

/**
 * Key → value rows. Each value is text (model roles), a list (fallback chains)
 * or JSON; a JSON mode edits the whole record at once.
 */
function RecordEditor({ setting, disabled, onChange }: EditorProps) {
	const initial = (setting.value ?? {}) as Record<string, unknown>;
	const [entries, setEntries] = useState(() => entriesOf(initial));
	const [json, setJson] = useState<string | null>(null);
	const report = (result: { value: unknown } | { error: string }) =>
		onChange("error" in result ? { dirty: true, error: result.error } : same(result.value, initial) ? CLEAN : { dirty: true, value: result.value });
	const updateEntries = (next: Entry[]) => { setEntries(next); report(recordOf(next)); };
	const edit = (index: number, patch: Partial<Entry>) => updateEntries(entries.map((e, i) => i === index ? { ...e, ...patch } : e));

	if (json !== null) {
		const parsed = parseJsonShape(json, "object");
		return (
			<div className="space-y-1">
				<textarea
					value={json}
					disabled={disabled}
					rows={Math.min(14, Math.max(3, json.split("\n").length))}
					onChange={e => { setJson(e.target.value); report(parseJsonShape(e.target.value, "object")); }}
					className="field w-full resize-y px-2 py-1.5 font-mono text-2xs"
				/>
				<button
					type="button"
					disabled={disabled || "error" in parsed}
					onClick={() => { if ("value" in parsed) { setEntries(entriesOf(parsed.value as Record<string, unknown>)); setJson(null); } }}
					className="font-mono text-2xs text-ink-3 underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
				>
					edit as rows
				</button>
			</div>
		);
	}
	const current = recordOf(entries);
	return (
		<div className="space-y-1">
			{entries.length === 0 ? <div className="font-mono text-2xs text-ink-4">empty</div> : null}
			{entries.map((entry, index) => (
				<div key={index} className="grid grid-cols-[minmax(0,0.8fr)_auto_minmax(0,1.2fr)_auto] items-start gap-1">
					<input
						value={entry.key}
						disabled={disabled}
						placeholder="key"
						onChange={e => edit(index, { key: e.target.value })}
						className="field h-7 w-full px-1.5 font-mono text-2xs"
					/>
					<select
						value={entry.kind}
						disabled={disabled}
						aria-label={`Value type for ${entry.key || `row ${index + 1}`}`}
						onChange={e => {
							const kind = e.target.value as EntryKind;
							const parsed = recordOf([entry]);
							// Carry the value across when it fits the new kind; otherwise start blank.
							const old = "value" in parsed ? parsed.value[entry.key.trim()] : undefined;
							const text = old !== undefined && kindOf(old) === kind ? entryText(kind, old) : kind === "json" && old !== undefined ? JSON.stringify(old) : "";
							edit(index, { kind, text });
						}}
						className="field h-7 px-1 font-mono text-2xs"
					>
						<option value="text">text</option>
						<option value="list">list</option>
						<option value="json">json</option>
					</select>
					{entry.kind === "text" ? (
						<input value={entry.text} disabled={disabled} placeholder="value" onChange={e => edit(index, { text: e.target.value })} className="field h-7 w-full px-1.5 font-mono text-2xs" />
					) : (
						<textarea
							value={entry.text}
							disabled={disabled}
							rows={Math.min(6, Math.max(1, entry.text.split("\n").length))}
							placeholder={entry.kind === "list" ? "one entry per line" : "JSON value"}
							onChange={e => edit(index, { text: e.target.value })}
							className="field w-full resize-y px-1.5 py-1 font-mono text-2xs"
						/>
					)}
					<button type="button" aria-label="Remove row" disabled={disabled} onClick={() => updateEntries(entries.filter((_, i) => i !== index))} className="btn-ghost h-7 w-7 p-0 text-ink-4 hover:text-danger">×</button>
				</div>
			))}
			<div className="flex gap-3">
				<button
					type="button"
					disabled={disabled}
					onClick={() => updateEntries([...entries, { key: "", kind: entries[0]?.kind ?? "text", text: "" }])}
					className="font-mono text-2xs text-ink-3 underline-offset-2 hover:text-ink hover:underline"
				>
					+ add row
				</button>
				<button
					type="button"
					disabled={disabled || "error" in current}
					onClick={() => { if ("value" in current) setJson(JSON.stringify(current.value, null, 2)); }}
					className="font-mono text-2xs text-ink-3 underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
				>
					edit as JSON
				</button>
			</div>
		</div>
	);
}
