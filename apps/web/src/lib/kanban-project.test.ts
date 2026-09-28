import { describe, expect, test } from "bun:test";

import { ALL_PROJECTS, filterFromKey, filterKey, toQueryCwd, type ProjectFilter } from "./kanban-project";

describe("kanban project filter", () => {
	test("maps to the tasks API cwd: omitted for all, null for unassigned, the path otherwise", () => {
		expect(toQueryCwd(ALL_PROJECTS)).toBeUndefined();
		expect(toQueryCwd({ kind: "unassigned" })).toBeNull();
		expect(toQueryCwd({ kind: "cwd", cwd: "/repos/alpha" })).toBe("/repos/alpha");
	});

	test("select values round-trip, including directories named like the sentinels", () => {
		const filters: ProjectFilter[] = [
			ALL_PROJECTS,
			{ kind: "unassigned" },
			{ kind: "cwd", cwd: "/repos/alpha" },
			{ kind: "cwd", cwd: "all" },
			{ kind: "cwd", cwd: "unassigned" },
		];
		for (const f of filters) expect(filterFromKey(filterKey(f))).toEqual(f);
	});
});
