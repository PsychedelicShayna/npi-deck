import { describe, expect, test } from "bun:test";

import type { RoutineSpec, ValidationError } from "@npi-deck/protocol";

import { summarizeRoutineValidationErrors, validateStepId } from "./routine-validation";

const spec: RoutineSpec = {
	name: "daily-briefing",
	trigger: [{ manual: {} }],
	steps: [
		{ id: "should_run", type: "transform", body: "return true" },
		{ id: "Agent Bad", type: "agent", prompt: "hello" },
	],
};

describe("routine validation summaries", () => {
	test("validates step ids with the same pattern as the schema", () => {
		expect(validateStepId("agent_1")).toBeUndefined();
		expect(validateStepId("Agent Bad")).toContain("lowercase");
		expect(validateStepId("1_agent")).toContain("start with a letter");
	});

	test("collapses Ajv oneOf noise to the relevant invalid id", () => {
		const errors: ValidationError[] = [
			{
				path: "/steps/1/id",
				keyword: "pattern",
				message: 'must match pattern "^[a-z][a-z0-9_]*$"',
				params: { pattern: "^[a-z][a-z0-9_]*$" },
			},
			{
				path: "/steps/1",
				keyword: "required",
				message: "must have required property 'command'",
				params: { missingProperty: "command" },
			},
			{
				path: "/steps/1/type",
				keyword: "const",
				message: "must be equal to constant",
				params: { allowedValue: "run" },
			},
			{
				path: "/steps/1",
				keyword: "oneOf",
				message: "must match exactly one schema in oneOf",
				params: { passingSchemas: null },
			},
		];

		expect(summarizeRoutineValidationErrors(errors, spec)).toEqual([
			{
				path: "/steps/1/id",
				message: "Step 2 (agent) id: use lowercase letters, numbers, and underscores; start with a letter",
			},
		]);
	});
});
