/**
 * The one encoder for `routine_runs.trigger_payload`, used by started runs
 * and by runs rejected before they start. Steps receive the full payload in
 * memory; the stored copy is at most TRIGGER_PAYLOAD_MAX_BYTES of UTF-8 and
 * always parses as JSON. A payload whose JSON is larger is stored as
 * `{ truncated: true, bytes, preview }`: `bytes` is the size of the full JSON
 * and `preview` is its head.
 *
 * The encoder does not redact. A caller holding credentials, such as request
 * headers, strips them before it hands the payload over.
 */

export const TRIGGER_PAYLOAD_MAX_BYTES = 8 * 1024;

export function encodeTriggerPayload(payload: Record<string, unknown>): string {
	const json = JSON.stringify(payload);
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
