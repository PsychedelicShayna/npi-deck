import { useMemo } from "react";
import { Handle, Position, ReactFlowProvider, type Connection, type Edge, type Node, type NodeProps, type OnNodesChange } from "@xyflow/react";
import type { MixtureDefinition, MixtureDefinitionReport, MixtureEdge } from "@npi-deck/protocol";
import { GraphCanvasSurface } from "@/components/graph/GraphCanvasSurface";
import { edgeIdentity, fieldIssues, issuesUnder } from "./document";

export type Positions = Record<string, { x: number; y: number }>;

interface MemberData extends Record<string, unknown> {
	title: string;
	caption: string;
	entry: boolean;
	verdict: boolean;
	gated: number;
	errors: number;
}
type MemberNode = Node<MemberData, "mixture">;

function MemberCard({ data, selected }: NodeProps<MemberNode>) {
	const tone = data.gated ? "border-warn" : data.errors ? "border-danger" : selected ? "border-accent" : "border-line-strong";
	return (
		<div className={`min-w-48 max-w-64 rounded-md border-2 bg-paper-2 px-3 py-2 text-ink shadow-sm ${tone} ${selected ? "ring-2 ring-accent/60" : ""}`}>
			<Handle type="target" position={Position.Left} />
			<div className="flex items-center gap-2 text-sm font-semibold">
				{data.entry ? (
					<span aria-label="Entry member" className="text-accent">
						▶
					</span>
				) : null}
				{data.title}
			</div>
			<div className="mt-1 break-all font-mono text-xs text-ink-3">
				{data.verdict ? "Verdict · " : "Model · "}
				{data.caption || "no model"}
			</div>
			{data.gated ? <div className="mt-1 font-mono text-2xs uppercase tracking-meta text-warn">not runnable on this backend</div> : null}
			{!data.gated && data.errors ? <div className="mt-1 font-mono text-2xs uppercase tracking-meta text-danger">{data.errors} error{data.errors === 1 ? "" : "s"}</div> : null}
			<Handle type="source" position={Position.Right} />
		</div>
	);
}
const nodeTypes = { mixture: MemberCard };

/** Layered left-to-right layout from the entry; a saved position wins. Pixels only, never semantics. */
export function layoutPositions(definition: MixtureDefinition, saved: Positions): Positions {
	const result: Positions = {};
	const depths = new Map<string, number>([[definition.entry, 0]]);
	for (let i = 0; i < definition.members.length; i++)
		for (const edge of definition.edges) {
			if (!depths.has(edge.from)) continue;
			for (const target of Array.isArray(edge.to) ? edge.to : [edge.to])
				if (!depths.has(target)) depths.set(target, Math.min(i + 1, (depths.get(edge.from) ?? 0) + 1));
		}
	const counts = new Map<number, number>();
	for (const member of definition.members) {
		const depth = depths.get(member.id) ?? depths.size + 1;
		const row = counts.get(depth) ?? 0;
		counts.set(depth, row + 1);
		result[member.id] = saved[member.id] ?? { x: 40 + depth * 360, y: 60 + row * 155 };
	}
	return result;
}

function transitLabel(edge: MixtureEdge): string {
	return Object.entries(edge.x).filter(([, on]) => on).map(([part]) => part).join(" + ") || "no transit";
}

