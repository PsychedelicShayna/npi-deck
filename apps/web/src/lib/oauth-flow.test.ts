import { describe, expect, test } from "bun:test";
import type { ServerFrame } from "@omp-deck/protocol";

import { createOAuthFrameGate, type OAuthFlowFrame } from "./oauth-flow";

describe("createOAuthFrameGate", () => {
	test("a prompt broadcast before the start response reaches the flow once it is bound (R08)", () => {
		const seen: OAuthFlowFrame[] = [];
		const gate = createOAuthFrameGate("ollama", (f) => seen.push(f));
		// Ollama calls onAuth then onPrompt synchronously: both frames beat the HTTP response.
		gate.push({ type: "oauth_consent", flowId: "f1", provider: "ollama", url: "https://ollama.test/consent" });
		gate.push({ type: "oauth_prompt", flowId: "f1", provider: "ollama", promptId: "p1", message: "API key?" });
		expect(seen).toEqual([]);

		gate.bind("f1");
		expect(seen.map((f) => f.type)).toEqual(["oauth_consent", "oauth_prompt"]);

		gate.push({ type: "oauth_complete", flowId: "f1", provider: "ollama" });
		expect(seen.at(-1)?.type).toBe("oauth_complete");
	});

	test("frames from another provider or another flow never reach the modal", () => {
		const seen: OAuthFlowFrame[] = [];
		const gate = createOAuthFrameGate("anthropic", (f) => seen.push(f));
		gate.push({ type: "oauth_progress", flowId: "old", provider: "anthropic", message: "stale flow" });
		gate.push({ type: "oauth_progress", flowId: "x", provider: "openai-codex", message: "other provider" });
		gate.push({ type: "models_changed" } as ServerFrame);
		gate.bind("new");
		gate.push({ type: "oauth_failed", flowId: "old", provider: "anthropic", message: "late" });
		expect(seen).toEqual([]);
	});
});
