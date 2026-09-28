import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { beginGeneration, GEN_ENV, readGenerations, sweepGenerations } from "./generations.ts";

const linux = process.platform === "linux";
const spawned: Bun.Subprocess[] = [];
const savedGen = process.env[GEN_ENV];

function sleeper(gen?: string): Bun.Subprocess {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
	if (gen) env[GEN_ENV] = gen;
	const proc = Bun.spawn(["sleep", "30"], { env, stdout: "ignore", stderr: "ignore" });
	spawned.push(proc);
	return proc;
}

async function waitForEnviron(proc: Bun.Subprocess): Promise<void> {
	// /proc/<pid>/environ reflects the new image only after exec.
	for (let i = 0; i < 50; i++) {
		try {
			if (fs.readFileSync(`/proc/${proc.pid}/cmdline`, "latin1").startsWith("sleep")) return;
		} catch {
			// not there yet
		}
		await Bun.sleep(10);
	}
}

function tmpRun(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "npi-deck-gen-"));
}

afterEach(() => {
	for (const p of spawned.splice(0)) p.kill("SIGKILL");
	if (savedGen === undefined) delete process.env[GEN_ENV];
	else process.env[GEN_ENV] = savedGen;
});

describe.skipIf(!linux)("generation sweep", () => {
	test("a new generation kills processes of journaled generations and nothing else", async () => {
		const runDir = tmpRun();
		const first = beginGeneration(runDir).gen;
		const orphan = sleeper(first);
		const unmarked = sleeper();
		const foreign = sleeper("some-other-data-dir-generation");
		await Promise.all([orphan, unmarked, foreign].map(waitForEnviron));

		const next = beginGeneration(runDir);

		expect(next.swept).toEqual([orphan.pid]);
		expect(await orphan.exited).not.toBe(0);
		expect(unmarked.exitCode).toBeNull();
		expect(foreign.exitCode).toBeNull();
		expect(readGenerations(runDir)).toEqual([next.gen]);
		expect(process.env[GEN_ENV]).toBe(next.gen);
	});

	test("sweepGenerations kills the current generation too and empties the journal", async () => {
		const runDir = tmpRun();
		const { gen } = beginGeneration(runDir);
		const child = sleeper(gen);
		await waitForEnviron(child);

		expect(sweepGenerations(runDir)).toEqual([child.pid]);
		await child.exited;
		expect(readGenerations(runDir)).toEqual([]);
	});
});
