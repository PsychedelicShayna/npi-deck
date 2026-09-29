import { compileStructuredOutputSchema } from "@npi-deck/protocol";

/** Answers longer than this are refused before they are parsed or validated. */
export const MAX_STRUCTURED_ANSWER_CHARS = 256 * 1024;
/** Wall-clock budget for compiling the schema and validating one answer. */
export const STRUCTURED_OUTPUT_TIMEOUT_MS = 2_000;
const MAX_REPORTED_SCHEMA_ERRORS = 10;

export type StructuredOutputCheck =
	| { ok: true; json: unknown }
	| { ok: false; kind: "size" | "parse" | "mismatch" | "schema" | "timeout" | "worker"; error: string };

/** A fault in the agent's answer, which `strict: false` tolerates; the rest fail the step in either mode. */
export function isAnswerFault(check: Extract<StructuredOutputCheck, { ok: false }>): boolean {
	return check.kind === "size" || check.kind === "parse" || check.kind === "mismatch";
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Compile the schema, parse the answer, then validate it; each failure class
 * reports separately. Synchronous and unbounded: a routine-supplied `pattern`
 * can backtrack for seconds, so the server only calls this on a worker thread
 * through {@link checkStructuredOutput}.
 */
export function checkStructuredOutputSync(schema: unknown, answer: string): StructuredOutputCheck {
	let validate: ReturnType<typeof compileStructuredOutputSchema>;
	try {
		validate = compileStructuredOutputSchema(schema);
	} catch (error) {
		return { ok: false, kind: "schema", error: `structured_output schema could not be compiled: ${message(error)}` };
	}
	let json: unknown;
	try {
		json = JSON.parse(answer);
	} catch (error) {
		return { ok: false, kind: "parse", error: `structured_output is not valid JSON: ${message(error)}` };
	}
	const validation = validate(json);
	if (validation.valid) return { ok: true, json };
	const errors = validation.errors ?? [];
	const described = errors.slice(0, MAX_REPORTED_SCHEMA_ERRORS).map(error => {
		const property = error.keyword === "additionalProperties" ? ` '${String(error.params.additionalProperty)}'` : "";
		return `${error.path} ${error.message}${property}`;
	});
	if (errors.length > MAX_REPORTED_SCHEMA_ERRORS) described.push(`(+${errors.length - MAX_REPORTED_SCHEMA_ERRORS} more)`);
	return { ok: false, kind: "mismatch", error: `structured_output does not match schema: ${described.join("; ")}` };
}

/**
 * {@link checkStructuredOutputSync} on a fresh worker thread, terminated after
 * `timeoutMs` so a pathological schema cannot stall the server's event loop.
 */
export function checkStructuredOutput(schema: unknown, answer: string, timeoutMs = STRUCTURED_OUTPUT_TIMEOUT_MS): Promise<StructuredOutputCheck> {
	if (answer.length > MAX_STRUCTURED_ANSWER_CHARS) {
		return Promise.resolve({ ok: false, kind: "size", error: `structured_output answer is ${answer.length} characters; the limit is ${MAX_STRUCTURED_ANSWER_CHARS}` });
	}
	return new Promise(resolve => {
		const worker = new Worker(new URL("./structured-output-worker.ts", import.meta.url));
		let settled = false;
		const finish = (check: StructuredOutputCheck) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			worker.terminate();
			resolve(check);
		};
		const timer = setTimeout(() => finish({ ok: false, kind: "timeout", error: `structured_output validation timed out after ${timeoutMs} ms` }), timeoutMs);
		worker.addEventListener("message", (event: MessageEvent<StructuredOutputCheck>) => finish(event.data));
		worker.addEventListener("error", (event: ErrorEvent) => finish({ ok: false, kind: "worker", error: `structured_output validation failed: ${event.message}` }));
		worker.addEventListener("close", () => finish({ ok: false, kind: "worker", error: "structured_output validation worker exited without a result" }));
		worker.postMessage({ schema, answer });
	});
}
