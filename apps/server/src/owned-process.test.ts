import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initializeOwnedGeneration, spawnOwned, spawnOwnedSync, stopOwnedProcesses } from "./owned-process.ts";
import { GEN_ENV } from "./owned/generations.ts";

const linux = process.platform === "linux";
const savedHome = process.env.NPI_DECK_HOME;
const savedGeneration = process.env[GEN_ENV];
let home = "";

function isolatedHome(): string {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "npi-owned-process-"));
	process.env.NPI_DECK_HOME = home;
	return home;
}

function running(pid: number): boolean {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
	} catch { return false; }
}

afterEach(async () => {
	await stopOwnedProcesses();
	if (savedHome === undefined) delete process.env.NPI_DECK_HOME;
	else process.env.NPI_DECK_HOME = savedHome;
	if (savedGeneration === undefined) delete process.env[GEN_ENV];
	else process.env[GEN_ENV] = savedGeneration;
	if (home) fs.rmSync(home, { recursive: true, force: true });
	home = "";
});

test.skipIf(!linux)("leader exit kills a background child in its owned group", async () => {
	const dir = isolatedHome();
	initializeOwnedGeneration();
	const pidFile = path.join(dir, "grandchild.pid");
	const proc = spawnOwned(["sh", "-c", `sleep 30 & echo $! > '${pidFile}'; exit 0`], { stdout: "ignore", stderr: "ignore" });
	await proc.exited;
	const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
	for (let i = 0; i < 50 && running(pid); i++) await Bun.sleep(10);
	const journal = JSON.parse(fs.readFileSync(path.join(dir, "run/owned.json"), "utf8"));
	expect(running(pid)).toBe(false);
	expect(journal).toEqual([]);
});

test.skipIf(!linux)("stale leader identity never signals an unrelated process group", async () => {
	const dir = isolatedHome();
	const run = path.join(dir, "run");
	fs.mkdirSync(run, { recursive: true });
	const unrelated = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
	try {
		fs.writeFileSync(path.join(run, "owned.json"), JSON.stringify([{
			pid: unrelated.pid, pgid: unrelated.pid, starttime: "0", generation: "stale", groupId: "stale",
		}]));
		initializeOwnedGeneration();
		expect(running(unrelated.pid)).toBe(true);
	} finally {
		unrelated.kill("SIGKILL");
		await unrelated.exited;
	}
});

test.skipIf(!linux)("synchronous child inherits generation without inheriting omitted secrets", () => {
	isolatedHome();
	initializeOwnedGeneration();
	const key = "NPI_DECK_TEST_SECRET";
	const saved = process.env[key];
	process.env[key] = "not-for-child";
	try {
		const proc = spawnOwnedSync(["env"], { stdout: "pipe", stderr: "pipe",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }, { replaceEnv: true });
		const environment = proc.stdout.toString().split("\n");
		expect(proc.exitCode).toBe(0);
		expect(environment).toContain(`${GEN_ENV}=${process.env[GEN_ENV]}`);
		expect(environment.some((entry) => entry.startsWith("NPI_DECK_OWNED_GROUP="))).toBe(true);
		expect(environment).not.toContain(`${key}=not-for-child`);
	} finally {
		if (saved === undefined) delete process.env[key];
		else process.env[key] = saved;
	}
});
