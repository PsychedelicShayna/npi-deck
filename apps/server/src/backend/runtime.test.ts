import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listBackends, resolveBackendSelection, writeActiveBackend } from "./runtime.ts";

const roots: string[] = [];
function home(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "npi-deck-backend-test-"));
	roots.push(dir);
	return dir;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("backend selection", () => {
	test("backendless boot, registered source selection and persisted switching", () => {
		const dir = home();
		const env = { NPI_DECK_HOME: dir };
		expect(resolveBackendSelection(env)).toBeUndefined();
		writeFileSync(path.join(dir, "config.yml"), "backends:\n  - id: first\n    kind: source\n    path: /tmp/tree-a\n  - id: second\n    kind: source\n    path: /tmp/tree-b\nactiveBackend: first\n");
		expect(resolveBackendSelection(env)?.path).toBe("/tmp/tree-a");
		writeActiveBackend("second", dir);
		expect(resolveBackendSelection(env)?.path).toBe("/tmp/tree-b");
		writeActiveBackend(null, dir);
		expect(resolveBackendSelection(env)).toBeUndefined();
		expect(listBackends(dir)).toHaveLength(2);
	});
	test("env pin overrides config and reserved gateways cannot load", () => {
		const dir = home();
		writeFileSync(path.join(dir, "config.yml"), "backends:\n  - id: future\n    kind: gateway\n    path: https://example.invalid\nactiveBackend: future\n");
		expect(() => resolveBackendSelection({ NPI_DECK_HOME: dir })).toThrow(/reserved kind gateway/);
		expect(resolveBackendSelection({ NPI_DECK_HOME: dir, NPI_DECK_BACKEND: "/tmp/pinned" })).toEqual({ id: null, path: "/tmp/pinned", source: "env" });
	});
});
