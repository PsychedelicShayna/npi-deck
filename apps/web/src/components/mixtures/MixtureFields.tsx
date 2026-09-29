import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import type {
	MixtureDefinition,
	MixtureDefinitionReport,
	MixtureEdge,
	MixtureGatedFeature,
	MixtureMember,
	MixturePart,
	MixtureTransit,
	MixturesDocument,
} from "@npi-deck/protocol";
import { Badge } from "@/components/ui/Badge";
import { edgeIdentity, fieldIssues, issuesAt, type FieldIssues } from "./document";

/** Reports a field holding unparseable JSON; the editor blocks saving and navigation until it is fixed. */
export const JsonDraftContext = createContext<(id: string, pending: boolean) => void>(() => {});
/** Features this backend's capability gate refuses, with NeoPi's reason. */
export const MixtureGatesContext = createContext<ReadonlyMap<MixtureGatedFeature, string>>(new Map());

const input = "field w-full rounded px-2 py-1 text-sm";

/** "Not runnable on this backend", from the backend's own gate probe; never inferred client-side. */
export function GateTag({ feature }: { feature: MixtureGatedFeature }) {
	const message = useContext(MixtureGatesContext).get(feature);
	if (!message) return null;
	return (
		<Badge tone="warn" title={message}>
			not runnable on this backend
		</Badge>
	);
}

/** Validation issues NeoPi reported at one field. */
export function IssueList({ issues }: { issues: FieldIssues }) {
	if (!issues.gated.length && !issues.errors.length && !issues.warnings.length) return null;
	return (
		<ul className="space-y-1 text-xs">
			{issues.gated.map((issue, i) => (
				<li key={`g${i}`} className="text-warn">
					<Badge tone="warn">not runnable on this backend</Badge> {issue.message}
				</li>
			))}
			{issues.errors.map((issue, i) => (
				<li key={`e${i}`} className="text-danger">
					<span className="font-mono">{issue.code}</span>: {issue.message}
				</li>
			))}
			{issues.warnings.map((issue, i) => (
				<li key={`w${i}`} className="text-ink-3">
					<span className="font-mono">{issue.code}</span>: {issue.message}
				</li>
			))}
		</ul>
	);
}

function Label({ text, gate }: { text: string; gate?: MixtureGatedFeature }) {
	return (
		<span className="inline-flex flex-wrap items-center gap-2">
			{text}
			{gate ? <GateTag feature={gate} /> : null}
		</span>
	);
}

function Text({
	label,
	value,
	onChange,
	multiline = false,
	list,
	gate,
}: {
	label: string;
	value?: string;
	onChange: (value: string) => void;
	multiline?: boolean;
	list?: string;
	gate?: MixtureGatedFeature;
}) {
	return (
		<label className="block space-y-1 text-sm">
			<Label text={label} gate={gate} />
			{multiline ? (
				<textarea className={`${input} min-h-20`} value={value ?? ""} onChange={e => onChange(e.target.value)} />
			) : (
				<input className={input} list={list} value={value ?? ""} onChange={e => onChange(e.target.value)} />
			)}
		</label>
	);
}

