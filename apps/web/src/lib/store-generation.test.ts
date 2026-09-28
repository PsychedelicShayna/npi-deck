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

test("first worker hello refetches lists discarded from pre-hello bootstrap", async () => {
	const original = { WebSocket: globalThis.WebSocket, location: globalThis.location, fetch: globalThis.fetch };
	useStore.getState().disconnect();
	useStore.setState({ workerGeneration: undefined, sessions: [], workspaces: [], defaultCwd: "" });
	const requests: Array<{ url: string; resolve: (response: Response) => void }> = [];
	Object.assign(globalThis, {
		WebSocket: FakeSocket,
		location: { protocol: "http:", host: "localhost" },
		fetch: (url: string) => new Promise<Response>((resolve) => requests.push({ url, resolve })),
	});
	const reply = (request: (typeof requests)[number]) => {
		request.resolve(Response.json(request.url.includes("/workspaces")
			? { workspaces: [{ cwd: "/workspace", label: "workspace", sessionCount: 1 }], defaultCwd: "/workspace" }
			: { sessions: [{ id: "session-1", path: "/workspace/session.jsonl", cwd: "/workspace", messageCount: 1 }] }));
	};
	try {
		const boot = useStore.getState().bootstrap();
		const startedBeforeHello = requests.splice(0);
		sockets.at(-1)!.emit("message", {
			type: "hello", workerGeneration: "first", connectionId: "first-connection", backend: null, capabilities: [],
		});
		for (const request of startedBeforeHello) reply(request);
		await boot;
		for (const request of requests.splice(0)) reply(request);
		await Bun.sleep(0);
		expect(useStore.getState().workspaces.map(w => w.cwd)).toEqual(["/workspace"]);
		expect(useStore.getState().sessions.map(s => s.id)).toEqual(["session-1"]);
	} finally {
		for (const request of requests) reply(request);
		useStore.getState().disconnect();
		Object.assign(globalThis, original);
	}
});

test("a same-worker reconnect resubscribes and invalidates advisor state missed offline", async () => {
	const original = { WebSocket: globalThis.WebSocket, location: globalThis.location, fetch: globalThis.fetch };
	useStore.getState().disconnect();
	useStore.setState({ workerGeneration: undefined, sessionsById: {}, subscribed: new Set<string>() });
	Object.assign(globalThis, {
		WebSocket: FakeSocket,
		location: { protocol: "http:", host: "localhost" },
		fetch: async (url: string) => Response.json(url.includes("workspaces") ? { workspaces: [], defaultCwd: "/tmp" } : { sessions: [] }),
	});
	const hello = { type: "hello", workerGeneration: "same", backend: null, capabilities: [] };
	const snapshot = { sessionId: "session-a", cwd: "/tmp", sessionFile: "/tmp/a.jsonl", isStreaming: false, messages: [], todoPhases: [], queuedPrompts: [] };
	try {
		useStore.getState().connect();
		const first = sockets.at(-1)!;
		first.emit("message", { ...hello, connectionId: "c1" });
		useStore.getState().selectSession("session-a");
		first.emit("message", { type: "subscribed", sessionId: "session-a", snapshot });
		const before = useStore.getState().sessionsById["session-a"]?.advisorActivity;
		// An advisor note lands while the socket is down; its event is never replayed.
		first.emit("close");
		useStore.getState().ws?.connect();
		const next = sockets.at(-1)!;
		next.emit("message", { ...hello, connectionId: "c2" });
		expect(next.sent.map(frame => JSON.parse(frame))).toContainEqual({ type: "subscribe", sessionId: "session-a" });
		next.emit("message", { type: "subscribed", sessionId: "session-a", snapshot });
		const after = useStore.getState().sessionsById["session-a"]?.advisorActivity;
		expect(after ?? 0).toBeGreaterThan(before ?? 0);
	} finally {
		useStore.getState().disconnect();
		Object.assign(globalThis, original);
	}
});