export function MixtureGraph({
	definition,
	keys,
	report,
	selected,
	positionsById,
	onPositions,
	onSelect,
	onConnect,
}: {
	definition: MixtureDefinition;
	/** Stable React Flow ids, one per member index. */
	keys: string[];
	report?: MixtureDefinitionReport;
	selected: string | null;
	positionsById: Positions;
	onPositions: (positions: Positions) => void;
	onSelect: (selection: string | null) => void;
	onConnect: (from: string, to: string) => void;
}) {
	const layout = useMemo(() => layoutPositions(definition, positionsById), [definition, positionsById]);
	const nodes = useMemo<MemberNode[]>(
		() =>
			definition.members.map((member, index) => {
				const issues = fieldIssues(report, list => issuesUnder(list, `members[${index}]`));
				return {
					id: keys[index] ?? `member-${index}`,
					type: "mixture",
					position: layout[member.id] ?? { x: 0, y: 0 },
					ariaLabel: `Member ${member.id}${definition.entry === member.id ? ", entry" : ""}. Enter selects; arrow keys move it.`,
					data: {
						title: member.id,
						caption: member.kind === "verdict" ? member.question.type : member.model,
						entry: definition.entry === member.id,
						verdict: member.kind === "verdict",
						gated: issues.gated.length,
						errors: issues.errors.length,
					},
					selected: selected === `member:${index}`,
				};
			}),
		[definition, keys, layout, report, selected],
	);
	const edges = useMemo<Edge[]>(
		() =>
			definition.edges.flatMap((edge, i) => {
				const lookup = (memberId: string) => keys[definition.members.findIndex(member => member.id === memberId)] ?? "";
				const issues = fieldIssues(report, list => issuesUnder(list, `edges[${i}]`));
				const gated = issues.gated.length > 0;
				// The edge id is in the connection list; the canvas label stays short enough to sit between cards.
				const label = `${transitLabel(edge)}${gated ? " · not runnable" : ""}`;
				const stroke = gated ? "rgb(var(--warn))" : issues.errors.length ? "rgb(var(--danger))" : "rgb(var(--accent))";
				const isSelected = selected === `edge:${i}`;
				const branches: Edge[] = (Array.isArray(edge.to) ? edge.to : [edge.to]).map((target, branch) => ({
					id: `${i}:${branch}`,
					source: lookup(edge.from),
					target: lookup(target),
					type: "smoothstep",
					label,
					selected: isSelected,
					style: { strokeWidth: isSelected ? 3 : 2, stroke, strokeDasharray: gated ? "6 4" : undefined },
					labelStyle: { fill: "rgb(var(--ink))", fontSize: 12, fontFamily: "IBM Plex Mono" },
					labelBgStyle: { fill: "rgb(var(--paper-2))" },
				}));
				if ("join" in edge && Array.isArray(edge.to))
					for (const [branch, target] of edge.to.entries())
						branches.push({
							id: `${i}:join:${branch}`,
							source: lookup(target),
							target: lookup(edge.join),
							type: "smoothstep",
							label: `join ${edgeIdentity(edge)}`,
							selected: isSelected,
							style: { strokeWidth: 2, stroke: "rgb(var(--line-strong))", strokeDasharray: "6 4" },
							labelStyle: { fill: "rgb(var(--ink))", fontSize: 12 },
							labelBgStyle: { fill: "rgb(var(--paper-2))" },
						});
				return branches;
			}),
		[definition, keys, report, selected],
	);
	// React Flow's keyboard support moves a selected node with the arrow keys and
	// selects a focused one with Enter; both arrive here as node changes.
	const handleNodeChange: OnNodesChange<MemberNode> = changes => {
		let next: Positions | undefined;
		for (const change of changes) {
			if (change.type === "position" && change.position) {
				const member = definition.members[keys.indexOf(change.id)];
				if (member) (next ??= { ...layout })[member.id] = change.position;
			} else if (change.type === "select" && change.selected) {
				const index = keys.indexOf(change.id);
				if (index >= 0) onSelect(`member:${index}`);
			}
		}
		if (next) onPositions(next);
	};
	const handleConnect = (connection: Connection) => {
		const from = definition.members[keys.indexOf(connection.source)]?.id;
		const to = definition.members[keys.indexOf(connection.target)]?.id;
		if (from && to) onConnect(from, to);
	};
	return (
		<ReactFlowProvider>
			<div className="graph-canvas h-full w-full">
				<GraphCanvasSurface<MemberNode, Edge>
					nodes={nodes}
					edges={edges}
					nodeTypes={nodeTypes}
					onNodesChange={handleNodeChange}
					onNodeClick={(_, node) => onSelect(`member:${keys.indexOf(node.id)}`)}
					onEdgeClick={(_, edge) => onSelect(`edge:${Number(edge.id.split(":")[0])}`)}
					onPaneClick={() => onSelect(null)}
					onConnect={handleConnect}
					nodesDraggable
					nodesFocusable
					edgesFocusable
					fitView
					fitViewOptions={{ padding: 0.25 }}
				/>
			</div>
		</ReactFlowProvider>
	);
}
