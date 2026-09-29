import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { MixtureSaveResponse, MixturesDocument, MixturesResponse } from "@npi-deck/protocol";
import { feature, hasFeature, loadBackend, resolveBackendSelection, sdk } from "./backend/runtime.ts";
import { getDeckModelRegistry } from "./auth-singleton.ts";
import { InProcessAgentBridge } from "./bridge/in-process.ts";
import type { Config } from "./config.ts";
import { buildMixturesRouter } from "./routes-mixtures.ts";

const root = await mkdtemp(path.join(tmpdir(), "deck-mixtures-test-"));
const project = path.join(root, "project");
await mkdir(path.join(root, "agent"), { recursive: true });
await mkdir(project);
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.OMP_DECK_INSTALL_STARTER_SKILLS = "0";
process.env.OMP_DECK_INSTALL_STARTER_EXTENSIONS = "0";
const backend = resolveBackendSelection();
if (!backend) throw new Error("mixture route tests require a configured NeoPi backend");
await loadBackend(backend);
if (!hasFeature("mixture-config") || !hasFeature("mixtures")) throw new Error("backend lacks the mixture features these tests exercise");

// The deck's shared registry: the one the bridge lists picker models from and chats resolve against.
const registry = await getDeckModelRegistry();
const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 1_000 });
// Keyed members resolve against getAvailable(); no request is ever sent.
registry.registerProvider("deck-test", { baseUrl: "http://127.0.0.1:1/v1", apiKey: "deck-test-key", api: "openai-completions", models: [model("writer"), model("editor")] });

const config: Config = { defaultCwd: project, extraWorkspaces: [], host: "127.0.0.1", port: 0, devMode: true, idleTimeoutMs: 0, dbPath: path.join(root, "db"), uploadsRoot: path.join(root, "uploads") };
const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
const app = buildMixturesRouter(bridge, config);
const pickerMixtures = async () => (await bridge.listModels({ cwd: project })).filter(info => info.isMixture).map(info => info.id);
const request = (url: string, init?: RequestInit) => app.request(`http://127.0.0.1${url}`, init);
const load = async () => (await (await request(`/mixtures?cwd=${encodeURIComponent(project)}`)).json()) as MixturesResponse;
const save = (body: unknown) => request("/mixtures", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const file = path.join(project, "MIXTURES.toml");

const member = (id: string) => ({ id, model: `deck-test/${id}`, systemPrompt: `You are the ${id}.`, tools: false });
const chain = (name: string) => ({ name, entry: "writer", members: [member("writer"), member("editor")], edges: [{ from: "writer", to: "editor", x: { output: true as const } }] });
const withRoute = (name: string) => {
	const definition = chain(name);
	return { ...definition, members: [{ ...definition.members[0]!, route: { instructions: "pick" } }, definition.members[1]!] };
};

beforeEach(async () => {
	await rm(file, { force: true });
});
afterAll(async () => {
	await bridge.dispose();
	registry.unregisterProvider("deck-test");
	// NeoPi fixes its agent dir at first load and other test files share it; remove only this file's workspace.
	await rm(project, { recursive: true, force: true });
});

test("validation reports NeoPi's M1 gate per definition; a linear model chain is runnable", async () => {
	const draft = await request("/mixtures/draft", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd: project, input: { kind: "document", doc: { mixtures: [chain("linear"), withRoute("routed")] } } }),
	});
	expect(draft.status).toBe(200);
	const body = (await draft.json()) as { validation: MixturesResponse["project"]["validation"] };
	expect(body.validation.map(report => [report.name, report.runnable])).toEqual([["linear", true], ["routed", false]]);
	expect(body.validation[1]!.unsupported).toEqual([expect.objectContaining({ code: "unsupported.feature", path: "members[0].route" })]);
	const capabilities = (await load()).capabilities;
	expect(capabilities.milestone).toBe("M1");
	// Pinned NeoPi runs only linear chains of tool-less model members: every probed feature is refused.
	expect(capabilities.gates.filter(gate => !gate.gated)).toEqual([]);
	expect(capabilities.gates.map(gate => gate.feature)).toContain("tools");
});

