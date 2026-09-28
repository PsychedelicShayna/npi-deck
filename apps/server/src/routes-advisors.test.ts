import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { loadBackend } from "./backend/runtime.ts";
import { buildAdvisorsRouter } from "./routes-advisors.ts";
import type { AgentBridge } from "./bridge/types.ts";
import type { Config } from "./config.ts";

const root = await mkdtemp(path.join(process.env.HOME ?? "/home/shayna/tmp", "deck-advisor-test-"));
const agentDir = path.join(root, "agent");
const project = path.join(root, "project");
await mkdir(agentDir); await mkdir(project);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.OMP_DECK_INSTALL_STARTER_SKILLS = "0";
process.env.OMP_DECK_INSTALL_STARTER_EXTENSIONS = "0";
await loadBackend({ id: null, path: process.env.NPI_DECK_BACKEND!, source: "env" });
const config: Config = { defaultCwd: project, extraWorkspaces: [], host: "127.0.0.1", port: 0, devMode: true, idleTimeoutMs: 0, dbPath: path.join(root, "db"), uploadsRoot: path.join(root, "uploads") };
let enabled = false;
let roster: Array<{ name: string; enabled?: boolean }> = [];
let model = "";
const fake = {
	cwd: project,
	advisorStatus: () => ({ overview: { configured: enabled, advisors: roster.map(a => ({ name: a.name, status: enabled && a.enabled !== false ? "running" : "paused", yielded: true })) }, stats: { cost: 0, advisors: [] }, notes: [], events: [] }),
	setAdvisorEnabled: (next: boolean) => { enabled = next; },
	applyAdvisorConfigs: (discovered: { advisors: typeof roster }) => { roster = discovered.advisors; },
	reloadAdvisorSettings: async () => { model = (await readFile(path.join(agentDir, "config.yml"), "utf8")).match(/advisor: (\S+)/)?.[1] ?? ""; },
};
const bridge = { listSessions: async () => [], advisorSession: (id: string) => id === "live" ? fake : undefined, liveAdvisorSessions: () => [fake] } as unknown as AgentBridge;
const app = buildAdvisorsRouter(bridge, config);
const request = (url: string, init?: RequestInit) => app.request(`http://127.0.0.1${url}`, init);
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test("project save hot-applies; user overrides and independent master toggle survive", async () => {
	await writeFile(path.join(agentDir, "WATCHDOG.yml"), "advisors:\n  - name: Shared\n    instructions: User version\n");
	const initial = await (await request(`/advisors?cwd=${encodeURIComponent(project)}`)).json();
	const userHash = initial.user.hash;
	const projectHash = initial.project.hash;
	const response = await request("/advisors/watchdog", json("PUT", { cwd: project, scope: "project", hash: projectHash, doc: { advisors: [{ name: "Shared", instructions: "Project version" }, { name: "Other", enabled: false }] } }));
	expect(response.status).toBe(200);
	const saved = await response.json();
	expect(saved.merged.advisors.find((a: { name: string }) => a.name === "Shared").source).toBe(saved.saved.file);
	expect(saved.merged.advisors.find((a: { name: string }) => a.name === "Shared").instructions).toBe("Project version");
	expect((await readFile(path.join(agentDir, "WATCHDOG.yml"), "utf8"))).toContain("User version");
	expect(enabled).toBe(false);
	const toggled = await request("/sessions/live/advisors", json("PATCH", { enabled: true }));
	expect((await toggled.json()).overview.advisors).toEqual([{ name: "Shared", status: "running", yielded: true }, { name: "Other", status: "paused", yielded: true }]);
	expect((await request("/sessions/live/advisors", json("PATCH", { enabled: false }))).status).toBe(200);
	const userEdit = await request("/advisors/watchdog", json("PUT", { cwd: project, scope: "user", hash: userHash, doc: { advisors: [{ name: "Shared", instructions: "User updated" }] } }));
	expect(userEdit.status).toBe(200);
	expect((await userEdit.json()).merged.advisors[0].instructions).toBe("Project version");
	expect(enabled).toBe(false);
});

test("two stale editors and an external edit cannot overwrite a WATCHDOG file", async () => {
	const initial = await (await request(`/advisors?cwd=${encodeURIComponent(project)}`)).json();
	const file = initial.project.file;
	await writeFile(file, "# external editor\nadvisors:\n  - name: TUI\n");
	const stale = await request("/advisors/watchdog", json("PUT", { cwd: project, scope: "project", hash: initial.project.hash, doc: { advisors: [{ name: "Lost" }] } }));
	expect(stale.status).toBe(409);
	expect(await readFile(file, "utf8")).toContain("TUI");
	const fresh = await (await request(`/advisors?cwd=${encodeURIComponent(project)}`)).json();
	const [winner, loser] = await Promise.all([request("/advisors/watchdog", json("PUT", { cwd: project, scope: "project", hash: fresh.project.hash, doc: { advisors: [{ name: "First" }] } })), request("/advisors/watchdog", json("PUT", { cwd: project, scope: "project", hash: fresh.project.hash, doc: { advisors: [{ name: "Second" }] } }))]);
	expect([winner.status, loser.status].sort()).toEqual([200, 409]);
});

test("model role saves via locked settings without dropping unrelated keys", async () => {
	await writeFile(path.join(agentDir, "config.yml"), "# Captain comment\ntheme:\n  dark: titanium\nmodelRoles:\n  smol: openrouter/openai/gpt-4o-mini\n");
	const response = await request("/advisors/settings", json("PATCH", { cwd: project, model: "openrouter/openai/gpt-4o-mini" }));
	expect(response.status).toBe(200);
	const text = await readFile(path.join(agentDir, "config.yml"), "utf8");
	expect(text).toContain("smol: openrouter/openai/gpt-4o-mini");
	expect(text).toContain("dark: titanium");
	expect(text).toContain("advisor: openrouter/openai/gpt-4o-mini");
	expect(model).toBe("openrouter/openai/gpt-4o-mini");
});
