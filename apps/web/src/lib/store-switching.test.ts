import { afterEach, beforeEach, expect, test } from "bun:test";
import { dropDraft, readDraft, saveDraft } from "./composer-drafts";
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

interface Pending { url: string; method: string; body?: string; resolve: (body: unknown) => void }
/** Requests the test answers explicitly, in any order. */
let pending: Pending[] = [];
const original = { WebSocket: globalThis.WebSocket, location: globalThis.location, fetch: globalThis.fetch };

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const transcript = (id: string, extra: Record<string, unknown> = {}) => ({ sessionId: id, path: `/s/${id}.jsonl`, cwd: "/tmp", messages: [user(`${id} says hi`)], ...extra });
const snapshot = (id: string) => ({ sessionId: id, cwd: "/tmp", sessionFile: `/s/${id}.jsonl`, isStreaming: false, messages: [user(`${id} live`)], todoPhases: [], queuedPrompts: [] });

function answer(match: (p: Pending) => boolean, body: unknown): Pending {
	const i = pending.findIndex(match);
	if (i < 0) throw new Error(`no pending request; have ${pending.map((p) => `${p.method} ${p.url}`).join(", ")}`);
	const [p] = pending.splice(i, 1);
	p!.resolve(body);
	return p!;
}
const transcriptOf = (id: string) => (p: Pending) => p.url.includes("/sessions/transcript") && p.url.includes(encodeURIComponent(`/s/${id}.jsonl`));
const resumeOf = (id: string) => (p: Pending) => p.method === "POST" && p.url.endsWith("/sessions") && p.body!.includes(`/s/${id}.jsonl`);
const sent = () => sockets.at(-1)!.sent.map((raw) => JSON.parse(raw) as { type: string; sessionId?: string; text?: string });
const settle = () => Bun.sleep(0);

beforeEach(() => {
	pending = [];
	useStore.getState().disconnect();
	useStore.setState({ workerGeneration: undefined, sessionsById: {}, activeId: undefined, subscribed: new Set<string>() });
	Object.assign(globalThis, {
		WebSocket: FakeSocket,
		location: { protocol: "http:", host: "localhost" },
		fetch: (url: string, init?: RequestInit) => {
			if (url.includes("/workspaces")) return Promise.resolve(Response.json({ workspaces: [], defaultCwd: "/tmp" }));
			if (url.includes("/sessions") && !url.includes("transcript") && (init?.method ?? "GET") === "GET") return Promise.resolve(Response.json({ sessions: [] }));
			return new Promise<Response>((resolve) => pending.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined, resolve: (body) => resolve(Response.json(body)) }));
		},
	});
	useStore.getState().connect();
	sockets.at(-1)!.emit("message", { type: "hello", workerGeneration: "w", connectionId: "c1", backend: null, capabilities: [] });
});

afterEach(() => {
	for (const p of pending) p.resolve({});
	useStore.getState().disconnect();
	Object.assign(globalThis, original);
});

test("a transcript that loads after the reader moved on does not take the view", async () => {
	const slow = useStore.getState().openTranscript("/s/bravo.jsonl");
	const fast = useStore.getState().openTranscript("/s/echo.jsonl");
	answer(transcriptOf("echo"), transcript("echo"));
	await fast;
	answer(transcriptOf("bravo"), transcript("bravo"));
	await slow;
	expect(useStore.getState().activeId).toBe("echo");
	expect(useStore.getState().sessionsById.echo?.readOnly).toBeDefined();
});

test("a transcript that loads after a live session was selected does not take the view", async () => {
	sockets.at(-1)!.emit("message", { type: "subscribed", sessionId: "alpha", snapshot: snapshot("alpha") });
	const slow = useStore.getState().openTranscript("/s/bravo.jsonl");
	useStore.getState().selectSession("alpha");
	answer(transcriptOf("bravo"), transcript("bravo"));
	await slow;
	expect(useStore.getState().activeId).toBe("alpha");
});

test("a resume that finishes after the reader switched away leaves them where they are", async () => {
	await Promise.all([useStore.getState().openTranscript("/s/alpha.jsonl"), settle().then(() => answer(transcriptOf("alpha"), transcript("alpha")))]);
	const resume = useStore.getState().resumeSession("alpha");
	await settle();
	const other = useStore.getState().openTranscript("/s/charlie.jsonl");
	answer(transcriptOf("charlie"), transcript("charlie"));
	await other;
	answer(resumeOf("alpha"), { sessionId: "alpha", sessionFile: "/s/alpha.jsonl", cwd: "/tmp" });
	await resume;
	const state = useStore.getState();
	expect(state.activeId).toBe("charlie");
	expect(state.sessionsById.alpha?.readOnly).toBeUndefined();
	expect(sent()).toContainEqual({ type: "subscribe", sessionId: "alpha" });
});

