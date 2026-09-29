import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import type { ModelInfo, NpiModelRole, NpiModelRolePool, NpiModelRolesResponse } from "@npi-deck/protocol";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import {
	modelKey,
	parseRoleChoice,
	ROLE_DESCRIPTIONS,
	roleLiveSummary,
	roleModelOptions,
	roleSelector,
	type RoleChoice,
} from "@/lib/model-roles";
import { npiConfigApi } from "@/lib/npi-config-api";
import { cn } from "@/lib/utils";
import { provenanceTone } from "./NpiConfigSection";

const CUSTOM = "__custom__";
const EMPTY_POOL: NpiModelRolePool = { models: [], mixtures: false };

/**
 * Settings → Model roles: which model NeoPi uses for each role. Built-in roles
 * come from the backend's own catalog, custom roles from the config. A save
 * writes only that role's key in the global config file through the NeoPi
 * settings path, so other roles (including ones this deck does not know) stay
 * as they are, and live chats reload.
 */
export function ModelRolesSection() {
	const [data, setData] = useState<NpiModelRolesResponse | null>(null);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [error, setError] = useState<string | undefined>();

	const refresh = useCallback(async () => {
		try {
			const [roles, list] = await Promise.all([npiConfigApi.modelRoles(), api.listModels()]);
			setData(roles);
			setModels(list.models);
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);
	useEffect(() => { void refresh(); }, [refresh]);

	const groups = useMemo(() => {
		if (!data) return [];
		return [
			{ title: "Chat roles", roles: data.roles.filter(role => role.builtin && role.section === "chat") },
			{ title: "Model-kind roles", roles: data.roles.filter(role => role.builtin && role.section === "kind") },
			{ title: "Custom roles", roles: data.roles.filter(role => !role.builtin) },
		].filter(group => group.roles.length > 0);
	}, [data]);

	const locked = data?.setting.lockedReason;
	return (
		<div className="mx-auto max-w-6xl space-y-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h1 className="text-xl font-semibold tracking-tight">Model roles</h1>
					<p className="mt-1 max-w-3xl text-sm text-ink-3">
						The model NeoPi uses for each workload (<span className="font-mono">modelRoles</span>). An unset role follows
						NeoPi's built-in chain. Saving writes that one role to the global config file and reloads live chats; every
						other role, including custom ones, is kept.
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
						<div>{data.roles.length} roles</div>
					</div>
					{locked ? <p role="note" className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">{locked}</p> : null}
					{data.setting.invalidGlobalValue ? (
						<p role="note" className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
							The config file's modelRoles is not a mapping, so NeoPi ignores it. Fix it under Settings → NeoPi before editing roles here.
						</p>
					) : null}
					{groups.map(group => (
						<div key={group.title} className="overflow-hidden rounded-md border border-line bg-paper">
							<div className="border-b border-line bg-paper-2 px-3 py-2">
								<div className="meta">{group.title}</div>
							</div>
							<div className="divide-y divide-line">
								{group.roles.map(role => (
									<RoleRow
										key={role.id}
										role={role}
										pool={data.pools[role.pool] ?? EMPTY_POOL}
										models={models}
										thinkingLevels={data.thinkingLevels}
										cwd={data.cwd}
										disabled={locked !== undefined || data.setting.invalidGlobalValue}
										onSaved={refresh}
									/>
								))}
							</div>
						</div>
					))}
				</>
			) : error ? null : <div className="text-sm text-ink-3">Loading...</div>}
		</div>
	);
}

interface RoleRowProps {
	role: NpiModelRole;
	pool: NpiModelRolePool;
	models: readonly ModelInfo[];
	thinkingLevels: readonly string[];
	cwd: string;
	disabled: boolean;
	onSaved: () => Promise<void>;
}

export function RoleRow({ role, pool, models, thinkingLevels, cwd, disabled, onSaved }: RoleRowProps) {
	const options = useMemo(() => roleModelOptions(models, pool), [models, pool]);
	const listed = useMemo(() => new Set(options.flatMap(group => group.models.map(modelKey))), [options]);
	const initial = useMemo(() => parseRoleChoice(role.value, listed, thinkingLevels), [role.value, listed, thinkingLevels]);
	const [choice, setChoice] = useState<RoleChoice>(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [status, setStatus] = useState<{ text: string; complete: boolean } | undefined>();
	// A reload (or the models arriving) restarts the editor from the saved value.
	const [shown, setShown] = useState(initial);
	if (shown !== initial) {
		setShown(initial);
		setChoice(initial);
	}

	const selector = roleSelector(choice);
	const dirty = selector !== role.value;
	const canSave = !disabled && !busy && dirty && selector !== undefined;

	async function save(): Promise<void> {
		if (selector === undefined) return;
		setBusy(true);
		setError(undefined);
		setStatus(undefined);
		try {
			const result = await npiConfigApi.setEntries("modelRoles", { [role.id]: selector });
			setStatus(roleLiveSummary(result, role.id, selector));
			await onSaved();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	const selectValue = choice.kind === "unset" ? "" : choice.kind === "model" ? choice.model : CUSTOM;
	return (
		<div className="grid grid-cols-1 gap-3 px-3 py-3 text-sm lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
			<div className="min-w-0 space-y-1">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="font-medium text-ink">{role.name}</span>
					<span className="font-mono text-2xs text-ink-4">@{role.id}</span>
					<Badge tone={provenanceTone(role.provenance)} title="Layer supplying this role's selector">{role.provenance === "default" ? "unset" : role.provenance}</Badge>
					{role.builtin ? null : <Badge tone="muted">custom</Badge>}
					{role.hidden ? <Badge tone="muted" title="modelTags hides this role from NeoPi's role carousel">hidden</Badge> : null}
				</div>
				<p className="text-xs text-ink-3">{ROLE_DESCRIPTIONS[role.id] ?? (role.builtin ? "Built-in NeoPi role." : `Custom role from your config; @${role.id} selects it.`)}</p>
				{notes(role, cwd).map(note => <p key={note} className="text-xs text-ink-3">{note}</p>)}
			</div>
			<div className="min-w-0 space-y-2">
				<div className="flex gap-1">
					<select
						aria-label={`Model for ${role.id}`}
						value={selectValue}
						disabled={disabled || busy}
						onChange={e => {
							const next = e.target.value;
							if (next === "") setChoice({ kind: "unset" });
							else if (next === CUSTOM) setChoice({ kind: "custom", text: selector ?? "" });
							else setChoice({ kind: "model", model: next, thinking: choice.kind === "model" ? choice.thinking : "" });
						}}
						className="field h-7 min-w-0 flex-1 px-2 font-mono text-2xs"
					>
						<option value="">Unset (NeoPi's built-in chain)</option>
						{options.map(group => (
							<optgroup key={group.provider} label={group.mixtures ? "mixtures of agents" : group.provider}>
								{group.models.map(model => (
									<option key={modelKey(model)} value={modelKey(model)}>
										{model.label === model.id ? modelKey(model) : `${model.label} (${modelKey(model)})`}
									</option>
								))}
							</optgroup>
						))}
						<option value={CUSTOM}>Custom selector…</option>
					</select>
					{choice.kind === "model" && role.section === "chat" ? (
						<select
							aria-label={`Thinking level for ${role.id}`}
							value={choice.thinking}
							disabled={disabled || busy}
							onChange={e => setChoice({ ...choice, thinking: e.target.value })}
							title="Thinking level suffix (provider/model:level)"
							className="field h-7 w-36 px-2 font-mono text-2xs"
						>
							<option value="">default thinking</option>
							{thinkingLevels.map(level => <option key={level} value={level}>{level}</option>)}
						</select>
					) : null}
				</div>
				{choice.kind === "custom" ? (
					<input
						aria-label={`Selector for ${role.id}`}
						value={choice.text}
						disabled={disabled || busy}
						placeholder="provider/model, provider/model:high, @slow, or a comma list"
						onChange={e => setChoice({ kind: "custom", text: e.target.value })}
						className="field h-7 w-full px-2 font-mono text-2xs"
					/>
				) : null}
				{choice.kind === "custom" && selector === undefined ? <p className="font-mono text-2xs text-danger">Enter a selector, or choose Unset.</p> : null}
				{error ? <p role="alert" className="font-mono text-2xs text-danger">{error}</p> : null}
				{status ? <p role="status" className={cn("text-2xs", status.complete ? "text-success" : "text-warn")}>{status.text}</p> : null}
				<div className="flex flex-wrap items-center gap-2">
					<Button variant="primary" size="sm" disabled={!canSave} onClick={() => void save()}>
						<Save className="h-3.5 w-3.5" />
						{selector === null && role.value !== null ? "Unset" : "Save"}
					</Button>
					{dirty ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => setChoice(initial)}>Discard</Button> : null}
					<span className="truncate font-mono text-2xs text-ink-4">config: {role.value ?? "unset"}</span>
				</div>
			</div>
		</div>
	);
}

function notes(role: NpiModelRole, cwd: string): string[] {
	const out: string[] = [];
	if (role.provenance === "project" || role.provenance === "overlay" || role.provenance === "runtime")
		out.push(`A ${role.provenance} layer assigns ${role.effectiveValue ?? "a value"} in ${cwd}; saving here changes the global file only.`);
	if (role.provenance === "default" && role.patterns.length > 0)
		out.push(`Built-in chain: ${role.patterns.slice(0, 4).join(", ")}${role.patterns.length > 4 ? `, +${role.patterns.length - 4} more` : ""}`);
	if (role.resolved)
		out.push(`Resolves to ${role.resolved.provider}/${role.resolved.modelId}${role.resolved.thinkingLevel ? `:${role.resolved.thinkingLevel}` : ""}.`);
	else if (role.patterns.length === 0)
		out.push("No built-in chain: while unset, NeoPi falls back to another role or the chat's own model.");
	else out.push("No model with credentials matches this role's chain.");
	return out;
}
