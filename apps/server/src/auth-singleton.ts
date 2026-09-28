/**
 * Process-wide, lazily-constructed AuthStorage + ModelRegistry. Both the
 * in-process bridge and the new `/api/auth/oauth` routes need a single
 * shared instance so:
 *
 * - OAuth login() mutates the same `#data` Map that the bridge's
 *   ModelRegistry reads via `hasConfiguredAuth(model)` — see the SDK
 *   findings memo (docs/oauth-deck-sdk-findings.md) for the live-read
 *   pathway through `authStorage.hasAuth`. Two AuthStorage instances
 *   would break this and force a `registry.refresh()` after every login.
 * - The routes can call `registry.refreshProvider(provider, "online")`
 *   as a belt-and-suspenders catalog refresh for dynamic-discovery
 *   providers after a successful OAuth.
 *
 * The bridge owns the registry lifecycle (offline refresh on first
 * resolve, background online refresh after that). Routes consume only.
 */
import type { AuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { sdk } from "./backend/runtime.ts";
import { logger } from "./log.ts";

const log = logger("auth-singleton");

let registryPromise: Promise<ModelRegistry> | undefined;

export function getDeckModelRegistry(): Promise<ModelRegistry> {
	if (registryPromise) return registryPromise;
	registryPromise = (async () => {
		const { discoverAuthStorage, ModelRegistry } = sdk();
		const auth = await discoverAuthStorage();
		const registry = new ModelRegistry(auth);
		// Offline refresh = read models.yml + built-ins; online runs in background.
		// Mirrors the bridge's previous behavior exactly so boot stays fast.
		await registry.refresh("offline");
		registry.refreshInBackground("online");
		log.info("model registry ready");
		return registry;
	})();
	return registryPromise;
}

export async function getDeckAuthStorage(): Promise<AuthStorage> {
	const registry = await getDeckModelRegistry();
	return registry.authStorage;
}