test("a prompt sent from a read-only chat goes to that chat even if the reader switches during the resume", async () => {
	await Promise.all([useStore.getState().openTranscript("/s/delta.jsonl"), settle().then(() => answer(transcriptOf("delta"), transcript("delta")))]);
	sockets.at(-1)!.emit("message", { type: "subscribed", sessionId: "alpha", snapshot: snapshot("alpha") });
	useStore.getState().sendPrompt("for delta");
	await settle();
	useStore.getState().selectSession("alpha");
	answer(resumeOf("delta"), { sessionId: "delta", sessionFile: "/s/delta.jsonl", cwd: "/tmp" });
	await Bun.sleep(5);
	const prompts = sent().filter((f) => f.type === "prompt");
	expect(prompts).toEqual([{ type: "prompt", sessionId: "delta", text: "for delta" }]);
	expect(useStore.getState().activeId).toBe("alpha");
});

test("resuming a chat twice while the first resume runs opens it once", async () => {
	await Promise.all([useStore.getState().openTranscript("/s/alpha.jsonl"), settle().then(() => answer(transcriptOf("alpha"), transcript("alpha")))]);
	const first = useStore.getState().resumeSession("alpha");
	const second = useStore.getState().resumeSession("alpha");
	await settle();
	expect(pending.filter(resumeOf("alpha"))).toHaveLength(1);
	answer(resumeOf("alpha"), { sessionId: "alpha", sessionFile: "/s/alpha.jsonl", cwd: "/tmp" });
	expect(await Promise.all([first, second])).toEqual(["alpha", "alpha"]);
});

test("a session running on the server opens live and subscribes instead of showing its file read-only", async () => {
	const open = useStore.getState().openTranscript("/s/alpha.jsonl");
	answer(transcriptOf("alpha"), transcript("alpha", { live: true }));
	await open;
	const state = useStore.getState();
	expect(state.activeId).toBe("alpha");
	expect(state.sessionsById.alpha?.readOnly).toBeUndefined();
	expect(sent()).toContainEqual({ type: "subscribe", sessionId: "alpha" });
});

test("a live chat the server no longer runs stays on screen read-only and resumable", async () => {
	useStore.getState().selectSession("alpha");
	sockets.at(-1)!.emit("message", { type: "subscribed", sessionId: "alpha", snapshot: snapshot("alpha") });
	// Reconnect after the idle reaper disposed it: the resubscribe is refused.
	sockets.at(-1)!.emit("message", { type: "session_disposed", sessionId: "alpha" });
	let state = useStore.getState();
	expect(state.activeId).toBe("alpha");
	expect(state.sessionsById.alpha?.readOnly?.path).toBe("/s/alpha.jsonl");
	expect(state.sessionsById.alpha?.messages.length).toBe(1);
	expect(state.subscribed.has("alpha")).toBe(false);

	// Sending resumes it, then prompts, rather than posting to a dead session.
	useStore.getState().sendPrompt("still there?");
	await settle();
	expect(sent().filter((f) => f.type === "prompt")).toEqual([]);
	answer(resumeOf("alpha"), { sessionId: "alpha", sessionFile: "/s/alpha.jsonl", cwd: "/tmp" });
	await Bun.sleep(5);
	state = useStore.getState();
	expect(sent().filter((f) => f.type === "prompt")).toEqual([{ type: "prompt", sessionId: "alpha", text: "still there?" }]);
	expect(state.subscribed.has("alpha")).toBe(true);
});

test("closing the chat on screen stops an open still in flight from taking the view", async () => {
	sockets.at(-1)!.emit("message", { type: "subscribed", sessionId: "alpha", snapshot: snapshot("alpha") });
	useStore.getState().selectSession("alpha");
	const open = useStore.getState().openTranscript("/s/bravo.jsonl");
	const close = useStore.getState().disposeSession("alpha");
	answer((p) => p.method === "DELETE", { ok: true });
	await close;
	answer(transcriptOf("bravo"), transcript("bravo"));
	await open;
	expect(useStore.getState().activeId).toBeUndefined();
});

