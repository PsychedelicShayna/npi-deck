/**
 * The one encoder for `routine_runs.trigger_payload`, used by started runs
 * and by runs rejected before they start. Steps receive the full payload in
 * memory; only the stored copy is redacted and bounded.
 *
 * Redaction is by key: at any depth, the value of a key matching
 * CREDENTIAL_KEY is stored as `[redacted]`, whatever its type. Values under
 * other keys are stored as sent, so a credential under an innocuous key is
 * kept.
 *
 * The redacted JSON is at most TRIGGER_PAYLOAD_MAX_BYTES of UTF-8 and always
 * parses. A larger one is stored as `{ truncated: true, bytes, preview }`:
 * `bytes` is the size of the full redacted JSON and `preview` is its head.
 */

export const TRIGGER_PAYLOAD_MAX_BYTES = 8 * 1024;

const CREDENTIAL_KEY = /token|secret|passw|pwd|api[-_]?key|auth|signature|cookie|credential|session|bearer/i;

export function encodeTriggerPayload(payload: Record<string, unknown>): string {
	const json = JSON.stringify(payload, (key, value: unknown) => (CREDENTIAL_KEY.test(key) ? "[redacted]" : value));
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes <= TRIGGER_PAYLOAD_MAX_BYTES) return json;
	// Escaping inside `preview` can grow the head, so shrink it until the
	// wrapper fits. Each pass strictly shortens the head, and an empty head
	// always fits.
	let chars = Math.min(json.length, TRIGGER_PAYLOAD_MAX_BYTES);
	for (;;) {
		const stored = JSON.stringify({ truncated: true, bytes, preview: json.slice(0, chars) });
		const size = Buffer.byteLength(stored, "utf8");
		if (size <= TRIGGER_PAYLOAD_MAX_BYTES) return stored;
		chars = Math.max(0, Math.floor((chars * TRIGGER_PAYLOAD_MAX_BYTES) / size) - 64);
	}
}
