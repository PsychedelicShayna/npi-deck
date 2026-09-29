/**
 * A client that reconnects resubscribes to every chat it had open. A chat the
 * idle reaper stopped meanwhile must be reported as gone, so the client can
 * show it read-only and resume it instead of posting prompts into nothing.
 * A chat reopened under the same id is a new session: a socket still holding
 * the old one's subscription must be moved onto it, not handed a snapshot.
 */
import { afterEach, expect, test } from "bun:test";
import type { ServerFrame } from "@npi-deck/protocol";

import { WsHub } from "./ws.ts";

type Bridge = ConstructorParameters<typeof WsHub>[0];

let hub: WsHub | null = null;

afterEach(() => {
	hub?.dispose();
	hub = null;
});

test("subscribing to a chat the server no longer runs reports it disposed", async () => {
	const bridge = { getSession: () => undefined } as unknown as Bridge;
	hub = new WsHub(bridge, "subscribe-test");
	const sent: ServerFrame[] = [];
	const ws = {
		data: hub.createConnectionData(),
		send: (raw: string) => sent.push(JSON.parse(raw) as ServerFrame),
	} as unknown as Parameters<WsHub["onMessage"]>[0];
	await hub.onMessage(ws, JSON.stringify({ type: "subscribe", sessionId: "reaped" }));
	expect(sent).toEqual([{ type: "session_disposed", sessionId: "reaped" }]);
});

test("resubscribing after the chat was reopened under the same id streams the reopened chat", async () => {
	type Listener = (event: unknown) => void;
	const handle = (name: string) => {
		const listeners = new Set<Listener>();
		return {
			name,
			listeners,
			subscribe: (l: Listener) => { listeners.add(l); return () => listeners.delete(l); },
			snapshot: () => ({ sessionId: "chat", name }),
			emit: (event: unknown) => { for (const l of listeners) l(event); },
		};
	};
	const old = handle("old");
	let live = old;
	const bridge = {
		getSession: () => live,
		bumpActivity: () => {},
		subscribeUiFrames: () => () => {},
		subscribePlanModeFrames: () => () => {},
		subscribeSubagents: () => () => {},
		trackSubscriberAdded: () => {},
		trackSubscriberRemoved: () => {},
	} as unknown as Bridge;
	hub = new WsHub(bridge, "subscribe-test");
	const sent: ServerFrame[] = [];
	const ws = {
		data: hub.createConnectionData(),
		send: (raw: string) => sent.push(JSON.parse(raw) as ServerFrame),
	} as unknown as Parameters<WsHub["onMessage"]>[0];
	await hub.onMessage(ws, JSON.stringify({ type: "subscribe", sessionId: "chat" }));

	// Disposed and resumed without this socket hearing session_disposed.
	const reopened = handle("reopened");
	live = reopened;
	await hub.onMessage(ws, JSON.stringify({ type: "subscribe", sessionId: "chat" }));
	expect(sent.at(-1)).toEqual({ type: "subscribed", sessionId: "chat", snapshot: { sessionId: "chat", name: "reopened" } } as never);
	expect(old.listeners.size).toBe(0);

	reopened.emit({ type: "message_start" });
	expect(sent.at(-1)).toEqual({ type: "session_event", sessionId: "chat", event: { type: "message_start" } } as never);
	// Asking again while it is still the same chat keeps one stream.
	await hub.onMessage(ws, JSON.stringify({ type: "subscribe", sessionId: "chat" }));
	expect(reopened.listeners.size).toBe(1);
});