test("closing a chat drops its unsent draft; other chats keep theirs", async () => {
	await Promise.all([useStore.getState().openTranscript("/s/echo.jsonl"), settle().then(() => answer(transcriptOf("echo"), transcript("echo")))]);
	await Promise.all([useStore.getState().openTranscript("/s/delta.jsonl"), settle().then(() => answer(transcriptOf("delta"), transcript("delta")))]);
	saveDraft("echo", { text: "for echo", images: [] });
	saveDraft("delta", { text: "for delta", images: [] });
	await useStore.getState().disposeSession("echo");
	expect(readDraft("echo")).toBeUndefined();
	expect(readDraft("delta")?.text).toBe("for delta");
	dropDraft("delta");
});

test("a chat reopened read-only after closing keeps its view when the slow close finishes", async () => {
	useStore.getState().selectSession("alpha");
	sockets.at(-1)!.emit("message", { type: "subscribed", sessionId: "alpha", snapshot: snapshot("alpha") });
	// DELETE answers 202 at once; the server disposes the chat in the background.
	const closing = useStore.getState().disposeSession("alpha");
	answer((p) => p.method === "DELETE" && p.url.endsWith("/sessions/alpha"), { ok: true });
	await closing;
	expect(useStore.getState().subscribed.has("alpha")).toBe(false);

	const open = useStore.getState().openTranscript("/s/alpha.jsonl");
	answer(transcriptOf("alpha"), transcript("alpha"));
	await open;
	const view = useStore.getState().sessionsById.alpha;
	expect(view?.readOnly?.path).toBe("/s/alpha.jsonl");

	// The close of the old live chat finishes now.
	sockets.at(-1)!.emit("message", { type: "session_disposed", sessionId: "alpha" });
	await settle();
	const state = useStore.getState();
	expect(state.sessionsById.alpha).toBe(view!);
	expect(state.activeId).toBe("alpha");
	expect(state.subscribed.has("alpha")).toBe(false);
	expect(pending.filter(transcriptOf("alpha"))).toEqual([]);
});

test("closing a live chat ends this connection's stream at once; a resume starts clean and stays subscribed", async () => {
	useStore.getState().selectSession("alpha");
	const socket = sockets.at(-1)!;
	socket.emit("message", { type: "subscribed", sessionId: "alpha", snapshot: snapshot("alpha") });
	// An ask dialog and a subagent tree are outstanding in alpha, and in bravo.
	const dialog = (sessionId: string) => ({ type: "ext_ui_dialog_open", sessionId, dialogId: `${sessionId}-ask`, kind: "confirm", prompt: "go on?" });
	const tree = (sessionId: string) => ({ type: "subagents_snapshot", sessionId, nodes: [{ id: `${sessionId}-child`, parentId: sessionId, name: "child", status: "running", createdAt: 1 }] });
	for (const id of ["alpha", "bravo"]) {
		socket.emit("message", dialog(id));
		socket.emit("message", tree(id));
	}
	// Unsubscribed before the slow close starts, so the server's session_disposed
	// for this generation never reaches a resume that finishes ahead of it.
	const closing = useStore.getState().disposeSession("alpha");
	expect(sent().filter((f) => f.type === "unsubscribe")).toEqual([{ type: "unsubscribe", sessionId: "alpha" }]);
	answer((p) => p.method === "DELETE" && p.url.endsWith("/sessions/alpha"), { ok: true });
	await closing;

	await Promise.all([useStore.getState().openTranscript("/s/alpha.jsonl"), settle().then(() => answer(transcriptOf("alpha"), transcript("alpha")))]);
	useStore.getState().sendPrompt("back again");
	await settle();
	answer(resumeOf("alpha"), { sessionId: "alpha", sessionFile: "/s/alpha.jsonl", cwd: "/tmp" });
	await Bun.sleep(5);
	socket.emit("message", { type: "subscribed", sessionId: "alpha", snapshot: snapshot("alpha") });
	let state = useStore.getState();
	expect(state.subscribed.has("alpha")).toBe(true);
	// The reopened chat shows neither the closed chat's dialog nor its tree; bravo keeps both.
	expect(state.pendingDialogs.alpha).toBeUndefined();
	expect(state.subagentsBySession.alpha).toBeUndefined();
	expect(state.pendingDialogs.bravo?.dialogId).toBe("bravo-ask");
	expect(state.subagentsBySession.bravo?.[0]?.id).toBe("bravo-child");
	// The reply to the close's unsubscribe arrives late: the resumed chat keeps its subscription.
	socket.emit("message", { type: "unsubscribed", sessionId: "alpha" });
	state = useStore.getState();
	expect(state.subscribed.has("alpha")).toBe(true);
});
