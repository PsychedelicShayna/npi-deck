/**
 * Ajv validator for V1 routine specs. Single source of truth: the JSON
 * Schemas under `./schemas/`. The visual builder (Phase 3) reads the same
 * files to drive per-step form rendering.
 *
 * Schemas are registered with Ajv by their `$id` (e.g.
 * `npi-deck/schemas/step-common.json`), and the root `routine-spec.json`
 * `$ref`-resolves against that namespace.
 */

import Ajv2020, { type ErrorObject } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import routineSpecSchema from "./schemas/routine-spec.json";
import routineLayoutSchema from "./schemas/routine-layout.json";
import stepAgentSchema from "./schemas/step-agent.json";
import stepCommonSchema from "./schemas/step-common.json";
import stepDeckSchema from "./schemas/step-deck.json";
import stepHttpSchema from "./schemas/step-http.json";
import stepMcpSchema from "./schemas/step-mcp.json";
import stepRunSchema from "./schemas/step-run.json";
import stepSetStateSchema from "./schemas/step-set_state.json";
import stepTransformSchema from "./schemas/step-transform.json";
import stepWaitSchema from "./schemas/step-wait.json";
import stepWriteSchema from "./schemas/step-write.json";
import triggerCronSchema from "./schemas/trigger-cron.json";
import triggerEventSchema from "./schemas/trigger-event.json";
import triggerManualSchema from "./schemas/trigger-manual.json";
import triggerWebhookSchema from "./schemas/trigger-webhook.json";

export interface ValidationError {
	/** JSON Pointer to the offending node (Ajv's `instancePath`). */
	path: string;
	/** Ajv's keyword that triggered (e.g. "required", "enum", "type"). */
	keyword: string;
	/** Human-readable message. */
	message: string;
	/** Schema-side context (e.g. {missingProperty: "id"} for required-keyword errors). */
	params: Record<string, unknown>;
}

export interface ValidationResult {
	valid: boolean;
	errors?: ValidationError[];
}

const SUB_SCHEMAS = [
	stepCommonSchema,
	stepRunSchema,
	stepAgentSchema,
	stepWriteSchema,
	stepHttpSchema,
	stepDeckSchema,
	stepMcpSchema,
	stepTransformSchema,
	stepWaitSchema,
	stepSetStateSchema,
	triggerCronSchema,
	triggerWebhookSchema,
	triggerManualSchema,
	triggerEventSchema,
	routineLayoutSchema,
] as const;

let cachedValidator: ((spec: unknown) => boolean) | null = null;
let cachedAjv: Ajv2020 | null = null;

function getValidator(): { ajv: Ajv2020; validate: (spec: unknown) => boolean } {
	if (cachedValidator && cachedAjv) {
		return { ajv: cachedAjv, validate: cachedValidator };
	}

	// strict:false lets us use additionalProperties selectively without Ajv
	// complaining about every minor schema feature. allErrors:true returns
	// the full list rather than failing fast so the UI can surface multiple
	// problems at once.
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	addFormats(ajv);

	for (const schema of SUB_SCHEMAS) {
		ajv.addSchema(schema);
	}
	const validate = ajv.compile(routineSpecSchema);

	cachedAjv = ajv;
	cachedValidator = validate;
	return { ajv, validate };
}

function normalizeErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
	if (!errors) return [];
	return errors.map((e) => ({
		path: e.instancePath || "/",
		keyword: e.keyword,
		message: e.message ?? "(no message)",
		params: (e.params as Record<string, unknown>) ?? {},
	}));
}

/**
 * Validate a V1 routine spec object. The argument should already be the
 * parsed-from-YAML JavaScript object; YAML parsing is the caller's
 * responsibility (and lives in the server's routine runner).
 *
 * Three-stage validation:
 *   1. Ajv structural validation against the JSON Schemas.
 *   2. Cross-reference pass: when a `layout` block is present, every edge
 *      `from`/`to` and every node key must reference an actual step id.
 *      Reported with a synthetic `crossRef` keyword + a JSON-Pointer path so
 *      the UI can surface them inline alongside Ajv errors.
 *   3. Every agent step's `structured_output.schema` must compile with
 *      {@link compileStructuredOutputSchema}, so an unusable or `$async`
 *      schema is refused at save instead of at run time.
 */
