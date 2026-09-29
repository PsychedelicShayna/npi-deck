import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import type {
	McpArgInput,
	McpKeyRef,
	McpKeyValueInput,
	McpServerMutationResponse,
	McpServerRow,
	McpServerScope,
	McpServersResponse,
	McpTransport,
} from "@npi-deck/protocol";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { McpServersApiError, mcpServersApi } from "@/lib/mcp-servers-api";
import { cn } from "@/lib/utils";

/** An env or header row being edited; `stored` means "keep the value the file holds". */
type Pair = { key: string; value: string; stored: boolean };
/**
 * One argument row: typed text, or the stored argument at `keepIndex` (a
 * redacted credential). `flag` binds a hidden value to the flag that hides it,
 * so the pair moves and is removed together — the server refuses to write one
 * without the other.
 */
type Arg = { text: string; keepIndex?: number; flag?: string };

interface Draft {
	name: string;
	scope: McpServerScope;
	sourcePath?: string;
	transport: McpTransport;
	command: string;
	args: Arg[];
	cwd: string;
	url: string;
	/** The stored URL holds credentials this page never received; keep it unless the field is edited. */
	urlKept: boolean;
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

/** Values never arrive, so every listed key starts as "keep what is stored". */
const pairsOf = (entries: McpKeyRef[]): Pair[] =>
	entries.map(entry => ({ key: entry.key, value: "", stored: entry.set }));

const inputsOf = (pairs: Pair[]): McpKeyValueInput[] =>
	pairs.filter(pair => pair.key.trim() !== "").map(pair => ({ key: pair.key.trim(), value: pair.stored ? null : pair.value }));

/**
 * Arguments as editable rows. A value hidden only because a `--api-key`-shaped
 * flag precedes it is folded into that flag's row.
 */
function argsOf(row: McpServerRow): Arg[] {
	const out: Arg[] = [];
	(row.args ?? []).forEach((arg, index) => {
		const previous = out[out.length - 1];
		// The server renders exactly this display for a flag's hidden value.
		if (arg.redacted && arg.display === "\u2022\u2022\u2022\u2022\u2022\u2022" && previous?.keepIndex === undefined && previous?.text.startsWith("-")) {
			out[out.length - 1] = { text: previous.text, flag: previous.text, keepIndex: index };
			return;
		}
		out.push(arg.redacted ? { text: arg.display, keepIndex: index } : { text: arg.display });
	});
	return out;
}

const argInputsOf = (args: Arg[]): McpArgInput[] =>
	args.filter(arg => arg.keepIndex !== undefined || arg.text.trim() !== "")
		.flatMap(arg => {
			if (arg.keepIndex === undefined) return [arg.text.trim()];
			return arg.flag === undefined ? [{ keepIndex: arg.keepIndex }] : [arg.flag, { keepIndex: arg.keepIndex }];
		});

function draftOf(row: McpServerRow): Draft {
	return {
		name: row.name,
		scope: row.scope ?? "user",
		...(row.scope !== undefined ? { sourcePath: row.sourcePath } : {}),
		transport: row.transport,
		command: row.command ?? "",
		args: argsOf(row),
		cwd: row.cwd ?? "",
		// A listed URL is only its scheme; the field starts empty and keeps the stored one until typed over.
		url: row.urlRedacted ? "" : row.url ?? "",
		urlKept: row.urlRedacted === true,
		timeout: row.timeout === undefined ? "" : String(row.timeout),
		env: pairsOf(row.env),
		headers: pairsOf(row.headers),
	};
}

const emptyDraft = (scope: McpServerScope): Draft => ({
	name: "", scope, transport: "stdio", command: "", args: [], cwd: "", url: "", urlKept: false, timeout: "", env: [], headers: [],
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

	/**
	 * Every mutation settles here: a rejected save shows in the section's error
	 * bar, never as an unhandled rejection. A 409 means the entry changed since
	 * this page loaded it, so the list reloads and the stale editor closes; the
	 * message stays up so the change can be made again on fresh data.
	 */
	const run = useCallback(async (action: () => Promise<McpServerMutationResponse>): Promise<void> => {
		try {
			setError(undefined);
			await report(await action());
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (err instanceof McpServersApiError && err.status === 409) {
				setEditing(null);
				await refresh();
			}
			setError(message);
		}
	}, [report, refresh]);

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
						never leave the server, URLs are hidden whole, and other arguments are
						masked heuristically (the value after a key- or token-shaped flag). An edit keeps whatever it was not shown.
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
								onSubmit={draft => run(() => mcpServersApi.create({
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
										run={run}
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
	const timeout = draft.timeout.trim() === "" ? null : Number(draft.timeout);
	return {
		...(draft.sourcePath !== undefined ? { sourcePath: draft.sourcePath } : {}),
		transport: draft.transport,
		...(draft.transport === "stdio"
			? { command: draft.command.trim(), args: argInputsOf(draft.args), cwd: draft.cwd.trim(), env: inputsOf(draft.env) }
			// A URL this page only ever saw redacted is kept as stored.
			: { url: draft.urlKept ? null : draft.url.trim(), headers: inputsOf(draft.headers) }),
		timeout,
	};
}

function ServerRow({ row, editing, onEdit, onCancel, run: runAction }: {
	row: McpServerRow;
	editing: boolean;
	onEdit: () => void;
	onCancel: () => void;
	run: (action: () => Promise<McpServerMutationResponse>) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);

	async function run(action: () => Promise<McpServerMutationResponse>): Promise<void> {
		setBusy(true);
		try { await runAction(action); }
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
					? [row.command, ...(row.args ?? []).map(arg => arg.display)].filter(Boolean).join(" ") || "(no command)"
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
					onSubmit={draft => run(() => mcpServersApi.update(row.name, { scope: draft.scope, ...writeBody(draft), revision: row.revision ?? "" }))}
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
								onClick={() => void run(() => mcpServersApi.remove(row.name, { ...target, revision: row.revision ?? "" }))}
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

/** Names only: an env or header value never leaves the server, so the page shows whether one is stored. */
function KeyList({ label, entries }: { label: string; entries: McpKeyRef[] }) {
	if (entries.length === 0) return null;
	return (
		<div className="flex flex-wrap items-center gap-1 font-mono text-2xs text-ink-4">
			<span className="uppercase tracking-meta">{label}</span>
			{entries.map(entry => (
				<span
					key={entry.key}
					title={entry.set ? "A value is stored; it is never sent to this page" : "The config file leaves this key empty"}
					className={cn("rounded px-1", entry.set ? "bg-paper-3" : "bg-warn/10 text-warn")}
				>
					{entry.key}={entry.set ? "\u2022\u2022\u2022\u2022\u2022\u2022" : "(empty)"}
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
					<Field label="Arguments">
						<div className="space-y-1">
							{draft.args.map((arg, index) => (
								<div key={index} className="flex items-center gap-2">
									<input
										value={arg.flag !== undefined ? `${arg.flag} \u2022\u2022\u2022\u2022\u2022\u2022` : arg.text}
										readOnly={arg.keepIndex !== undefined}
										onChange={e => set("args", draft.args.map((a, i) => i === index ? { text: e.target.value } : a))}
										className={cn(inputClass, "min-w-0 flex-1 font-mono", arg.keepIndex !== undefined && "text-ink-4")}
										placeholder="--flag or value"
									/>
									{arg.keepIndex !== undefined ? (
										<Badge
											tone="danger"
											title={arg.flag !== undefined
												? "This flag's value is a credential and stays with it. Remove the row to replace the pair."
												: "This argument carries a credential; it is kept as stored. Remove the row to replace it."}
										>
											kept
										</Badge>
									) : null}
									<button
										type="button"
										aria-label={`Remove argument ${index + 1}`}
										className="text-ink-4 hover:text-danger"
										onClick={() => set("args", draft.args.filter((_, i) => i !== index))}
									>
										<X className="h-3.5 w-3.5" />
									</button>
								</div>
							))}
							<Button variant="ghost" size="sm" onClick={() => set("args", [...draft.args, { text: "" }])}>
								<Plus className="h-3.5 w-3.5" />
								Add argument
							</Button>
						</div>
					</Field>
				</div>
			) : (
				<Field label="URL">
					<input
						value={draft.url}
						onChange={e => setDraft(current => ({ ...current, url: e.target.value, urlKept: false }))}
						className={inputClass}
						placeholder={draft.urlKept ? "\u2022\u2022\u2022\u2022\u2022\u2022 kept as stored \u2014 type to replace" : "https://example.com/mcp"}
					/>
					{draft.urlKept ? (
						<p className="text-2xs text-ink-4">
							Any part of a URL can be a credential, so this page never receives it; the stored URL is kept unless you type a new one.
						</p>
					) : null}
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
