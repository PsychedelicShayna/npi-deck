/**
 * Internal types for the V1 routine runner. Public types live in
 * `@npi-deck/protocol` (RoutineSpec, RoutineStep, RoutineStepRun, etc.); this
 * file is for runner-internal contracts.
 */

import type {
	Routine,
	RoutineSpec,
	RoutineStep,
	RoutineStepStatus,
} from "@npi-deck/protocol";

/** What a step executor returns. Always non-throwing — exceptions become this shape. */
export interface StepResult {
	status: Exclude<RoutineStepStatus, "pending" | "running">;
	/** Captured stdout (clipped). */
	stdoutExcerpt: string;
	/** Captured stderr (clipped). */
	stderrExcerpt: string;
	/** Structured output captured to context.steps.<id>.json. */
	json?: unknown;
	/** Human-readable error message when status='failed' or 'aborted'. */
	error?: string;
	/** Wall-clock duration in ms. */
	durationMs: number;
	/** Agent steps populate these; other types leave undefined. */
	model?: string;
	llmTokensIn?: number;
	llmTokensOut?: number;
	llmCostMicros?: number;
}

/** Context object exposed to templates + sandbox at every step boundary. */
export interface RunContext {
	run: {
		id: string;
		started: string;
		iso_started: string;
		date: string;
		trigger_kind: "cron" | "manual" | "webhook" | "event";
	};
	trigger: Record<string, unknown>;
	steps: Record<string, StepContextEntry>;
	env: Record<string, string>;
	secrets: Record<string, string>;
	state: Record<string, unknown>;
}

/** Subset of StepResult that flows into context.steps.<id>. */
export interface StepContextEntry {
	status: RoutineStepStatus;
	stdout: string;
	stderr: string;
	json?: unknown;
	error?: string;
	exit_code?: number;
	duration_ms: number;
	model?: string;
	tokens?: { in: number; out: number };
}

/** Reasons the runner can abort a whole run. */
export type AbortReason =
	| "budget"
	| "timeout"
	| "cancelled"
	| "failure"
	| "signature_invalid"
	| "concurrency_skipped";

/** What the trigger-router hands the runner. */
export interface TriggerInvocation {
	routineId: string;
	triggerKind: "cron" | "manual" | "webhook" | "event";
	payload: Record<string, unknown>;
}

/** Things the runner needs to bootstrap a single run. Kept narrow so tests can fake. */
export interface RunnerDeps {
	getRoutine: (id: string) => Routine | undefined;
	getRoutineSpec: (routine: Routine) => RoutineSpec | null;
	/** Returns initial cross-run state for a routine. */
	loadState: (routineId: string) => Record<string, unknown>;
	/** Persists set_state output atomically. */
	saveState: (routineId: string, kv: Record<string, unknown>) => void;
	/** Wall-clock ms; injectable for deterministic tests. */
	now: () => number;
}

/** Map of step type to its executor. Step files self-register here via the registry pattern. */
export type StepExecutor = (
	step: RoutineStep,
	context: RunContext,
	signal: AbortSignal,
) => Promise<StepResult>;
