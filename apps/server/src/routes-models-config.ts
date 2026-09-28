/**
 * models.yml (custom providers, models, overrides, discovery) from Settings.
 *
 *   GET  /models-config            the file NeoPi reads: masked text, NeoPi's verdict, provider summary
 *   POST /models-config/validate   run a document through NeoPi's own loader without writing it
 *   PUT  /models-config            validate, write atomically with a backup, refresh the model registry
 *
 * Validation is NeoPi's ModelsConfigFile pipeline (YAML parse, schema, provider
 * checks) run on the exact text that would be written. Credentials never reach
 * the browser: see models-config-secrets.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Hono } from "hono";
import type { ModelsConfig } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";
import type {
	ModelsConfigDocumentRequest,
	ModelsConfigProviderSummary,
	ModelsConfigRegistryApply,
	ModelsConfigResponse,
	ModelsConfigSaveResponse,
	ModelsConfigValidateResponse,
} from "@npi-deck/protocol";

import { getDeckModelRegistry } from "./auth-singleton.ts";
import { feature, sdk } from "./backend/runtime.ts";
import { logger } from "./log.ts";
import { credentialValues, maskModelsYaml, PlaceholderError, restoreModelsYaml, scrubCredentials } from "./models-config-secrets.ts";

const log = logger("routes:models-config");
const IO_FAILED = "The deck could not read or write models.yml; the server log has the details.";
const ABSENT = "absent";

class RequestError extends Error {
	constructor(message: string, readonly status: 400 | 409) {
		super(message);
	}
}

type Validation = { ok: true; config: ModelsConfig } | { ok: false; message: string };

/** The file NeoPi's registry reads: models.yml, or models.yaml when only that exists. */
function modelsFile(): string {
	return feature("models-config").ModelsConfigFile.relocate(path.join(sdk().getAgentDir(), "models.yml")).path();
}

