import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { StartersResponse } from "@npi-deck/protocol";

import { MANAGED_ENV_KEYS_LOADED, commitManagedEnvUpdates, readManagedEnvFile, setDeckGeneratedEnv } from "./env-store.ts";
import { resolveEnvSetting } from "./env-schema.ts";
import { buildStartersRouter } from "./routes-starters.ts";
import { installOptedInStarters } from "./starters.ts";

const ENV_KEYS = [
	"NPI_DECK_HOME",
	"NPI_DECK_STARTER_SKILLS_DIR",
	"NPI_DECK_STARTER_EXTENSIONS_DIR",
	"NPI_DECK_STARTERS",
	"NPI_DECK_INSTALL_STARTER_SKILLS",
	"NPI_DECK_INSTALL_STARTER_EXTENSIONS",
	"NPI_DECK_MAINTENANCE_GATE_DISABLED",
	"NPI_DECK_ORG_ROOT",
];

let saved: Record<string, string | undefined>;
let root: string;
let agentDir: string;
const kbRoot = "/tmp/npi-deck-starters-kb";

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	for (const k of ENV_KEYS) delete process.env[k];
	root = mkdtempSync(path.join(os.tmpdir(), "npi-deck-starters-"));
	process.env.NPI_DECK_HOME = path.join(root, "data");
	agentDir = path.join(root, "agent");
	mkdirSync(agentDir);

	const skills = path.join(root, "starter-skills");
	for (const [name, description] of [["alpha", "Does alpha things."], ["beta", "Does beta things."]]) {
		mkdirSync(path.join(skills, name), { recursive: true });
		writeFileSync(
			path.join(skills, name, "SKILL.md"),
			`---\nname: ${name}\ndescription: ${description}\nsource: npi-deck starter (from upstream/${name})\n---\n\n# ${name}\n`,
		);
	}
	writeFileSync(path.join(skills, "README.md"), "not a starter");
	process.env.NPI_DECK_STARTER_SKILLS_DIR = skills;

	const extensions = path.join(root, "starter-extensions");
	mkdirSync(path.join(extensions, "maintenance-gate"), { recursive: true });
	writeFileSync(
		path.join(extensions, "maintenance-gate", "index.ts"),
		"/**\n * maintenance-gate\n * source: npi-deck starter (native)\n *\n * Nudges the agent at turn end\n * to capture what it learned.\n *\n * Design notes.\n */\nexport default {};\n",
	);
	process.env.NPI_DECK_STARTER_EXTENSIONS_DIR = extensions;
});

