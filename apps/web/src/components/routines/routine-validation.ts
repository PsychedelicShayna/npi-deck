import type { RoutineSpec, RoutineStep, ValidationError } from "@npi-deck/protocol";

export const STEP_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
export const STEP_ID_REQUIREMENT = "use lowercase letters, numbers, and underscores; start with a letter";

export function validateStepId(id: string): string | undefined {
	if (id.length === 0) return "required";
	return STEP_ID_PATTERN.test(id) ? undefined : STEP_ID_REQUIREMENT;
}

export interface RoutineValidationMessage {
	path: string;
	message: string;
}

const REQUIRED_BY_TYPE: Record<RoutineStep["type"], readonly string[]> = {
	run: ["id", "type", "command"],
	agent: ["id", "type", "prompt"],
	write: ["id", "type", "path", "content"],
	http: ["id", "type", "method", "url"],
	deck: ["id", "type", "action"],
	mcp: ["id", "type", "server", "tool"],
	transform: ["id", "type", "body"],
	wait: ["id", "type", "duration_secs"],
	set_state: ["id", "type", "state"],
};

export function summarizeRoutineValidationErrors(
	errors: readonly ValidationError[] | undefined,
	spec: RoutineSpec,
): RoutineValidationMessage[] {
	if (!errors || errors.length === 0) return [];

	const messages: RoutineValidationMessage[] = [];
	const seen = new Set<string>();
	for (const error of errors) {
		const message = summarizeValidationError(error, spec);
		if (!message) continue;
		const key = `${message.path}\u0000${message.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		messages.push(message);
	}

	return messages.length > 0 ? messages : [{ path: "/", message: "Spec is invalid" }];
}

function summarizeValidationError(error: ValidationError, spec: RoutineSpec): RoutineValidationMessage | undefined {
	if (error.keyword === "oneOf") return undefined;

	const stepMatch = /^\/steps\/(\d+)(?:\/([^/]+))?$/.exec(error.path);
	if (stepMatch) {
		const stepIndex = Number(stepMatch[1]);
		const field = stepMatch[2];
		const step = spec.steps[stepIndex];
		const label = `Step ${stepIndex + 1}${step?.type ? ` (${step.type})` : ""}`;

		if (field === "id" && error.keyword === "pattern") {
			return { path: error.path, message: `${label} id: ${STEP_ID_REQUIREMENT}` };
		}
		if (field === "type" && error.keyword === "const" && step?.type) {
			return undefined;
		}
		if (error.keyword === "required") {
			const missing = typeof error.params.missingProperty === "string"
				? error.params.missingProperty
				: undefined;
			if (!missing) return { path: error.path, message: `${label}: ${error.message}` };
			if (step?.type && !REQUIRED_BY_TYPE[step.type].includes(missing)) return undefined;
			return { path: error.path, message: `${label}: missing ${missing}` };
		}
		return { path: error.path, message: `${label}${field ? ` ${field}` : ""}: ${error.message}` };
	}

	return { path: error.path || "/", message: `${error.path || "/"}: ${error.message}` };
}