function NumberField({
	label,
	value,
	onChange,
	min,
	step,
	gate,
}: {
	label: string;
	value?: number;
	onChange: (value?: number) => void;
	min?: number;
	step?: number;
	gate?: MixtureGatedFeature;
}) {
	return (
		<label className="block space-y-1 text-sm">
			<Label text={label} gate={gate} />
			<input
				className={input}
				type="number"
				min={min}
				step={step}
				value={value ?? ""}
				onChange={e => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
			/>
		</label>
	);
}

function Check({ label, checked, onChange, gate }: { label: string; checked: boolean; onChange: (value: boolean) => void; gate?: MixtureGatedFeature }) {
	return (
		<label className="flex flex-wrap items-center gap-2 text-sm">
			<input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
			<Label text={label} gate={gate} />
		</label>
	);
}

function Select({
	label,
	value,
	choices,
	onChange,
	unset = "Unset",
	gate,
}: {
	label: string;
	value?: string;
	choices: ReadonlyArray<string | { value: string; label: string }>;
	onChange: (value: string) => void;
	unset?: string | null;
	gate?: MixtureGatedFeature;
}) {
	return (
		<label className="block space-y-1 text-sm">
			<Label text={label} gate={gate} />
			<select className={input} value={value ?? ""} onChange={e => onChange(e.target.value)}>
				{unset !== null ? <option value="">{unset}</option> : null}
				{choices.map(choice => {
					const option = typeof choice === "string" ? { value: choice, label: choice } : choice;
					return (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					);
				})}
			</select>
		</label>
	);
}

function Section({ title, gate, children }: { title: string; gate?: MixtureGatedFeature; children: ReactNode }) {
	return (
		<section className="space-y-3 border-t border-line pt-3">
			<h4 className="flex flex-wrap items-center gap-2 font-medium">
				{title}
				{gate ? <GateTag feature={gate} /> : null}
			</h4>
			{children}
		</section>
	);
}

/** Parse valid edits immediately; invalid local text blocks every write/navigation until repaired. */
export function JsonField<T>({
	label,
	value,
	onChange,
	help,
	validate,
}: {
	label: string;
	value: T;
	onChange: (value: T) => void;
	help?: string;
	validate?: (value: unknown) => string | undefined;
}) {
	const id = useId();
	const setPending = useContext(JsonDraftContext);
	const serialized = JSON.stringify(value ?? null, null, 2);
	const [text, setText] = useState(serialized);
	const [focused, setFocused] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		if (!focused && !error) setText(serialized);
	}, [serialized, focused, error]);
	useEffect(() => () => setPending(id, false), [id, setPending]);
	function update(next: string) {
		setText(next);
		try {
			const parsed = JSON.parse(next) as T;
			const diagnostic = validate?.(parsed);
			if (diagnostic) throw new Error(diagnostic);
			setError("");
			setPending(id, false);
			if (JSON.stringify(parsed) !== JSON.stringify(value) && !(parsed === null && value === undefined)) onChange(parsed);
		} catch (reason) {
			setError(String(reason));
			setPending(id, true);
		}
	}
	return (
		<div className="space-y-1 text-sm">
			<label className="block" htmlFor={id}>
				{label}
			</label>
			{help ? <p className="text-xs text-ink-3">{help}</p> : null}
			<textarea
				id={id}
				className={`${input} min-h-24 font-mono text-xs`}
				spellCheck={false}
				value={text}
				aria-invalid={!!error}
				onFocus={() => setFocused(true)}
				onChange={e => update(e.target.value)}
				onBlur={() => {
					setFocused(false);
					if (!error) setText(serialized);
				}}
			/>
			{error ? (
				<p role="alert" className="text-danger">
					{error}; correct this JSON before saving or leaving.
				</p>
			) : null}
		</div>
	);
}

function omitEmpty<T extends object>(value: T): T | undefined {
	return Object.keys(value).length ? value : undefined;
}

function objectDiagnostic(value: unknown): string | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(item => typeof item === "string")
		? undefined
		: "Expected a JSON object of name → template strings.";
}

export function PresetsFields({ doc, onChange }: { doc: MixturesDocument; onChange: (doc: MixturesDocument) => void }) {
	return (
		<section className="space-y-3">
			<h3 className="font-semibold">Document presets</h3>
			<p className="text-xs text-ink-3">Shared by every mixture in this file; a mixture's own presets shadow them.</p>
			<JsonField label="Shared envelopes (JSON object)" value={doc.envelopes ?? {}} validate={objectDiagnostic} onChange={envelopes => onChange({ ...doc, envelopes: omitEmpty(envelopes) })} />
			<JsonField label="Shared roles (JSON object)" value={doc.roles ?? {}} validate={objectDiagnostic} onChange={roles => onChange({ ...doc, roles: omitEmpty(roles) })} />
		</section>
	);
}

