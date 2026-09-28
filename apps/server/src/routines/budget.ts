/**
 * Per-run budget enforcer. Tracks LLM tokens, estimated cost, wall-clock,
 * and step count against the spec's `budget` block. The runner calls
 * `tryConsume()` after every step; if any cap is hit the runner aborts the
 * run with `abort_reason='budget'`.
 *
 * Cost estimation is approximate — model price table at module bottom; not a
 * substitute for vendor-side billing. For BYOK customers the displayed cost
 * is "we think you spent about this" and the real bill is what their vendor
 * says. Documented per the V1 plan §10.4.
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

const PRICES_PER_MILLION: Record<string, { input: number; output: number }> = {
	"claude-sonnet-4-6": { input: 3.0, output: 15.0 },
	"claude-opus-4": { input: 15.0, output: 75.0 },
	"claude-haiku-4-5": { input: 1.0, output: 5.0 },
	"gpt-4o": { input: 5.0, output: 15.0 },
	"gpt-4o-mini": { input: 0.15, output: 0.6 },
	// Sensible default for unknown models — assume sonnet-tier pricing so the
	// estimate errs on the side of triggering the budget alarm.
	default: { input: 3.0, output: 15.0 },
};

export function newBudgetState(now: () => number): BudgetState {
	return {
		startedAtMs: now(),
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalCostMicros: 0,
		stepsExecuted: 0,
	};
}

/** Compute USD micro-cents (millionths of a dollar) for a single step's LLM usage. */
export function costMicros(model: string | undefined, tokensIn: number, tokensOut: number): number {
	const tier = (model && PRICES_PER_MILLION[model]) || PRICES_PER_MILLION.default!;
	// price per million → cents per token → micros per token (×10000)
	const inMicros = Math.round((tokensIn * tier.input * 10_000) / 1_000_000 * 1_000_000) / 1_000_000;
	const outMicros = Math.round((tokensOut * tier.output * 10_000) / 1_000_000 * 1_000_000) / 1_000_000;
	// Simpler: just multiply tokens by per-million price (USD) × 1_000_000 micros/$ / 1_000_000 tokens = identity scaler.
	const inUsd = (tokensIn / 1_000_000) * tier.input;
	const outUsd = (tokensOut / 1_000_000) * tier.output;
	return Math.round((inUsd + outUsd) * 1_000_000);
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
