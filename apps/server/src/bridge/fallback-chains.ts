import type { AgentSession, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import type { ModelRef, SessionFallbackChainResponse } from "@npi-deck/protocol";

import { feature, hasFeature, sdk } from "../backend/runtime.ts";

type Chains = Record<string, string[]>;

/**
 * The retry fallback the deck gives a chat it starts on its default model
 * (see `InProcessAgentBridge.start`). Session-local: never written to config.yml.
 */
export interface DeckFallbacks {
	model: ModelRef;
	/** The primary's own chain key (`provider/id:effort`). */
	primaryKey: string;
	chains: Chains;
	/** Keys of `chains` the last {@link applyDeckFallbacks} put in force. */
	applied: Set<string>;
}

/** Whether a configured chain key is a model key naming `model`, at any effort. */
function namesModel(key: string, model: ModelRef, registry: ModelRegistry): boolean {
	// Without NeoPi's selector parser the deck cannot tell; its entries stay in force.
	if (!hasFeature("fallback-chains")) return false;
	const api = feature("fallback-chains");
	if (!api.isRetryFallbackModelKey(key) || api.isRetryFallbackWildcardKey(key)) return false;
	const parsed = api.parseRetryFallbackSelector(key, registry);
	return parsed?.provider === model.provider && parsed.id === model.id;
}

/**
 * Put the deck's fallbacks over the chat's configured `retry.fallbackChains`
 * as a runtime override. The primary's entry yields once the configuration
 * gives that model a chain of its own. A runtime override replaces the whole
 * record, so run this again after every settings reload: otherwise a later
 * config.yml edit never reaches the chat.
 */
export function applyDeckFallbacks(settings: Settings, deck: DeckFallbacks, registry: ModelRegistry): void {
	const setting = sdk().cfgRetryFallbackChains;
	setting.clearOverride(settings);
	const configured = setting.get(settings);
	const ownChain = Object.keys(configured).some(key => namesModel(key, deck.model, registry));
	const entries = Object.entries(deck.chains).filter(([key]) => !(ownChain && key === deck.primaryKey));
	deck.applied = new Set(entries.map(([key]) => key));
	setting.override(settings, { ...configured, ...Object.fromEntries(entries) });
}

/**
 * The chain NeoPi resolves for the chat's active model, with the key the
 * picker edits for that model. Resolution is NeoPi's own, over the chat's
 * settings; it omits the live role hint NeoPi adds while retrying, which
 * only matters when a role key and a matching model share no model key.
 */
export function describeFallbackChain(
	session: AgentSession,
	registry: ModelRegistry,
	deck: DeckFallbacks | undefined,
): SessionFallbackChainResponse | undefined {
	const model = session.model;
	if (!model) return undefined;
	const api = feature("fallback-chains");
	const settings = session.settings;
	const chains = api.getRetryFallbackChains(settings);
	const resolvedKey = api.resolveRetryFallbackChainKey(
		{ chains, getModelRole: role => settings.getModelRole(role), modelLookup: registry },
		api.formatRetryFallbackSelector(model, session.thinkingLevel),
		model,
	);
	const base = `${model.provider}/${model.id}`;
	const deckDefault = resolvedKey !== undefined && deck?.applied.has(resolvedKey) === true;
	const ownKey = resolvedKey !== undefined && !deckDefault && namesModel(resolvedKey, model, registry);
	const chain = resolvedKey === undefined ? undefined : chains[resolvedKey];
	return {
		model: base,
		key: ownKey ? resolvedKey : base,
		...(resolvedKey !== undefined && Array.isArray(chain)
			? { resolved: { key: resolvedKey, chain: [...chain], ...(deckDefault ? { deckDefault: true as const } : {}) } }
			: {}),
	};
}
