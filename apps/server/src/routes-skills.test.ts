import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import type { ListSkillsResponse, SkillDetailResponse, SkillSummary } from "@npi-deck/protocol";

import { loadBackend, resolveBackendSelection, sdk } from "./backend/runtime.ts";
import type { Config } from "./config.ts";
import type { MarketplaceService } from "./marketplace-service.ts";
import { buildSkillsRouter } from "./routes-skills.ts";
import { SkillsService } from "./skills-service.ts";
import { watchSkillRoots } from "./skills-watcher.ts";

const root = mkdtempSync(path.join(tmpdir(), "deck-skills-test-"));
if (!process.env.PI_CODING_AGENT_DIR) process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const selection = resolveBackendSelection();
if (!selection) throw new Error("skill authoring tests require a configured NeoPi backend");
await loadBackend(selection);
// NeoPi fixes its agent dir when first loaded; another test file may have loaded it first.
// These tests write skills, so they must never reach the user's real agent dir. Bun's
// userInfo() reads $HOME, which a test run may override, so the real home comes from passwd.
const agentDir = sdk().getAgentDir();
const realHome = readFileSync("/etc/passwd", "utf8").split("\n").map((line) => line.split(":"))
	.find((fields) => Number(fields[2]) === process.getuid?.())?.[5] ?? userInfo().homedir;
if (!agentDir.startsWith(tmpdir()) || agentDir === realHome || agentDir.startsWith(`${realHome}${path.sep}`)) {
	throw new Error(`refusing to write skills into an agent dir that is not temporary or sits under ${realHome}: ${agentDir}`);
}
const skillsRoot = path.join(agentDir, "skills");
const project = path.join(root, "project");
const outside = path.join(root, "outside");
mkdirSync(project, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Skill dirs and links a test created under the shared agent dir; removed after each test. */
const created = new Set<string>();
afterEach(() => {
	for (const entry of created) rmSync(entry, { recursive: true, force: true });
	created.clear();
	rmSync(outside, { recursive: true, force: true });
});

const config = { defaultCwd: project } as Config;
const marketplace = { listInstalled: async () => [] } as unknown as MarketplaceService;
const app = buildSkillsRouter(new SkillsService(config, marketplace));
const request = (url: string, init?: RequestInit) => app.request(`http://127.0.0.1${url}`, init);
const send = (method: "POST" | "PUT" | "DELETE", url: string, body?: unknown) =>
	request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function list(): Promise<SkillSummary[]> {
	return ((await (await request("/skills")).json()) as ListSkillsResponse).skills;
}
async function row(skillPath: string): Promise<SkillSummary | undefined> {
	return (await list()).find((s) => s.skillPath === skillPath);
}
async function detail(id: string): Promise<SkillDetailResponse> {
	return (await (await request(`/skills/${id}`)).json()) as SkillDetailResponse;
}

function handWrite(dir: string, frontmatter: string, body = "Hand-written body.\n"): string {
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "SKILL.md");
	writeFileSync(file, `---\n${frontmatter}---\n\n${body}`);
	return file;
}
function userSkill(name: string, frontmatter = `name: ${name}\ndescription: Made by hand.\n`): string {
	created.add(path.join(skillsRoot, name));
	return handWrite(path.join(skillsRoot, name), frontmatter);
}
async function create(name: string, description = "Writes release notes.", body = "# Notes\n\nSteps.") {
	created.add(path.join(skillsRoot, name.trim()));
	return send("POST", "/skills", { name, description, body });
}

test("a created skill lands as SKILL.md under the agent dir and lists as an editable OMP user skill", async () => {
	const response = await create("release-notes");
	expect(response.status).toBe(201);
	const summary = (await response.json()) as SkillSummary;
	const file = path.join(skillsRoot, "release-notes", "SKILL.md");
	expect(summary).toMatchObject({ name: "release-notes", provider: "native", level: "user", skillPath: file, editable: true });
	expect(summary.frontmatter.description).toBe("Writes release notes.");

	const raw = readFileSync(file, "utf8");
	const [, yaml, body] = /^---\n([\s\S]*?)---\n\n([\s\S]*)$/.exec(raw) ?? [];
	expect(YAML.parse(yaml!)).toEqual({ name: "release-notes", description: "Writes release notes." });
	expect(body).toBe("# Notes\n\nSteps.\n");
	expect((await detail(summary.id)).body).toContain("# Notes\n\nSteps.");
});