export function DefinitionFields({
	definition,
	report,
	onChange,
}: {
	definition: MixtureDefinition;
	report?: MixtureDefinitionReport;
	onChange: (definition: MixtureDefinition) => void;
}) {
	const patch = (change: Partial<MixtureDefinition>) => onChange({ ...definition, ...change });
	const limits = definition.limits ?? {};
	const changeLimit = (change: NonNullable<MixtureDefinition["limits"]>) => {
		const next = Object.fromEntries(Object.entries({ ...limits, ...change }).filter(([, value]) => value !== undefined)) as NonNullable<MixtureDefinition["limits"]>;
		patch({ limits: omitEmpty(next) });
	};
	const at = (...paths: string[]) => fieldIssues(report, issues => issuesAt(issues, ...paths));
	return (
		<div className="space-y-4">
			<h3 className="font-semibold">Mixture</h3>
			<Text label="Name (the model id is mixture/<name>)" value={definition.name} onChange={name => patch({ name })} />
			<IssueList issues={at("name")} />
			<Text label="Description (shown in the model picker)" value={definition.description} onChange={description => patch({ description: description || undefined })} />
			<Select
				label="Entry member (receives your prompt)"
				value={definition.entry}
				choices={definition.members.filter(member => member.kind !== "verdict").map(member => member.id)}
				onChange={entry => patch({ entry })}
			/>
			<IssueList issues={at("entry", "members")} />
			<Check label="Serve through the auth-gateway" gate="serve" checked={definition.serve ?? false} onChange={serve => patch({ serve: serve || undefined })} />
			<IssueList issues={at("serve", "edges", "steering")} />
			<Section title="Limits">
				<NumberField label="Maximum hops" value={limits.maxHops} min={1} onChange={maxHops => changeLimit({ maxHops })} />
				<IssueList issues={at("limits.max_hops")} />
				<NumberField label="Budget USD" gate="budgetUsd" value={limits.budgetUsd} min={0} step={0.01} onChange={budgetUsd => changeLimit({ budgetUsd })} />
				<NumberField label="Wall clock minutes" gate="wallClockMinutes" value={limits.wallClockMinutes} min={0} onChange={wallClockMinutes => changeLimit({ wallClockMinutes })} />
				<Select
					label="On limit"
					gate="onLimit"
					value={limits.onLimit}
					choices={["stop", "pause", "judge"]}
					onChange={onLimit => changeLimit({ onLimit: onLimit ? (onLimit as "stop" | "pause" | "judge") : undefined })}
				/>
				<Text label="Limit judge target member" gate="limitTarget" value={limits.limitTarget} onChange={limitTarget => changeLimit({ limitTarget: limitTarget || undefined })} />
				<IssueList issues={at("limits.budget_usd", "limits.wall_clock_minutes", "limits.on_limit", "limits.limit_target")} />
			</Section>
			<Section title="Steering" gate="steering">
				<Text label="Steering target (active / entry / auto / member id)" value={definition.steering?.target} onChange={target => patch({ steering: target ? { target } : undefined })} />
			</Section>
			<Section title="Mixture presets">
				<JsonField label="Envelopes (JSON object)" value={definition.envelopes ?? {}} validate={objectDiagnostic} onChange={envelopes => patch({ envelopes: omitEmpty(envelopes) })} />
				<JsonField label="Roles (JSON object)" value={definition.roles ?? {}} validate={objectDiagnostic} onChange={roles => patch({ roles: omitEmpty(roles) })} />
			</Section>
		</div>
	);
}

