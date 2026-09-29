import { Hono } from "hono";

import { hasFeature } from "./backend/runtime.ts";
import type { AgentBridge } from "./bridge/types.ts";
import { logger } from "./log.ts";

const log = logger("routes:fallback-chain");

/**
 * #31: the fallback chain that covers a live chat's active model, for the
 * model picker. Edits go through `PATCH /api/npi-config` (`retry.fallbackChains`
 * with `entries`), which validates, writes config.yml and reloads live chats.
 */
export function buildFallbackChainRouter(bridge: AgentBridge): Hono {
	const app = new Hono();

	app.get("/sessions/:id/fallback-chain", async c => {
		if (!hasFeature("fallback-chains")) return c.json({ error: "This NeoPi backend cannot resolve fallback chains." }, 501);
		try {
			const body = await bridge.fallbackChain(c.req.param("id"));
			if (!body) return c.json({ error: "session not found, not active, or without a model" }, 404);
			return c.json(body);
		} catch (err) {
			log.error("resolve fallback chain failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	return app;
}