export function validateRoutineSpec(spec: unknown): ValidationResult {
	const { validate } = getValidator();
	const valid = validate(spec);
	if (!valid) {
		// Cast: Ajv attaches `.errors` to the compiled validator function.
		const errors = (validate as unknown as { errors?: ErrorObject[] | null }).errors;
		return { valid: false, errors: normalizeErrors(errors) };
	}

	const crossRef = checkLayoutCrossRefs(spec);
	if (crossRef.length > 0) {
		return { valid: false, errors: crossRef };
	}
	const outputSchemas = checkStructuredOutputSchemas(spec);
	if (outputSchemas.length > 0) {
		return { valid: false, errors: outputSchemas };
	}
	return { valid: true };
}

/**
 * Compile a headless agent's declared output schema. Throws when the schema
 * itself is invalid, so callers can report that apart from a bad answer.
 * `$async` schemas are refused: their validator returns a Promise, which a
 * synchronous caller would read as a pass. (Ajv already refuses `$async`
 * nested under a synchronous root.)
 */
export function compileStructuredOutputSchema(schema: unknown): (output: unknown) => ValidationResult {
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	addFormats(ajv);
	const validate = ajv.compile(schema as object);
	// Ajv types compile() as synchronous; an `$async: true` root still yields an async validator.
	if ((validate as { $async?: unknown }).$async) throw new Error("$async schemas are not supported; structured output is validated synchronously");
	return (output) => validate(output) ? { valid: true } : { valid: false, errors: normalizeErrors(validate.errors) };
}

/** Stage 3 of {@link validateRoutineSpec}; runs after Ajv has guaranteed the step shapes. */
function checkStructuredOutputSchemas(spec: unknown): ValidationError[] {
	const steps = (spec as { steps?: unknown }).steps;
	if (!Array.isArray(steps)) return [];
	const errors: ValidationError[] = [];
	steps.forEach((step: { type?: unknown; structured_output?: { schema?: unknown } }, index) => {
		if (step.type !== "agent" || !step.structured_output) return;
		try {
			compileStructuredOutputSchema(step.structured_output.schema);
		} catch (error) {
			errors.push({
				path: `/steps/${index}/structured_output/schema`,
				keyword: "structuredOutputSchema",
				message: `structured_output schema could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
				params: {},
			});
		}
	});
	return errors;
}

/**
 * Cross-reference pass for `layout`. JSON Schema can't express "this string
 * must match a sibling array's element ids", so we do it after structural
 * validation has guaranteed the shape. Bails early when the input is not an
 * object — Ajv already accepted it, but the type system does not know that.
 */
function checkLayoutCrossRefs(spec: unknown): ValidationError[] {
	if (!spec || typeof spec !== "object") return [];
	const layout = (spec as { layout?: unknown }).layout;
	if (!layout || typeof layout !== "object") return [];
	const stepsRaw = (spec as { steps?: unknown }).steps;
	if (!Array.isArray(stepsRaw)) return [];

	const stepIds = new Set<string>();
	for (const step of stepsRaw) {
		const id = (step as { id?: unknown })?.id;
		if (typeof id === "string") stepIds.add(id);
	}

	const errors: ValidationError[] = [];

	const nodes = (layout as { nodes?: unknown }).nodes;
	if (nodes && typeof nodes === "object" && !Array.isArray(nodes)) {
		for (const key of Object.keys(nodes)) {
			if (!stepIds.has(key)) {
				errors.push({
					path: `/layout/nodes/${encodePointer(key)}`,
					keyword: "crossRef",
					message: `layout.nodes references step id "${key}" which does not exist in steps[]`,
					params: { missingStepId: key },
				});
			}
		}
	}

	const edges = (layout as { edges?: unknown }).edges;
	if (Array.isArray(edges)) {
		for (let i = 0; i < edges.length; i++) {
			const edge = edges[i] as { from?: unknown; to?: unknown } | null;
			if (!edge || typeof edge !== "object") continue;
			for (const endpoint of ["from", "to"] as const) {
				const value = edge[endpoint];
				if (typeof value === "string" && !stepIds.has(value)) {
					errors.push({
						path: `/layout/edges/${i}/${endpoint}`,
						keyword: "crossRef",
						message: `layout.edges[${i}].${endpoint} references step id "${value}" which does not exist in steps[]`,
						params: { missingStepId: value },
					});
				}
			}
		}
	}

	return errors;
}

/** Encode a string for inclusion in a JSON Pointer per RFC 6901. */
function encodePointer(segment: string): string {
	return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