export function MemberFields({
	member,
	index,
	edgeIds,
	models,
	report,
	onChange,
	onRename,
}: {
	member: MixtureMember;
	index: number;
	edgeIds: string[];
	models: string[];
	report?: MixtureDefinitionReport;
	onChange: (member: MixtureMember) => void;
	onRename: (name: string) => void;
}) {
	const patch = (change: Record<string, unknown>) => onChange({ ...member, ...change } as MixtureMember);
	const path = `members[${index}]`;
	const at = (...suffixes: string[]) => fieldIssues(report, issues => issuesAt(issues, ...suffixes.map(suffix => `${path}${suffix}`)));
	const model = member.kind !== "verdict" ? member : null;
	const listId = useId();
	return (
		<div className="space-y-3">
			<h3 className="flex flex-wrap items-center gap-2 font-semibold">
				{model ? "Model member" : "Verdict member"}
				{model ? null : <GateTag feature="verdict" />}
			</h3>
			<IssueList issues={at("")} />
			<Text label="Member id" value={member.id} onChange={onRename} />
			<IssueList issues={at(".id")} />
			<Text label="Description" value={member.description} onChange={description => patch({ description: description || undefined })} />
			<Select label="Show output" value={member.show} choices={["always", "never", "final"]} unset="Default (always)" onChange={show => patch({ show: show || undefined })} />
			<IssueList issues={at(".show")} />
			{model ? (
				<>
					<Text label="Model (provider/id[:effort] or @role)" value={model.model} list={listId} onChange={value => patch({ model: value })} />
					<datalist id={listId}>
						{models.map(value => (
							<option key={value} value={value} />
						))}
					</datalist>
					<IssueList issues={at(".model")} />
					<Text label="Role preset" value={model.role} onChange={role => patch({ role: role || undefined })} />
					<IssueList issues={at(".role")} />
					<Text label="System prompt (wins over the role preset)" value={model.systemPrompt} multiline onChange={systemPrompt => patch({ systemPrompt })} />
					<Select
						label="Inherit the outer system prompt"
						value={model.inherit === undefined ? "" : String(model.inherit)}
						choices={["true", "false"]}
						unset="Default (only when tools are on)"
						onChange={choice => patch({ inherit: choice ? choice === "true" : undefined })}
					/>
					<Select
						label="Tools"
						gate="tools"
						value={model.tools === false ? "false" : model.tools === true ? "true" : Array.isArray(model.tools) ? "list" : ""}
						choices={[
							{ value: "false", label: "Off" },
							{ value: "true", label: "All caller tools" },
							{ value: "list", label: "Allow-list" },
						]}
						unset="Default (on when the member has no outgoing edge)"
						onChange={choice => patch({ tools: choice === "false" ? false : choice === "true" ? true : choice === "list" ? [] : undefined })}
					/>
					{Array.isArray(model.tools) ? <JsonField label="Allowed tools (JSON array)" value={model.tools} onChange={tools => patch({ tools })} /> : null}
					<IssueList issues={at(".tools")} />
					<NumberField label="Maximum output tokens" min={1} value={model.maxTokens} onChange={maxTokens => patch({ maxTokens })} />
					<Section title="Route decision" gate="route">
						<Check label="Enable route" checked={!!model.route} onChange={enabled => patch({ route: enabled ? { instructions: "" } : undefined })} />
						{model.route ? (
							<>
								<Text label="Route instructions" multiline value={model.route.instructions} onChange={instructions => patch({ route: { ...model.route!, instructions } })} />
								<JsonField label="Route state (JSON array of output / input / toolTrace)" value={model.route.state ?? []} onChange={state => patch({ route: { ...model.route!, state } })} />
								<NumberField label="Minimum confidence" step={0.01} value={model.route.minConfidence} onChange={minConfidence => patch({ route: { ...model.route!, minConfidence } })} />
								<Select label="Fallback edge" value={model.route.fallback} choices={edgeIds} onChange={fallback => patch({ route: { ...model.route!, fallback: fallback || undefined } })} />
							</>
						) : null}
						<IssueList issues={at(".route")} />
					</Section>
					<Section title="Terminate decision" gate="terminate">
						<Check label="Enable terminate" checked={!!model.terminate} onChange={enabled => patch({ terminate: enabled ? { instructions: "" } : undefined })} />
						{model.terminate ? (
							<>
								<Text label="Termination instructions" multiline value={model.terminate.instructions} onChange={instructions => patch({ terminate: { ...model.terminate!, instructions } })} />
								<JsonField label="Termination criteria (JSON object: true, false)" value={model.terminate.criteria ?? {}} onChange={criteria => patch({ terminate: { ...model.terminate!, criteria } })} />
								<JsonField label="Termination state (JSON array)" value={model.terminate.state ?? []} onChange={state => patch({ terminate: { ...model.terminate!, state } })} />
								<NumberField label="Termination threshold" step={0.01} value={model.terminate.threshold} onChange={threshold => patch({ terminate: { ...model.terminate!, threshold } })} />
							</>
						) : null}
						<IssueList issues={at(".terminate")} />
					</Section>
				</>
			) : member.kind === "verdict" ? (
				<>
					<Select
						label="Question type"
						value={member.question.type}
						unset={null}
						choices={["choice", "noul", "score"]}
						onChange={type =>
							patch({ question: type === "score" ? { type, instructions: member.question.instructions, criteria: ["", ""] } : { type, instructions: member.question.instructions, criteria: {} } })
						}
					/>
					<Text label="Question instructions" multiline value={member.question.instructions} onChange={instructions => patch({ question: { ...member.question, instructions } })} />
					<JsonField
						label="Question criteria (choice: keyed object; noul: true/false object; score: array of at least two strings)"
						value={member.question.criteria}
						onChange={criteria => patch({ question: { ...member.question, criteria } })}
					/>
					<JsonField label="Verdict state (JSON array)" value={member.state ?? []} onChange={state => patch({ state: state as MixturePart[] })} />
					<Text label="Render preset" value={member.render} onChange={render => patch({ render: render || undefined })} />
				</>
			) : null}
		</div>
	);
}

