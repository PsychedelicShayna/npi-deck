/**
 * A prompt whose slash command the deck or SDK handles itself never starts an
 * agent run, so no `agent_end` follows. The sender must still learn that its
 * request completed (Telegram's per-chat queue waits on it).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerFrame } from "@npi-deck/protocol";

import { WsHub } from "./ws.ts";

type Bridge = ConstructorParameters<typeof WsHub>[0];

let hub: WsHub | null = null;

afterEach(() => {
	hub?.dispose();
	hub = null;
});

function setup(handle: Record<string, unknown>) {
	const prompted: string[] = [];
	const bridge = {
		getSession: () => ({
			prompt: async (text: string) => {
				prompted.push(text);
			},
			...handle,
		}),
		bumpActivity: () => {},
	} as unknown as Bridge;
	hub = new WsHub(bridge);
	const sent: ServerFrame[] = [];
	const ws = {
		data: hub.createConnectionData(),
		send: (raw: string) => sent.push(JSON.parse(raw) as ServerFrame),
	} as unknown as Parameters<WsHub["onMessage"]>[0];
	const promptFrame = (text: string) => hub!.onMessage(ws, JSON.stringify({ type: "prompt", sessionId: "s", text }));
	return { sent, prompted, promptFrame };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("WsHub prompt", () => {
	test("a deck-consumed slash command answers the sender with prompt_consumed", async () => {
		const { sent, prompted, promptFrame } = setup({
			dispatchDeckSlashCommand: async () => ({ kind: "consumed", output: "No tasks." }),
		});
		await promptFrame("/task list");
		await settle();
		expect(sent).toEqual([{ type: "prompt_consumed", sessionId: "s", output: "No tasks." }]);
		expect(prompted).toEqual([]);
	});

	test("an SDK-consumed slash command answers the sender with prompt_consumed", async () => {
		const { sent, promptFrame } = setup({
			dispatchDeckSlashCommand: async () => ({ kind: "fallthrough" }),
			dispatchSlashCommand: async () => ({ kind: "consumed", output: "Done." }),
		});
		await promptFrame("/usage");
		await settle();
		expect(sent).toEqual([{ type: "prompt_consumed", sessionId: "s", output: "Done." }]);
	});

	test("a slash command that falls through reaches the agent without prompt_consumed", async () => {
		const { sent, prompted, promptFrame } = setup({
			dispatchDeckSlashCommand: async () => ({ kind: "fallthrough" }),
			dispatchSlashCommand: async () => ({ kind: "fallthrough" }),
		});
		await promptFrame("/skill:foo");
		await settle();
		expect(sent).toEqual([]);
		expect(prompted).toEqual(["/skill:foo"]);
	});
});
