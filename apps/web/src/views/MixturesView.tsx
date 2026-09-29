import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useSearchParams } from "react-router-dom";
import type {
	MixtureDefinition,
	MixtureDefinitionReport,
	MixtureDraftResponse,
	MixtureEdge,
	MixtureMember,
	MixtureScope,
	MixtureTransit,
	MixturesDocument,
	MixturesResponse,
} from "@npi-deck/protocol";
import { Layout } from "@/components/Layout";
import { Badge } from "@/components/ui/Badge";
import { MixtureGraph, type Positions } from "@/components/mixtures/MixtureGraph";
import { AddMemberForm, ConnectionForm } from "@/components/mixtures/MixtureForms";
import {
	DefinitionFields,
	EdgeFields,
	IssueList,
	JsonDraftContext,
	MemberFields,
	MixtureGatesContext,
	PresetsFields,
} from "@/components/mixtures/MixtureFields";
import {
	edgeIdentity,
	edgeTargets,
	fieldIssues,
	moveItem,
	newDefinition,
	newEdge,
	renameEdge,
	renameMember,
	replaceDefinition,
	structureKey,
	uniqueId,
} from "@/components/mixtures/document";
import { api } from "@/lib/api";
import { MixturesApiError, mixturesApi } from "@/lib/mixtures-api";
import { useStore } from "@/lib/store";

type Tab = "flow" | "list" | "toml";
interface Snapshot {
	doc: MixturesDocument;
	keys: string[][];
}

const blank: MixturesDocument = { mixtures: [] };
const explain = (error: unknown) => (error instanceof Error ? error.message : String(error));
const freshKeys = (doc: MixturesDocument) => doc.mixtures.map(definition => definition.members.map(() => crypto.randomUUID()));
const typing = (target: EventTarget) => target instanceof HTMLElement && !!target.closest("input,textarea,select,[contenteditable]");

export function MixturesView() {
	const [pending, setPending] = useState<Record<string, boolean>>({});
	const report = useCallback(
		(id: string, active: boolean) =>
			setPending(previous => {
				if (!!previous[id] === active) return previous;
				const next = { ...previous };
				if (active) next[id] = true;
				else delete next[id];
				return next;
			}),
		[],
	);
	return (
		<JsonDraftContext.Provider value={report}>
			<MixturesEditor jsonPending={Object.keys(pending).length > 0} />
		</JsonDraftContext.Provider>
	);
}

/** Whether a definition is runnable, refused by the gate, or otherwise invalid. */
function StatusBadge({ report }: { report?: MixtureDefinitionReport }) {
	if (!report) return <Badge tone="muted">validating</Badge>;
	if (report.runnable) return <Badge tone="success">runnable</Badge>;
	if (report.unsupported.length) return <Badge tone="warn">not runnable on this backend</Badge>;
	return <Badge tone="danger">{report.errors.length} error{report.errors.length === 1 ? "" : "s"}</Badge>;
}

