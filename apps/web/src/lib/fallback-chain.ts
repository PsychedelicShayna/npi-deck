/**
 * Chain edits for the model picker's fallback editor (#31). A chain is the
 * ordered list of selectors under one key of NeoPi's `retry.fallbackChains`.
 */

/** Why `entry` cannot be appended to `chain` for primary `model` (`provider/id`), or undefined. */
export function addRefusal(chain: readonly string[], entry: string, model: string): string | undefined {
	if (entry === model) return "The active model is the primary; it cannot be its own fallback.";
	if (chain.includes(entry)) return `${entry} is already in the chain.`;
	return undefined;
}

export function withFallbackAdded(chain: readonly string[], entry: string): string[] {
	return [...chain, entry];
}

export function withFallbackRemoved(chain: readonly string[], index: number): string[] {
	return chain.filter((_, i) => i !== index);
}

/** Swap the entry at `index` with its neighbour; undefined when it is already at that end. */
export function withFallbackMoved(chain: readonly string[], index: number, delta: -1 | 1): string[] | undefined {
	const target = index + delta;
	if (index < 0 || index >= chain.length || target < 0 || target >= chain.length) return undefined;
	const next = [...chain];
	[next[index], next[target]] = [next[target]!, next[index]!];
	return next;
}

/** The configured chain under `key` of a `retry.fallbackChains` value; empty when absent or malformed. */
export function chainAt(record: unknown, key: string): string[] {
	if (!record || typeof record !== "object" || Array.isArray(record)) return [];
	const chain = (record as Record<string, unknown>)[key];
	return Array.isArray(chain) ? chain.filter((entry): entry is string => typeof entry === "string") : [];
}

/** How a `retry.fallbackChains` key applies, in the words the picker uses. */
export function describeChainKey(key: string): string {
	if (key.endsWith("/*")) return `the ${key} provider wildcard`;
	if (key.includes("/")) return `the ${key} model chain`;
	if (key === "default") return "the default chain";
	return `the ${key} role chain`;
}
