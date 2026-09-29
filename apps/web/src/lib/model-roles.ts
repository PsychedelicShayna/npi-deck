import type { ModelInfo, NpiConfigPatchResponse, NpiModelRolePool } from "@npi-deck/protocol";

/**
 * What each built-in NeoPi role is for. NeoPi's role metadata carries a name and
 * tag but no prose; these summarize its docs (settings.md, local-models.md) and
 * the call sites that resolve each role. Custom roles get none.
 */
export const ROLE_DESCRIPTIONS: Readonly<Record<string, string>> = {
	default: "The model new chats start with; * and @default select it.",
	smol: "Fast, cheap model for quick internal work such as edit auto-repair and extraction.",
	slow: "Thinking model for hard problems. The advisor and chronicler roles follow it while they are unset.",
	vision: "Answers questions about images when the active model cannot see them.",
	plan: "The architect model plan mode switches to.",
	commit: "Writes commit messages; falls back to smol, then the chat roles.",
	tiny: "Very small model for session titles and similar one-line jobs; takes tiny catalog models as well as chat models.",
	memory: "Memory extraction and consolidation; while unset it follows tiny, then the smol list.",
	task: "Default model for subagents the task tool starts.",
	advisor: "Second-opinion reviewer that watches each turn while the advisor is on. The Advisors view sets this role too.",
	chronicler: "Background Chronicler capture; while unset it follows the slow chain.",
	prose: "Model for post-processing chain steps that name none; falls back to smol.",
	image: "Image generation for the generate_image tool.",
	web: "Search backend or grounded chat model behind the web_search tool.",
	speech: "Text-to-speech model.",
	dictation: "Speech-to-text model for microphone input.",
	judge: "Small typed decisions: the auto thinking level, unexpected-stop detection, git AI staging and the judge() helper.",
};

/** A role's editor state: unset, a listed model (with an optional thinking suffix), or free selector text. */
export type RoleChoice =
	| { kind: "unset" }
	| { kind: "model"; model: string; thinking: string }
	| { kind: "custom"; text: string };

export const modelKey = (model: Pick<ModelInfo, "provider" | "id">) => `${model.provider}/${model.id}`;

/**
 * Read a configured selector back into the editor. A listed model id wins as is
 * (ids such as `llama3:8b` contain colons); otherwise a trailing thinking level
 * on a listed model splits off. Anything else (role aliases, comma lists,
 * models without credentials) stays editable as text.
 */
export function parseRoleChoice(value: string | null, listed: ReadonlySet<string>, thinkingLevels: readonly string[]): RoleChoice {
	if (value === null) return { kind: "unset" };
	if (listed.has(value)) return { kind: "model", model: value, thinking: "" };
	const colon = value.lastIndexOf(":");
	if (colon > 0) {
		const model = value.slice(0, colon);
		const thinking = value.slice(colon + 1);
		if (listed.has(model) && thinkingLevels.includes(thinking)) return { kind: "model", model, thinking };
	}
	return { kind: "custom", text: value };
}

/** The selector a choice writes: null removes the role, undefined means the text is not a selector yet. */
export function roleSelector(choice: RoleChoice): string | null | undefined {
	if (choice.kind === "unset") return null;
	if (choice.kind === "model") return choice.thinking ? `${choice.model}:${choice.thinking}` : choice.model;
	const text = choice.text.trim();
	return text === "" ? undefined : text;
}

/**
 * The models a role's picker offers: the pool NeoPi judged available for the
 * role, labelled from `/api/models`, grouped by provider. The pool also holds
 * keyless runner models (`local/…`, `web/…`) that `/api/models` does not list;
 * those show under their id. A listed model the deck marks unavailable (its key
 * is a placeholder) is left out, and mixtures come from `/api/models` when the
 * role takes them. Mixtures (the user's own compositions) come first, then
 * providers alphabetically.
 */
export function roleModelOptions(models: readonly ModelInfo[], pool: NpiModelRolePool): Array<{ provider: string; mixtures: boolean; models: ModelInfo[] }> {
	const listed = new Map(models.map(model => [modelKey(model), model]));
	const offered: ModelInfo[] = [];
	for (const key of pool.models) {
		const model = listed.get(key);
		if (model) {
			if (model.isAvailable) offered.push(model);
			continue;
		}
		const slash = key.indexOf("/");
		const id = key.slice(slash + 1);
		offered.push({ provider: key.slice(0, slash), id, label: id, isAvailable: true });
	}
	if (pool.mixtures) {
		const inPool = new Set(pool.models);
		offered.push(...models.filter(model => model.isMixture && model.isAvailable && !inPool.has(modelKey(model))));
	}
	const groups = new Map<string, ModelInfo[]>();
	for (const model of offered) {
		const group = groups.get(model.provider) ?? [];
		group.push(model);
		groups.set(model.provider, group);
	}
	return [...groups.entries()]
		.map(([provider, items]) => ({
			provider,
			mixtures: items.some(model => model.isMixture),
			models: items.sort((a, b) => a.label.localeCompare(b.label)),
		}))
		.sort((a, b) => a.mixtures !== b.mixtures ? (a.mixtures ? -1 : 1) : a.provider.localeCompare(b.provider));
}

/** One role's selector inside a live chat's effective `modelRoles` record (NeoPi joins a list with commas). */
function liveRoleValue(record: unknown, role: string): string | undefined {
	if (typeof record !== "object" || record === null) return undefined;
	const value = (record as Record<string, unknown>)[role];
	if (typeof value === "string") return value;
	return Array.isArray(value) && value.every(entry => typeof entry === "string") ? value.join(",") : undefined;
}

/**
 * After a role write: how many live chats now resolve the role to what was
 * saved, and which ones a project or runtime layer or a failed reload holds back.
 */
export function roleLiveSummary(result: NpiConfigPatchResponse, role: string, selector: string | null): { text: string; complete: boolean } {
	const saved = selector === null ? `Unset ${role}; NeoPi's built-in chain applies.` : `Saved ${role}.`;
	if (result.live.length === 0) return { text: `${saved} No live chats to reload.`, complete: true };
	const chats = (n: number) => `${n} live chat${n === 1 ? "" : "s"}`;
	const failed = result.live.filter(live => live.reloadFailed).length;
	const held = result.live.filter(live => !live.reloadFailed && liveRoleValue(live.effectiveValue, role) !== (selector ?? undefined)).length;
	const parts = [`${saved} Live chats using it now: ${result.live.length - failed - held} of ${result.live.length}.`];
	if (held) parts.push(`${chats(held)} ${held === 1 ? "keeps" : "keep"} a value from a project or runtime layer.`);
	if (failed) parts.push(`${chats(failed)} failed to reload and ${failed === 1 ? "keeps its" : "keep their"} previous settings; the server log has details.`);
	return { text: parts.join(" "), complete: failed === 0 && held === 0 };
}