function readModelsFile(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

function revisionOf(text: string | null): string {
	return text === null ? ABSENT : createHash("sha256").update(text).digest("hex");
}

/**
 * NeoPi's verdict on `text`, from its own loader: the handle is relocated to a
 * private copy so nothing the user reads is touched and no cache is shared.
 */
function validateWithNeoPi(text: string): Validation {
	const dir = mkdtempSync(path.join(tmpdir(), "npi-deck-models-"));
	try {
		const file = path.join(dir, "models.yml");
		writeFileSync(file, text, { mode: 0o600 });
		const result = feature("models-config").ModelsConfigFile.relocate(file).tryLoad();
		if (result.status === "ok") return { ok: true, config: result.value };
		const message = result.error instanceof Error ? result.error.message : String(result.error ?? "models.yml could not be loaded");
		return { ok: false, message };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function summarize(config: ModelsConfig, secrets: readonly string[]): ModelsConfigProviderSummary[] {
	const url = (value: string | undefined) => value === undefined ? undefined : scrubCredentials(value, secrets);
	return Object.entries(config.providers ?? {}).map(([name, provider]) => ({
		name,
		baseUrl: url(provider.baseUrl),
		api: provider.api,
		auth: provider.auth ?? "apiKey",
		apiKeySet: provider.apiKey !== undefined,
		headers: Object.keys(provider.headers ?? {}),
		discovery: provider.discovery?.type,
		transport: provider.transport,
		models: (provider.models ?? []).map(model => ({
			id: model.id,
			name: model.name,
			api: model.api,
			baseUrl: url(model.baseUrl),
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			input: model.input,
		})),
		modelOverrides: Object.keys(provider.modelOverrides ?? {}),
	}));
}

/** The response for one exact text of the file. */
function describe(file: string, text: string | null): ModelsConfigResponse {
	const base = { path: file, exists: text !== null, revision: revisionOf(text) };
	if (text === null) return { ...base, raw: "", maskedSecrets: 0, providers: [] };
	const mask = maskModelsYaml(text);
	const secrets = mask.ok ? [...mask.secrets.values()].map(secret => secret.text) : credentialValues(text);
	const verdict = validateWithNeoPi(text);
	return {
		...base,
		raw: mask.ok ? mask.masked : null,
		...(mask.ok ? {} : {
			rawUnavailable: "The deck cannot locate every credential in this file, so it does not show it. Fix it in a text editor, or save a complete replacement here (the current file is kept as a backup).",
		}),
		maskedSecrets: mask.ok ? mask.secrets.size : 0,
		...(verdict.ok ? {} : { error: scrubCredentials(verdict.message, secrets) }),
		providers: verdict.ok ? summarize(verdict.config, secrets) : [],
	};
}

/**
 * The text a request would write: placeholders restored from the file on disk,
 * then accepted by NeoPi. Errors carry NeoPi's message with credentials masked.
 */
function prepare(raw: string, diskText: string | null): { text: string; config: ModelsConfig; secrets: string[] } {
	const disk = diskText === null ? undefined : maskModelsYaml(diskText);
	const diskSecrets = disk?.ok ? disk.secrets : new Map();
	const known = [...diskSecrets.values()].map(secret => secret.text);
	let text: string;
	try {
		text = restoreModelsYaml(raw, diskSecrets);
	} catch (err) {
		if (!(err instanceof PlaceholderError)) throw err;
		// NeoPi's own complaint about the document comes first when it has one.
		const verdict = validateWithNeoPi(raw);
		if (!verdict.ok) throw new RequestError(scrubCredentials(verdict.message, [...known, ...credentialValues(raw)]), 400);
		throw new RequestError(err.message, 409);
	}
	const secrets = [...known, ...credentialValues(text)];
	const verdict = validateWithNeoPi(text);
	if (!verdict.ok) throw new RequestError(scrubCredentials(verdict.message, secrets), 400);
	return { text, config: verdict.config, secrets };
}

/**
 * Replace `file` with `text` through a synced temp file and a rename, keeping
 * the previous contents as `<file>.bak`. A symlinked file is written through
 * the link. Returns the backup path, or null when there was no file.
 */
function writeAtomically(file: string, text: string): string | null {
	const exists = existsSync(file);
	const target = exists ? realpathSync(file) : file;
	const dir = path.dirname(target);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// Keep the user's permissions; a new file holds credentials, so owner-only.
	const mode = exists ? statSync(target).mode & 0o777 : 0o600;
	const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
	let backup: string | null = null;
	try {
		const fd = openSync(temp, "wx", mode);
		try {
			writeFileSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		chmodSync(temp, mode);
		if (exists) {
			backup = `${target}.bak`;
			copyFileSync(target, backup);
			chmodSync(backup, mode);
		}
		renameSync(temp, target);
	} catch (err) {
		rmSync(temp, { force: true });
		throw err;
	}
	const dirFd = openSync(dir, "r");
	try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
	return backup;
}

/** Re-read models.yml into the deck's shared registry (picker and every chat) and report what it now lists. */
async function refreshRegistry(config: ModelsConfig, secrets: readonly string[]): Promise<ModelsConfigRegistryApply> {
	let registry: Awaited<ReturnType<typeof getDeckModelRegistry>>;
	try {
		registry = await getDeckModelRegistry();
		// Forces the static reload past the mtime gate; runtime discoveries come back from the cache, offline.
		await registry.reapplyModelPolicies();
	} catch (err) {
		log.warn("model registry refresh after models.yml save failed", err);
		return {
			refreshed: false,
			error: "The model registry could not re-read models.yml; the server log has the details. The picker keeps the previous models until the deck restarts.",
			missingModels: [],
			discovering: [],
		};
	}
	const loadError = registry.getError();
	const missingModels: string[] = [];
	const discovering: string[] = [];
	for (const [name, provider] of Object.entries(config.providers ?? {})) {
		for (const model of provider.models ?? []) {
			if (!registry.find(name, model.id)) missingModels.push(`${name}/${model.id}`);
		}
		if (provider.discovery) {
			discovering.push(name);
			void registry.refreshProvider(name, "online").catch(err => log.warn(`model discovery for ${name} after models.yml save failed`, err));
		}
	}
	return {
		refreshed: true,
		...(loadError ? { error: scrubCredentials(loadError.message, secrets) } : {}),
		missingModels,
		discovering,
	};
}

// One models.yml write at a time from this process; the revision check covers other writers.
let saveQueue: Promise<void> = Promise.resolve();
function serializeSave<T>(run: () => Promise<T>): Promise<T> {
	const result = saveQueue.then(run);
	saveQueue = result.then(() => {}, () => {});
	return result;
}

async function documentRequest(c: { req: { json: () => Promise<unknown> } }, needsRevision: boolean): Promise<ModelsConfigDocumentRequest | string> {
	let body: unknown;
	try { body = await c.req.json(); } catch { return "JSON body required"; }
	const request = body as Partial<ModelsConfigDocumentRequest> | null;
	if (typeof request !== "object" || request === null || typeof request.raw !== "string") return "raw must be the document text";
	if (needsRevision && typeof request.revision !== "string") return "revision must be the revision the edit started from";
	return request as ModelsConfigDocumentRequest;
}

export function buildModelsConfigRouter(): Hono {
	const app = new Hono();

	app.get("/models-config", c => {
		try {
			const file = modelsFile();
			return c.json(describe(file, readModelsFile(file)));
		} catch (err) {
			log.warn("read models.yml failed", err);
			return c.json({ error: IO_FAILED }, 500);
		}
	});

	app.post("/models-config/validate", async c => {
		const body = await documentRequest(c, false);
		if (typeof body === "string") return c.json({ error: body }, 400);
		try {
			const file = modelsFile();
			const { config, secrets } = prepare(body.raw, readModelsFile(file));
			const response: ModelsConfigValidateResponse = { providers: summarize(config, secrets) };
			return c.json(response);
		} catch (err) {
			if (err instanceof RequestError) return c.json({ error: err.message }, err.status);
			log.warn("validate models.yml failed", err);
			return c.json({ error: IO_FAILED }, 500);
		}
	});

	app.put("/models-config", async c => {
		const body = await documentRequest(c, true);
		if (typeof body === "string") return c.json({ error: body }, 400);
		try {
			return c.json(await serializeSave(async (): Promise<ModelsConfigSaveResponse> => {
				const file = modelsFile();
				const before = readModelsFile(file);
				if (revisionOf(before) !== body.revision) {
					throw new RequestError("models.yml changed on disk since the editor loaded it. Reload, then reapply your edits.", 409);
				}
				const { text, config, secrets } = prepare(body.raw, before);
				const backupPath = writeAtomically(file, text);
				const written = readModelsFile(file);
				if (written !== text) throw new Error(`models.yml read back differently after the write (${file})`);
				const registry = await refreshRegistry(config, secrets);
				return { ...describe(modelsFile(), written), backupPath, registry };
			}));
		} catch (err) {
			if (err instanceof RequestError) return c.json({ error: err.message }, err.status);
			log.warn("save models.yml failed", err);
			return c.json({ error: IO_FAILED }, 500);
		}
	});

	return app;
}
