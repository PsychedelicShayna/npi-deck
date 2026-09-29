import { afterAll, beforeEach, expect, test } from "bun:test";
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
process.env.OMP_DECK_INSTALL_STARTER_SKILLS = "0";
process.env.OMP_DECK_INSTALL_STARTER_EXTENSIONS = "0";
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
	expect(body.raw).toContain("# Custom providers for the deck tests");
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
		["baseUrl", raw!.replace("https://beta.test/v1", `https://beta.test/v1?key=${placeholder}`)],
		["api", raw!.replace("api: openai-completions", `api: "${placeholder}"`)],
		["comment", raw!.replace("# Custom providers for the deck tests", `# ${placeholder}`)],
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
	await writeFile(modelsFile, "providers:\n  tiny:\n    baseUrl: https://example.test/zq9\n    api: openai-completions\n    apiKey: zq9\n    models:\n      - id: tiny-model\n");
	const short = await load();
	expect(short.raw).toBeNull();
	expect(short.rawUnavailable).toBeDefined();
	expect(short.providers).toEqual([]);
	expect(JSON.stringify([short.raw, short.providers, short.error])).not.toContain("zq9");

	await writeFile(modelsFile, FIXTURE.replace("https://beta.test/v1", "https://beta.test/v1?key=sk-acme-live-77aa0b"));
	const response = await request("/models-config");
	expectNoSecret(await response.clone().text());
	const long = await response.json() as ModelsConfigResponse;
	expect(long.providers.find(p => p.name === "beta")!.baseUrl).toMatch(PLACEHOLDER);
	// That placeholder sits in baseUrl, where it cannot be restored: saving it unchanged is refused.
	const resave = await send("PUT", "/models-config", { raw: long.raw!, revision: long.revision });
	expect(resave.status).toBe(400);
});

test("a comment is masked from any credential-like word, known credential or placeholder-looking text onward", async () => {
	const comments = [
		"# apiKey: <npi-deck-masked:0000000000000000> sk-other-live-123",
		"# rotated sk-acme-live-77aa0b out last week",
		"# token: hunter2hunter2",
		"# see https://example.test/opaque/Zx81Qm0Lp2Rt7Yw4Ke9a",
	];
	await writeFile(modelsFile, `${comments.join("\n")}\n${FIXTURE}`);
	const response = await request("/models-config");
	const text = await response.clone().text();
	expectNoSecret(text, [...SECRETS, "sk-other-live-123", "hunter2hunter2", "Zx81Qm0Lp2Rt7Yw4Ke9a", "0000000000000000"]);
	const body = await response.json() as ModelsConfigResponse;
	const lines = body.raw!.split("\n");
	expect(lines[0]).toMatch(/^# apiKey: <npi-deck-masked:[0-9a-f]{16}>$/);
	expect(lines[1]).toMatch(/^# rotated <npi-deck-masked:[0-9a-f]{16}>$/);
	expect(lines[2]).toMatch(/^# token: <npi-deck-masked:[0-9a-f]{16}>$/);
	expect(lines[3]).toMatch(/^# see https:<npi-deck-masked:[0-9a-f]{16}>$/);
	// A masked comment cannot be restored; the save names its line.
	const resave = await send("PUT", "/models-config", { raw: body.raw!, revision: body.revision });
	expect(resave.status).toBe(400);
	expect(((await resave.json()) as { error: string }).error).toContain("Line 1");
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
		[raw!.replace("    baseUrl: https://beta.test/v1\n", ""), 'Provider beta: "baseUrl" is required when defining custom models.'],
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
