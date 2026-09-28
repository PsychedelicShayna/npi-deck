import type { SubagentNode, SubagentTranscriptResponse } from "@npi-deck/protocol";
import { feature } from "../backend/runtime.ts";
import { workRegistry } from "../work-registry.ts";

type Registry = ReturnType<typeof import("@oh-my-pi/pi-coding-agent/registry/agent-registry").AgentRegistry.global>;
type Bus = { on(channel: string, listener: (payload: any) => void): () => void };

/** One root generation owns one bus. Never infer ownership from a user-supplied file path. */
export class SubagentTree {
	private readonly registry: Registry;
	private readonly nodes = new Map<string, SubagentNode>();
	private readonly releases = new Map<string, () => void>();
	private readonly listeners = new Set<(nodes: SubagentNode[]) => void>();
	private readonly unsubscribers: Array<() => void>;

	constructor(readonly rootId: string, bus: Bus, private readonly api = feature("subagent-tree")) {
		this.registry = api.AgentRegistry.global();
		this.unsubscribers = [
			bus.on("task:subagent:lifecycle", (data) => this.lifecycle(data)),
			bus.on("task:subagent:progress", (data) => this.progress(data)),
			bus.on("task:subagent:event", (data) => this.event(data)),
			this.registry.onChange((change) => {
				if (change.ref.kind !== "sub" || !this.nodes.has(change.ref.id)) return;
				if (change.type === "removed") {
					this.release(change.ref.id);
					return;
				}
				const node = this.nodes.get(change.ref.id)!;
				this.nodes.set(change.ref.id, { ...node, status: change.ref.status, activity: change.ref.activity, sessionFile: change.ref.sessionFile ?? node.sessionFile });
				if (change.ref.status !== "running") this.release(change.ref.id);
				this.publish();
			}),
		];
	}

	private belongs(id: string): boolean {
		const seen = new Set<string>();
		let current: string | undefined = id;
		while (current && !seen.has(current)) {
			seen.add(current);
			const ref = this.registry.get(current);
			// A removed parent can still anchor an already-observed child; the
			// stored parent was accepted against this root's registry earlier.
			const parent: string | undefined = ref?.parentId ?? this.nodes.get(current)?.parentId;
			if (parent === this.rootId) return true;
			current = parent;
		}
		return false;
	}

	private publish(): void {
		const nodes = this.snapshot();
		for (const listener of this.listeners) listener(nodes);
	}

	snapshot(): SubagentNode[] {
		return [...this.nodes.values()].filter(node => this.belongs(node.id))
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	subscribe(listener: (nodes: SubagentNode[]) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot());
		return () => this.listeners.delete(listener);
	}

	private lifecycle(data: { id: string; agent?: string; description?: string; status: string; sessionFile?: string }): void {
		if (!this.belongs(data.id)) return;
		const ref = this.registry.get(data.id)!;
		const previous = this.nodes.get(data.id);
		const status = data.status === "started" ? ref.status : data.status;
		this.nodes.set(data.id, {
			id: data.id, parentId: ref.parentId!, name: ref.displayName || data.agent || data.id,
			status, description: data.description ?? previous?.description,
			activity: status === "running" ? ref.activity ?? previous?.activity : undefined,
			sessionFile: ref.sessionFile ?? data.sessionFile ?? previous?.sessionFile,
			createdAt: previous?.createdAt ?? ref.createdAt,
		});
		if (status === "running" && !this.releases.has(data.id)) {
			this.releases.set(data.id, workRegistry.admit("subagent", `${this.rootId}:${data.id}`));
		} else if (status !== "running") this.release(data.id);
		this.publish();
	}

	private progress(data: { progress: { id: string; status?: string; description?: string; activity?: string }; sessionFile?: string }): void {
		const id = data.progress?.id;
		if (!id || !this.belongs(id)) return;
		const node = this.nodes.get(id);
		if (!node) return;
		const ref = this.registry.get(id)!;
		const status = ref.status === "aborted" ? "aborted" : data.progress.status ?? node.status;
		this.nodes.set(id, { ...node, status, description: data.progress.description ?? node.description,
			activity: status === "running" ? ref.activity ?? data.progress.activity ?? node.activity : undefined,
			sessionFile: ref.sessionFile ?? data.sessionFile ?? node.sessionFile });
		if (status !== "running") this.release(id);
		this.publish();
	}

	private event(data: { id: string; event?: { type?: string; toolName?: string } }): void {
		if (!this.belongs(data.id)) return;
		const node = this.nodes.get(data.id);
		if (!node || node.status !== "running") return;
		const ref = this.registry.get(data.id)!;
		this.nodes.set(data.id, { ...node, activity: ref.activity ?? (data.event?.toolName ? `Using ${data.event.toolName}` : node.activity) });
		this.publish();
	}

	private release(id: string): void {
		this.releases.get(id)?.();
		this.releases.delete(id);
	}

	/** 403 for another root's id, including when the target has been removed. */
	private owned(id: string): SubagentNode {
		const node = this.nodes.get(id);
		if (!node || (this.registry.get(id) && !this.belongs(id))) throw new Error("Forbidden subagent");
		return node;
	}

	async transcript(id: string, fromByte = 0): Promise<SubagentTranscriptResponse> {
		const node = this.owned(id);
		const ref = this.registry.get(id);
		const file = ref?.sessionFile ?? node.sessionFile;
		if (!file) return { id, messages: [], nextByte: 0, reset: false };
		// An existing ref must still identify the same transcript as the bus record.
		if (ref && node.sessionFile && file !== node.sessionFile) throw new Error("Forbidden subagent");
		const result = await this.api.readRpcSubagentTranscript(file, fromByte);
		return { id, messages: result.messages as unknown as SubagentTranscriptResponse["messages"], nextByte: result.nextByte, reset: result.reset };
	}

	async abort(id: string): Promise<void> {
		const node = this.owned(id);
		const ref = this.registry.get(id);
		if (!ref || !this.belongs(id)) throw new Error("Forbidden subagent");
		if (ref.status === "aborted") return;
		if (ref.status !== "running" && ref.status !== "parked" && ref.status !== "idle") throw new Error("Subagent no longer active");
		let abortError: unknown;
		try {
			if (ref.session) await ref.session.abort({ reason: "Stopped from NPI deck" });
		} catch (error) {
			abortError = error;
		}
		const released = await this.api.AgentLifecycleManager.global().release(id, ref, { tombstone: true });
		if (!released) throw new Error("Subagent no longer active");
		this.release(id);
		this.nodes.set(id, { ...node, status: "aborted", activity: undefined });
		this.publish();
		if (abortError) throw abortError;
	}

	dispose(): void {
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		for (const id of this.releases.keys()) this.release(id);
		this.listeners.clear();
	}
}
