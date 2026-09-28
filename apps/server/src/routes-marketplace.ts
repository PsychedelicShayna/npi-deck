import { Hono } from "hono";
import type {
	AddMarketplaceRequest,
	InstallPluginRequest,
	InstallPluginResponse,
	ListMarketplaceResponse,
	MarketplaceSource,
	UninstallPluginRequest,
} from "@npi-deck/protocol";

import { logger } from "./log.ts";
import type { MarketplaceService } from "./marketplace-service.ts";

const log = logger("routes:marketplace");

export function buildMarketplaceRouter(service: MarketplaceService): Hono {
	const app = new Hono();

	app.get("/marketplace", async (c) => {
		try {
			const body: ListMarketplaceResponse = await service.listCatalog();
			return c.json(body);
		} catch (err) {
			log.error(`listCatalog failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.post("/marketplace/install", async (c) => {
		let body: InstallPluginRequest;
		try {
			body = (await c.req.json()) as InstallPluginRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.name || !body.marketplace) {
			return c.json({ error: "name and marketplace are required" }, 400);
		}
		try {
			const installed = await service.install({
				name: body.name,
				marketplace: body.marketplace,
				...(body.scope ? { scope: body.scope } : {}),
				...(body.force ? { force: true } : {}),
			});
			const resp: InstallPluginResponse = { ok: true, installed };
			return c.json(resp);
		} catch (err) {
			log.error(`install failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.post("/marketplace/uninstall", async (c) => {
		let body: UninstallPluginRequest;
		try {
			body = (await c.req.json()) as UninstallPluginRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.id) return c.json({ error: "id is required" }, 400);
		try {
			await service.uninstall({ id: body.id, ...(body.scope ? { scope: body.scope } : {}) });
			return c.json({ ok: true });
		} catch (err) {
			log.error(`uninstall failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.post("/marketplace/refresh", async (c) => {
		try {
			await service.refresh();
			return c.json({ ok: true });
		} catch (err) {
			log.error(`refresh failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.post("/marketplaces", async (c) => {
		let body: AddMarketplaceRequest;
		try {
			body = (await c.req.json()) as AddMarketplaceRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.source) return c.json({ error: "source is required" }, 400);
		try {
			const added: MarketplaceSource = await service.addMarketplace(body.source);
			return c.json({ ok: true, marketplace: added });
		} catch (err) {
			log.error(`addMarketplace failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.delete("/marketplaces/:name", async (c) => {
		const name = c.req.param("name");
		try {
			await service.removeMarketplace(name);
			return c.json({ ok: true });
		} catch (err) {
			log.error(`removeMarketplace failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	return app;
}
