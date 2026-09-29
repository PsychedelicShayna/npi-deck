import type { MixtureDraftRequest, MixtureSaveRequest } from "@npi-deck/protocol";
import { Hono, type Context } from "hono";
import type { AgentBridge } from "./bridge/types.ts";
import type { Config } from "./config.ts";
import { getDeckModelRegistry } from "./auth-singleton.ts";
import { logger } from "./log.ts";
import { MixtureServiceError, MixturesService, type MixturesHost } from "./mixtures-service.ts";

const log = logger("routes:mixtures");
// JSON may escape one document character into six bytes; bound the transport before parsing.
const MAX_REQUEST_BYTES = 6 * 4 * 1024 * 1024 + 64 * 1024;

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function body(c: Context): Promise<Record<string, unknown>> {
	const length = Number(c.req.header("content-length"));
	if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) throw new MixtureServiceError(400, "request exceeds mixture document size limit");
	const reader = c.req.raw.body?.getReader();
	if (!reader) throw new MixtureServiceError(400, "JSON body required");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_REQUEST_BYTES) {
				await reader.cancel();
				throw new MixtureServiceError(400, "request exceeds mixture document size limit");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
	} catch {
		throw new MixtureServiceError(400, "invalid JSON request");
	}
	if (!record(parsed)) throw new MixtureServiceError(400, "JSON object required");
	return parsed;
}

function isDocument(value: unknown): boolean {
	return record(value) && Array.isArray(value.mixtures);
}

/** Mounted below /api: read, draft-validate and save MIXTURES.toml for a known workspace. */
export function buildMixturesRouter(bridge: AgentBridge, config: Config, service = new MixturesService(mixturesHost(bridge, config))): Hono {
	const app = new Hono();
	const respond = async (c: Context, run: () => Promise<unknown>) => {
		try {
			return c.json(await run());
		} catch (error) {
			if (error instanceof MixtureServiceError) return c.json({ error: error.message, ...error.details }, error.status);
			log.warn("mixture request failed", error);
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
		}
	};
	app.get("/mixtures", c => respond(c, () => service.load(c.req.query("cwd") ?? config.defaultCwd)));
	app.get("/mixtures/discovered", c => respond(c, () => service.discovered(c.req.query("cwd") ?? config.defaultCwd)));
	app.post("/mixtures/draft", c =>
		respond(c, async () => {
			const request = await body(c);
			const input = request.input;
			if (!record(input) || !((input.kind === "toml" && typeof input.text === "string") || (input.kind === "document" && isDocument(input.doc))))
				throw new MixtureServiceError(400, "TOML text or document with mixtures array required");
			return service.draft(request as unknown as MixtureDraftRequest);
		}),
	);
	app.put("/mixtures", c =>
		respond(c, async () => {
			const request = await body(c);
			if (!isDocument(request.doc)) throw new MixtureServiceError(400, "document with mixtures array required");
			if (request.confirmCanonicalRewrite !== undefined && typeof request.confirmCanonicalRewrite !== "boolean")
				throw new MixtureServiceError(400, "confirmCanonicalRewrite must be a boolean");
			return service.save(request as unknown as MixtureSaveRequest);
		}),
	);
	return app;
}

/** The server's side of the service: workspaces, the shared registry, and the bridge's roster refresh. */
function mixturesHost(bridge: AgentBridge, config: Config): MixturesHost {
	return {
		async workspaces() {
			const saved = await bridge.listSessions({});
			return [...new Set([config.defaultCwd, ...config.extraWorkspaces, ...saved.map(session => session.cwd)])];
		},
		// The bridge resolves every chat against this same registry.
		registry: getDeckModelRegistry,
		refreshRoster: cwd => bridge.refreshMixtureRoster(cwd),
		async pickerMixtures(cwd) {
			return (await bridge.listModels({ cwd })).filter(model => model.isMixture).map(model => model.id);
		},
	};
}
