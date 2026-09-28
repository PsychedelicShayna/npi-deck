/**
 * Which project the kanban board shows. The board is one global board; the
 * filter narrows it. `all` is the default.
 */
export type ProjectFilter = { kind: "all" } | { kind: "unassigned" } | { kind: "cwd"; cwd: string };

export const ALL_PROJECTS: ProjectFilter = { kind: "all" };

/** Project keys carry a prefix so a cwd literally named "all" cannot collide with a sentinel. */
const CWD_PREFIX = "cwd:";

/** `cwd` for `tasksApi.list`: omitted for all projects, `null` for unassigned. */
export function toQueryCwd(filter: ProjectFilter): string | null | undefined {
	if (filter.kind === "all") return undefined;
	if (filter.kind === "unassigned") return null;
	return filter.cwd;
}

/** Stable `<select>` value for a filter. */
export function filterKey(filter: ProjectFilter): string {
	if (filter.kind === "cwd") return `${CWD_PREFIX}${filter.cwd}`;
	return filter.kind;
}

/** Inverse of `filterKey`; anything unrecognised means all projects. */
export function filterFromKey(key: string): ProjectFilter {
	if (key.startsWith(CWD_PREFIX)) return { kind: "cwd", cwd: key.slice(CWD_PREFIX.length) };
	if (key === "unassigned") return { kind: "unassigned" };
	return ALL_PROJECTS;
}

/** Last path segment of a cwd, the name a card shows for its project. */
export function projectLabel(cwd: string | undefined): string {
	if (!cwd) return "unassigned";
	return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}
