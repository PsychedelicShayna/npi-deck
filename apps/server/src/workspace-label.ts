/**
 * Display label for a working directory: its last path segment. Shared so the
 * session workspace picker and the kanban project filter name a repo the same.
 */
export function deriveLabel(cwd: string): string {
	if (!cwd) return "(unknown)";
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? cwd;
}
