/** Process-wide in-flight work ledger for shutdown and backend-switch admission. */
export type WorkKind = "session" | "subagent" | "routine-queued" | "routine-run" | "routine-step" | "process" | "oauth" | "bridge";
export interface WorkItem { kind: WorkKind; id: string }
const items = new Map<string, WorkItem>();
let closed = false;
export const workRegistry = {
	admit(kind: WorkKind, id: string): () => void {
		if (closed) throw new Error("work admissions closed");
		const key = `${kind}:${id}`;
		if (items.has(key)) throw new Error(`work already admitted: ${key}`);
		items.set(key, { kind, id });
		return () => { items.delete(key); };
	},
	transition(from: WorkKind, to: WorkKind, id: string): void {
		const item = items.get(`${from}:${id}`);
		if (!item) throw new Error(`work not admitted: ${from}:${id}`);
		item.kind = to;
	},
	closeAdmissions(): void { closed = true; },
	get busy(): boolean { return items.size > 0; },
	snapshot(): WorkItem[] { return [...items.values()]; },
};
