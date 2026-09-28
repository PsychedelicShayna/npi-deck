import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { ModelsConfigResponse, ModelsConfigSaveResponse } from "@npi-deck/protocol";
import { loadBackend, resolveBackendSelection, sdk } from "./backend/runtime.ts";
import { getDeckModelRegistry } from "./auth-singleton.ts";
import { buildModelsConfigRouter } from "./routes-models-config.ts";

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

const SECRETS = ["sk-acme-live-77aa0b", "sk-bearer-3c4d1e", "sk-shared-anchor-5b1e", "sk-old-commented-9f2c"];
const FIXTURE = `# Custom providers for the deck tests
# rotated out, old key: apiKey: sk-old-commented-9f2c
providers:
  acme:
    baseUrl: https://llm.acme.test/v1?key=sk-acme-live-77aa0b
    api: openai-completions
    apiKey: sk-acme-live-77aa0b   # literal key
    headers:
      Authorization: "Bearer sk-bearer-3c4d1e"
      X-Team: research
    models:
      - id: acme-large
        contextWindow: 128000
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

test("the raw document and summary never carry a credential, wherever it appears", async () => {
	const response = await request("/models-config");
	expect(response.status).toBe(200);
	const text = await response.clone().text();
	for (const secret of SECRETS) expect(text).not.toContain(secret);
	const body = await response.json() as ModelsConfigResponse;
	expect(body.path).toBe(modelsFile);
	expect(body.error).toBeUndefined();
	// Comments and layout outside credentials survive.
	expect(body.raw).toContain("# Custom providers for the deck tests");
	expect(body.raw).toContain("X-Team: research");
	expect(body.raw).toContain("apiKey: *shared");
	const acme = body.providers.find(p => p.name === "acme");
	expect(acme).toMatchObject({ apiKeySet: true, auth: "apiKey", headers: ["Authorization", "X-Team"], models: [{ id: "acme-large", contextWindow: 128000 }] });
});

test("saving the masked document with a new model keeps every credential and comment, backs up, and reaches the registry", async () => {
	const before = await load();
	const edited = `${before.raw!}  delta:\n    baseUrl: https://delta.test/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: delta-fresh\n`;
	const response = await send("PUT", "/models-config", { raw: edited, revision: before.revision });
	expect(response.status).toBe(200);
	const text = await response.clone().text();
	for (const secret of SECRETS) expect(text).not.toContain(secret);
	const saved = await response.json() as ModelsConfigSaveResponse;

	const onDisk = await readFile(modelsFile, "utf8");
	expect(onDisk).toContain("# rotated out, old key: apiKey: sk-old-commented-9f2c");
	expect(onDisk).toContain("# literal key");
	const parsed = parseYaml(onDisk) as { providers: Record<string, { apiKey?: string; baseUrl: string; headers?: Record<string, string> }> };
	expect(parsed.providers.acme).toMatchObject({
		apiKey: "sk-acme-live-77aa0b",
		baseUrl: "https://llm.acme.test/v1?key=sk-acme-live-77aa0b",
		headers: { Authorization: "Bearer sk-bearer-3c4d1e", "X-Team": "research" },
	});
	expect(parsed.providers.gamma!.apiKey).toBe("sk-shared-anchor-5b1e");
	expect(((await stat(modelsFile)).mode & 0o777)).toBe(0o600);

	expect(saved.backupPath).toBe(backupFile);
	expect(await readFile(backupFile, "utf8")).toBe(FIXTURE);
	expect(saved.revision).not.toBe(before.revision);
	expect(saved.registry).toMatchObject({ refreshed: true, missingModels: [] });
	expect(saved.registry.error).toBeUndefined();
	expect((await getDeckModelRegistry()).find("delta", "delta-fresh")).toBeDefined();
	expect(saved.providers.map(p => p.name)).toEqual(["acme", "beta", "gamma", "delta"]);
});

test("invalid documents are rejected with NeoPi's message and leave models.yml and its backup alone", async () => {
	const { raw, revision } = await load();
	const cases: Array<[string, string]> = [
		[raw!.replace("    baseUrl: https://beta.test/v1\n", ""), 'Provider beta: "baseUrl" is required when defining custom models.'],
		[raw!.replace("contextWindow: 128000", "contextWindow: -5"), "Provider acme, model acme-large: invalid contextWindow"],
		[raw!.replace("api: openai-completions", "api: not-an-api"), "Schema error"],
		[`${raw!}  broken: [\n`, "YAML Parse error"],
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

test("a rejected document whose error quotes a restored credential does not echo it", async () => {
	const { raw, revision } = await load();
	// Move acme's placeholder into a field NeoPi quotes when it rejects the value.
	const placeholder = /apiKey: "(<npi-deck-masked:[0-9a-f]+>)"/.exec(raw!)![1]!;
	const document = raw!.replace("api: openai-completions", `api: "${placeholder}"`);
	const response = await send("PUT", "/models-config", { raw: document, revision });
	expect(response.status).toBe(400);
	const text = await response.text();
	expect(text).toContain("Schema error");
	expect(text).not.toContain("sk-acme-live-77aa0b");
	expect(await readFile(modelsFile, "utf8")).toBe(FIXTURE);
});

test("stale revisions and unknown placeholders are refused without writing", async () => {
	const { raw, revision } = await load();
	await writeFile(modelsFile, `${FIXTURE}# edited in the TUI meanwhile\n`);
	const stale = await send("PUT", "/models-config", { raw: raw!, revision });
	expect(stale.status).toBe(409);
	expect(await readFile(modelsFile, "utf8")).toBe(`${FIXTURE}# edited in the TUI meanwhile\n`);

	const fresh = await load();
	const forged = fresh.raw!.replace(/<npi-deck-masked:[0-9a-f]+>/, "<npi-deck-masked:0123456789abcdef>");
	const unknown = await send("PUT", "/models-config", { raw: forged, revision: fresh.revision });
	expect(unknown.status).toBe(409);
	expect(await Bun.file(backupFile).exists()).toBe(false);
});

test("a file NeoPi rejects is still shown masked with its error; an unparseable one is withheld", async () => {
	await writeFile(modelsFile, FIXTURE.replace("    baseUrl: https://beta.test/v1\n", ""));
	const invalid = await load();
	expect(invalid.error).toContain('Provider beta: "baseUrl" is required');
	expect(invalid.providers).toEqual([]);
	expect(invalid.raw).toContain("<npi-deck-masked:");

	await writeFile(modelsFile, "providers:\n  acme:\n    apiKey: sk-acme-live-77aa0b: [\n");
	const response = await request("/models-config");
	const text = await response.clone().text();
	expect(text).not.toContain("sk-acme-live-77aa0b");
	const broken = await response.json() as ModelsConfigResponse;
	expect(broken.raw).toBeNull();
	expect(broken.rawUnavailable).toBeDefined();
	expect(broken.error).toContain("YAML Parse error");
});
