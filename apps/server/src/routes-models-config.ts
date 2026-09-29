/**
 * models.yml (custom providers, models, overrides, discovery) from Settings.
 *
 *   GET  /models-config            the file NeoPi reads: masked text, NeoPi's verdict, provider summary
 *   POST /models-config/validate   run a document through NeoPi's own loader without writing it
 *   PUT  /models-config            validate, compare-and-replace with a backup, refresh the model registry
 *
 * Validation is NeoPi's ModelsConfigFile pipeline (YAML parse, schema, provider
 * checks). Credentials never reach the browser (models-config-secrets.ts), and
 * no response is built from a document with restored credentials: summaries
 * and messages come from the submitted (masked) document or a re-masked read.
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fchmodSync,
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
import {
	displayUrl,
	leaksSecret,
	maskModelsYaml,
	PlaceholderError,
	restoreModelsYaml,
	revisionOf,
	safeMessage,
	type Secret,
	WITHHELD_MESSAGE,
} from "./models-config-secrets.ts";

const log = logger("routes:models-config");
const IO_FAILED = "The deck could not read or write models.yml; the server log has the details.";
const STALE = "models.yml changed on disk since the editor loaded it. Reload, then reapply your edits.";
const RAW_UNAVAILABLE =
	"The deck cannot mask every credential in this file unambiguously (it is not valid YAML, or a credential is short or appears where it cannot be replaced), so it does not show the file. Fix it in a text editor, or save a complete replacement here (the current file is kept as a backup).";
const RESTORED_REJECTED =
	"NeoPi rejects the document once its masked credentials are restored; the message is withheld because it may quote one. The deck server log has the details.";
/** Bun's YAML parse errors name no content; anything else about a file the deck cannot mask is withheld. */
const PARSE_ONLY = /^Failed to load config file models, Unexpected error: YAML Parse error: [A-Za-z ]+$/;

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

/**
 * Summary of a masked document's config: credentials are at most placeholders,
 * and only their presence is reported; a baseUrl shows at most its scheme and
 * `••••••`, never its host or path.
 */
function summarize(config: ModelsConfig, secrets: Map<string, Secret>): ModelsConfigProviderSummary[] {
	return Object.entries(config.providers ?? {}).map(([name, provider]) => ({
		name,
		baseUrl: displayUrl(provider.baseUrl, secrets),
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
			baseUrl: displayUrl(model.baseUrl, secrets),
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			input: model.input,
		})),
		modelOverrides: Object.keys(provider.modelOverrides ?? {}),
	}));
}

/**
 * The response for one exact text of the file, built from its masking only.
 * NeoPi's verdict on the real text decides valid/invalid; its message and the
 * summary come from the masked text. `known` lists the file's credentials.
 */
function describe(file: string, text: string | null): { response: ModelsConfigResponse; known: string[] } {
	const base = { path: file, exists: text !== null, revision: revisionOf(text) };
	if (text === null) return { response: { ...base, raw: "", maskedSecrets: 0, providers: [] }, known: [] };
	const mask = maskModelsYaml(text);
	const disk = validateWithNeoPi(text);
	const withheld = (error: string | undefined): ModelsConfigResponse => ({
		...base,
		raw: null,
		rawUnavailable: RAW_UNAVAILABLE,
		maskedSecrets: 0,
		...(error === undefined ? {} : { error }),
		providers: [],
	});
	if (!disk.ok) log.warn(`models.yml is rejected by NeoPi: ${safeMessage(disk.message, mask.known)}`);
	if (!mask.ok) {
		return { response: withheld(disk.ok ? undefined : PARSE_ONLY.test(disk.message) ? disk.message : WITHHELD_MESSAGE), known: mask.known };
	}
	const shown = validateWithNeoPi(mask.masked);
	const error = disk.ok ? undefined : safeMessage(shown.ok ? WITHHELD_MESSAGE : shown.message, mask.known);
	const providers = disk.ok && shown.ok ? summarize(shown.config, mask.secrets) : [];
	if (leaksSecret({ providers, error }, mask.known)) return { response: withheld(disk.ok ? undefined : WITHHELD_MESSAGE), known: mask.known };
	return {
		response: {
			...base,
			raw: mask.masked,
			maskedSecrets: mask.secrets.size,
			...(error === undefined ? {} : { error }),
			providers,
		},
		known: mask.known,
	};
}

/**
 * The text a request would write, and the config NeoPi reads from the
 * submitted (masked) document. Placeholders outside credential positions are
 * refused before anything is validated. The submitted document's own message
 * is returned; a rejection that appears only once credentials are restored is
 * withheld, since it could quote one.
 */
