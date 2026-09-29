/**
 * A client that reconnects resubscribes to every chat it had open. A chat the
 * idle reaper stopped meanwhile must be reported as gone, so the client can
 * show it read-only and resume it instead of posting prompts into nothing.
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
