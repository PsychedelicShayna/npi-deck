import { expect, test } from "bun:test";

import { addRefusal, chainAt, withFallbackMoved, withFallbackRemoved } from "./fallback-chain";

const model = "anthropic/claude-opus-5-5";

test("the primary and entries already in the chain are refused; other efforts of a model are not", () => {
	const chain = ["zai/glm-5.3", "openai-codex/gpt-6-sol:medium"];
	expect(addRefusal(chain, model, model)).toContain("primary");
	expect(addRefusal(chain, "zai/glm-5.3", model)).toContain("already");
	expect(addRefusal(chain, `${model}:low`, model)).toBeUndefined();
	expect(addRefusal(chain, "openai-codex/gpt-6-sol", model)).toBeUndefined();
});

test("moves swap neighbours and stop at either end; removal keeps the rest in order", () => {
	const chain = ["a/1", "b/2", "c/3"];
	expect(withFallbackMoved(chain, 2, -1)).toEqual(["a/1", "c/3", "b/2"]);
	expect(withFallbackMoved(chain, 0, 1)).toEqual(["b/2", "a/1", "c/3"]);
	expect(withFallbackMoved(chain, 0, -1)).toBeUndefined();
	expect(withFallbackMoved(chain, 2, 1)).toBeUndefined();
	expect(chain).toEqual(["a/1", "b/2", "c/3"]);
	expect(withFallbackRemoved(chain, 1)).toEqual(["a/1", "c/3"]);
});

test("a chain is read from the configured record; a missing key or malformed value reads as no chain", () => {
	expect(chainAt({ [model]: ["zai/glm-5.3"], default: ["x/y"] }, model)).toEqual(["zai/glm-5.3"]);
	expect(chainAt({ default: ["x/y"] }, model)).toEqual([]);
	expect(chainAt(null, model)).toEqual([]);
	expect(chainAt(["not", "a", "record"], model)).toEqual([]);
	expect(chainAt({ [model]: "zai/glm-5.3" }, model)).toEqual([]);
});
