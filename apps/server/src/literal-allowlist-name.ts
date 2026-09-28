// Bun.Glob treats a leading ! as negation; the other metacharacters can
// match names besides the one configured by the operator. CSV flags also
// reserve commas. A filtered run must never broaden its own allowlist.
export function isLiteralAllowlistName(name: unknown): name is string {
	return typeof name === "string" && name.length > 0 && name === name.trim() && !/[!,*?[\]{}()\\]/.test(name);
}
