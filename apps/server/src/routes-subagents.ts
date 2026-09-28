import { Hono } from "hono";
import type { AgentBridge } from "./bridge/types.ts";

/** Transcript and kill are addressed by root session AND child id; no arbitrary file reads. */
export function buildSubagentsRouter(bridge: AgentBridge): Hono {
	const app = new Hono();
	app.get("/:sessionId", (c) => {
		const sessionId = c.req.param("sessionId");
		if (!bridge.getSession(sessionId)) return c.json({ error: "session not found" }, 404);
		return c.json({ nodes: bridge.subagentSnapshot(sessionId) });
	});
	app.get("/:sessionId/:id/transcript", async (c) => {
		const { sessionId, id } = c.req.param();
		if (!bridge.getSession(sessionId)) return c.json({ error: "session not found" }, 404);
		const raw = c.req.query("fromByte") ?? "0";
		const fromByte = Number(raw);
		if (!Number.isSafeInteger(fromByte) || fromByte < 0) return c.json({ error: "invalid fromByte" }, 400);
		try {
			return c.json(await bridge.readSubagentTranscript(sessionId, id, fromByte));
		} catch (error) {
			if (String(error).includes("Forbidden subagent")) return c.json({ error: "forbidden" }, 403);
			throw error;
		}
	});
	app.post("/:sessionId/:id/abort", async (c) => {
		const { sessionId, id } = c.req.param();
		if (!bridge.getSession(sessionId)) return c.json({ error: "session not found" }, 404);
		try {
			await bridge.abortSubagent(sessionId, id);
			return c.json({ ok: true });
		} catch (error) {
			if (String(error).includes("Forbidden subagent")) return c.json({ error: "forbidden" }, 403);
			if (String(error).includes("Subagent no longer active")) return c.json({ error: "subagent no longer active" }, 409);
			throw error;
		}
	});
	return app;
}