export function TransitFields({
	value,
	onChange,
	label = "Hands on (x)",
	issues,
}: {
	value: MixtureTransit;
	onChange: (value: MixtureTransit) => void;
	label?: string;
	issues?: FieldIssues;
}) {
	const parts = [
		["output", "output", undefined],
		["input", "input", undefined],
		["reasoning", "reasoning", undefined],
		["toolTrace", "tool trace", "toolTrace"],
	] as const;
	return (
		<fieldset className="space-y-2 border-t border-line pt-3">
			<legend className="font-medium">{label}</legend>
			{parts.map(([part, text, gate]) => (
				<Check key={part} label={text} gate={gate} checked={value[part] === true} onChange={checked => onChange({ ...value, [part]: checked ? true : undefined })} />
			))}
			<Select
				label="Transcript"
				gate="transcript"
				value={value.transcript ? (value.transcript === true ? "verbatim" : (value.transcript.optimize ?? "verbatim")) : ""}
				choices={["verbatim", "compact", "snapcompact"]}
				unset="Off"
				onChange={mode =>
					onChange({
						...value,
						transcript: mode ? { ...(typeof value.transcript === "object" ? value.transcript : {}), optimize: mode as "verbatim" | "compact" | "snapcompact" } : undefined,
					})
				}
			/>
			{typeof value.transcript === "object" ? (
				<NumberField
					label="Transcript token budget"
					value={value.transcript.budgetTokens}
					min={1}
					onChange={budgetTokens => onChange({ ...value, transcript: { ...(value.transcript as object), budgetTokens } })}
				/>
			) : null}
			{issues ? <IssueList issues={issues} /> : null}
		</fieldset>
	);
}

export function EdgeFields({
	edge,
	index,
	members,
	report,
	onChange,
}: {
	edge: MixtureEdge;
	index: number;
	members: MixtureMember[];
	report?: MixtureDefinitionReport;
	onChange: (edge: MixtureEdge) => void;
}) {
	const patch = (change: Record<string, unknown>) => onChange({ ...edge, ...change } as MixtureEdge);
	const ids = members.map(member => member.id);
	const path = `edges[${index}]`;
	const at = (...suffixes: string[]) => fieldIssues(report, issues => issuesAt(issues, ...suffixes.map(suffix => `${path}${suffix}`)));
	const transitIssues = fieldIssues(report, issues => issues.filter(issue => issue.path.startsWith(`${path}.x`)));
	return (
		<div className="space-y-3">
			<h3 className="flex flex-wrap items-center gap-2 font-semibold">
				Connection
				{"join" in edge ? <GateTag feature="fanout" /> : null}
			</h3>
			<IssueList issues={at("", ".from")} />
			<Text label="Edge id (blank derives from→to)" value={edge.id} onChange={id => patch({ id: id || undefined })} />
			<p className="break-all font-mono text-xs text-ink-3">Effective id: {edgeIdentity(edge)}</p>
			<IssueList issues={at(".id")} />
			<Select label="From member" value={edge.from} unset={null} choices={ids} onChange={from => patch({ from })} />
			{"join" in edge ? (
				<>
					<JsonField
						label="Fan-out targets (JSON array of member ids)"
						value={edge.to}
						validate={parsed => (Array.isArray(parsed) && parsed.every(target => typeof target === "string") ? undefined : "Fan-out targets must be a JSON array of member id strings.")}
						onChange={to => patch({ to })}
					/>
					<Select label="Join member" value={edge.join} choices={ids} onChange={join => patch({ join })} />
					<JsonField label="Slices (same / auto / JSON array)" value={edge.slices ?? "same"} onChange={slices => patch({ slices })} />
					<TransitFields label="Join hands on" value={edge.joinX ?? { output: true }} onChange={joinX => patch({ joinX })} />
					<Text label="Join envelope" value={edge.joinEnvelope} onChange={joinEnvelope => patch({ joinEnvelope: joinEnvelope || undefined })} />
					<NumberField label="Quorum" value={edge.quorum} min={1} onChange={quorum => patch({ quorum })} />
					<NumberField label="Grace milliseconds" value={edge.graceMs} min={0} onChange={graceMs => patch({ graceMs })} />
					<Check label="Anonymize branches" checked={edge.anonymize ?? false} onChange={anonymize => patch({ anonymize: anonymize || undefined })} />
				</>
			) : (
				<Select label="To member" value={edge.to} unset={null} choices={ids} onChange={to => patch({ to })} />
			)}
			<TransitFields value={edge.x} onChange={x => patch({ x })} issues={transitIssues} />
			<Text label="Envelope preset or inline template" value={edge.envelope} multiline onChange={envelope => patch({ envelope: envelope || undefined })} />
			<IssueList issues={at(".envelope")} />
			<Text label="When (a rubric for route decisions)" value={edge.when} multiline onChange={when => patch({ when: when || undefined })} />
			<Select label="Show" value={edge.show} choices={["always", "never"]} unset="Default (source member's show)" onChange={show => patch({ show: show || undefined })} />
			<NumberField label="Maximum traversals" gate="maxTraversals" min={1} value={edge.maxTraversals} onChange={maxTraversals => patch({ maxTraversals })} />
			<IssueList issues={at(".max_traversals")} />
		</div>
	);
}
