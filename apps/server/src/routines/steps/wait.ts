/**
 * `wait` step: sleep N seconds. Abortable.
 */

import type { RoutineStep } from "@npi-deck/protocol";
import type { StepResult } from "../types.ts";

export async function executeWaitStep(
	step: Extract<RoutineStep, { type: "wait" }>,
	_context: unknown,
	signal: AbortSignal,
): Promise<StepResult> {
	const startedMs = Date.now();
	const durationMs = step.duration_secs * 1000;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, durationMs);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
	if (signal.aborted) {
		return {
			status: "aborted",
			stdoutExcerpt: "",
			stderrExcerpt: "",
			error: "aborted during wait",
			durationMs: Date.now() - startedMs,
		};
	}
	return {
		status: "success",
		stdoutExcerpt: `waited ${step.duration_secs}s`,
		stderrExcerpt: "",
		durationMs: Date.now() - startedMs,
	};
}
