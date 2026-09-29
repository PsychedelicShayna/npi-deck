import { useId, useState } from "react";
import type { MixtureMember, MixtureTransit } from "@npi-deck/protocol";
import { GateTag } from "./MixtureFields";

const PARTS = [
	["output", "output", undefined],
	["input", "input", undefined],
	["reasoning", "reasoning", undefined],
	["toolTrace", "tool trace", "toolTrace"],
	["transcript", "transcript", "transcript"],
] as const;

/** The keyboard route to what dragging a handle does on the flowchart. */
export function ConnectionForm({
	members,
	onConnect,
	onCancel,
}: {
	members: MixtureMember[];
	onConnect: (from: string, to: string, transit: MixtureTransit) => void;
	onCancel: () => void;
}) {
	const [from, setFrom] = useState(members[0]?.id ?? "");
	const [to, setTo] = useState(members.find(member => member.id !== from)?.id ?? "");
	const [parts, setParts] = useState<MixtureTransit>({ output: true });
	const empty = !Object.values(parts).some(Boolean);
	return (
		<form
			className="space-y-3 rounded border-2 border-accent bg-paper-2 p-4 text-sm"
			aria-label="New mixture connection"
			onSubmit={event => {
				event.preventDefault();
				if (from && to && !empty) onConnect(from, to, parts);
			}}
		>
			<h3 className="font-semibold">Connect members</h3>
			<p className="text-ink-3">A directed edge: the source's hop hands the checked parts to the target. Layout never changes execution.</p>
			<label className="block">
				From member
				<select required autoFocus className="field mt-1 w-full p-2" value={from} onChange={event => setFrom(event.target.value)}>
					{members.map(member => (
						<option key={member.id} value={member.id}>
							{member.id}
						</option>
					))}
				</select>
			</label>
			<label className="block">
				To member
				<select required className="field mt-1 w-full p-2" value={to} onChange={event => setTo(event.target.value)}>
					<option value="">Select a member</option>
					{members.map(member => (
						<option key={member.id} value={member.id}>
							{member.id}
						</option>
					))}
				</select>
			</label>
			<fieldset className="space-y-1">
				<legend>Hands on</legend>
				{PARTS.map(([part, label, gate]) => (
					<label key={part} className="flex flex-wrap items-center gap-2">
						<input type="checkbox" checked={!!parts[part]} onChange={event => setParts(value => ({ ...value, [part]: event.target.checked ? true : undefined }))} />
						{label}
						{gate ? <GateTag feature={gate} /> : null}
					</label>
				))}
			</fieldset>
			<div className="flex gap-2">
				<button type="submit" className="btn-primary px-3 py-2" disabled={!from || !to || empty}>
					Create connection
				</button>
				<button type="button" className="btn-ghost px-3 py-2" onClick={onCancel}>
					Cancel
				</button>
			</div>
		</form>
	);
}

/** Adds a model member with the fields NeoPi requires (a model, and a prompt or role). */
export function AddMemberForm({
	suggestedId,
	models,
	onAdd,
	onCancel,
}: {
	suggestedId: string;
	models: string[];
	onAdd: (member: MixtureMember) => void;
	onCancel: () => void;
}) {
	const [id, setId] = useState(suggestedId);
	const [model, setModel] = useState("");
	const [systemPrompt, setSystemPrompt] = useState("");
	const listId = useId();
	return (
		<form
			className="space-y-3 rounded border-2 border-accent bg-paper-2 p-4 text-sm"
			aria-label="New model member"
			onSubmit={event => {
				event.preventDefault();
				if (id.trim() && model.trim()) onAdd({ id: id.trim(), model: model.trim(), systemPrompt, tools: false });
			}}
		>
			<h3 className="font-semibold">Add model member</h3>
			<p className="text-ink-3">Tools start off: this backend runs only tool-less members.</p>
			<label className="block">
				Member id
				<input required autoFocus className="field mt-1 w-full p-2" value={id} onChange={event => setId(event.target.value)} />
			</label>
			<label className="block">
				Model (provider/id[:effort] or @role)
				<input required className="field mt-1 w-full p-2 font-mono" list={listId} value={model} onChange={event => setModel(event.target.value)} />
				<datalist id={listId}>
					{models.map(value => (
						<option key={value} value={value} />
					))}
				</datalist>
			</label>
			<label className="block">
				System prompt
				<textarea className="field mt-1 min-h-20 w-full p-2" value={systemPrompt} onChange={event => setSystemPrompt(event.target.value)} />
			</label>
			<div className="flex gap-2">
				<button type="submit" className="btn-primary px-3 py-2" disabled={!id.trim() || !model.trim()}>
					Add member
				</button>
				<button type="button" className="btn-ghost px-3 py-2" onClick={onCancel}>
					Cancel
				</button>
			</div>
		</form>
	);
}
