/**
 * /api/skills — skill enumeration across every omp provider, and authoring of
 * OMP user skills (#32).
 *
 * - `GET /api/skills?cwd=<abs>` lists every skill `loadCapability(skillCapability.id)`
 *   returns, native-first.
 * - `GET /api/skills/:id?cwd=<abs>` returns one skill's body + co-located files.
 *   `id` is the server-issued opaque identifier carried on every list row;
 *   clients never construct it from parts.
 * - `POST /api/skills` creates `<agentDir>/skills/<name>/SKILL.md`.
 * - `PUT /api/skills/:id` replaces an editable skill's description and body.
 * - `DELETE /api/skills/:id` removes an editable skill's directory.
 *
 * Only rows the listing marks `editable` can be changed; everything else
 * answers 403.
 */

import type { Context } from "hono";
import { Hono } from "hono";

import type { CreateSkillRequest, UpdateSkillRequest } from "@npi-deck/protocol";

import { logger } from "./log.ts";
import { SkillAuthoringError } from "./skill-authoring.ts";
import type { SkillsService } from "./skills-service.ts";

const log = logger("routes:skills");

async function jsonBody<T>(c: Context): Promise<T> {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		throw new SkillAuthoringError("JSON body required", 400);
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) throw new SkillAuthoringError("JSON object body required", 400);
	return body as T;
}

async function respond(c: Context, what: string, run: () => Promise<Response>): Promise<Response> {
	try {
		return await run();
	} catch (err) {
		if (err instanceof SkillAuthoringError) return c.json({ error: err.message }, err.status);
		log.error(`${what} failed`, err);
		return c.json({ error: String(err) }, 500);
	}
}

export function buildSkillsRouter(service: SkillsService): Hono {
	const app = new Hono();

	app.get("/skills", async (c) => {
		const cwd = c.req.query("cwd");
		try {
			const body = await service.listSkills(cwd);
			return c.json(body);
		} catch (err) {
			log.error(`listSkills failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/skills/:id", async (c) => {
		const id = c.req.param("id");
		const cwd = c.req.query("cwd");
		if (!id) return c.json({ error: "id is required" }, 400);
		try {
			const detail = await service.getSkillDetail(id, cwd);
			if (!detail) return c.json({ error: "skill not found" }, 404);
			return c.json(detail);
		} catch (err) {
			log.error(`getSkillDetail failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/skills", (c) =>
		respond(c, "createSkill", async () => {
			const body = await jsonBody<CreateSkillRequest>(c);
			return c.json(await service.createSkill(body, c.req.query("cwd")), 201);
		}),
	);

	app.put("/skills/:id", (c) =>
		respond(c, "updateSkill", async () => {
			const body = await jsonBody<UpdateSkillRequest>(c);
			return c.json(await service.updateSkill(c.req.param("id"), body, c.req.query("cwd")));
		}),
	);

	app.delete("/skills/:id", (c) =>
		respond(c, "deleteSkill", async () => {
			await service.deleteSkill(c.req.param("id"), c.req.query("cwd"));
			return c.json({ ok: true });
		}),
	);

	return app;
}
