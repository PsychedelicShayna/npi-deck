import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import type {
	McpKeyValue,
	McpKeyValueInput,
	McpServerMutationResponse,
	McpServerRow,
	McpServerScope,
	McpServersResponse,
	McpTransport,
} from "@npi-deck/protocol";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { mcpServersApi } from "@/lib/mcp-servers-api";
import { cn } from "@/lib/utils";

/** An env or header row being edited; `stored` means "keep the value the file holds". */
type Pair = { key: string; value: string; stored: boolean };

interface Draft {
	name: string;
	scope: McpServerScope;
	sourcePath?: string;
	transport: McpTransport;
	command: string;
	args: string;
	cwd: string;
	url: string;
	timeout: string;
	env: Pair[];
	headers: Pair[];
}

const DISABLED_REASON: Record<NonNullable<McpServerRow["disabledReason"]>, string> = {
	denylisted: "Disabled in the user mcp.json denylist.",
	"config-flag": "Its own entry sets enabled: false.",
	"extension-disabled": "Switched off in NeoPi's disabledExtensions setting.",
	"provider-disabled": "Its discovery provider is switched off in NeoPi.",
	"user-opt-in": "A foreign tool's home config; NeoPi loads it only when that source is opted in.",
	shadowed: "A higher-priority source defines the same name, so this entry never loads.",
};

const pairsOf = (entries: McpKeyValue[]): Pair[] =>
	entries.map(entry => ({ key: entry.key, value: entry.masked ? "" : entry.value ?? "", stored: entry.masked }));

const inputsOf = (pairs: Pair[]): McpKeyValueInput[] =>
	pairs.filter(pair => pair.key.trim() !== "").map(pair => ({ key: pair.key.trim(), value: pair.stored ? null : pair.value }));

function draftOf(row: McpServerRow): Draft {
	return {
		name: row.name,
		scope: row.scope ?? "user",
		...(row.scope !== undefined ? { sourcePath: row.sourcePath } : {}),
		transport: row.transport,
		command: row.command ?? "",
		args: (row.args ?? []).join("\n"),
		cwd: row.cwd ?? "",
		url: row.url ?? "",
		timeout: row.timeout === undefined ? "" : String(row.timeout),
		env: pairsOf(row.env),
		headers: pairsOf(row.headers),
	};
}

const emptyDraft = (scope: McpServerScope): Draft => ({
	name: "", scope, transport: "stdio", command: "", args: "", cwd: "", url: "", timeout: "", env: [], headers: [],
});

/**
 * Every MCP server NeoPi discovers, with an editor for the ones that live in a
 * config file NeoPi's own writer owns. Saving writes that file and reconciles
 * each live chat's MCP runtime; the result says exactly how far it reached.
 */
