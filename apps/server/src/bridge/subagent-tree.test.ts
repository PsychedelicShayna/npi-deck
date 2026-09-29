import { expect, test } from "bun:test";
import { workRegistry } from "../work-registry.ts";
import { SubagentTree } from "./subagent-tree.ts";

const refs = new Map<string, any>();
const listeners = new Set<(change: any) => void>();
const registry = {
	get: (id: string) => refs.get(id),
	onChange: (listener: (change: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
};
const released: Array<{ id: string; ref: unknown; tombstone: boolean }> = [];
const api = {
	AgentRegistry: { global: () => registry },
	AgentLifecycleManager: { global: () => ({ release: async (id: string, ref: unknown, opts: { tombstone: boolean }) => {
		if (refs.get(id) !== ref) return false;
		released.push({ id, ref, tombstone: opts.tombstone });
		(ref as any).status = "aborted";
		(ref as any).session = null;
		return true;
	} }) },
	readRpcSubagentTranscript: async (file: string, fromByte: number) => ({ messages: [{ role: "assistant", content: file }], nextByte: fromByte + 1, reset: false }),
} as unknown as NonNullable<ConstructorParameters<typeof SubagentTree>[2]>;
function bus() {
	const handlers = new Map<string, (data: any) => void>();
	return { on(channel: string, cb: (data: any) => void) { handlers.set(channel, cb); return () => { handlers.delete(channel); }; },
		emit(channel: string, data: any) { handlers.get(channel)?.(data); } };
}

test("root ownership gates nested transcripts and abort, and tombstones the exact live ref", async () => {
	refs.clear(); released.length = 0;
	const aborted: string[] = [];
	refs.set("rootA", { id: "rootA", kind: "main" });
	refs.set("rootB", { id: "rootB", kind: "main" });
	refs.set("parent", { id: "parent", parentId: "rootA", kind: "sub", status: "running", createdAt: 1, displayName: "parent", sessionFile: "/tmp/parent.jsonl", session: { abort: async () => aborted.push("parent") } });
	const child = { id: "child", parentId: "parent", kind: "sub", status: "running", createdAt: 2, displayName: "child", sessionFile: "/tmp/child.jsonl", session: { abort: async () => aborted.push("child") } };
	refs.set("child", child);
	const aBus = bus(), bBus = bus();
	const a = new SubagentTree("rootA", aBus, api), b = new SubagentTree("rootB", bBus, api);
	aBus.emit("task:subagent:lifecycle", { id: "parent", status: "started" });
	aBus.emit("task:subagent:lifecycle", { id: "child", status: "started" });
	bBus.emit("task:subagent:lifecycle", { id: "child", status: "started" });
	expect(a.snapshot().map(n => n.id)).toEqual(["parent", "child"]);
	expect(b.snapshot()).toEqual([]);
	expect((await a.transcript("child", 4)).nextByte).toBe(5);
	await expect(b.transcript("child")).rejects.toThrow("Forbidden subagent");
	await expect(b.abort("child")).rejects.toThrow("Forbidden subagent");
	await a.abort("child");
	expect(aborted).toEqual(["child"]);
	expect(released).toEqual([{ id: "child", ref: child, tombstone: true }]);
	expect(a.snapshot().find(n => n.id === "child")?.status).toBe("aborted");
	const parked = refs.get("parent"); parked.status = "parked"; parked.session = null;
	aBus.emit("task:subagent:lifecycle", { id: "parent", status: "completed" });
	expect((await a.transcript("parent")).messages[0]?.content).toBe("/tmp/parent.jsonl");
	a.dispose(); b.dispose();
});

test("cross-session HTTP transcript and abort return 403 without invoking the target", async () => {
	const { buildSubagentsRouter } = await import("../routes-subagents.ts");
	const app = buildSubagentsRouter({
		getSession: () => ({ sessionId: "other" }),
		subagentSnapshot: () => [],
		readSubagentTranscript: async () => { throw new Error("Forbidden subagent"); },
		abortSubagent: async () => { throw new Error("Forbidden subagent"); },
	} as any);
	const transcript = await app.request("/other/child/transcript");
	const abort = await app.request("/other/child/abort", { method: "POST" });
	expect(transcript.status).toBe(403);
	expect(abort.status).toBe(403);
});

test("replaced generation is forbidden and disappearing child cannot be marked aborted", async () => {
	refs.clear(); released.length = 0;
	refs.set("rootA", { id: "rootA", kind: "main" });
	const original = { id: "race", parentId: "rootA", kind: "sub", status: "running", createdAt: 1, displayName: "race", sessionFile: "/tmp/race.jsonl",
		session: { abort: async () => { refs.delete("race"); } } };
	refs.set("race", original);
	const events = bus(), tree = new SubagentTree("rootA", events, api);
	events.emit("task:subagent:lifecycle", { id: "race", status: "started" });
	await expect(tree.abort("race")).rejects.toThrow("Subagent no longer active");
	expect(tree.snapshot()[0]?.status).toBe("running");
	refs.set("race", { ...original, parentId: "foreign", sessionFile: "/tmp/foreign.jsonl" });
	await expect(tree.transcript("race")).rejects.toThrow("Forbidden subagent");
	await expect(tree.abort("race")).rejects.toThrow("Forbidden subagent");
	tree.dispose();
});

function removedAfterStart(id: string) {
	refs.clear(); released.length = 0;
	refs.set("rootA", { id: "rootA", kind: "main" });
	const ref = { id, parentId: "rootA", kind: "sub", status: "running", createdAt: 1, displayName: id, sessionFile: `/tmp/${id}.jsonl`, activity: "Thinking" };
	refs.set(id, ref);
	const events = bus(), tree = new SubagentTree("rootA", events, api);
	events.emit("task:subagent:lifecycle", { id, status: "started" });
	expect(workRegistry.snapshot()).toContainEqual({ kind: "subagent", id: `rootA:${id}` });
	refs.delete(id);
	for (const listener of listeners) listener({ type: "removed", ref });
	expect(workRegistry.snapshot()).not.toContainEqual({ kind: "subagent", id: `rootA:${id}` });
	return { events, tree };
}

test("late lifecycle after removal records a terminal status and never re-admits work", () => {
	const { events, tree } = removedAfterStart("late-life");
	expect(() => events.emit("task:subagent:lifecycle", { id: "late-life", status: "started" })).not.toThrow();
	expect(workRegistry.snapshot()).not.toContainEqual({ kind: "subagent", id: "rootA:late-life" });
	expect(() => events.emit("task:subagent:lifecycle", { id: "late-life", status: "completed", description: "done" })).not.toThrow();
	expect(tree.snapshot()).toMatchObject([{ id: "late-life", parentId: "rootA", status: "completed", description: "done", activity: undefined, sessionFile: "/tmp/late-life.jsonl" }]);
	expect(workRegistry.snapshot()).not.toContainEqual({ kind: "subagent", id: "rootA:late-life" });
	events.emit("task:subagent:lifecycle", { id: "late-life", status: "failed" });
	expect(tree.snapshot()[0]?.status).toBe("completed");
	tree.dispose();
});

test("late progress after removal records a terminal status and ignores running updates", () => {
	const { events, tree } = removedAfterStart("late-progress");
	expect(() => events.emit("task:subagent:progress", { progress: { id: "late-progress", status: "running", activity: "Using bash" } })).not.toThrow();
	expect(tree.snapshot()[0]).toMatchObject({ status: "running", activity: "Thinking" });
	expect(() => events.emit("task:subagent:progress", { progress: { id: "late-progress", status: "failed" } })).not.toThrow();
	expect(tree.snapshot()[0]).toMatchObject({ status: "failed", activity: undefined });
	expect(workRegistry.snapshot()).not.toContainEqual({ kind: "subagent", id: "rootA:late-progress" });
	tree.dispose();
});

test("late tool event after removal is ignored", () => {
	const { events, tree } = removedAfterStart("late-event");
	const seen: unknown[] = [];
	tree.subscribe(nodes => seen.push(nodes));
	expect(() => events.emit("task:subagent:event", { id: "late-event", event: { type: "tool_execution_start", toolName: "bash" } })).not.toThrow();
	expect(seen).toHaveLength(1);
	expect(tree.snapshot()[0]).toMatchObject({ status: "running", activity: "Thinking" });
	tree.dispose();
});

function liveChild(id: string) {
	refs.clear(); released.length = 0;
	refs.set("rootA", { id: "rootA", kind: "main" });
	const ref = { id, parentId: "rootA", kind: "sub", status: "running", createdAt: 1, displayName: id, sessionFile: `/tmp/${id}.jsonl`, session: { abort: async () => {} } };
	refs.set(id, ref);
	const events = bus(), tree = new SubagentTree("rootA", events, api);
	events.emit("task:subagent:lifecycle", { id, status: "started" });
	return { events, tree, ref };
}

test("an aborted tombstone outranks a late lifecycle or progress completion", async () => {
	for (const late of [
		(events: ReturnType<typeof bus>, id: string) => events.emit("task:subagent:lifecycle", { id, status: "completed" }),
		(events: ReturnType<typeof bus>, id: string) => events.emit("task:subagent:progress", { progress: { id, status: "completed" } }),
	]) {
		// Tombstoned by the deck's own abort: node and ref are both aborted.
		const deck = liveChild("deck-abort");
		await deck.tree.abort("deck-abort");
		late(deck.events, "deck-abort");
		expect(deck.tree.snapshot()[0]?.status).toBe("aborted");
		deck.tree.dispose();
		// Tombstoned elsewhere before its registry change reached this tree.
		const hub = liveChild("hub-abort");
		hub.ref.status = "aborted";
		late(hub.events, "hub-abort");
		expect(hub.tree.snapshot()[0]?.status).toBe("aborted");
		expect(workRegistry.snapshot()).not.toContainEqual({ kind: "subagent", id: "rootA:hub-abort" });
		hub.tree.dispose();
	}
});

test("a finished child keeps its first terminal status except for a later abort", () => {
	const { events, tree, ref } = liveChild("finished");
	ref.status = "idle";
	events.emit("task:subagent:lifecycle", { id: "finished", status: "completed" });
	events.emit("task:subagent:progress", { progress: { id: "finished", status: "failed" } });
	events.emit("task:subagent:lifecycle", { id: "finished", status: "failed" });
	expect(tree.snapshot()[0]?.status).toBe("completed");
	events.emit("task:subagent:lifecycle", { id: "finished", status: "aborted" });
	expect(tree.snapshot()[0]?.status).toBe("aborted");
	events.emit("task:subagent:progress", { progress: { id: "finished", status: "completed" } });
	expect(tree.snapshot()[0]?.status).toBe("aborted");
	tree.dispose();
});