test("names that could leave the skills root, or that NeoPi would not load, are refused and write nothing", async () => {
	const before = existsSync(skillsRoot) ? new Set(await Array.fromAsync(new Bun.Glob("*").scan({ cwd: skillsRoot, onlyFiles: false }))) : new Set<string>();
	for (const name of ["../escape", "a/b", "..", ".hidden", "Upper", "trailing-", "a--b", "", "x".repeat(65)]) {
		const response = await send("POST", "/skills", { name, description: "d", body: "b" });
		expect(response.status, name).toBe(400);
		expect(((await response.json()) as { error: string }).error.length).toBeGreaterThan(0);
	}
	expect(existsSync(path.join(agentDir, "escape"))).toBe(false);
	const after = existsSync(skillsRoot) ? new Set(await Array.fromAsync(new Bun.Glob("*").scan({ cwd: skillsRoot, onlyFiles: false }))) : new Set<string>();
	expect(after).toEqual(before);
});

test("a blank or oversized description is refused", async () => {
	expect((await create("blank-desc", "   ")).status).toBe(400);
	expect((await create("long-desc", "d".repeat(1025))).status).toBe(400);
	expect(existsSync(path.join(skillsRoot, "blank-desc"))).toBe(false);
});

test("a name that collides with an occupied directory or another OMP skill is refused without touching it", async () => {
	const handMade = userSkill("taken");
	const original = readFileSync(handMade, "utf8");
	expect((await create("taken")).status).toBe(409);
	expect(readFileSync(handMade, "utf8")).toBe(original);

	// A dangling link still occupies the name: the entry is the user's.
	mkdirSync(skillsRoot, { recursive: true });
	symlinkSync(path.join(root, "nowhere"), path.join(skillsRoot, "dangling"));
	created.add(path.join(skillsRoot, "dangling"));
	expect((await create("dangling")).status).toBe(409);
	expect(lstatSync(path.join(skillsRoot, "dangling")).isSymbolicLink()).toBe(true);

	const projectSkill = handWrite(path.join(project, ".omp", "skills", "shared-name"), "name: shared-name\ndescription: Project one.\n");
	created.add(path.dirname(projectSkill));
	const clash = await create("shared-name");
	expect(clash.status).toBe(409);
	expect(((await clash.json()) as { error: string }).error).toContain("project");
	expect(existsSync(path.join(skillsRoot, "shared-name"))).toBe(false);
});

test("an edit replaces description and body, keeps other frontmatter, and the listing shows it at once", async () => {
	const file = userSkill("hand-made", "# kept comment\nname: hand-made\ndescription: Old words.\ntags: [a, b]\nhide: false\n");
	const listed = (await row(file))!;
	expect(listed.editable).toBe(true);
	const { revision } = await detail(listed.id);

	const response = await send("PUT", `/skills/${listed.id}`, { description: "New words: with a colon.", body: "\n\nNew body.", revision });
	expect(response.status).toBe(200);
	expect(((await response.json()) as SkillSummary).frontmatter.description).toBe("New words: with a colon.");

	const raw = readFileSync(file, "utf8");
	expect(raw).toContain("# kept comment");
	expect(raw).toContain("tags: [a, b]\n");
	const frontmatter = YAML.parse(/^---\n([\s\S]*?)---\n/.exec(raw)![1]!);
	expect(frontmatter).toEqual({ name: "hand-made", description: "New words: with a colon.", tags: ["a", "b"], hide: false });
	expect(raw.endsWith("---\n\nNew body.\n")).toBe(true);
	expect((await row(file))!.frontmatter.description).toBe("New words: with a colon.");
});

test("an edit against a stale revision is refused and leaves the file alone", async () => {
	const file = userSkill("raced");
	const listed = (await row(file))!;
	const { revision } = await detail(listed.id);
	writeFileSync(file, "---\nname: raced\ndescription: Changed on disk.\n---\n\nAgent edit.\n");
	const response = await send("PUT", `/skills/${listed.id}`, { description: "Deck edit.", body: "Deck body.", revision });
	expect(response.status).toBe(409);
	expect(readFileSync(file, "utf8")).toContain("Agent edit.");
	expect((await send("PUT", `/skills/${listed.id}`, { description: "Deck edit.", body: "Deck body." })).status).toBe(400);
});

test("a skill directory symlinked outside the skills root is read-only and survives edit and delete attempts", async () => {
	const target = handWrite(path.join(outside, "linked"), "name: linked\ndescription: Lives elsewhere.\n");
	mkdirSync(skillsRoot, { recursive: true });
	symlinkSync(path.join(outside, "linked"), path.join(skillsRoot, "linked"));
	created.add(path.join(skillsRoot, "linked"));
	const listed = (await row(path.join(skillsRoot, "linked", "SKILL.md")))!;
	expect(listed).toMatchObject({ provider: "native", level: "user", editable: false });
	const { revision } = await detail(listed.id);

	const edit = await send("PUT", `/skills/${listed.id}`, { description: "Hijacked.", body: "x", revision });
	expect(edit.status).toBe(409);
	expect(((await edit.json()) as { error: string }).error).toContain("outside the skills root");
	expect((await send("DELETE", `/skills/${listed.id}`)).status).toBe(409);
	expect(readFileSync(target, "utf8")).toContain("Lives elsewhere.");
	expect(lstatSync(path.join(skillsRoot, "linked")).isSymbolicLink()).toBe(true);
});

