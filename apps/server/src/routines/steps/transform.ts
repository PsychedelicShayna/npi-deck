/**
 * `transform` step: pure-JS expression over the run context, evaluated in the
 * quickjs sandbox. Returns whatever the expression returns; captured as the
 * step's json output for downstream steps.
 */

import type { RoutineStep } from "@npi-deck/protocol";
import { evaluate } from "../sandbox.ts";
import type { RunContext, StepResult } from "../types.ts";

export async function executeTransformStep(
	step: Extract<RoutineStep, { type: "transform" }>,
	context: RunContext,
	_signal: AbortSignal,
): Promise<StepResult> {
	const startedMs = Date.now();
	try {
		const result = await evaluate(step.body, context as unknown as Record<string, unknown>);
		return {
			status: "success",
			stdoutExcerpt: "",
			stderrExcerpt: "",
			json: result,
			durationMs: Date.now() - startedMs,
		};
	} catch (err) {
		return {
			status: "failed",
			stdoutExcerpt: "",
			stderrExcerpt: String(err),
			error: String(err),
			durationMs: Date.now() - startedMs,
		};
	}
}
