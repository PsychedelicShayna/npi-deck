import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { StartersResponse } from "@npi-deck/protocol";

import { MANAGED_ENV_KEYS_LOADED, readManagedEnvFile } from "./env-store.ts";
import { buildStartersRouter } from "./routes-starters.ts";
import { installStarterExtensions } from "./starter-extensions.ts";
import { installStarterSkills } from "./starter-skills.ts";

const ENV_KEYS = [
	"NPI_DECK_HOME",
	"NPI_DECK_STARTER_SKILLS_DIR",
	"NPI_DECK_STARTER_EXTENSIONS_DIR",
	"NPI_DECK_INSTALL_STARTER_SKILLS",
	"NPI_DECK_INSTALL_STARTER_EXTENSIONS",
];

let saved: Record<string, string | undefined>;
let root: string;
let agentDir: string;

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	for (const k of ENV_KEYS) delete process.env[k];
	root = mkdtempSync(path.join(os.tmpdir(), "npi-deck-starters-"));
	process.env.NPI_DECK_HOME = path.join(root, "data");
	agentDir = path.join(root, "agent");

	const skills = path.join(root, "starter-skills");
	for (const [name, description] of [["alpha", "Does alpha things."], ["beta", "Does beta things."]]) {
		mkdirSync(path.join(skills, name), { recursive: true });
		writeFileSync(path.join(skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
	}
	writeFileSync(path.join(skills, "README.md"), "not a starter");
	process.env.NPI_DECK_STARTER_SKILLS_DIR = skills;

	const extensions = path.join(root, "starter-extensions");
	mkdirSync(path.join(extensions, "gate"), { recursive: true });
	writeFileSync(
		path.join(extensions, "gate", "index.ts"),
		"/**\n * gate\n *\n * Nudges the agent at turn end\n * to capture what it learned.\n *\n * Design notes.\n */\nexport default {};\n",
	);
	process.env.NPI_DECK_STARTER_EXTENSIONS_DIR = extensions;

	// alpha is already installed; the user owns that copy.
	mkdirSync(path.join(agentDir, "skills", "alpha"), { recursive: true });
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		MANAGED_ENV_KEYS_LOADED.delete(k);
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

function app() {
	return buildStartersRouter({ agentDir: () => agentDir });
}

async function list(): Promise<StartersResponse> {
	return (await (await app().request("http://127.0.0.1/starters")).json()) as StartersResponse;
}

function putAutoInstall(body: unknown) {
	return app().request("http://127.0.0.1/starters/auto-install", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("Settings → Starters (#98)", () => {
	test("lists every bundled starter with what it does and whether it is installed", async () => {
		const body = await list();
		expect(body.skills.targetDir).toBe(path.join(agentDir, "skills"));
		expect(body.skills.autoInstall).toBe(true);
		expect(body.skills.setting).toEqual({ key: "NPI_DECK_INSTALL_STARTER_SKILLS", source: "unset", editable: true });
		expect(body.skills.items).toEqual([
			{ name: "alpha", description: "Does alpha things.", installed: true, installedPath: path.join(agentDir, "skills", "alpha") },
			{ name: "beta", description: "Does beta things.", installed: false, installedPath: path.join(agentDir, "skills", "beta") },
		]);
		expect(body.extensions.items).toEqual([
			{
				name: "gate",
				description: "Nudges the agent at turn end to capture what it learned.",
				installed: false,
				installedPath: path.join(agentDir, "extensions", "gate"),
			},
		]);
	});

	test("switching launch-time install off stops the copy; switching it on copies what is missing", async () => {
		const off = await putAutoInstall({ skills: false });
		expect(off.status).toBe(200);
		expect(((await off.json()) as StartersResponse).skills.autoInstall).toBe(false);
		expect(readManagedEnvFile().values.get("NPI_DECK_INSTALL_STARTER_SKILLS")).toBe("0");
		expect(await installStarterSkills(agentDir)).toEqual({ installed: [], skipped: [] });
		expect(existsSync(path.join(agentDir, "skills", "beta"))).toBe(false);

		const on = (await (await putAutoInstall({ skills: true })).json()) as StartersResponse;
		expect(on.skills.autoInstall).toBe(true);
		expect(readManagedEnvFile().values.has("NPI_DECK_INSTALL_STARTER_SKILLS")).toBe(false);
		expect(await installStarterSkills(agentDir)).toEqual({ installed: ["beta"], skipped: ["alpha"] });
		expect((await list()).skills.items.every((item) => item.installed)).toBe(true);
	});

	test("any off spelling the Env editor accepts disables the install, and a shell-exported switch is read-only", async () => {
		process.env.NPI_DECK_INSTALL_STARTER_EXTENSIONS = "off";
		const body = await list();
		expect(body.extensions.autoInstall).toBe(false);
		expect(body.extensions.setting).toEqual({ key: "NPI_DECK_INSTALL_STARTER_EXTENSIONS", source: "process-env", editable: false });
		expect(await installStarterExtensions(agentDir)).toEqual({ installed: [], skipped: [] });
		expect((await putAutoInstall({ extensions: true })).status).toBe(409);
	});

	test("a non-boolean switch is refused", async () => {
		expect((await putAutoInstall({ skills: "no" })).status).toBe(400);
	});
});

describe("starter installers stay inside the agent dir (#98 review)", () => {
	test("a skills or extensions dir symlinked outside the agent dir is refused and nothing is written through it", async () => {
		const outside = path.join(root, "outside");
		mkdirSync(path.join(outside, "skills"), { recursive: true });
		mkdirSync(path.join(outside, "extensions"), { recursive: true });
		const freshAgent = path.join(root, "fresh-agent");
		mkdirSync(freshAgent);
		symlinkSync(path.join(outside, "skills"), path.join(freshAgent, "skills"));
		symlinkSync(path.join(outside, "extensions"), path.join(freshAgent, "extensions"));

		expect(await installStarterSkills(freshAgent)).toEqual({ installed: [], skipped: [] });
		expect(await installStarterExtensions(freshAgent)).toEqual({ installed: [], skipped: [] });
		expect(readdirSync(path.join(outside, "skills"))).toEqual([]);
		expect(readdirSync(path.join(outside, "extensions"))).toEqual([]);
	});

	test("a starter destination that is a symlink, even a dangling one, counts as the user's and is not written through", async () => {
		const outside = path.join(root, "outside-beta");
		symlinkSync(outside, path.join(agentDir, "skills", "beta"));
		const result = await installStarterSkills(agentDir);
		expect(result.installed).toEqual([]);
		expect(result.skipped.sort()).toEqual(["alpha", "beta"]);
		expect(existsSync(outside)).toBe(false);
	});

	test("a symlinked agent dir itself is fine: containment is checked on resolved paths", async () => {
		const linked = path.join(root, "agent-link");
		symlinkSync(agentDir, linked);
		expect(await installStarterSkills(linked)).toEqual({ installed: ["beta"], skipped: ["alpha"] });
		expect(existsSync(path.join(agentDir, "skills", "beta", "SKILL.md"))).toBe(true);
	});
});