test("a SKILL.md symlinked out of its directory is read-only", async () => {
	const target = handWrite(path.join(outside, "file-target"), "name: file-link\ndescription: Linked file.\n");
	mkdirSync(path.join(skillsRoot, "file-link"), { recursive: true });
	created.add(path.join(skillsRoot, "file-link"));
	symlinkSync(target, path.join(skillsRoot, "file-link", "SKILL.md"));
	const listed = (await row(path.join(skillsRoot, "file-link", "SKILL.md")))!;
	expect(listed.editable).toBe(false);
	const { revision } = await detail(listed.id);
	expect((await send("PUT", `/skills/${listed.id}`, { description: "Hijacked.", body: "x", revision })).status).toBe(409);
	expect(readFileSync(target, "utf8")).toContain("Linked file.");
});

test("a skills root symlinked outside the agent dir refuses new skills", async () => {
	mkdirSync(skillsRoot, { recursive: true });
	const parked = path.join(root, "parked-skills");
	renameSync(skillsRoot, parked);
	mkdirSync(outside, { recursive: true });
	symlinkSync(outside, skillsRoot);
	try {
		const response = await send("POST", "/skills", { name: "escapes", description: "d", body: "b" });
		expect(response.status).toBe(409);
		expect(existsSync(path.join(outside, "escapes"))).toBe(false);
	} finally {
		rmSync(skillsRoot);
		renameSync(parked, skillsRoot);
	}
});

test("project skills and other providers' skills stay read-only", async () => {
	const projectFile = handWrite(path.join(project, ".omp", "skills", "project-only"), "name: project-only\ndescription: Project.\n");
	const claudeFile = handWrite(path.join(project, ".claude", "skills", "claude-only"), "name: claude-only\ndescription: Claude.\n");
	created.add(path.dirname(projectFile));
	created.add(path.dirname(claudeFile));
	const rows = await list();
	const readOnly = rows.filter((s) => s.skillPath === projectFile || s.skillPath === claudeFile);
	expect(readOnly.map((s) => s.provider).sort()).toEqual(["claude", "native"]);
	for (const skill of readOnly) {
		expect(skill.editable).toBe(false);
		const { revision } = await detail(skill.id);
		expect((await send("PUT", `/skills/${skill.id}`, { description: "Edited.", body: "x", revision })).status).toBe(403);
		expect((await send("DELETE", `/skills/${skill.id}`)).status).toBe(403);
	}
	expect(readFileSync(projectFile, "utf8")).toContain("Project.");
	expect(readFileSync(claudeFile, "utf8")).toContain("Claude.");
	expect(rows.filter((s) => s.provider !== "native" || s.level !== "user").every((s) => !s.editable)).toBe(true);
});

test("deleting a skill removes its directory without following links inside it", async () => {
	const file = userSkill("doomed");
	mkdirSync(outside, { recursive: true });
	writeFileSync(path.join(outside, "keep.txt"), "keep");
	symlinkSync(outside, path.join(skillsRoot, "doomed", "refs"));
	const listed = (await row(file))!;
	expect((await send("DELETE", `/skills/${listed.id}`)).status).toBe(200);
	expect(existsSync(path.join(skillsRoot, "doomed"))).toBe(false);
	expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
	expect(await row(file)).toBeUndefined();
	expect((await send("DELETE", `/skills/${listed.id}`)).status).toBe(404);
});

test("the watcher arms a skills root created after it started and reports what lands in it", async () => {
	const fresh = path.join(root, "fresh-agent", "skills");
	let changes = 0;
	const stop = watchSkillRoots([fresh], () => {
		changes += 1;
	});
	try {
		await Bun.sleep(50);
		mkdirSync(path.join(fresh, "first"), { recursive: true });
		await waitFor(() => changes > 0);
		const armed = changes;
		writeFileSync(path.join(fresh, "first", "SKILL.md"), "---\nname: first\ndescription: d\n---\n");
		await waitFor(() => changes > armed);
	} finally {
		stop();
	}
});

async function waitFor(ready: () => boolean): Promise<void> {
	for (let i = 0; i < 100 && !ready(); i++) await Bun.sleep(20);
	expect(ready()).toBe(true);
}
