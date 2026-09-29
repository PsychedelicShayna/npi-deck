import { afterAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { ModelsConfigResponse, ModelsConfigSaveResponse } from "@npi-deck/protocol";
import { loadBackend, resolveBackendSelection, sdk } from "./backend/runtime.ts";
import { getDeckModelRegistry } from "./auth-singleton.ts";
import { buildModelsConfigRouter, replaceModelsFile } from "./routes-models-config.ts";

const root = await mkdtemp(path.join(tmpdir(), "deck-models-config-test-"));
await mkdir(path.join(root, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
const backend = resolveBackendSelection();
if (!backend) throw new Error("models.yml tests require a configured NeoPi backend");
await loadBackend(backend);
// NeoPi fixes its agent dir when first loaded; another test file may have loaded it first.
const agentDir = sdk().getAgentDir();
if (!agentDir.startsWith(tmpdir())) throw new Error(`refusing to edit a non-temporary agent dir: ${agentDir}`);
await mkdir(agentDir, { recursive: true });
const modelsFile = path.join(agentDir, "models.yml");
const backupFile = `${modelsFile}.bak`;
const priorModels = await Bun.file(modelsFile).exists() ? await readFile(modelsFile, "utf8") : null;

const app = buildModelsConfigRouter();
const request = (url: string, init?: RequestInit) => app.request(`http://127.0.0.1${url}`, init);
const send = (method: "PUT" | "POST", url: string, body: unknown) =>
	request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const load = async () => await (await request("/models-config")).json() as ModelsConfigResponse;
const PLACEHOLDER = /<npi-deck-masked:[0-9a-f]{16}>/;
const COMMENT = /^# <npi-deck-comment:[0-9a-f]{16}>$/;
const COMMENT_ANYWHERE = /# <npi-deck-comment:[0-9a-f]{16}>/;
const BETA_URL = /(  beta:\n    baseUrl: )"<npi-deck-masked:[0-9a-f]{16}>"/;
const BETA_URL_LINE = /  beta:\n    baseUrl: "<npi-deck-masked:[0-9a-f]{16}>"\n/;

const SECRETS = [
	"sk-acme-live-77aa0b", "sk-bearer-3c4d1e", "svc-live-9a8b7c6d", "meta-tag-5e6f7a8b",
	"route-secret-1a2b3c4d", "override-secret-2b3c4d5e", "sk-shared-anchor-5b1e",
];
const FIXTURE = `# Custom providers for the deck tests
providers:
  acme:
    baseUrl: https://llm.acme.test/v1
    api: openai-completions
    apiKey: sk-acme-live-77aa0b   # literal key
    headers:
      Authorization: "Bearer sk-bearer-3c4d1e"
      X-Service: svc-live-9a8b7c6d
    requestMetadata:
      team: meta-tag-5e6f7a8b
    models:
      - id: acme-large
        contextWindow: 128000
        headers:
          X-Model-Route: route-secret-1a2b3c4d
    modelOverrides:
      acme-old:
        headers:
          X-Override: override-secret-2b3c4d5e
  beta:
    baseUrl: https://beta.test/v1
    api: openai-completions
    apiKey: &shared sk-shared-anchor-5b1e
    models:
      - id: beta-small
  gamma:
    baseUrl: https://gamma.test/v1
    api: openai-completions
    apiKey: *shared
    models:
      - id: gamma-mini
`;
const expectNoSecret = (text: string, secrets: readonly string[] = SECRETS) => {
	for (const secret of secrets) expect(text).not.toContain(secret);
};

beforeEach(async () => {
	await writeFile(modelsFile, FIXTURE, { mode: 0o600 });
	await rm(backupFile, { force: true });
});
afterAll(async () => {
	if (priorModels === null) await rm(modelsFile, { force: true });
	else await writeFile(modelsFile, priorModels);
	await rm(backupFile, { force: true });
	await rm(root, { recursive: true, force: true });
});

test("every header value, requestMetadata value and apiKey is masked in raw and summary", async () => {
	const response = await request("/models-config");
	expect(response.status).toBe(200);
	expectNoSecret(await response.clone().text());
	const body = await response.json() as ModelsConfigResponse;
	expect(body.path).toBe(modelsFile);
	expect(body.error).toBeUndefined();
	expect(body.raw).not.toContain("Custom providers for the deck tests");
	expect(body.raw).not.toContain("literal key");
	expect(body.raw!.split("\n")[0]).toMatch(COMMENT);
	expect(body.raw).toContain("apiKey: *shared");
	expect(body.raw).toMatch(/X-Service: "<npi-deck-masked:[0-9a-f]{16}>"/);
	const acme = body.providers.find(p => p.name === "acme");
	expect(acme).toMatchObject({ apiKeySet: true, auth: "apiKey", headers: ["Authorization", "X-Service"], models: [{ id: "acme-large", contextWindow: 128000 }], modelOverrides: ["acme-old"] });
});

test("saving the masked document with a new model keeps every credential, backs up, and reaches the registry", async () => {
	const before = await load();
	const edited = `${before.raw!}  delta:\n    baseUrl: https://delta.test/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: delta-fresh\n`;
	const validated = await send("POST", "/models-config/validate", { raw: edited });
	expect(validated.status).toBe(200);
	expectNoSecret(await validated.text());

	const response = await send("PUT", "/models-config", { raw: edited, revision: before.revision });
	expect(response.status).toBe(200);
	expectNoSecret(await response.clone().text());
	const saved = await response.json() as ModelsConfigSaveResponse;

	const onDisk = await readFile(modelsFile, "utf8");
	expect(onDisk).toContain("# literal key");
	const parsed = parseYaml(onDisk) as { providers: Record<string, Record<string, unknown>> };
	expect(parsed.providers.acme).toMatchObject({
		apiKey: "sk-acme-live-77aa0b",
		headers: { Authorization: "Bearer sk-bearer-3c4d1e", "X-Service": "svc-live-9a8b7c6d" },
		requestMetadata: { team: "meta-tag-5e6f7a8b" },
		models: [{ id: "acme-large", headers: { "X-Model-Route": "route-secret-1a2b3c4d" } }],
		modelOverrides: { "acme-old": { headers: { "X-Override": "override-secret-2b3c4d5e" } } },
	});
	expect(parsed.providers.gamma!.apiKey).toBe("sk-shared-anchor-5b1e");
	expect(((await stat(modelsFile)).mode & 0o777)).toBe(0o600);

	expect(saved.backupPath).toBe(backupFile);
	expect(await readFile(backupFile, "utf8")).toBe(FIXTURE);
	expect(saved.registry).toMatchObject({ refreshed: true, missingModels: [] });
	expect(saved.registry.error).toBeUndefined();
	expect((await getDeckModelRegistry()).find("delta", "delta-fresh")).toBeDefined();
	expect(saved.providers.map(p => p.name)).toEqual(["acme", "beta", "gamma", "delta"]);
});

test("a placeholder outside a credential position is refused before validation and never restored", async () => {
	const { raw, revision } = await load();
	const placeholder = /apiKey: "(<npi-deck-masked:[0-9a-f]+>)"/.exec(raw!)![1]!;
	const cases: Array<[string, string]> = [
		["model name", raw!.replace("- id: beta-small", `- id: beta-small\n        name: "${placeholder}"`)],
		["model id", raw!.replace("- id: gamma-mini", `- id: "${placeholder}"`)],
		["provider key", raw!.replace("  gamma:\n", `  "${placeholder}":\n`)],
		["inside a baseUrl", raw!.replace(BETA_URL, `$1"https://beta.test/v1?key=${placeholder}"`)],
		["an apiKey as a whole baseUrl", raw!.replace(BETA_URL, `$1"${placeholder}"`)],
		["api", raw!.replace("api: openai-completions", `api: "${placeholder}"`)],
		["comment", raw!.replace(COMMENT_ANYWHERE, `# ${placeholder}`)],
		["alias into a name", raw!.replace(`apiKey: "${placeholder}"`, `apiKey: &k "${placeholder}"`).replace("- id: beta-small", "- id: beta-small\n        name: *k")],
		["part of a header value", raw!.replace(/Authorization: "<npi-deck-masked:[0-9a-f]+>"/, `Authorization: "Bearer ${placeholder}"`)],
	];
	for (const [where, document] of cases) {
		for (const [method, url] of [["POST", "/models-config/validate"], ["PUT", "/models-config"]] as const) {
			const response = await send(method, url, { raw: document, revision });
			const text = await response.text();
			expect({ where, method, status: response.status }).toEqual({ where, method, status: 400 });
			expect(JSON.parse(text).error).toContain("can only be restored as the whole value");
			expectNoSecret(text);
		}
	}
	expect(await readFile(modelsFile, "utf8")).toBe(FIXTURE);
	expect(await Bun.file(backupFile).exists()).toBe(false);
});

test("a short credential that also appears elsewhere withholds the document; a long one is masked where it appears", async () => {
	await writeFile(modelsFile, "providers:\n  tiny:\n    baseUrl: https://example.test/v1\n    api: openai-completions\n    apiKey: zq9\n    models:\n      - id: tiny-zq9\n");
	const short = await load();
	expect(short.raw).toBeNull();
	expect(short.rawUnavailable).toBeDefined();
	expect(short.providers).toEqual([]);
	expect(JSON.stringify([short.raw, short.providers, short.error])).not.toContain("zq9");

	await writeFile(modelsFile, FIXTURE.replace("- id: beta-small", "- id: beta-small\n        name: backup of sk-acme-live-77aa0b"));
	const response = await request("/models-config");
	expectNoSecret(await response.clone().text());
	const long = await response.json() as ModelsConfigResponse;
	expect(long.providers.find(p => p.name === "beta")!.models[0]!.name).toMatch(PLACEHOLDER);
	// That placeholder sits in a model name, where it cannot be restored: saving it unchanged is refused.
	const resave = await send("PUT", "/models-config", { raw: long.raw!, revision: long.revision });
	expect(resave.status).toBe(400);
});

test("a baseUrl's query value, path token or host label repeated in a shown field withholds the document", async () => {
	const provider = (name: string, baseUrl: string, model: string) =>
		`providers:\n  ${name}:\n    baseUrl: "${baseUrl}"\n    api: openai-completions\n    auth: none\n    models:\n      - id: ${model}\n`;
	const cases: Array<[string, string, string]> = [
		["query value", provider("gw", "https://gw.test/v1?token=sk-live-123", "gw-model\n        name: sk-live-123"), "sk-live-123"],
		["encoded query value", provider("gw", "https://gw.test/v1?token=sk%2Dlive%2D456", "gw-model\n        name: sk-live-456"), "sk-live-456"],
		["path token", provider("gw", "https://gw.test/v1/keys/sk-path-tok-4242", "sk-path-tok-4242"), "sk-path-tok-4242"],
		["host label", provider("tenant-7f3a9c2e", "https://tenant-7f3a9c2e.gw.test/v1", "gw-model"), "tenant-7f3a9c2e"],
		["token behind an encoded path delimiter", provider("gw", "https://gw.test/v1%3Ftoken%3Dsk-live-789", "gw-model\n        name: sk-live-789"), "sk-live-789"],
		["token behind an encoded query space", provider("gw", "https://gw.test/v1?auth=Bearer%20sk-live-321", "gw-model\n        name: sk-live-321"), "sk-live-321"],
	];
	for (const [what, file, secret] of cases) {
		await writeFile(modelsFile, file);
		const body = await load();
		expect({ what, raw: body.raw, providers: body.providers }).toEqual({ what, raw: null, providers: [] });
		expect(body.rawUnavailable).toBeDefined();
		expect(JSON.stringify([body.raw, body.providers, body.error])).not.toContain(secret);
	}

	// Host labels and path segments that are words (short, or without a digit) are not registered,
	// so ordinary files whose names echo their URL keep their raw text.
	const ordinary: Array<[string, string]> = [
		["openai-direct", provider("openai-direct", "https://api.openai.com/v1", "gpt-4o")],
		["anthropic", provider("anthropic", "https://api.anthropic.com", "claude-sonnet").replace("api: openai-completions", "api: anthropic-messages")],
		["openrouter", provider("openrouter", "https://openrouter.ai/api/v1", "openrouter/auto")],
	];
	for (const [name, file] of ordinary) {
		await writeFile(modelsFile, file);
		const body = await load();
		expect({ name, rawShown: typeof body.raw === "string" && /baseUrl: "<npi-deck-masked:[0-9a-f]{16}>"/.test(body.raw) }).toEqual({ name, rawShown: true });
		expect(body.providers).toMatchObject([{ name, baseUrl: "https://••••••" }]);
	}
	expect((await load()).raw).toContain("- id: openrouter/auto");
});

test("every baseUrl is masked whole, shown only as its scheme, and restores exactly, only as a baseUrl", async () => {
	const urls = {
		query: "https://gateway.test/v1?token=sk-query-live-1111",
		userinfo: "https://svc-user:pw%2Duserinfo%2D2222@userinfo.test:8443/v1",
		fragment: "https://frag.test/v1#sk-fragment-live-3333",
		encoded: "https://pct.test/v1%3Ftoken%3Dsk-pct-live-4444",
		host: "https://sk-host-live-7777.gw.test/v1",
		path: "https://gw.test/v1/keys/sk-path-live-8888",
		plain: "http://plain.test/v1",
		model: "https://model.test/v2?key=sk-model-live-5555",
	};
	const provider = (name: string, baseUrl: string, model = "") =>
		`  ${name}:\n    baseUrl: "${baseUrl}"\n    api: openai-completions\n    auth: none\n    models:\n      - id: ${name}-model\n${model}`;
	const file = `providers:\n${[
		provider("gw", urls.query, `        baseUrl: "${urls.model}"\n`),
		provider("ui", urls.userinfo),
		provider("fr", urls.fragment),
		provider("pc", urls.encoded),
		provider("hs", urls.host),
		provider("ph", urls.path),
		provider("plain", urls.plain),
	].join("")}`;
	await writeFile(modelsFile, file);
	const leaked = [
		...Object.values(urls), "gateway.test", "sk-query-live-1111", "svc-user", "pw-userinfo-2222", "sk-fragment-live-3333",
		"sk-pct-live-4444", "sk-host-live-7777", "sk-path-live-8888", "plain.test", "sk-model-live-5555",
	];
	const response = await request("/models-config");
	expectNoSecret(await response.clone().text(), leaked);
	const body = await response.json() as ModelsConfigResponse;
	expect(body.raw!.match(/baseUrl: "<npi-deck-masked:[0-9a-f]{16}>"/g)).toHaveLength(8);
	const shown = (providers: ModelsConfigResponse["providers"]) =>
		providers.flatMap(p => [p.baseUrl, ...p.models.map(m => m.baseUrl).filter(Boolean)]);
	const expected = ["https://••••••", "https://••••••", "https://••••••", "https://••••••", "https://••••••", "https://••••••", "https://••••••", "http://••••••"];
	expect(shown(body.providers)).toEqual(expected);

	const validated = await send("POST", "/models-config/validate", { raw: body.raw! });
	const validatedText = await validated.text();
	expectNoSecret(validatedText, leaked);
	expect(shown((JSON.parse(validatedText) as { providers: ModelsConfigResponse["providers"] }).providers)).toEqual(expected);

	// A new URL typed over a placeholder replaces the stored one; the rest restore exactly.
	const edited = body.raw!
		.replace(/(  plain:\n    baseUrl: )"<npi-deck-masked:[0-9a-f]{16}>"/, '$1"http://replaced.test/v9"')
		.replace("- id: plain-model", "- id: plain-model\n      - id: plain-extra");
	const saved = await send("PUT", "/models-config", { raw: edited, revision: body.revision });
	expect(saved.status).toBe(200);
	expectNoSecret(await saved.text(), [...leaked, "replaced.test"]);
	const onDisk = parseYaml(await readFile(modelsFile, "utf8")) as { providers: Record<string, { baseUrl: string; models: Array<{ id: string; baseUrl?: string }> }> };
	expect(onDisk.providers.gw!.baseUrl).toBe(urls.query);
	expect(onDisk.providers.gw!.models[0]!.baseUrl).toBe(urls.model);
	expect(onDisk.providers.ui!.baseUrl).toBe(urls.userinfo);
	expect(onDisk.providers.fr!.baseUrl).toBe(urls.fragment);
	expect(onDisk.providers.pc!.baseUrl).toBe(urls.encoded);
	expect(onDisk.providers.hs!.baseUrl).toBe(urls.host);
	expect(onDisk.providers.ph!.baseUrl).toBe(urls.path);
	expect(onDisk.providers.plain).toMatchObject({ baseUrl: "http://replaced.test/v9", models: [{ id: "plain-model" }, { id: "plain-extra" }] });
});

test("no comment text is shown; unchanged comment placeholders restore verbatim, edited and new comments are kept as typed", async () => {
	const header = [
		"# retired hunter2",
		"# retired hunter2; password changed",
		"# apiKey: <npi-deck-masked:0000000000000000> sk-other-live-123",
		"# keep me exactly:  spacing & symbols #1",
	];
	await writeFile(modelsFile, `${header.join("\n")}\n${FIXTURE}`);
	const response = await request("/models-config");
	expectNoSecret(await response.clone().text(), [
		...SECRETS, "hunter2", "password changed", "sk-other-live-123", "0000000000000000", "keep me", "Custom providers", "literal key",
	]);
	const body = await response.json() as ModelsConfigResponse;
	const lines = body.raw!.split("\n");
	for (const line of lines.slice(0, 5)) expect(line).toMatch(COMMENT);
	expect(body.raw).toMatch(/apiKey: "<npi-deck-masked:[0-9a-f]{16}>" {3}# <npi-deck-comment:[0-9a-f]{16}>/);

	// Keep comments 1 and 4, rewrite 2, delete 3, add one.
	const edited = [lines[0], "# retired, rotated on 2026-09-01", lines[3], "# added in the deck", ...lines.slice(4)].join("\n");
	const saved = await send("PUT", "/models-config", { raw: edited, revision: body.revision });
	expect(saved.status).toBe(200);
	expectNoSecret(await saved.text(), [...SECRETS, "hunter2", "keep me", "rotated on", "added in the deck"]);
	const onDisk = await readFile(modelsFile, "utf8");
	expect(onDisk.split("\n").slice(0, 5)).toEqual([
		"# retired hunter2",
		"# retired, rotated on 2026-09-01",
		"# keep me exactly:  spacing & symbols #1",
		"# added in the deck",
		"# Custom providers for the deck tests",
	]);
	expect(onDisk).toContain('apiKey: "sk-acme-live-77aa0b"   # literal key');
	expect(onDisk).not.toContain("sk-other-live-123");
});

test("a comment placeholder anywhere but a whole unchanged comment is refused; an unknown one is stale", async () => {
	const { raw, revision } = await load();
	const comment = /# (<npi-deck-comment:[0-9a-f]{16}>)/.exec(raw!)![1]!;
	const cases: Array<[string, string]> = [
		["model name", raw!.replace("- id: beta-small", `- id: beta-small\n        name: "${comment}"`)],
		["provider key", raw!.replace("  gamma:\n", `  "${comment}":\n`)],
		["edited comment", raw!.replace(`# ${comment}`, `# ${comment} plus a note`)],
	];
	for (const [where, document] of cases) {
		const response = await send("PUT", "/models-config", { raw: document, revision });
		expect({ where, status: response.status }).toEqual({ where, status: 400 });
		expect(((await response.json()) as { error: string }).error).toContain("comment placeholder");
	}
	const forged = await send("PUT", "/models-config", { raw: raw!.replace(comment, "<npi-deck-comment:0123456789abcdef>"), revision });
	expect(forged.status).toBe(409);
	expect(await readFile(modelsFile, "utf8")).toBe(FIXTURE);
	expect(await Bun.file(backupFile).exists()).toBe(false);
});

test("the revision is keyed: a short apiKey cannot be recovered offline from raw and revision", async () => {
	const file = 'providers:\n  pin:\n    baseUrl: "https://pin.test/v1"\n    api: openai-completions\n    apiKey: "zz42"\n    models:\n      - id: pin-model\n';
	await writeFile(modelsFile, file);
	const body = await load();
	const reconstruct = (guess: string) => body.raw!
		.replace(/baseUrl: "<npi-deck-masked:[0-9a-f]{16}>"/, 'baseUrl: "https://pin.test/v1"')
		.replace(/apiKey: "<npi-deck-masked:[0-9a-f]{16}>"/, `apiKey: ${JSON.stringify(guess)}`);
	const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
	// The masked text plus the right guesses is the file, so an unkeyed digest would confirm them.
	expect(reconstruct("zz42")).toBe(file);
	const candidates = Array.from({ length: 100 }, (_, n) => `zz${String(n).padStart(2, "0")}`);
	expect(candidates.filter(guess => [sha256(reconstruct(guess)), sha256(guess)].includes(body.revision))).toEqual([]);
	// It still identifies the file for compare-and-replace.
	const saved = await send("PUT", "/models-config", { raw: body.raw!.replace("pin-model", "pin-model-2"), revision: body.revision });
	expect(saved.status).toBe(200);
	expect(await readFile(modelsFile, "utf8")).toContain('apiKey: "zz42"');
});

test("the backup replaces a symlinked .bak instead of writing through it, owner-only", async () => {
	const victim = path.join(root, "victim.txt");
	await writeFile(victim, "do not touch\n");
	await symlink(victim, backupFile);
	const { raw, revision } = await load();
	const response = await send("PUT", "/models-config", { raw: raw!.replace("contextWindow: 128000", "contextWindow: 64000"), revision });
	expect(response.status).toBe(200);
	expect(await readFile(victim, "utf8")).toBe("do not touch\n");
	expect((await lstat(backupFile)).isSymbolicLink()).toBe(false);
	expect(((await stat(backupFile)).mode & 0o777)).toBe(0o600);
	expect(await readFile(backupFile, "utf8")).toBe(FIXTURE);
});

test("compare-and-replace refuses a file that changed after the edit's revision, leaving no temp or backup", async () => {
	const concurrent = `${FIXTURE}# edited in the TUI meanwhile\n`;
	await writeFile(modelsFile, concurrent);
	let status: unknown;
	try {
		replaceModelsFile(modelsFile, "providers: {}\n", FIXTURE);
	} catch (err) {
		status = (err as { status?: unknown }).status;
	}
	expect(status).toBe(409);
	expect(await readFile(modelsFile, "utf8")).toBe(concurrent);
	expect(await Bun.file(backupFile).exists()).toBe(false);
	expect((await readdir(agentDir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

test("invalid documents are rejected with NeoPi's message and leave models.yml and its backup alone", async () => {
	const { raw, revision } = await load();
	const cases: Array<[string, string]> = [
		[raw!.replace(BETA_URL_LINE, "  beta:\n"), 'Provider beta: "baseUrl" is required when defining custom models.'],
		[raw!.replace("contextWindow: 128000", "contextWindow: -5"), "Provider acme, model acme-large: invalid contextWindow"],
		[raw!.replace("api: openai-completions", "api: not-an-api"), "Schema error"],
		[`${raw!}  broken: [\n`, "YAML"],
	];
	for (const [document, message] of cases) {
		for (const [method, url] of [["POST", "/models-config/validate"], ["PUT", "/models-config"]] as const) {
			const response = await send(method, url, { raw: document, revision });
			expect(response.status).toBe(400);
			expect(((await response.json()) as { error: string }).error).toContain(message);
		}
	}
	expect(await readFile(modelsFile, "utf8")).toBe(FIXTURE);
	expect(await Bun.file(backupFile).exists()).toBe(false);
});

test("stale revisions and unknown placeholders are refused without writing", async () => {
	const { raw, revision } = await load();
	await writeFile(modelsFile, `${FIXTURE}# edited in the TUI meanwhile\n`);
	const stale = await send("PUT", "/models-config", { raw: raw!, revision });
	expect(stale.status).toBe(409);
	expect(await readFile(modelsFile, "utf8")).toBe(`${FIXTURE}# edited in the TUI meanwhile\n`);

	const fresh = await load();
	const forged = fresh.raw!.replace(PLACEHOLDER, "<npi-deck-masked:0123456789abcdef>");
	const unknown = await send("PUT", "/models-config", { raw: forged, revision: fresh.revision });
	expect(unknown.status).toBe(409);
	expect(await Bun.file(backupFile).exists()).toBe(false);
});

test("a file NeoPi rejects is still shown masked with its error; an unparseable one is withheld", async () => {
	await writeFile(modelsFile, FIXTURE.replace("    baseUrl: https://beta.test/v1\n", ""));
	const invalid = await load();
	expect(invalid.error).toContain('Provider beta: "baseUrl" is required');
	expect(invalid.providers).toEqual([]);
	expect(invalid.raw).toMatch(PLACEHOLDER);

	await writeFile(modelsFile, "providers:\n  acme:\n    apiKey: sk-acme-live-77aa0b: [\n");
	const response = await request("/models-config");
	expectNoSecret(await response.clone().text());
	const broken = await response.json() as ModelsConfigResponse;
	expect(broken.raw).toBeNull();
	expect(broken.rawUnavailable).toBeDefined();
	expect(broken.error).toContain("YAML Parse error");
});