test("save is compare-and-swap on the loaded hash and verifies the file NeoPi wrote", async () => {
	const before = await load();
	expect(before.project.exists).toBe(false);
	const first = await save({ cwd: project, scope: "project", baseHash: before.project.hash, doc: { mixtures: [chain("first")] } });
	expect(first.status).toBe(200);
	const saved = (await first.json()) as MixtureSaveResponse;
	expect(saved.scope.exists).toBe(true);
	expect(saved.scope.doc.mixtures.map(mixture => mixture.name)).toEqual(["first"]);
	expect(await readFile(file, "utf8")).toContain('name = "first"');

	// A second editor that loaded before the first save must not overwrite it.
	const stale = await save({ cwd: project, scope: "project", baseHash: before.project.hash, doc: { mixtures: [chain("second")] } });
	expect(stale.status).toBe(409);
	expect(await readFile(file, "utf8")).toContain('name = "first"');

	// An external edit also moves the hash.
	await writeFile(file, `${await readFile(file, "utf8")}\n`);
	const external = await save({ cwd: project, scope: "project", baseHash: saved.scope.hash, doc: { mixtures: [chain("second")] } });
	expect(external.status).toBe(409);
});

test("definitions with validation errors block a save unless carried over unchanged", async () => {
	const start = await load();
	const refused = await save({ cwd: project, scope: "project", baseHash: start.project.hash, doc: { mixtures: [chain("ok"), withRoute("routed")] } });
	expect(refused.status).toBe(422);
	expect(((await refused.json()) as { blocked: number[] }).blocked).toEqual([1]);
	expect(await Bun.file(file).exists()).toBe(false);

	// A hand-written non-runnable definition already on disk survives an edit of its neighbour.
	const doc: MixturesDocument = { mixtures: [chain("ok"), withRoute("routed")] };
	await feature("mixture-config").saveMixturesConfigFile(file, doc as never);
	const loaded = await load();
	const edited = { mixtures: [{ ...loaded.project.doc.mixtures[0]!, description: "edited" }, loaded.project.doc.mixtures[1]!] };
	const kept = await save({ cwd: project, scope: "project", baseHash: loaded.project.hash, doc: edited });
	expect(kept.status).toBe(200);
	const result = (await kept.json()) as MixtureSaveResponse;
	expect(result.scope.doc.mixtures.map(mixture => [mixture.name, mixture.description])).toEqual([["ok", "edited"], ["routed", undefined]]);
	expect(result.scope.validation.map(report => report.runnable)).toEqual([true, false]);
});

test("a saved runnable mixture becomes a picker model without a restart, even while a chat holds the workspace", async () => {
	// A live chat in the workspace keeps its scope's roster; a save must replace it, not wait for release.
	const agentDir = sdk().getAgentDir();
	const chat = await feature("mixtures").MixtureWorkspace.retain("test-live-chat", { cwd: project, agentDir, registry, settings: await sdk().Settings.loadReadOnly({ cwd: project, agentDir }) });
	try {
		expect(await pickerMixtures()).not.toContain("fresh");
		const start = await load();
		const response = await save({ cwd: project, scope: "project", baseHash: start.project.hash, doc: { mixtures: [chain("fresh")] } });
		expect(response.status).toBe(200);
		const result = (await response.json()) as MixtureSaveResponse;
		expect(result.picker).toEqual(["fresh"]);
		expect(await pickerMixtures()).toEqual(["fresh"]);
		expect(chat.scope.find("fresh")).toBeDefined();

		// Removing it from the file removes it from the picker too.
		const removed = await save({ cwd: project, scope: "project", baseHash: result.scope.hash, doc: { mixtures: [] } });
		expect(removed.status).toBe(200);
		expect(await Bun.file(file).exists()).toBe(false);
		expect(await pickerMixtures()).toEqual([]);
	} finally {
		chat.release();
	}
});

test("a saved definition NeoPi refuses never reaches the picker", async () => {
	await feature("mixture-config").saveMixturesConfigFile(file, { mixtures: [chain("listed"), withRoute("refused")] } as never);
	const loaded = await load();
	// Editing only the runnable neighbour saves both and registers only the runnable one.
	const edited = { mixtures: [{ ...loaded.project.doc.mixtures[0]!, description: "edited" }, loaded.project.doc.mixtures[1]!] };
	const response = await save({ cwd: project, scope: "project", baseHash: loaded.project.hash, doc: edited });
	expect(response.status).toBe(200);
	expect(((await response.json()) as MixtureSaveResponse).picker).toEqual(["listed"]);
});
