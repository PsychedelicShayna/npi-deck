import { expect, test } from "bun:test";
import { WsClient } from "./ws";

class Socket {
	static OPEN = 1;
	readyState = Socket.OPEN;
	listeners = new Map<string, Array<(event: { data: string }) => void>>();
	sent: string[] = [];
	constructor(_url: string) { sockets.push(this); }
	addEventListener(event: string, listener: (event: { data: string }) => void) {
		this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]);
	}
	emit(event: string, frame?: unknown) { for (const callback of this.listeners.get(event) ?? []) callback({ data: JSON.stringify(frame) }); }
	send(value: string) { this.sent.push(value); }
	close() { this.emit("close"); }
}
const sockets: Socket[] = [];

test("reconnect discards offline prompts across worker generations and waits for hello", () => {
	const oldSocket = globalThis.WebSocket;
	const oldLocation = globalThis.location;
	Object.assign(globalThis, { WebSocket: Socket, location: { protocol: "http:", host: "localhost" } });
	try {
		const client = new WsClient();
		client.connect();
		const first = sockets.at(-1)!;
		first.emit("open");
		client.send({ type: "prompt", sessionId: "s", text: "first" });
		expect(first.sent).toHaveLength(0);
		first.emit("message", { type: "hello", connectionId: "c1", workerGeneration: "a", backend: null, capabilities: [] });
		expect(first.sent.map(JSON.parse)).toEqual([{ type: "prompt", sessionId: "s", text: "first" }]);
		first.emit("close");
		client.send({ type: "prompt", sessionId: "s", text: "offline" });
		client.connect();
		const next = sockets.at(-1)!;
		next.emit("open");
		expect(next.sent).toHaveLength(0);
		next.emit("message", { type: "hello", connectionId: "c2", workerGeneration: "b", backend: null, capabilities: [] });
		expect(next.sent).toHaveLength(0);
		client.send({ type: "prompt", sessionId: "s", text: "explicit" });
		expect(next.sent.map(JSON.parse)).toEqual([{ type: "prompt", sessionId: "s", text: "explicit" }]);
		client.dispose();
	} finally { Object.assign(globalThis, { WebSocket: oldSocket, location: oldLocation }); }
});
