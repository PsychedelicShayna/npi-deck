import type { MixtureDefinition, MixtureDefinitionReport, MixtureEdge, MixtureIssue, MixtureMember, MixturesDocument } from "@npi-deck/protocol";

/** NeoPi's `mixtureEdgeId`: the explicit id, else one derived from the endpoints. */
export function edgeIdentity(edge: MixtureEdge): string {
	return edge.id || (Array.isArray(edge.to) ? `${edge.from}->[${edge.to.join(",")}]` : `${edge.from}->${edge.to}`);
}

export function edgeTargets(edge: MixtureEdge): string[] {
	return Array.isArray(edge.to) ? [...edge.to, ..."join" in edge ? [edge.join] : []] : [edge.to];
}

export function renameMember(def: MixtureDefinition, memberIndex: number, after: string): MixtureDefinition {
	const before = def.members[memberIndex]?.id;
	if (before === undefined) return def;
	// Duplicated imported IDs make references ambiguous; change only the selected
	// record and leave endpoint/entry references for deliberate repair.
	if (def.members.filter(member => member.id === before).length !== 1) {
		return { ...def, members: def.members.map((member, index) => (index === memberIndex ? { ...member, id: after } : member)) };
	}
	const replace = (id: string) => (id === before ? after : id);
	const edges = def.edges.map(
		edge =>
			({
				...edge,
				from: replace(edge.from),
				to: Array.isArray(edge.to) ? edge.to.map(replace) : replace(edge.to),
				...("join" in edge ? { join: replace(edge.join) } : {}),
			}) as MixtureEdge,
	);
	const identities = new Map(def.edges.map((edge, i) => [edgeIdentity(edge), edgeIdentity(edges[i] ?? edge)] as const));
	return {
		...def,
		entry: replace(def.entry),
		members: def.members.map(
			(member, index) =>
				({
					...member,
					id: index === memberIndex ? after : member.id,
					...(member.kind !== "verdict" && member.route?.fallback
						? { route: { ...member.route, fallback: identities.get(member.route.fallback) ?? member.route.fallback } }
						: {}),
				}) as MixtureMember,
		),
		edges,
		limits: def.limits ? { ...def.limits, limitTarget: def.limits.limitTarget ? replace(def.limits.limitTarget) : undefined } : undefined,
		steering: def.steering ? { ...def.steering, target: replace(def.steering.target) } : undefined,
	};
}

/** Replace one edge; a changed identity follows into route fallbacks that named it. */
export function renameEdge(def: MixtureDefinition, index: number, edge: MixtureEdge): MixtureDefinition {
	const before = edgeIdentity(def.edges[index] ?? edge);
	const after = edgeIdentity(edge);
	return {
		...def,
		edges: def.edges.map((old, i) => (i === index ? edge : old)),
		members:
			before === after
				? def.members
				: def.members.map(member =>
						member.kind !== "verdict" && member.route?.fallback === before ? { ...member, route: { ...member.route, fallback: after } } : member,
					),
	};
}

/** Move an array item by `delta` places; out-of-range moves return the array unchanged. */
export function moveItem<T>(items: readonly T[], index: number, delta: number): T[] {
	const target = index + delta;
	if (index < 0 || index >= items.length || target < 0 || target >= items.length) return [...items];
	const next = [...items];
	const [item] = next.splice(index, 1);
	next.splice(target, 0, item!);
	return next;
}

export function replaceDefinition(doc: MixturesDocument, index: number, definition: MixtureDefinition): MixturesDocument {
	return { ...doc, mixtures: doc.mixtures.map((item, i) => (i === index ? definition : item)) };
}

export function newDefinition(name: string): MixtureDefinition {
	return { name, entry: "", members: [], edges: [] };
}

export function newEdge(from: string, to: string): MixtureEdge {
	return { from, to, x: { output: true } };
}

export function uniqueId(prefix: string, existing: readonly string[]): string {
	let index = 1;
	while (existing.includes(`${prefix}${index}`)) index++;
	return `${prefix}${index}`;
}

/** Issues at `path` or below it (`members[0]` covers `members[0].route`). */
export function issuesUnder(issues: readonly MixtureIssue[], path: string): MixtureIssue[] {
	return issues.filter(issue => issue.path === path || issue.path.startsWith(`${path}.`) || issue.path.startsWith(`${path}[`));
}

/** Key-order-independent identity, matching the server's carried-over check. */
export function structureKey(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(structureKey).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${structureKey(item)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "undefined";
}

/** Issues exactly at `path`. */
export function issuesAt(issues: readonly MixtureIssue[], ...paths: string[]): MixtureIssue[] {
	return issues.filter(issue => paths.includes(issue.path));
}

export interface FieldIssues {
	/** Capability-gate refusals: the feature is not runnable on this backend. */
	gated: MixtureIssue[];
	/** Other validation errors. */
	errors: MixtureIssue[];
	warnings: MixtureIssue[];
}

export function fieldIssues(report: MixtureDefinitionReport | undefined, select: (issues: readonly MixtureIssue[]) => MixtureIssue[]): FieldIssues {
	if (!report) return { gated: [], errors: [], warnings: [] };
	const errors = select(report.errors);
	return {
		gated: errors.filter(issue => issue.code === "unsupported.feature"),
		errors: errors.filter(issue => issue.code !== "unsupported.feature"),
		warnings: select(report.warnings),
	};
}