export function McpServersSection() {
	const [data, setData] = useState<McpServersResponse | null>(null);
	const [error, setError] = useState<string | undefined>();
	const [note, setNote] = useState<string | undefined>();
	const [editing, setEditing] = useState<string | null>(null);
	const [adding, setAdding] = useState<Draft | null>(null);

	const refresh = useCallback(async () => {
		try {
			setData(await mcpServersApi.list());
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);
	useEffect(() => { void refresh(); }, [refresh]);

	const report = useCallback(async (result: McpServerMutationResponse) => {
		setNote(result.applyNote);
		setEditing(null);
		setAdding(null);
		await refresh();
	}, [refresh]);

	const groups = useMemo(() => {
		if (!data) return [];
		const order: Array<McpServerRow["level"]> = ["user", "project", "native"];
		return order
			.map(level => ({ level, rows: data.servers.filter(row => row.level === level) }))
			.filter(group => group.rows.length > 0);
	}, [data]);

	return (
		<div className="mx-auto max-w-6xl space-y-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h1 className="text-xl font-semibold tracking-tight">MCP servers</h1>
					<p className="mt-1 max-w-3xl text-sm text-ink-3">
						Every Model Context Protocol server NeoPi discovers, from your user and project{" "}
						<span className="font-mono">mcp.json</span> and from other tools' configs. Env and header values
						that look like credentials are masked and never sent to this page.
					</p>
				</div>
				<div className="flex gap-2">
					<Button variant="outline" size="sm" onClick={() => void refresh()}>
						<RotateCcw className="h-3.5 w-3.5" />
						Reload
					</Button>
					<Button variant="primary" size="sm" onClick={() => { setAdding(emptyDraft("user")); setEditing(null); }}>
						<Plus className="h-3.5 w-3.5" />
						Add server
					</Button>
				</div>
			</div>

			{error ? (
				<div role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{error}</div>
			) : null}
			{note ? (
				<div role="status" className="flex items-start gap-2 rounded-md border border-line bg-paper-2 px-3 py-2 text-xs text-ink-2">
					<span className="flex-1">{note}</span>
					<button type="button" aria-label="Dismiss" className="text-ink-4 hover:text-ink" onClick={() => setNote(undefined)}>
						<X className="h-3.5 w-3.5" />
					</button>
				</div>
			) : null}

			{data ? (
				<>
					<div className="rounded-md border border-line bg-paper-2 px-3 py-2 font-mono text-2xs text-ink-3">
						<div>user: {data.userConfigPath}</div>
						<div>project: {data.projectConfigPath}{data.projectConfigEnabled ? "" : " (mcp.enableProjectConfig is off; new chats ignore it)"}</div>
						<div>workspace: {data.cwd}</div>
						<div>{data.servers.length} server{data.servers.length === 1 ? "" : "s"}</div>
					</div>
					{data.warnings.map(warning => (
						<p key={warning} className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 font-mono text-2xs text-warn">{warning}</p>
					))}

					{adding ? (
						<div className="overflow-hidden rounded-md border border-accent/40 bg-paper">
							<div className="border-b border-line bg-paper-2 px-3 py-2"><div className="meta">New server</div></div>
							<Editor
								draft={adding}
								nameEditable
								scopeEditable
								onCancel={() => setAdding(null)}
								onSubmit={async draft => report(await mcpServersApi.create({
									name: draft.name.trim(),
									scope: draft.scope,
									...writeBody(draft),
								}))}
							/>
						</div>
					) : null}

					{groups.map(group => (
						<div key={group.level} className="overflow-hidden rounded-md border border-line bg-paper">
							<div className="border-b border-line bg-paper-2 px-3 py-2">
								<div className="meta">{group.level === "native" ? "Built in" : `${group.level} scope`}</div>
							</div>
							<div className="divide-y divide-line">
								{group.rows.map(row => (
									<ServerRow
										key={`${row.sourcePath}:${row.name}`}
										row={row}
										editing={editing === `${row.sourcePath}:${row.name}`}
										onEdit={() => { setEditing(`${row.sourcePath}:${row.name}`); setAdding(null); }}
										onCancel={() => setEditing(null)}
										onResult={report}
										onError={message => setError(message)}
									/>
								))}
							</div>
						</div>
					))}
					{data.servers.length === 0 ? <div className="text-sm text-ink-3">No MCP server is configured.</div> : null}
				</>
			) : error ? null : <div className="text-sm text-ink-3">Loading...</div>}
		</div>
	);
}

function writeBody(draft: Draft) {
	const args = draft.args.split("\n").map(line => line.trim()).filter(line => line !== "");
	const timeout = draft.timeout.trim() === "" ? null : Number(draft.timeout);
	return {
		...(draft.sourcePath !== undefined ? { sourcePath: draft.sourcePath } : {}),
		transport: draft.transport,
		...(draft.transport === "stdio"
			? { command: draft.command.trim(), args, cwd: draft.cwd.trim(), env: inputsOf(draft.env) }
			: { url: draft.url.trim(), headers: inputsOf(draft.headers) }),
		timeout,
	};
}

function ServerRow({ row, editing, onEdit, onCancel, onResult, onError }: {
	row: McpServerRow;
	editing: boolean;
	onEdit: () => void;
	onCancel: () => void;
	onResult: (result: McpServerMutationResponse) => Promise<void>;
	onError: (message: string) => void;
}) {
	const [busy, setBusy] = useState(false);

	async function run(action: () => Promise<McpServerMutationResponse>): Promise<void> {
		setBusy(true);
		try { await onResult(await action()); }
		catch (err) { onError(err instanceof Error ? err.message : String(err)); }
		finally { setBusy(false); }
	}

	const target = { scope: row.scope ?? "user", ...(row.scope !== undefined ? { sourcePath: row.sourcePath } : {}) };
	return (
		<div className="space-y-2 px-3 py-3 text-sm">
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="font-medium text-ink">{row.name}</span>
				<Badge tone="muted">{row.transport}</Badge>
				<Badge tone={row.state === "enabled" ? "success" : row.state === "shadowed" ? "warn" : "muted"}>{row.state}</Badge>
				{row.forceEnabled ? <Badge tone="accent" title="Listed in the user enabledServers allowlist">forced on</Badge> : null}
				{row.editable ? null : <Badge tone="warn" title="NeoPi's writer does not own this file">read-only file</Badge>}
			</div>
			<div className="break-all font-mono text-2xs text-ink-4">
				{row.transport === "stdio"
					? [row.command, ...(row.args ?? [])].filter(Boolean).join(" ") || "(no command)"
					: row.url ?? "(no url)"}
			</div>
			<div className="break-all font-mono text-2xs text-ink-4">{row.providerName || row.provider} · {row.sourcePath}</div>
			{row.cwd ? <div className="break-all font-mono text-2xs text-ink-4">cwd {row.cwd}</div> : null}
			{row.timeout !== undefined ? <div className="font-mono text-2xs text-ink-4">timeout {row.timeout} ms</div> : null}
			<KeyList label="env" entries={row.env} />
			<KeyList label="headers" entries={row.headers} />
			{row.disabledReason ? <p className="text-xs text-ink-3">{DISABLED_REASON[row.disabledReason]}</p> : null}

			{editing ? (
				<Editor
					draft={draftOf(row)}
					onCancel={onCancel}
					onSubmit={async draft => { await run(() => mcpServersApi.update(row.name, { scope: draft.scope, ...writeBody(draft) })); }}
				/>
			) : (
				<div className="flex flex-wrap items-center gap-2 pt-1">
					<Button
						variant="outline"
						size="sm"
						disabled={busy || row.state === "shadowed"}
						title={row.state === "shadowed" ? "A higher-priority source owns this name" : undefined}
						onClick={() => void run(() => mcpServersApi.setEnabled(row.name, { ...target, enabled: row.state !== "enabled" }))}
					>
						{row.state === "enabled" ? "Disable" : "Enable"}
					</Button>
					{row.editable ? (
						<>
							<Button variant="outline" size="sm" disabled={busy} onClick={onEdit}>Edit</Button>
							<Button
								variant="danger"
								size="sm"
								disabled={busy}
								onClick={() => void run(() => mcpServersApi.remove(row.name, target))}
							>
								<Trash2 className="h-3.5 w-3.5" />
								Remove
							</Button>
						</>
					) : (
						<span className="text-2xs text-ink-4">Edit it where it lives; the deck never rewrites another tool's config.</span>
					)}
				</div>
			)}
		</div>
	);
}

function KeyList({ label, entries }: { label: string; entries: McpKeyValue[] }) {
	if (entries.length === 0) return null;
	return (
		<div className="flex flex-wrap items-center gap-1 font-mono text-2xs text-ink-4">
			<span className="uppercase tracking-meta">{label}</span>
			{entries.map(entry => (
				<span key={entry.key} className={cn("rounded px-1", entry.masked ? "bg-danger/10 text-danger" : "bg-paper-3")}>
					{entry.key}={entry.masked ? "••••••" : entry.value}
				</span>
			))}
		</div>
	);
}

function Editor({ draft: initial, nameEditable, scopeEditable, onCancel, onSubmit }: {
	draft: Draft;
	nameEditable?: boolean;
	scopeEditable?: boolean;
	onCancel: () => void;
	onSubmit: (draft: Draft) => Promise<void>;
}) {
	const [draft, setDraft] = useState(initial);
	const [busy, setBusy] = useState(false);
	const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
	const pairs = draft.transport === "stdio" ? draft.env : draft.headers;
	const pairsKey: "env" | "headers" = draft.transport === "stdio" ? "env" : "headers";

	return (
		<div className="space-y-3 border-t border-line bg-paper-2 px-3 py-3">
			<div className="grid gap-3 sm:grid-cols-2">
				{nameEditable ? (
					<Field label="Name">
						<input value={draft.name} onChange={e => set("name", e.target.value)} className={inputClass} placeholder="my-server" />
					</Field>
				) : null}
				{scopeEditable ? (
					<Field label="Scope">
						<select value={draft.scope} onChange={e => set("scope", e.target.value as McpServerScope)} className={inputClass}>
							<option value="user">user (~/.omp mcp.json)</option>
							<option value="project">project (.omp/mcp.json)</option>
						</select>
					</Field>
				) : null}
				<Field label="Transport">
					<select value={draft.transport} onChange={e => set("transport", e.target.value as McpTransport)} className={inputClass}>
						<option value="stdio">stdio</option>
						<option value="http">http</option>
						<option value="sse">sse</option>
					</select>
				</Field>
				<Field label="Timeout (ms, blank for NeoPi's default)">
					<input value={draft.timeout} onChange={e => set("timeout", e.target.value)} className={inputClass} inputMode="numeric" />
				</Field>
			</div>

			{draft.transport === "stdio" ? (
				<div className="grid gap-3 sm:grid-cols-2">
					<Field label="Command">
						<input value={draft.command} onChange={e => set("command", e.target.value)} className={inputClass} placeholder="bunx" />
					</Field>
					<Field label="Working directory (optional)">
						<input value={draft.cwd} onChange={e => set("cwd", e.target.value)} className={inputClass} />
					</Field>
					<Field label="Arguments (one per line)">
						<textarea value={draft.args} onChange={e => set("args", e.target.value)} rows={3} className={cn(inputClass, "h-auto py-1 font-mono")} />
					</Field>
				</div>
			) : (
				<Field label="URL">
					<input value={draft.url} onChange={e => set("url", e.target.value)} className={inputClass} placeholder="https://example.com/mcp" />
				</Field>
			)}

			<div className="space-y-1">
				<div className="meta">{pairsKey}</div>
				{pairs.map((pair, index) => (
					<div key={index} className="flex flex-wrap items-center gap-2">
						<input
							value={pair.key}
							onChange={e => set(pairsKey, pairs.map((p, i) => i === index ? { ...p, key: e.target.value } : p))}
							className={cn(inputClass, "w-48 font-mono")}
							placeholder="NAME"
						/>
						<input
							value={pair.stored ? "" : pair.value}
							onChange={e => set(pairsKey, pairs.map((p, i) => i === index ? { ...p, value: e.target.value, stored: false } : p))}
							className={cn(inputClass, "min-w-0 flex-1 font-mono")}
							placeholder={pair.stored ? "•••••• kept as stored — type to replace" : "value"}
						/>
						{pair.stored ? <Badge tone="danger" title="The stored value is kept; this page never receives it">kept</Badge> : null}
						<button
							type="button"
							aria-label={`Remove ${pair.key || "entry"}`}
							className="text-ink-4 hover:text-danger"
							onClick={() => set(pairsKey, pairs.filter((_, i) => i !== index))}
						>
							<X className="h-3.5 w-3.5" />
						</button>
					</div>
				))}
				<Button variant="ghost" size="sm" onClick={() => set(pairsKey, [...pairs, { key: "", value: "", stored: false }])}>
					<Plus className="h-3.5 w-3.5" />
					Add {pairsKey === "env" ? "variable" : "header"}
				</Button>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="primary"
					size="sm"
					disabled={busy}
					onClick={() => {
						setBusy(true);
						void onSubmit(draft).finally(() => setBusy(false));
					}}
				>
					<Save className="h-3.5 w-3.5" />
					Save
				</Button>
				<Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>
				<span className="text-2xs text-ink-4">Saving writes the config file, then reconciles each live chat.</span>
			</div>
		</div>
	);
}

const inputClass = "h-8 w-full rounded-md border border-line bg-paper px-2 text-sm outline-none focus:border-accent";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<label className="block space-y-1">
			<div className="meta">{label}</div>
			{children}
		</label>
	);
}
