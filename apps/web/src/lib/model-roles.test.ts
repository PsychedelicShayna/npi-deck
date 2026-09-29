/**
 * Settings → Model roles (#59): what each role's picker offers, how a
 * configured selector reads back into it, what a save writes, and how the
 * live-chat outcome is reported.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { ModelInfo, NpiConfigPatchResponse, NpiModelRole } from "@npi-deck/protocol";

import { RoleRow } from "../components/settings/ModelRolesSection";
import { parseRoleChoice, roleLiveSummary, roleModelOptions, roleSelector } from "./model-roles";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
const model = (provider: string, id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ provider, id, label: id, isAvailable: true, ...extra });
const MODELS = [
	model("openai", "gpt-5"),
	model("anthropic", "claude-opus-5-5", { label: "Claude Opus 5.5" }),
	model("ollama", "llama3:8b"),
	model("openai", "gpt-image-1"),
	model("anthropic", "claude-haiku", { isAvailable: false }),
	model("mixture", "council", { isMixture: true }),
];
const CHAT_POOL = { models: ["openai/gpt-5", "anthropic/claude-opus-5-5", "ollama/llama3:8b", "anthropic/claude-haiku"], mixtures: true };
const IMAGE_POOL = { models: ["openai/gpt-image-1"], mixtures: false };

describe("role picker options", () => {
	test("offer only credentialed models the role accepts, mixtures first", () => {
		const groups = roleModelOptions(MODELS, CHAT_POOL);
		expect(groups.map(g => g.provider)).toEqual(["mixture", "anthropic", "ollama", "openai"]);
		expect(groups.flatMap(g => g.models.map(m => `${m.provider}/${m.id}`))).toEqual(["mixture/council", "anthropic/claude-opus-5-5", "ollama/llama3:8b", "openai/gpt-5"]);
		// A model-kind role sees its own kind only, and no mixtures.
		expect(roleModelOptions(MODELS, IMAGE_POOL).flatMap(g => g.models.map(m => m.id))).toEqual(["gpt-image-1"]);
		// Keyless runner models NeoPi offers but /api/models does not list still appear, under their id.
		expect(roleModelOptions(MODELS, { models: ["local/kokoro"], mixtures: false })).toEqual([
			{ provider: "local", mixtures: false, models: [{ provider: "local", id: "kokoro", label: "kokoro", isAvailable: true }] },
		]);
	});
});

describe("configured selectors in the editor", () => {
	const listed = new Set(["openai/gpt-5", "ollama/llama3:8b"]);
	test("a listed model, alone or with a thinking level, selects that model", () => {
		expect(parseRoleChoice("openai/gpt-5", listed, LEVELS)).toEqual({ kind: "model", model: "openai/gpt-5", thinking: "" });
		expect(parseRoleChoice("openai/gpt-5:high", listed, LEVELS)).toEqual({ kind: "model", model: "openai/gpt-5", thinking: "high" });
		// A colon that is part of a listed id is not a thinking level.
		expect(parseRoleChoice("ollama/llama3:8b", listed, LEVELS)).toEqual({ kind: "model", model: "ollama/llama3:8b", thinking: "" });
	});
	test("aliases, lists, unknown suffixes and uncredentialed models stay as text; null is unset", () => {
		for (const value of ["@slow", "openai/gpt-5,@smol", "openai/gpt-5:turbo", "anthropic/claude-haiku"])
			expect(parseRoleChoice(value, listed, LEVELS)).toEqual({ kind: "custom", text: value });
		expect(parseRoleChoice(null, listed, LEVELS)).toEqual({ kind: "unset" });
	});
	test("the written selector: model plus suffix, trimmed text, null to unset, nothing for blank text", () => {
		expect(roleSelector({ kind: "model", model: "openai/gpt-5", thinking: "medium" })).toBe("openai/gpt-5:medium");
		expect(roleSelector({ kind: "model", model: "openai/gpt-5", thinking: "" })).toBe("openai/gpt-5");
		expect(roleSelector({ kind: "custom", text: "  @slow " })).toBe("@slow");
		expect(roleSelector({ kind: "custom", text: "  " })).toBeUndefined();
		expect(roleSelector({ kind: "unset" })).toBeNull();
	});
});

describe("live chats after a role save", () => {
	const live = (effectiveValue: unknown, reloadFailed = false): NpiConfigPatchResponse["live"][number] =>
		({ sessionId: "s", cwd: "/w", provenance: "global", effectiveValue, ...(reloadFailed ? { reloadFailed: true as const } : {}) });
	const result = (...entries: NpiConfigPatchResponse["live"]): NpiConfigPatchResponse =>
		({ setting: {} as NpiConfigPatchResponse["setting"], live: entries });

	test("counts chats that now use the role, ones a higher layer holds, and failed reloads", () => {
		const summary = roleLiveSummary(result(
			live({ smol: "openai/gpt-5", review: "x/y" }),
			live({ smol: "anthropic/claude-opus-5-5" }),
			live({}, true),
		), "smol", "openai/gpt-5");
		expect(summary.complete).toBe(false);
		expect(summary.text).toContain("Live chats using it now: 1 of 3.");
		expect(summary.text).toContain("1 live chat keeps a value from a project or runtime layer");
		expect(summary.text).toContain("1 live chat failed to reload");
	});
	test("unsetting counts chats where no layer assigns the role any more", () => {
		const summary = roleLiveSummary(result(live({ review: "x/y" }), live({ smol: ["a/b", "@slow"] })), "smol", null);
		expect(summary.text).toContain("Live chats using it now: 1 of 2.");
		expect(roleLiveSummary(result(), "smol", "a/b")).toEqual({ text: "Saved smol. No live chats to reload.", complete: true });
	});
});

describe("role row", () => {
	const role = (patch: Partial<NpiModelRole>): NpiModelRole => ({
		id: "slow", name: "Thinking", tag: "SLOW", section: "chat", builtin: true, hidden: false,
		value: null, effectiveValue: null, provenance: "default", patterns: ["anthropic/claude-opus-5-5"], pool: 0, ...patch,
	});
	const render = (r: NpiModelRole, pool = CHAT_POOL) => renderToStaticMarkup(createElement(RoleRow, {
		role: r, pool, models: MODELS, thinkingLevels: LEVELS, cwd: "/w", disabled: false, onSaved: async () => {},
	}));

	test("an unset role says so, shows NeoPi's built-in chain, and what it resolves to", () => {
		const html = render(role({ resolved: { provider: "anthropic", modelId: "claude-opus-5-5" } }));
		expect(html).toContain("unset");
		expect(html).toContain("Built-in chain: anthropic/claude-opus-5-5");
		expect(html).toContain("Resolves to anthropic/claude-opus-5-5.");
		expect(html).toMatch(/<option value="" selected="">Unset/);
		expect(render(role({ id: "task", patterns: [] }))).toContain("No built-in chain: while unset, NeoPi falls back to another role");
	});
	test("a model with a thinking level selects both; a project override is called out", () => {
		const html = render(role({ value: "openai/gpt-5:high", effectiveValue: "ollama/llama3:8b", provenance: "project" }));
		expect(html).toMatch(/<option value="openai\/gpt-5" selected="">/);
		expect(html).toMatch(/<option value="high" selected="">/);
		expect(html).toContain("A project layer assigns ollama/llama3:8b in /w; saving here changes the global file only.");
		expect(html).toContain("No model with credentials matches");
	});
	test("an alias stays editable as a custom selector; a custom role is labelled", () => {
		const html = render(role({ id: "review", name: "review", builtin: false, value: "@slow", provenance: "global" }));
		expect(html).toMatch(/<option value="__custom__" selected="">/);
		expect(html).toContain('value="@slow"');
		expect(html).toContain("custom");
		expect(html).toContain("@review selects it");
	});
});