function MixturesEditor({ jsonPending }: { jsonPending: boolean }) {
	const workspaces = useStore(s => s.workspaces);
	const activeId = useStore(s => s.activeId);
	const sessions = useStore(s => s.sessionsById);
	const [params] = useSearchParams();
	const wanted = params.get("name") ?? undefined;
	const [cwd, setCwd] = useState(() => sessions[activeId ?? ""]?.cwd ?? "");
	const currentCwd = cwd || workspaces[0]?.cwd || "";
	const [scope, setScope] = useState<MixtureScope>("project");
	const [loaded, setLoaded] = useState<MixturesResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [doc, setDoc] = useState<MixturesDocument>(blank);
	const [keys, setKeys] = useState<string[][]>([]);
	const [index, setIndex] = useState(-1);
	const [tab, setTab] = useState<Tab>("flow");
	const [selection, setSelection] = useState<string | null>(null);
	const [source, setSource] = useState("");
	const [sourceDirty, setSourceDirty] = useState(false);
	/** The graph revision the TOML text draft started from; discarding the text returns to it. */
	const [sourceBase, setSourceBase] = useState(0);
	const [revision, setRevision] = useState(0);
	const [savedRevision, setSavedRevision] = useState(0);
	const [draft, setDraft] = useState<{ revision: number; result: MixtureDraftResponse } | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [saving, setSaving] = useState(false);
	const [form, setForm] = useState<"none" | "connect" | "member">("none");
	const [models, setModels] = useState<string[]>([]);
	const [past, setPast] = useState<Snapshot[]>([]);
	const [future, setFuture] = useState<Snapshot[]>([]);
	const sequence = useRef(0);
	const loadEpoch = useRef(0);

	const dirty = revision !== savedRevision || sourceDirty || jsonPending;
	const blocker = useBlocker(dirty);
	useEffect(() => {
		if (blocker.state !== "blocked") return;
		if (window.confirm("Discard your unsaved mixture edits and leave?")) blocker.proceed();
		else blocker.reset();
	}, [blocker]);
	useEffect(() => {
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (!dirty) return;
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", beforeUnload);
		return () => window.removeEventListener("beforeunload", beforeUnload);
	}, [dirty]);

	const scopeDoc = loaded?.[scope];
	const definition = doc.mixtures[index];
	const current = draft?.revision === revision ? draft.result : null;
	// Graph validation: the draft's, or the loaded file's while nothing changed.
	const reports = sourceDirty ? undefined : (current?.validation ?? (revision === savedRevision ? scopeDoc?.validation : undefined));
	const report = reports?.[index];
	const gates = useMemo(
		() => new Map((loaded?.capabilities.gates ?? []).filter(gate => gate.gated).map(gate => [gate.feature, gate.message ?? ""] as const)),
		[loaded],
	);
	const selectedMemberIndex = selection?.startsWith("member:") ? Number(selection.slice(7)) : -1;
	const selectedEdgeIndex = selection?.startsWith("edge:") ? Number(selection.slice(5)) : -1;
	const selectedMember = definition?.members[selectedMemberIndex];
	const selectedEdge = definition?.edges[selectedEdgeIndex];

	// Layout is not part of MIXTURES.toml; it stays in this browser.
	const layoutKey = `npi-mixture-layout:${loaded?.cwd ?? currentCwd}:${scope}:${definition?.name ?? ""}`;
	const [positions, setPositions] = useState<Positions>({});
	useEffect(() => {
		try {
			setPositions(JSON.parse(localStorage.getItem(layoutKey) ?? "{}") as Positions);
		} catch {
			setPositions({});
		}
	}, [layoutKey]);
	function updatePositions(next: Positions) {
		setPositions(next);
		localStorage.setItem(layoutKey, JSON.stringify(next));
	}

	function accept(value: MixturesResponse, nextScope: MixtureScope, chosen?: string) {
		const nextDoc = structuredClone(value[nextScope].doc);
		const found = nextDoc.mixtures.findIndex(mixture => mixture.name === chosen);
		const rev = ++sequence.current;
		setLoaded(value);
		setDoc(nextDoc);
		setKeys(freshKeys(nextDoc));
		setIndex(nextDoc.mixtures.length ? Math.max(0, found) : -1);
		setSource(value[nextScope].toml);
		setSourceDirty(false);
		setDraft(null);
		setRevision(rev);
		setSavedRevision(rev);
		setSelection(null);
		setPast([]);
		setFuture([]);
		setForm("none");
	}

	async function load(workspace: string, chosen?: string, targetScope: MixtureScope = scope) {
		const epoch = ++loadEpoch.current;
		setLoading(true);
		setError("");
		try {
			const value = await mixturesApi.load(workspace);
			if (epoch !== loadEpoch.current) return;
			accept(value, targetScope, chosen);
		} catch (reason) {
			if (epoch === loadEpoch.current) setError(`Could not load MIXTURES.toml: ${explain(reason)}`);
		} finally {
			if (epoch === loadEpoch.current) setLoading(false);
		}
	}
	useEffect(() => {
		if (currentCwd) void load(currentCwd, wanted);
		// Reload only when the workspace changes; scope switches reuse the loaded response.
	}, [currentCwd]);

	useEffect(() => {
		const controller = new AbortController();
		api
			.listModels()
			.then(result => {
				if (!controller.signal.aborted)
					setModels(result.models.filter(model => !model.isMixture && model.isAvailable).map(model => `${model.provider}/${model.id}`));
			})
			.catch(reason => {
				if (!controller.signal.aborted) setError(`Model suggestions unavailable: ${explain(reason)}`);
			});
		return () => controller.abort();
	}, [currentCwd]);

	// NeoPi validates every edit: the draft endpoint parses, resolves and gate-checks it.
	useEffect(() => {
		if (!loaded || loading) return;
		if (!sourceDirty && revision === savedRevision) return;
		const controller = new AbortController();
		const at = revision;
		const timer = window.setTimeout(() => {
			mixturesApi
				.draft({ cwd: loaded.cwd, input: sourceDirty ? { kind: "toml", text: source } : { kind: "document", doc } }, controller.signal)
				.then(result => {
					if (!controller.signal.aborted) setDraft({ revision: at, result });
				})
				.catch(reason => {
					if (!controller.signal.aborted) setError(`Validation unavailable: ${explain(reason)}`);
				});
		}, 250);
		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [loaded, loading, doc, source, sourceDirty, revision, savedRevision]);

	function commit(next: MixturesDocument, nextKeys: string[][] = keys) {
		setPast(previous => [...previous.slice(-49), { doc, keys }]);
		setFuture([]);
		setDoc(next);
		setKeys(nextKeys);
		setRevision(++sequence.current);
		setNotice("");
	}
	function restore(snapshot: Snapshot) {
		setDoc(snapshot.doc);
		setKeys(snapshot.keys);
		setRevision(++sequence.current);
		setSelection(null);
	}
	function undo() {
		const previous = past.at(-1);
		if (!previous || sourceDirty) return;
		setFuture(items => [{ doc, keys }, ...items]);
		setPast(items => items.slice(0, -1));
		restore(previous);
	}
	function redo() {
		const next = future[0];
		if (!next || sourceDirty) return;
		setPast(items => [...items, { doc, keys }]);
		setFuture(items => items.slice(1));
		restore(next);
	}

	const editable = !!definition && !sourceDirty && !loading && !jsonPending && !saving;
	function updateDefinition(next: MixtureDefinition, nextKeys?: string[][]) {
		commit(replaceDefinition(doc, index, next), nextKeys);
	}
	function updateMember(memberIndex: number, next: MixtureMember) {
		if (definition) updateDefinition({ ...definition, members: definition.members.map((member, i) => (i === memberIndex ? next : member)) });
	}
	function addMember(member: MixtureMember) {
		if (!definition) return;
		const nextKeys = keys.map((list, i) => (i === index ? [...list, crypto.randomUUID()] : list));
		updateDefinition({ ...definition, entry: definition.entry || (member.kind === "verdict" ? "" : member.id), members: [...definition.members, member] }, nextKeys);
		setSelection(`member:${definition.members.length}`);
		setForm("none");
	}
	function addVerdict() {
		if (!definition) return;
		addMember({ kind: "verdict", id: uniqueId("verdict", definition.members.map(member => member.id)), question: { type: "noul", instructions: "" } });
	}
	function moveMember(memberIndex: number, delta: number) {
		if (!definition) return;
		const nextKeys = keys.map((list, i) => (i === index ? moveItem(list, memberIndex, delta) : list));
		updateDefinition({ ...definition, members: moveItem(definition.members, memberIndex, delta) }, nextKeys);
		setSelection(`member:${memberIndex + delta}`);
	}
	function removeMember(memberIndex: number) {
		const member = definition?.members[memberIndex];
		if (!definition || !member) return;
		const references = definition.edges.filter(edge => edge.from === member.id || edgeTargets(edge).includes(member.id)).map(edgeIdentity);
		if (!window.confirm(`Delete member ${member.id}?${references.length ? ` Connections that still name it: ${references.join(", ")}.` : ""}`)) return;
		const nextKeys = keys.map((list, i) => (i === index ? list.filter((_, j) => j !== memberIndex) : list));
		updateDefinition({ ...definition, members: definition.members.filter((_, i) => i !== memberIndex) }, nextKeys);
		setSelection(null);
	}
	function renameSelected(memberIndex: number, name: string) {
		if (!definition?.members[memberIndex]) return;
		const before = definition.members[memberIndex].id;
		if (before === name) return;
		if (positions[before]) {
			const layout = { ...positions, [name]: positions[before] };
			delete layout[before];
			updatePositions(layout);
		}
		updateDefinition(renameMember(definition, memberIndex, name));
	}
	function addEdge(from: string, to: string, transit?: MixtureTransit) {
		if (!definition || !editable) return;
		updateDefinition({ ...definition, edges: [...definition.edges, { ...newEdge(from, to), ...(transit ? { x: transit } : {}) }] });
		setSelection(`edge:${definition.edges.length}`);
		setForm("none");
	}
	function updateEdge(edgeIndex: number, next: MixtureEdge) {
		if (definition) updateDefinition(renameEdge(definition, edgeIndex, next));
	}
	function removeEdge(edgeIndex: number) {
		const edge = definition?.edges[edgeIndex];
		if (!definition || !edge) return;
		if (!window.confirm(`Delete connection ${edgeIdentity(edge)}?`)) return;
		updateDefinition({ ...definition, edges: definition.edges.filter((_, i) => i !== edgeIndex) });
		setSelection(null);
	}
	function addMixture() {
		const name = uniqueId("mixture", doc.mixtures.map(item => item.name));
		commit({ ...doc, mixtures: [...doc.mixtures, newDefinition(name)] }, [...keys, []]);
		setIndex(doc.mixtures.length);
		setSelection(null);
	}
	function removeMixture() {
		if (!definition || !window.confirm(`Delete ${definition.name} from this file? Nothing is written until you save.`)) return;
		commit({ ...doc, mixtures: doc.mixtures.filter((_, i) => i !== index) }, keys.filter((_, i) => i !== index));
		setIndex(doc.mixtures.length > 1 ? Math.min(index, doc.mixtures.length - 2) : -1);
		setSelection(null);
	}
	function copyFromOtherScope(item: MixtureDefinition) {
		if (doc.mixtures.some(mixture => mixture.name === item.name) && !window.confirm(`Replace ${item.name} in this draft?`)) return;
		const next = { ...doc, mixtures: [...doc.mixtures.filter(mixture => mixture.name !== item.name), structuredClone(item)] };
		commit(next, freshKeys(next));
		setIndex(next.mixtures.length - 1);
	}
	function changeScope(next: MixtureScope) {
		if (next === scope || !loaded) return;
		if (dirty && !window.confirm("Discard your unsaved edits and switch scope?")) return;
		setScope(next);
		accept(loaded, next);
	}
	function changeWorkspace(next: string) {
		if (next === currentCwd) return;
		if (dirty && !window.confirm("Discard your unsaved edits and switch workspace?")) return;
		setLoaded(null);
		setDoc(blank);
		setIndex(-1);
		setCwd(next);
	}
	function applySource() {
		if (!sourceDirty || !current || current.parseDiagnostics.some(message => message.startsWith("Invalid TOML"))) return;
		const next = structuredClone(current.doc);
		const { warnings: _warnings, ...clean } = next;
		commit(clean, freshKeys(clean));
		setIndex(clean.mixtures.length ? 0 : -1);
		setSourceDirty(false);
		setSelection(null);
		setNotice("The graph now holds the parsed TOML. Save to write it.");
	}

	// The server's rule: a definition with errors blocks saving unless it is unchanged from the file.
	const onDisk = useMemo(() => new Map((scopeDoc?.doc.mixtures ?? []).map(mixture => [mixture.name, structureKey(mixture)] as const)), [scopeDoc]);
	const blocked = (reports ?? []).filter(item => !item.runnable && onDisk.get(item.name) !== structureKey(doc.mixtures[item.index]));
	const lossy = current?.parseDiagnostics.some(message => message.includes("would change or omit")) ?? false;
	const saveBlockers = [
		!loaded?.capabilities.persistence ? "this backend cannot save mixtures" : "",
		sourceDirty ? "apply or discard the TOML text first" : "",
		jsonPending ? "fix the invalid JSON field" : "",
		dirty && !reports ? "waiting for NeoPi's validation" : "",
		blocked.length ? `NeoPi refuses ${blocked.map(item => item.name || "(unnamed)").join(", ")} (fix or revert them)` : "",
		lossy ? "NeoPi cannot represent this draft without changing it" : "",
	].filter(Boolean);
	const canSave = dirty && !saving && !loading && saveBlockers.length === 0;

	async function save(confirmCanonicalRewrite = false) {
		if (!loaded || (!canSave && !confirmCanonicalRewrite)) return;
		setSaving(true);
		setError("");
		setNotice("");
		try {
			const result = await mixturesApi.save({ cwd: loaded.cwd, scope, doc, baseHash: loaded[scope].hash, ...(confirmCanonicalRewrite ? { confirmCanonicalRewrite: true } : {}) });
			accept({ ...loaded, [scope]: result.scope, picker: result.picker }, scope, definition?.name);
			const listed = result.scope.validation.filter(item => item.runnable && result.picker.includes(item.name)).map(item => `mixture/${item.name}`);
			setNotice(`Saved ${result.scope.path}. ${listed.length ? `The model picker lists ${listed.join(", ")}.` : "No definition in this file is registered in the picker."}`);
		} catch (reason) {
			if (reason instanceof MixturesApiError && reason.status === 409 && reason.details.code === "rewrite-loses-source") {
				const diagnostics = Array.isArray(reason.details.parseDiagnostics) ? reason.details.parseDiagnostics.join("\n") : "";
				setSaving(false);
				if (window.confirm(`${reason.message}.\n\n${diagnostics}\n\nSave NeoPi's canonical form anyway?`)) await save(true);
				return;
			}
			const suffix = reason instanceof MixturesApiError && reason.status === 409 ? " Your edits are kept here; reload to see the file, then reapply them." : "";
			setError(`Not saved: ${explain(reason)}.${suffix}`);
		} finally {
			setSaving(false);
		}
	}

	// Shortcuts work wherever focus is on this page (body included), except undo/redo inside text fields.
	const shortcuts = useRef<(event: globalThis.KeyboardEvent) => void>(() => {});
	shortcuts.current = event => {
		const mod = event.ctrlKey || event.metaKey;
		if (!mod) return;
		const key = event.key.toLowerCase();
		if (key === "s") {
			event.preventDefault();
			void save();
			return;
		}
		if (event.target && typing(event.target)) return;
		if (key === "z" && !event.shiftKey) {
			event.preventDefault();
			undo();
		} else if (key === "y" || (key === "z" && event.shiftKey)) {
			event.preventDefault();
			redo();
		}
	};
	useEffect(() => {
		const listener = (event: globalThis.KeyboardEvent) => shortcuts.current(event);
		window.addEventListener("keydown", listener);
		return () => window.removeEventListener("keydown", listener);
	}, []);

	const otherScope: MixtureScope = scope === "project" ? "user" : "project";
	const sidebar = (
		<aside className="h-full overflow-y-auto p-4 text-sm">
			<h2 className="mb-4 text-lg font-semibold">Mixtures</h2>
			<label className="block">
				Workspace
				<select className="field mt-1 w-full p-2" value={currentCwd} onChange={event => changeWorkspace(event.target.value)}>
					{workspaces.map(workspace => (
						<option key={workspace.cwd} value={workspace.cwd}>
							{workspace.label} — {workspace.cwd}
						</option>
					))}
				</select>
			</label>
			<div className="mt-4 flex gap-2" role="group" aria-label="MIXTURES.toml scope">
				{(["project", "user"] as const).map(value => (
					<button key={value} type="button" aria-pressed={scope === value} className={scope === value ? "btn-primary px-3 py-2" : "btn-ghost px-3 py-2"} onClick={() => changeScope(value)}>
						{value === "project" ? "Project" : "User"}
					</button>
				))}
			</div>
			<p className="mt-3 break-all font-mono text-xs text-ink-3">{scopeDoc?.path ?? (loading ? "Loading…" : "Choose a workspace")}</p>
			<h3 className="mt-5 font-semibold">In this file</h3>
			<ul className="mt-1 space-y-1">
				{doc.mixtures.map((item, i) => (
					<li key={i}>
						<button
							type="button"
							aria-current={index === i}
							className={`block w-full rounded px-2 py-2 text-left ${index === i ? "bg-accent-soft text-ink" : "hover:bg-paper-3"}`}
							onClick={() => {
								setIndex(i);
								setSelection(null);
							}}
						>
							<span className="block font-medium">{item.name || "Unnamed mixture"}</span>
							<span className="mt-1 flex flex-wrap gap-1">
								<StatusBadge report={reports?.[i]} />
								{loaded?.picker.includes(item.name) && revision === savedRevision ? <Badge tone="accent">in picker</Badge> : null}
							</span>
						</button>
					</li>
				))}
			</ul>
			{!loading && !doc.mixtures.length ? <p className="mt-2 text-ink-3">No mixtures in this file yet.</p> : null}
			<button type="button" disabled={!loaded || loading || sourceDirty || jsonPending} className="btn-ghost mt-3 w-full p-2" onClick={addMixture}>
				Add mixture
			</button>
			{loaded?.[otherScope].doc.mixtures.length ? (
				<>
					<h3 className="mt-7 font-semibold">In the {otherScope} file</h3>
					{loaded[otherScope].doc.mixtures.map((item, i) => (
						<div key={`${item.name}:${i}`} className="mt-3 border-t border-line pt-2">
							<p className="font-semibold">{item.name}</p>
							<button type="button" disabled={loading || sourceDirty || jsonPending} className="btn-ghost mt-1 px-2 py-1" onClick={() => copyFromOtherScope(item)}>
								Copy into this file
							</button>
						</div>
					))}
				</>
			) : null}
		</aside>
	);

	const main = (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
				<header className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<h1 className="text-xl font-semibold">Mixtures of agents</h1>
						<p className="text-sm text-ink-3">Flowchart, member list and TOML edit the same MIXTURES.toml. NeoPi validates every edit; saving registers runnable mixtures in the model picker.</p>
					</div>
					<div className="flex flex-wrap gap-2">
						<button type="button" className="btn-ghost px-3 py-2" title="Ctrl+Z" disabled={!past.length || sourceDirty || loading} onClick={undo}>
							Undo
						</button>
						<button type="button" className="btn-ghost px-3 py-2" title="Ctrl+Y / Ctrl+Shift+Z" disabled={!future.length || sourceDirty || loading} onClick={redo}>
							Redo
						</button>
						<button
							type="button"
							className="btn-ghost px-3 py-2"
							disabled={!currentCwd || loading}
							onClick={() => {
								if (dirty && !window.confirm("Discard your unsaved edits and reload the file?")) return;
								void load(currentCwd, definition?.name);
							}}
						>
							Reload
						</button>
						<button type="button" className="btn-primary px-3 py-2" title={canSave ? "Ctrl+S" : saveBlockers.join("; ") || "No changes"} disabled={!canSave} onClick={() => void save()}>
							{saving ? "Saving…" : "Save"}
						</button>
					</div>
				</header>
				{loaded?.capabilities.milestone ? (
					<p role="note" className="rounded border border-warn/60 bg-warn/10 p-3 text-sm">
						This NeoPi runs <strong>{loaded.capabilities.milestone}</strong> mixtures. Features marked <Badge tone="warn">not runnable on this backend</Badge> stay visible and editable, but NeoPi refuses to save or register a mixture that uses them; nothing is flattened into a simpler graph.
					</p>
				) : null}
				{loaded?.capabilities.diagnostics.map((message, i) => (
					<p key={i} role="note" className="text-xs text-ink-3">
						{message}
					</p>
				))}
				{scopeDoc?.parseDiagnostics.map((message, i) => (
					<p key={i} role="alert" className="rounded border border-danger p-2 text-sm">
						{message}
					</p>
				))}
				{jsonPending ? (
					<p role="alert" className="rounded border border-danger p-3 text-sm text-danger">
						A JSON field holds invalid text. Fix it before saving or switching editors.
					</p>
				) : null}
				{error ? (
					<p role="alert" className="rounded border border-danger p-3 text-sm text-danger">
						{error}
					</p>
				) : null}
				{notice ? (
					<p role="status" className="rounded border border-line p-3 text-sm">
						{notice}
					</p>
				) : null}
				{dirty && saveBlockers.length ? <p className="text-xs text-ink-3">Save unavailable: {saveBlockers.join("; ")}.</p> : null}

				<div className="flex flex-wrap items-center gap-3 border-b border-line pb-3 text-sm">
					<strong>{definition?.name ?? "No mixture selected"}</strong>
					{definition ? <StatusBadge report={report} /> : null}
					<span className="text-ink-3">{dirty ? "Unsaved changes" : "Saved"}</span>
				</div>
				{!sourceDirty && current?.parseDiagnostics.length ? (
					<div role="alert" className="rounded border border-danger/60 p-3 text-sm">
						<h2 className="mb-1 font-semibold">NeoPi would not keep this draft as shown</h2>
						<ul className="list-disc space-y-1 pl-5 text-xs">
							{current.parseDiagnostics.map((message, i) => (
								<li key={i}>{message}</li>
							))}
						</ul>
					</div>
				) : null}
				{report && !report.runnable ? (
					<div className="rounded border border-line bg-paper-2 p-3">
						<h2 className="mb-1 text-sm font-semibold">Why NeoPi will not run {definition?.name}</h2>
						<IssueList issues={fieldIssues(report, issues => [...issues])} />
					</div>
				) : report?.warnings.length ? (
					<div className="rounded border border-line bg-paper-2 p-3">
						<IssueList issues={fieldIssues(report, issues => [...issues])} />
					</div>
				) : null}

				<div className="flex gap-2 border-b border-line pb-2" role="tablist" aria-label="Mixture representations">
					{(["flow", "list", "toml"] as const).map(value => (
						<button
							key={value}
							type="button"
							role="tab"
							aria-selected={tab === value}
							className={tab === value ? "btn-primary px-3 py-2" : "btn-ghost px-3 py-2"}
							onClick={() => {
								if (value !== tab && jsonPending && !window.confirm("Discard the invalid JSON field?")) return;
								setTab(value);
							}}
						>
							{value === "flow" ? "Flowchart" : value === "list" ? "Members and connections" : "TOML"}
						</button>
					))}
				</div>

				{tab === "toml" ? (
					<TomlTab
						text={sourceDirty ? source : (current?.toml ?? (revision === savedRevision ? (scopeDoc?.toml ?? "") : ""))}
						sourceDirty={sourceDirty}
						// The canonical text of an edited graph arrives with its validation.
						disabled={loading || !loaded || jsonPending || (!sourceDirty && revision !== savedRevision && !current)}
						draft={sourceDirty ? current : null}
						onChange={text => {
							if (!sourceDirty) setSourceBase(revision);
							setSource(text);
							setSourceDirty(true);
							setRevision(++sequence.current);
						}}
						onApply={applySource}
						onDiscard={() => {
							setSourceDirty(false);
							setRevision(sourceBase);
						}}
					/>
				) : definition ? (
					<div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
						<div className="min-w-0 space-y-4">
							{tab === "flow" ? (
								<>
									<div className="h-[480px] overflow-hidden rounded border border-line-strong bg-paper-2">
										<MixtureGraph
											definition={definition}
											keys={keys[index] ?? []}
											report={report}
											selected={selection}
											positionsById={positions}
											onPositions={updatePositions}
											onSelect={setSelection}
											onConnect={(from, to) => addEdge(from, to)}
										/>
									</div>
									<p className="text-xs text-ink-3">
										Keyboard: Tab to a member, Enter to select it, arrow keys to move it. Connect members with the form below instead of dragging between handles. Positions are kept in this browser, not in the file.
									</p>
								</>
							) : null}
							<MemberList
								definition={definition}
								keys={keys[index] ?? []}
								reports={report}
								editable={editable}
								onSelect={setSelection}
								onEntry={id => updateDefinition({ ...definition, entry: id })}
								onMove={moveMember}
								onRemove={removeMember}
								onAdd={() => setForm("member")}
								onAddVerdict={addVerdict}
							/>
							{form === "member" ? (
								<AddMemberForm suggestedId={uniqueId("member", definition.members.map(member => member.id))} models={models} onAdd={addMember} onCancel={() => setForm("none")} />
							) : null}
							<EdgeList definition={definition} report={report} editable={editable} onSelect={setSelection} onRemove={removeEdge} onAdd={() => setForm("connect")} />
							{form === "connect" && definition.members.length ? (
								<ConnectionForm members={definition.members} onConnect={addEdge} onCancel={() => setForm("none")} />
							) : null}
							<button type="button" className="btn-ghost border border-danger px-3 py-2 text-danger" disabled={!editable} onClick={removeMixture}>
								Delete this mixture
							</button>
						</div>
						<aside className="min-w-0 rounded border border-line bg-paper-2 p-4 xl:max-h-[80vh] xl:overflow-y-auto" aria-label="Selected item">
							<fieldset disabled={sourceDirty || loading || saving} className="space-y-5">
								<div key={`${currentCwd}:${scope}:${index}:${selection ?? "mixture"}`}>
									{selectedMember ? (
										<MemberFields
											member={selectedMember}
											index={selectedMemberIndex}
											edgeIds={definition.edges.map(edgeIdentity)}
											models={models}
											report={report}
											onChange={next => updateMember(selectedMemberIndex, next)}
											onRename={name => renameSelected(selectedMemberIndex, name)}
										/>
									) : selectedEdge ? (
										<EdgeFields edge={selectedEdge} index={selectedEdgeIndex} members={definition.members} report={report} onChange={next => updateEdge(selectedEdgeIndex, next)} />
									) : (
										<DefinitionFields definition={definition} report={report} onChange={next => updateDefinition(next)} />
									)}
								</div>
								{selection ? (
									<button type="button" className="btn-ghost px-3 py-2" onClick={() => setSelection(null)}>
										Show mixture settings
									</button>
								) : null}
							</fieldset>
						</aside>
					</div>
				) : (
					<div className="rounded border border-line p-6 text-sm">{loading ? "Loading…" : "Select or add a mixture."}</div>
				)}
				{!sourceDirty && loaded && !loading ? (
					<section key={`${currentCwd}:${scope}`} className="max-w-2xl border-t border-line pt-4">
						<PresetsFields doc={doc} onChange={next => commit(next)} />
					</section>
				) : null}
			</div>
		</div>
	);

	return (
		<MixtureGatesContext.Provider value={gates}>
			<Layout sidebar={sidebar} inspector={null} main={main} />
		</MixtureGatesContext.Provider>
	);
}

function MemberList({
	definition,
	keys,
	reports,
	editable,
	onSelect,
	onEntry,
	onMove,
	onRemove,
	onAdd,
	onAddVerdict,
}: {
	definition: MixtureDefinition;
	keys: string[];
	reports?: MixtureDefinitionReport;
	editable: boolean;
	onSelect: (selection: string) => void;
	onEntry: (id: string) => void;
	onMove: (index: number, delta: number) => void;
	onRemove: (index: number) => void;
	onAdd: () => void;
	onAddVerdict: () => void;
}) {
	return (
		<section className="space-y-2" aria-label="Members">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 className="text-base font-semibold">Members</h2>
				<div className="flex gap-2">
					<button type="button" className="btn-ghost px-3 py-2" disabled={!editable} onClick={onAdd}>
						Add model member
					</button>
					<button type="button" className="btn-ghost px-3 py-2" disabled={!editable} onClick={onAddVerdict}>
						Add verdict member
					</button>
				</div>
			</div>
			<ol className="space-y-2">
				{definition.members.map((member, i) => {
					const issues = fieldIssues(reports, list => list.filter(issue => issue.path === `members[${i}]` || issue.path.startsWith(`members[${i}].`)));
					return (
						<li key={keys[i] ?? i} className="flex flex-wrap items-center gap-2 rounded border border-line p-2 text-sm">
							<button type="button" className="btn-ghost min-w-0 flex-1 truncate px-2 py-2 text-left" onClick={() => onSelect(`member:${i}`)}>
								{definition.entry === member.id ? "▶ " : ""}
								{member.id} · {member.kind === "verdict" ? `verdict (${member.question.type})` : member.model}
							</button>
							{issues.gated.length ? <Badge tone="warn">not runnable on this backend</Badge> : issues.errors.length ? <Badge tone="danger">{issues.errors.length} error</Badge> : null}
							<button type="button" className="btn-ghost px-2 py-2" disabled={!editable || member.kind === "verdict" || definition.entry === member.id} onClick={() => onEntry(member.id)}>
								Set entry
							</button>
							<button type="button" className="btn-ghost px-2 py-2" aria-label={`Move ${member.id} up`} disabled={!editable || i === 0} onClick={() => onMove(i, -1)}>
								↑
							</button>
							<button type="button" className="btn-ghost px-2 py-2" aria-label={`Move ${member.id} down`} disabled={!editable || i === definition.members.length - 1} onClick={() => onMove(i, 1)}>
								↓
							</button>
							<button type="button" className="btn-ghost px-2 py-2" disabled={!editable} onClick={() => onRemove(i)}>
								Delete
							</button>
						</li>
					);
				})}
			</ol>
			{!definition.members.length ? <p className="text-sm text-ink-3">No members yet.</p> : null}
		</section>
	);
}

function EdgeList({
	definition,
	report,
	editable,
	onSelect,
	onRemove,
	onAdd,
}: {
	definition: MixtureDefinition;
	report?: MixtureDefinitionReport;
	editable: boolean;
	onSelect: (selection: string) => void;
	onRemove: (index: number) => void;
	onAdd: () => void;
}) {
	return (
		<section className="space-y-2" aria-label="Connections">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 className="text-base font-semibold">Connections</h2>
				<button type="button" className="btn-ghost px-3 py-2" disabled={!editable || !definition.members.length} onClick={onAdd}>
					Connect members
				</button>
			</div>
			{definition.edges.map((edge, i) => {
				const issues = fieldIssues(report, list => list.filter(issue => issue.path === `edges[${i}]` || issue.path.startsWith(`edges[${i}].`)));
				return (
					<div key={i} className="flex flex-wrap items-center gap-2 rounded border border-line p-2 text-sm">
						<button type="button" className="btn-ghost min-w-0 flex-1 truncate px-2 py-2 text-left" onClick={() => onSelect(`edge:${i}`)}>
							{edge.from} → {Array.isArray(edge.to) ? `[${edge.to.join(", ")}]` : edge.to} · {Object.keys(edge.x).join(" + ") || "nothing handed on"}
						</button>
						{issues.gated.length ? <Badge tone="warn">not runnable on this backend</Badge> : issues.errors.length ? <Badge tone="danger">{issues.errors.length} error</Badge> : null}
						<button type="button" className="btn-ghost px-2 py-2" disabled={!editable} onClick={() => onRemove(i)}>
							Delete
						</button>
					</div>
				);
			})}
			{!definition.edges.length ? <p className="text-sm text-ink-3">No connections: the entry member answers alone.</p> : null}
		</section>
	);
}

function TomlTab({
	text,
	sourceDirty,
	disabled,
	draft,
	onChange,
	onApply,
	onDiscard,
}: {
	text: string;
	sourceDirty: boolean;
	disabled: boolean;
	draft: MixtureDraftResponse | null;
	onChange: (text: string) => void;
	onApply: () => void;
	onDiscard: () => void;
}) {
	const invalid = draft?.parseDiagnostics.some(message => message.startsWith("Invalid TOML")) ?? true;
	return (
		<section className="space-y-3">
			<p className="text-sm text-ink-3">
				The same document as the flowchart, in NeoPi's canonical TOML. Editing here is a separate draft until you apply it to the graph; saving writes the graph.
			</p>
			<label className="block text-sm">
				MIXTURES.toml
				<textarea className="field mt-2 min-h-[420px] w-full p-3 font-mono text-xs" spellCheck={false} disabled={disabled} value={text} onChange={event => onChange(event.target.value)} />
			</label>
			{draft?.parseDiagnostics.map((message, i) => (
				<p key={i} role="alert" className="text-sm text-danger">
					{message}
				</p>
			))}
			{draft?.validation.map(item => (
				<div key={item.index} className="space-y-1 text-sm">
					<p className="flex items-center gap-2 font-medium">
						{item.name} <StatusBadge report={item} />
					</p>
					<IssueList issues={fieldIssues(item, issues => [...issues])} />
				</div>
			))}
			{sourceDirty ? (
				<div className="flex gap-2">
					<button type="button" className="btn-primary px-3 py-2" disabled={disabled || invalid} onClick={onApply}>
						Apply TOML to the graph
					</button>
					<button type="button" className="btn-ghost px-3 py-2" onClick={onDiscard}>
						Discard TOML edits
					</button>
				</div>
			) : null}
		</section>
	);
}

export default MixturesView;