afterEach(() => {
	setDeckGeneratedEnv("NPI_DECK_ORG_ROOT", undefined);
	for (const k of ENV_KEYS) {
		MANAGED_ENV_KEYS_LOADED.delete(k);
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(root, { recursive: true, force: true });
});

function app(dir: () => string = () => agentDir) {
	return buildStartersRouter({ agentDir: dir, kbRoot: () => kbRoot });
}

async function list(): Promise<StartersResponse> {
	return (await (await app().request("http://127.0.0.1/starters")).json()) as StartersResponse;
}

function optIn(id: string, body: unknown, dir?: () => string) {
	return app(dir).request(`http://127.0.0.1/starters/${id}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const optedInFile = () => readManagedEnvFile().values.get("NPI_DECK_STARTERS");

describe("starters are opt-in (#34)", () => {
	test("a fresh deck installs nothing and leaves the agent dir untouched, even with the old install switches on", async () => {
		process.env.NPI_DECK_INSTALL_STARTER_SKILLS = "1";
		process.env.NPI_DECK_INSTALL_STARTER_EXTENSIONS = "1";
		expect(await installOptedInStarters(agentDir)).toEqual([]);
		expect(readdirSync(agentDir)).toEqual([]);
	});

	test("the listing shows each starter's origin tag and that none is opted in", async () => {
		const body = await list();
		expect(body.setting).toEqual({ key: "NPI_DECK_STARTERS", source: "unset", editable: true });
		expect(body.skills.targetDir).toBe(path.join(agentDir, "skills"));
		expect(body.skills.items).toEqual([
			{
				kind: "skills",
				name: "alpha",
				description: "Does alpha things.",
				origin: "npi-deck starter (from upstream/alpha)",
				optedIn: false,
				installed: false,
				installedPath: path.join(agentDir, "skills", "alpha"),
			},
			{
				kind: "skills",
				name: "beta",
				description: "Does beta things.",
				origin: "npi-deck starter (from upstream/beta)",
				optedIn: false,
				installed: false,
				installedPath: path.join(agentDir, "skills", "beta"),
			},
		]);
		expect(body.extensions.items).toEqual([
			{
				kind: "extensions",
				name: "maintenance-gate",
				description: "Nudges the agent at turn end to capture what it learned.",
				origin: "npi-deck starter (native)",
				optedIn: false,
				installed: false,
				installedPath: path.join(agentDir, "extensions", "maintenance-gate"),
			},
		]);
	});

	test("opting in installs that starter now and at later launches; opting out stops that and keeps the copy", async () => {
		const res = await optIn("skills/beta", { optedIn: true });
		expect(res.status).toBe(200);
		const on = (await res.json()) as StartersResponse;
		expect(on.skills.items.map((i) => [i.name, i.optedIn, i.installed])).toEqual([["alpha", false, false], ["beta", true, true]]);
		expect(optedInFile()).toBe("skills/beta");
		expect(existsSync(path.join(agentDir, "skills", "beta", "SKILL.md"))).toBe(true);
		expect(existsSync(path.join(agentDir, "skills", "alpha"))).toBe(false);
		expect(existsSync(path.join(agentDir, "extensions"))).toBe(false);

		// Opted in: a copy that goes missing comes back at the next launch.
		rmSync(path.join(agentDir, "skills", "beta"), { recursive: true });
		expect(await installOptedInStarters(agentDir)).toEqual(["skills/beta"]);

		const off = (await (await optIn("skills/beta", { optedIn: false })).json()) as StartersResponse;
		expect(off.skills.items.find((i) => i.name === "beta")).toMatchObject({ optedIn: false, installed: true });
		expect(readManagedEnvFile().values.has("NPI_DECK_STARTERS")).toBe(false);

		// Opted out: deleting the copy is final.
		rmSync(path.join(agentDir, "skills", "beta"), { recursive: true });
		expect(await installOptedInStarters(agentDir)).toEqual([]);
		expect(readdirSync(path.join(agentDir, "skills"))).toEqual([]);
	});

	test("opting in never overwrites a copy the user already has", async () => {
		mkdirSync(path.join(agentDir, "skills", "alpha"), { recursive: true });
		writeFileSync(path.join(agentDir, "skills", "alpha", "SKILL.md"), "mine");
		const body = (await (await optIn("skills/alpha", { optedIn: true })).json()) as StartersResponse;
		expect(body.skills.items[0]).toMatchObject({ name: "alpha", optedIn: true, installed: true });
		expect(await Bun.file(path.join(agentDir, "skills", "alpha", "SKILL.md")).text()).toBe("mine");
	});

	test("a shell-exported opt-in list is read-only; unknown starters and non-boolean bodies are refused", async () => {
		expect((await optIn("skills/gamma", { optedIn: true })).status).toBe(404);
		expect((await optIn("routines/alpha", { optedIn: true })).status).toBe(404);
		expect((await optIn("skills/alpha", { optedIn: "yes" })).status).toBe(400);

		process.env.NPI_DECK_STARTERS = "skills/alpha";
		expect((await list()).setting).toEqual({ key: "NPI_DECK_STARTERS", source: "process-env", editable: false });
		expect((await optIn("skills/beta", { optedIn: true })).status).toBe(409);
		expect(existsSync(path.join(agentDir, "skills", "beta"))).toBe(false);
		expect(optedInFile()).toBeUndefined();
	});

	test("with no backend loaded, starters are skipped: nothing is listed, written or installed", async () => {
		const noBackend = () => {
			throw new Error("no backend loaded");
		};
		expect((await app(noBackend).request("http://127.0.0.1/starters")).status).toBe(503);
		expect((await optIn("skills/alpha", { optedIn: true }, noBackend)).status).toBe(503);
		expect(optedInFile()).toBeUndefined();
		expect(readdirSync(agentDir)).toEqual([]);
	});

	test("concurrent opt-ins all land in the list", async () => {
		const results = await Promise.all([optIn("skills/alpha", { optedIn: true }), optIn("skills/beta", { optedIn: true })]);
		expect(results.map((r) => r.status)).toEqual([200, 200]);
		expect(optedInFile()).toBe("skills/alpha,skills/beta");
	});
});

describe("maintenance gate org root follows its starter (#34)", () => {
	test("the deck sets NPI_DECK_ORG_ROOT only while maintenance-gate is opted in and enabled", async () => {
		expect(process.env.NPI_DECK_ORG_ROOT).toBeUndefined();
		await optIn("extensions/maintenance-gate", { optedIn: true });
		expect(process.env.NPI_DECK_ORG_ROOT).toBe(kbRoot);
		expect(existsSync(path.join(agentDir, "extensions", "maintenance-gate", "index.ts"))).toBe(true);

		const put = (body: unknown) =>
			app().request("http://127.0.0.1/starters/maintenance-gate", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		await put({ enabled: false });
		expect(process.env.NPI_DECK_ORG_ROOT).toBeUndefined();
		await put({ enabled: true });
		expect(process.env.NPI_DECK_ORG_ROOT).toBe(kbRoot);

		await optIn("extensions/maintenance-gate", { optedIn: false });
		expect(process.env.NPI_DECK_ORG_ROOT).toBeUndefined();
	});

	test("an org root the user set is never replaced or cleared", async () => {
		process.env.NPI_DECK_ORG_ROOT = "/srv/my-org";
		await optIn("extensions/maintenance-gate", { optedIn: true });
		expect(process.env.NPI_DECK_ORG_ROOT).toBe("/srv/my-org");
		await optIn("extensions/maintenance-gate", { optedIn: false });
		expect(process.env.NPI_DECK_ORG_ROOT).toBe("/srv/my-org");
	});

	test("an org root saved in Settings after opt-in overrides the generated one live, and opting out leaves it", async () => {
		const gate = async () =>
			(await (await app().request("http://127.0.0.1/starters/maintenance-gate")).json()) as { orgRoot: string | null; orgRootSource: string };
		await optIn("extensions/maintenance-gate", { optedIn: true });
		expect(resolveEnvSetting("NPI_DECK_ORG_ROOT").setting).toEqual({ key: "NPI_DECK_ORG_ROOT", source: "default", editable: true });
		expect(await gate()).toMatchObject({ orgRoot: kbRoot, orgRootSource: "default" });

		// The Env editor's save path.
		await commitManagedEnvUpdates({ NPI_DECK_ORG_ROOT: "/srv/my-org" });
		expect(process.env.NPI_DECK_ORG_ROOT).toBe("/srv/my-org");
		expect(resolveEnvSetting("NPI_DECK_ORG_ROOT")).toEqual({
			value: "/srv/my-org",
			setting: { key: "NPI_DECK_ORG_ROOT", source: "env-file", editable: true },
		});
		expect(await gate()).toMatchObject({ orgRoot: "/srv/my-org", orgRootSource: "env-file" });

		// Clearing the override while opted in brings the generated root back.
		await commitManagedEnvUpdates({ NPI_DECK_ORG_ROOT: null });
		expect(process.env.NPI_DECK_ORG_ROOT).toBe(kbRoot);
		await commitManagedEnvUpdates({ NPI_DECK_ORG_ROOT: "/srv/my-org" });

		await optIn("extensions/maintenance-gate", { optedIn: false });
		expect(process.env.NPI_DECK_ORG_ROOT).toBe("/srv/my-org");
		expect(readManagedEnvFile().values.get("NPI_DECK_ORG_ROOT")).toBe("/srv/my-org");

		// Opted out, clearing the override leaves nothing behind.
		await commitManagedEnvUpdates({ NPI_DECK_ORG_ROOT: null });
		expect(process.env.NPI_DECK_ORG_ROOT).toBeUndefined();
	});
});

describe("the bundled starters (#34)", () => {
	test("every one carries an npi-deck origin tag in its listing", async () => {
		delete process.env.NPI_DECK_STARTER_SKILLS_DIR;
		delete process.env.NPI_DECK_STARTER_EXTENSIONS_DIR;
		const body = await list();
		const items = [...body.skills.items, ...body.extensions.items];
		expect(items.map((i) => `${i.kind}/${i.name}`)).toEqual([
			"skills/create-skill",
			"skills/diagnose",
			"skills/grill-me",
			"skills/handoff",
			"skills/prototype",
			"skills/zoom-out",
			"extensions/maintenance-gate",
		]);
		for (const item of items) {
			expect(item.origin).toStartWith("npi-deck starter");
			expect(item.description).not.toBe("");
		}
	});
});

describe("starter installs stay inside the agent dir (#98 review)", () => {
	test("a skills dir symlinked outside the agent dir is refused and nothing is written through it", async () => {
		const outside = path.join(root, "outside");
		mkdirSync(path.join(outside, "skills"), { recursive: true });
		symlinkSync(path.join(outside, "skills"), path.join(agentDir, "skills"));

		const res = await optIn("skills/alpha", { optedIn: true });
		expect(res.status).toBe(500);
		expect(optedInFile()).toBeUndefined();
		process.env.NPI_DECK_STARTERS = "skills/alpha";
		expect(await installOptedInStarters(agentDir)).toEqual([]);
		expect(readdirSync(path.join(outside, "skills"))).toEqual([]);
	});

	test("a starter destination that is a symlink, even a dangling one, counts as the user's and is not written through", async () => {
		const outside = path.join(root, "outside-beta");
		mkdirSync(path.join(agentDir, "skills"));
		symlinkSync(outside, path.join(agentDir, "skills", "beta"));
		process.env.NPI_DECK_STARTERS = "skills/beta";
		expect(await installOptedInStarters(agentDir)).toEqual([]);
		expect(existsSync(outside)).toBe(false);
	});

	test("a symlinked agent dir itself is fine: containment is checked on resolved paths", async () => {
		const linked = path.join(root, "agent-link");
		symlinkSync(agentDir, linked);
		process.env.NPI_DECK_STARTERS = "skills/beta";
		expect(await installOptedInStarters(linked)).toEqual(["skills/beta"]);
		expect(existsSync(path.join(agentDir, "skills", "beta", "SKILL.md"))).toBe(true);
	});
});