function prepare(raw: string, diskText: string | null): { text: string; config: ModelsConfig; secrets: Map<string, Secret> } {
	const disk = diskText === null ? undefined : maskModelsYaml(diskText);
	const secrets: Map<string, Secret> = disk?.ok ? disk.secrets : new Map();
	const commentSources: Map<string, string> = disk?.ok ? disk.comments : new Map();
	let text: string;
	try {
		text = restoreModelsYaml(raw, secrets, commentSources);
	} catch (err) {
		if (err instanceof PlaceholderError) throw new RequestError(err.message, err.status);
		throw err;
	}
	const submitted = validateWithNeoPi(raw);
	if (!submitted.ok) throw new RequestError(submitted.message, 400);
	if (text !== raw) {
		const restored = validateWithNeoPi(text);
		if (!restored.ok) {
			log.warn(`restored models.yml rejected by NeoPi: ${safeMessage(restored.message, [...(disk?.known ?? []), ...maskModelsYaml(text).known])}`);
			throw new RequestError(RESTORED_REJECTED, 400);
		}
	}
	return { text, config: submitted.config, secrets };
}

/**
 * Replace `file` with `text` if it still holds `before` (compare-and-replace),
 * keeping `before` as `<file>.bak`. A symlinked file is written through the
 * link. Returns the backup path, or null when there was no file.
 *
 * Both files are written to exclusive (O_EXCL), owner-only temp files in the
 * target's directory and synced, then renamed into place; rename replaces a
 * symlink at `.bak` rather than writing through it. The target is re-read and
 * re-hashed immediately before the renames. NeoPi has no cross-process lock
 * for models.yml, so a write by another process in the few syscalls between
 * that re-read and the rename is still overwritten (it survives in no backup);
 * any earlier change is refused with 409.
 */
export function replaceModelsFile(file: string, text: string, before: string | null): string | null {
	const exists = existsSync(file);
	const target = exists ? realpathSync(file) : file;
	const dir = path.dirname(target);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// Keep the user's permissions on the file itself; the backup is owner-only.
	const mode = exists ? statSync(target).mode & 0o777 : 0o600;
	const temps: string[] = [];
	const writeTemp = (contents: string, fileMode: number): string => {
		const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
		const fd = openSync(temp, "wx", 0o600);
		temps.push(temp);
		try {
			writeFileSync(fd, contents);
			fchmodSync(fd, fileMode);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		return temp;
	};
	try {
		const next = writeTemp(text, mode);
		const saved = before === null ? undefined : writeTemp(before, 0o600);
		if (revisionOf(readModelsFile(target)) !== revisionOf(before)) throw new RequestError(STALE, 409);
		let backup: string | null = null;
		if (saved !== undefined) {
			backup = `${target}.bak`;
			renameSync(saved, backup);
			temps.splice(temps.indexOf(saved), 1);
		}
		renameSync(next, target);
		temps.splice(temps.indexOf(next), 1);
		const dirFd = openSync(dir, "r");
		try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
		return backup;
	} finally {
		for (const temp of temps) rmSync(temp, { force: true });
	}
}

/** Re-read models.yml into the deck's shared registry (picker and every chat) and report what it now lists. */
async function refreshRegistry(config: ModelsConfig, known: readonly string[]): Promise<ModelsConfigRegistryApply> {
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
		...(loadError ? { error: safeMessage(loadError.message, known) } : {}),
		missingModels,
		discovering,
	};
}

// One models.yml write at a time from this process; replaceModelsFile's compare-and-replace covers other writers.
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
			return c.json(describe(file, readModelsFile(file)).response);
		} catch (err) {
			log.warn("read models.yml failed", err);
			return c.json({ error: IO_FAILED }, 500);
		}
	});

	app.post("/models-config/validate", async c => {
		const body = await documentRequest(c, false);
		if (typeof body === "string") return c.json({ error: body }, 400);
		try {
			const { config, secrets } = prepare(body.raw, readModelsFile(modelsFile()));
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
				if (revisionOf(before) !== body.revision) throw new RequestError(STALE, 409);
				const { text, config } = prepare(body.raw, before);
				const backupPath = replaceModelsFile(file, text, before);
				const written = readModelsFile(file);
				if (written !== text) throw new Error(`models.yml read back differently after the write (${file})`);
				const { response, known } = describe(modelsFile(), written);
				const registry = await refreshRegistry(config, known);
				return { ...response, backupPath, registry };
			}));
		} catch (err) {
			if (err instanceof RequestError) return c.json({ error: err.message }, err.status);
			log.warn("save models.yml failed", err);
			return c.json({ error: IO_FAILED }, 500);
		}
	});

	return app;
}
