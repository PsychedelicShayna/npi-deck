/**
 * Runs the backend contract fixture against the pinned NeoPi tree (or an
 * explicit NPI_DECK_BACKEND override). The fixture isolates itself in child
 * processes, so importing the tree never touches this test process.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { expect, test } from "bun:test";

import { listBackends, resolveBackendSelection } from "./runtime.ts";

function fixtureBackend(): string | undefined {
	if (process.env.NPI_DECK_BACKEND) return resolveBackendSelection()?.path;
	const pin = readFileSync(path.resolve(import.meta.dir, "../../../../neopi.pin"), "utf8").trim();
	try { return listBackends().find(entry => entry.id === pin.slice(0, 10))?.path; }
	catch { return undefined; }
}

const backendPath = fixtureBackend();

test.skipIf(!backendPath)(
	"every manifest operation works against the pinned NeoPi tree",
	() => {
		const proc = Bun.spawnSync([process.execPath, `${import.meta.dir}/contract.ts`, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, NPI_DECK_BACKEND: backendPath! },
		});
		const out = proc.stdout.toString();
		const report = JSON.parse(out.slice(out.indexOf("{"))) as {
			ok: boolean;
			checks: { name: string; ok: boolean; detail: string }[];
		};
		expect(report.checks.filter((c) => !c.ok)).toEqual([]);
		expect(report.ok).toBe(true);
		expect(proc.exitCode).toBe(0);
	},
	120_000,
);
