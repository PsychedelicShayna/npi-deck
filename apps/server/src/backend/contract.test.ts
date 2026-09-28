/**
 * Runs the backend contract fixture (contract.ts) against the configured NeoPi
 * tree. The fixture isolates itself in child processes, so importing the tree
 * never touches this test process.
 */
import { expect, test } from "bun:test";

import { resolveBackendSelection } from "./runtime.ts";

function configuredBackend(): boolean {
	try {
		resolveBackendSelection();
		return true;
	} catch {
		return false;
	}
}

test.skipIf(!configuredBackend())(
	"every manifest operation works against the configured NeoPi tree",
	() => {
		const proc = Bun.spawnSync([process.execPath, `${import.meta.dir}/contract.ts`, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
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
