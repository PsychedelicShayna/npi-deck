import { expect, test } from "bun:test";
import { useStore } from "./store";

class FakeSocket {
	static OPEN = 1;
	readyState = 1;
	listeners = new Map<string, Array<(event: { data: string }) => void>>();
	sent: string[] = [];
	constructor(_url: string) { sockets.push(this); }
	addEventListener(name: string, fn: (event: { data: string }) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], fn]); }
	emit(name: string, body?: unknown) { for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(body) }); }
	send(data: string) { this.sent.push(data); }
	close() { this.emit("close"); }
}
const sockets: FakeSocket[] = [];

test("new worker ends live UI sessions without auto-resume or prompt replay", async () => {
	const original = { WebSocket: globalThis.WebSocket, location: globalThis.location, fetch: globalThis.fetch };
	Object.assign(globalThis, {
		WebSocket: FakeSocket,
		location: { protocol: "http:", host: "localhost" },
		fetch: async (url: string) => Response.json(url.includes("workspaces") ? { workspaces: [], defaultCwd: "/tmp" } : { sessions: [] }),
	});
	try {
		useStore.getState().connect();
		const first = sockets.at(-1)!;
		first.emit("message", { type: "hello", workerGeneration: "old", connectionId: "c1", backend: { id: "a", path: "/a", source: "config", commit: "abc", version: "1" }, capabilities: ["core"] });
		useStore.getState().selectSession("session-1");
		first.emit("message", { type: "subscribed", sessionId: "session-1", snapshot: { sessionId: "session-1", cwd: "/tmp", sessionFile: "/tmp/transcript.jsonl", isStreaming: true, messages: [], todoPhases: [], queuedPrompts: [{ id: "q", text: "old prompt", behavior: "followUp", queuedAt: 1 }] } });
		first.emit("close");
		useStore.getState().ws?.send({ type: "prompt", sessionId: "session-1", text: "offline" });
		useStore.getState().ws?.connect();
		const next = sockets.at(-1)!;
		next.emit("message", { type: "hello", workerGeneration: "new", connectionId: "c2", backend: null, capabilities: [] });
		const state = useStore.getState();
		expect(state.sessionsById["session-1"]?.endedByRestart).toBe(true);
		expect(state.sessionsById["session-1"]?.readOnly?.path).toBe("/tmp/transcript.jsonl");
		expect(state.sessionsById["session-1"]?.status).toBe("idle");
		expect(state.sessionsById["session-1"]?.queuedPrompts).toEqual([]);
		expect(state.subscribed.size).toBe(0);
		expect(next.sent).toEqual([]);
	} finally {
		useStore.getState().disconnect();
		Object.assign(globalThis, original);
	}
});
