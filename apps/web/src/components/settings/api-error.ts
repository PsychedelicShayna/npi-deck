/**
 * The server's own `{ error }` message from a failed settings request, else
 * the raw text. `settingsApi`/`startersApi` throw
 * `HTTP <status> <path>: <body>`.
 */
export function apiErrorText(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	const body = /^HTTP \d+ \S+: ([\s\S]*)$/.exec(message)?.[1];
	if (body) {
		try {
			const parsed = JSON.parse(body) as { error?: unknown };
			if (typeof parsed.error === "string") return parsed.error;
		} catch {
			/* not JSON: fall through to the raw text */
		}
	}
	return message;
}
