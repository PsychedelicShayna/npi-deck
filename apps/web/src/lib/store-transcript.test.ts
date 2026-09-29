import { afterEach, beforeEach, expect, test } from "bun:test";
import { useStore } from "./store";
import type { AssistantMsg, UserMsg } from "./types";

class FakeSocket {
	static OPEN = 1;
	readyState = 1;
	listeners = new Map<string, Array<(event: { data: string }) => void>>();
	constructor(_url: string) { sockets.push(this); }
	addEventListener(name: string, fn: (event: { data: string }) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], fn]); }
	emit(name: string, body?: unknown) { for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(body) }); }
	send(_data: string) {}
	close() { this.emit("close"); }
}
const sockets: FakeSocket[] = [];

const PATH = "/tmp/long.jsonl";
const user = (n: number) => ({ role: "user", content: [{ type: "text", text: `u${n}` }], timestamp: n });
const assistant = (n: number) => ({ role: "assistant", content: [{ type: "text", text: `a${n}` }], usage: { totalTokens: 10 * n }, timestamp: n });
const transcript = (messages: unknown[], omitted?: unknown) => ({ sessionId: "s1", path: PATH, cwd: "/tmp", messages, ...(omitted ? { omitted } : {}) });
const TAIL = transcript([user(2), assistant(2)], { count: 2, usage: [{ totalTokens: 10 }] });
const FULL = transcript([user(1), assistant(1), user(2), assistant(2)]);

/** Full loads (no `limit`) wait here until the test answers them. */
let fullLoads: Array<(body: unknown) => void> = [];
const original = { WebSocket: globalThis.WebSocket, location: globalThis.location, fetch: globalThis.fetch };

const texts = () => useStore.getState().sessionsById.s1?.messages.map((m) => m.role === "user" ? (m as UserMsg).text : (m as AssistantMsg).blocks.map((b) => (b as { text: string }).text).join(""));

beforeEach(() => {
	fullLoads = [];
	useStore.getState().disconnect();
	useStore.setState({ workerGeneration: undefined, sessionsById: {}, activeId: undefined, subscribed: new Set<string>() });
	Object.assign(globalThis, {
		WebSocket: FakeSocket,
		location: { protocol: "http:", host: "localhost" },
		fetch: (url: string) => {
			if (!url.includes("/sessions/transcript")) return Promise.resolve(Response.json(url.includes("workspaces") ? { workspaces: [], defaultCwd: "/tmp" } : { sessions: [] }));
			if (url.includes("limit=")) return Promise.resolve(Response.json(TAIL));
			return new Promise<Response>((resolve) => fullLoads.push((body) => resolve(Response.json(body))));
		},
	});
});

afterEach(() => {
	useStore.getState().disconnect();
	Object.assign(globalThis, original);
});

test("a full load fills in the older messages and keeps the whole session's cost", async () => {
	await useStore.getState().openTranscript(PATH);
	expect(useStore.getState().sessionsById.s1?.readOnly?.earlier).toBe(2);
	expect(useStore.getState().sessionsById.s1?.usage.totalTokens).toBe(30);
	const load = useStore.getState().loadEarlierTranscript("s1");
	fullLoads.shift()!(FULL);
	await load;
	expect(texts()).toEqual(["u1", "a1", "u2", "a2"]);
	expect(useStore.getState().sessionsById.s1?.readOnly?.earlier).toBeUndefined();
	expect(useStore.getState().sessionsById.s1?.usage.totalTokens).toBe(30);
});

test("a full load that lands after the chat was closed and reopened is dropped", async () => {
	await useStore.getState().openTranscript(PATH);
	const load = useStore.getState().loadEarlierTranscript("s1");
	await useStore.getState().disposeSession("s1");
	await useStore.getState().openTranscript(PATH);
	fullLoads.shift()!(FULL);
	await load;
	// The reopened chat still shows its own tail and can still load the rest.
	expect(texts()).toEqual(["u2", "a2"]);
	expect(useStore.getState().sessionsById.s1?.readOnly?.earlier).toBe(2);
});

test("a worker restart during a full load keeps the restart notice and drops the stale response", async () => {
	useStore.getState().connect();
	sockets.at(-1)!.emit("message", { type: "hello", workerGeneration: "old", connectionId: "c1", backend: null, capabilities: [] });
	await useStore.getState().openTranscript(PATH);
	const load = useStore.getState().loadEarlierTranscript("s1");
	sockets.at(-1)!.emit("close");
	useStore.getState().ws?.connect();
	sockets.at(-1)!.emit("message", { type: "hello", workerGeneration: "new", connectionId: "c2", backend: null, capabilities: [] });
	fullLoads.shift()!(FULL);
	await load;
	let s1 = useStore.getState().sessionsById.s1;
	expect(texts()).toEqual(["u2", "a2"]);
	expect(s1?.endedByRestart).toBe(true);
	expect(s1?.readOnly?.earlier).toBe(2);

	// Loading again against the new worker applies, and the notice stays.
	const again = useStore.getState().loadEarlierTranscript("s1");
	fullLoads.shift()!(FULL);
	await again;
	s1 = useStore.getState().sessionsById.s1;
	expect(texts()).toEqual(["u1", "a1", "u2", "a2"]);
	expect(s1?.endedByRestart).toBe(true);
});
