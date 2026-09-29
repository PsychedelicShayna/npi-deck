import { describe, expect, test } from "bun:test";

import { transcriptTail } from "./transcript-tail.ts";

const user = (n: number) => ({ role: "user", content: `u${n}` });
const assistant = (n: number) => ({ role: "assistant", content: `a${n}`, usage: { totalTokens: n } });
const toolResult = (n: number) => ({ role: "toolResult", content: `r${n}` });

describe("transcriptTail", () => {
	test("keeps the newest messages and reports each omitted assistant's usage", () => {
		const messages = [user(1), assistant(1), toolResult(1), assistant(2), user(2), assistant(3)];
		const tail = transcriptTail(messages, 2);
		expect(tail.messages).toEqual([user(2), assistant(3)]);
		// assistant(3) is sent, so its usage is not reported twice.
		expect(tail.omitted).toEqual({ count: 4, usage: [{ totalTokens: 1 }, { totalTokens: 2 }] });
	});

	test("a transcript within the limit, or no limit, is sent whole", () => {
		const messages = [user(1), assistant(1)];
		expect(transcriptTail(messages, 2)).toEqual({ messages });
		expect(transcriptTail(messages)).toEqual({ messages });
	});
});
