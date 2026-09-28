/**
 * Per-run budget enforcer. Agent steps supply provider-reported token and USD
 * usage; the runner accumulates every attempt before checking caps.
 */

import type { RoutineBudget } from "@npi-deck/protocol";

import type { StepResult } from "./types.ts";

export interface BudgetState {
	startedAtMs: number;
	totalTokensIn: number;
	totalTokensOut: number;
	totalCostMicros: number;
	stepsExecuted: number;
}

export interface BudgetExceeded {
	limit: string;
	value: number;
	cap: number;
}

export function newBudgetState(now: () => number): BudgetState {
	return {
		startedAtMs: now(),
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalCostMicros: 0,
		stepsExecuted: 0,
	};
}

/** Accumulate a step's resource usage. */
export function accumulate(state: BudgetState, step: StepResult): void {
	state.stepsExecuted += 1;
	if (step.llmTokensIn != null) state.totalTokensIn += step.llmTokensIn;
	if (step.llmTokensOut != null) state.totalTokensOut += step.llmTokensOut;
	if (step.llmCostMicros != null) state.totalCostMicros += step.llmCostMicros;
}

/** Check whether any cap is hit. Returns the offending limit, or undefined if all clear. */
export function checkBudget(
	state: BudgetState,
	budget: RoutineBudget | undefined,
	now: () => number,
): BudgetExceeded | undefined {
	if (!budget) return undefined;
	const elapsedMs = now() - state.startedAtMs;
	if (budget.max_duration_secs != null && elapsedMs > budget.max_duration_secs * 1000) {
		return { limit: "max_duration_secs", value: elapsedMs / 1000, cap: budget.max_duration_secs };
	}
	if (budget.max_llm_cost_usd != null) {
		const usd = state.totalCostMicros / 1_000_000;
		if (usd > budget.max_llm_cost_usd) {
			return { limit: "max_llm_cost_usd", value: usd, cap: budget.max_llm_cost_usd };
		}
	}
	if (budget.max_llm_tokens_input != null && state.totalTokensIn > budget.max_llm_tokens_input) {
		return { limit: "max_llm_tokens_input", value: state.totalTokensIn, cap: budget.max_llm_tokens_input };
	}
	if (budget.max_llm_tokens_output != null && state.totalTokensOut > budget.max_llm_tokens_output) {
		return { limit: "max_llm_tokens_output", value: state.totalTokensOut, cap: budget.max_llm_tokens_output };
	}
	if (budget.max_steps_executed != null && state.stepsExecuted > budget.max_steps_executed) {
		return { limit: "max_steps_executed", value: state.stepsExecuted, cap: budget.max_steps_executed };
	}
	return undefined;
}
