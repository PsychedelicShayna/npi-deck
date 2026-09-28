/**
 * Persistence layer for V1 routine_step_runs + routine_webhook_secrets.
 *
 * routine_state lives in `apps/server/src/routines/state.ts` because it's
 * tightly coupled to the runner's set_state semantics; the rest of the V1
 * tables flow through here.
 */

import type { RoutineStepRun, RoutineStepStatus } from "@npi-deck/protocol";

import { getDb, id, nowIso } from "./index.ts";

interface StepRunRow {
	id: string;
	run_id: string;
	step_id: string;
	step_index: number;
	step_type: string;
	started_at: string;
	ended_at: string | null;
	status: string;
	stdout_excerpt: string;
	stderr_excerpt: string;
	output_json: string | null;
	error: string | null;
	model: string | null;
	llm_tokens_in: number | null;
	llm_tokens_out: number | null;
	llm_cost_micros: number | null;
	duration_ms: number | null;
	attempt: number;
}

function rowToStepRun(r: StepRunRow): RoutineStepRun {
	const out: RoutineStepRun = {
		id: r.id,
		runId: r.run_id,
		stepId: r.step_id,
		stepIndex: r.step_index,
		stepType: r.step_type as RoutineStepRun["stepType"],
		startedAt: r.started_at,
		status: r.status as RoutineStepStatus,
		stdoutExcerpt: r.stdout_excerpt,
		stderrExcerpt: r.stderr_excerpt,
		attempt: r.attempt,
	};
	if (r.ended_at !== null) out.endedAt = r.ended_at;
	if (r.output_json !== null) out.outputJson = r.output_json;
	if (r.error !== null) out.error = r.error;
	if (r.model !== null) out.model = r.model;
	if (r.llm_tokens_in !== null) out.llmTokensIn = r.llm_tokens_in;
	if (r.llm_tokens_out !== null) out.llmTokensOut = r.llm_tokens_out;
	if (r.llm_cost_micros !== null) out.llmCostMicros = r.llm_cost_micros;
	if (r.duration_ms !== null) out.durationMs = r.duration_ms;
	return out;
}

/** Start a new step run record in status='running'. Returns the row id. */
export function startStepRun(input: {
	runId: string;
	stepId: string;
	stepIndex: number;
	stepType: string;
	attempt?: number;
}): string {
	const stepRunId = `srun_${id().toLowerCase().slice(0, 18)}`;
	const startedAt = nowIso();
	getDb()
		.prepare<unknown, [string, string, string, number, string, string, number]>(
			`INSERT INTO routine_step_runs (id, run_id, step_id, step_index, step_type, started_at, status, attempt)
			 VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
		)
		.run(
			stepRunId,
			input.runId,
			input.stepId,
			input.stepIndex,
			input.stepType,
			startedAt,
			input.attempt ?? 1,
		);
	return stepRunId;
}

/** Insert a step run that never actually started (e.g. status='skipped' via when:false). */
export function insertSkippedStepRun(input: {
	runId: string;
	stepId: string;
	stepIndex: number;
	stepType: string;
}): string {
	const stepRunId = `srun_${id().toLowerCase().slice(0, 18)}`;
	const now = nowIso();
	getDb()
		.prepare<unknown, [string, string, string, number, string, string, string]>(
			`INSERT INTO routine_step_runs (id, run_id, step_id, step_index, step_type, started_at, ended_at, status, duration_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped', 0)`,
		)
		.run(stepRunId, input.runId, input.stepId, input.stepIndex, input.stepType, now, now);
	return stepRunId;
}

/** Finish a step run record. */
export function finishStepRun(
	stepRunId: string,
	patch: {
		status: RoutineStepStatus;
		stdoutExcerpt?: string;
		stderrExcerpt?: string;
		outputJson?: string | null;
		error?: string | null;
		model?: string | null;
		llmTokensIn?: number | null;
		llmTokensOut?: number | null;
		llmCostMicros?: number | null;
		durationMs?: number | null;
	},
): void {
	getDb()
		.prepare<
			unknown,
			[
				string,
				string,
				string,
				string,
				string | null,
				string | null,
				string | null,
				number | null,
				number | null,
				number | null,
				number | null,
				string,
			]
		>(
			`UPDATE routine_step_runs
			   SET ended_at = ?, status = ?, stdout_excerpt = ?, stderr_excerpt = ?,
			       output_json = ?, error = ?, model = ?, llm_tokens_in = ?,
			       llm_tokens_out = ?, llm_cost_micros = ?, duration_ms = ?
			 WHERE id = ?`,
		)
		.run(
			nowIso(),
			patch.status,
			patch.stdoutExcerpt ?? "",
			patch.stderrExcerpt ?? "",
			patch.outputJson ?? null,
			patch.error ?? null,
			patch.model ?? null,
			patch.llmTokensIn ?? null,
			patch.llmTokensOut ?? null,
			patch.llmCostMicros ?? null,
			patch.durationMs ?? null,
			stepRunId,
		);
}

/** List all step runs for a routine run, in execution order. */
export function listStepRuns(runId: string): RoutineStepRun[] {
	const rows = getDb()
		.query<StepRunRow, [string]>(
			`SELECT id, run_id, step_id, step_index, step_type, started_at, ended_at,
			        status, stdout_excerpt, stderr_excerpt, output_json, error,
			        model, llm_tokens_in, llm_tokens_out, llm_cost_micros, duration_ms, attempt
			 FROM routine_step_runs WHERE run_id = ? ORDER BY step_index ASC, started_at ASC`,
		)
		.all(runId) as StepRunRow[];
	return rows.map(rowToStepRun);
}

// ─── routine_webhook_secrets ──────────────────────────────────────────────

interface WebhookSecretRow {
	routine_id: string;
	path: string;
	secret_hash: string;
	created_at: string;
	last_used_at: string | null;
}

export function upsertWebhookSecret(input: {
	routineId: string;
	path: string;
	secretHash: string;
}): boolean {
	if (isWebhookPathClaimedByAnotherRoutine(input.path, input.routineId)) return false;

	const now = nowIso();
	getDb()
		.prepare<unknown, [string, string, string, string]>(
			`INSERT INTO routine_webhook_secrets (routine_id, path, secret_hash, created_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(routine_id) DO UPDATE SET
			   path = excluded.path,
			   secret_hash = excluded.secret_hash,
			   created_at = excluded.created_at`,
		)
		.run(input.routineId, input.path, input.secretHash, now);
	return true;
}

export function ensureWebhookSecret(input: {
	routineId: string;
	path: string;
	secretHash: string;
}): boolean {
	if (isWebhookPathClaimedByAnotherRoutine(input.path, input.routineId)) return false;

	const existing = getWebhookSecretByRoutine(input.routineId);
	if (existing) {
		if (existing.path !== input.path) {
			getDb()
				.prepare<unknown, [string, string]>(
					"UPDATE routine_webhook_secrets SET path = ? WHERE routine_id = ?",
				)
				.run(input.path, input.routineId);
		}
		return true;
	}

	const now = nowIso();
	getDb()
		.prepare<unknown, [string, string, string, string]>(
			`INSERT INTO routine_webhook_secrets (routine_id, path, secret_hash, created_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(input.routineId, input.path, input.secretHash, now);
	return true;
}

export function deleteWebhookSecret(routineId: string): void {
	getDb()
		.prepare<unknown, [string]>("DELETE FROM routine_webhook_secrets WHERE routine_id = ?")
		.run(routineId);
}

export function getWebhookSecretByPath(path: string): WebhookSecretRow | undefined {
	const row = getDb()
		.query<WebhookSecretRow, [string]>(
			"SELECT routine_id, path, secret_hash, created_at, last_used_at FROM routine_webhook_secrets WHERE path = ?",
		)
		.get(path) as WebhookSecretRow | null;
	return row ?? undefined;
}

function getWebhookSecretByRoutine(routineId: string): WebhookSecretRow | undefined {
	const row = getDb()
		.query<WebhookSecretRow, [string]>(
			"SELECT routine_id, path, secret_hash, created_at, last_used_at FROM routine_webhook_secrets WHERE routine_id = ?",
		)
		.get(routineId) as WebhookSecretRow | null;
	return row ?? undefined;
}

function isWebhookPathClaimedByAnotherRoutine(path: string, routineId: string): boolean {
	const owner = getWebhookSecretByPath(path);
	return owner !== undefined && owner.routine_id !== routineId;
}

export function touchWebhookSecret(routineId: string): void {
	getDb()
		.prepare<unknown, [string, string]>(
			"UPDATE routine_webhook_secrets SET last_used_at = ? WHERE routine_id = ?",
		)
		.run(nowIso(), routineId);
}

// ─── routine_runs aggregates (V1 columns) ─────────────────────────────────

/** Finalize a routine_runs row with V1 aggregates. */
export function finalizeRun(
	runId: string,
	patch: {
		endedAt?: string;
		exitCode?: number | null;
		error?: string | null;
		stdoutExcerpt?: string;
		stderrExcerpt?: string;
		totalLlmTokens?: number;
		totalLlmCostMicros?: number;
		abortedAt?: string | null;
		abortReason?: string | null;
		stepCountTotal?: number;
		stepCountFailed?: number;
	},
): void {
	getDb()
		.prepare<
			unknown,
			[
				string,
				number | null,
				string,
				string,
				string | null,
				number,
				number,
				string | null,
				string | null,
				number,
				number,
				string,
			]
		>(
			`UPDATE routine_runs
			   SET ended_at = ?, exit_code = ?, stdout_excerpt = ?, stderr_excerpt = ?, error = ?,
			       total_llm_tokens = ?, total_llm_cost_micros = ?, aborted_at = ?, abort_reason = ?,
			       step_count_total = ?, step_count_failed = ?
			 WHERE id = ?`,
		)
		.run(
			patch.endedAt ?? nowIso(),
			patch.exitCode ?? null,
			patch.stdoutExcerpt ?? "",
			patch.stderrExcerpt ?? "",
			patch.error ?? null,
			patch.totalLlmTokens ?? 0,
			patch.totalLlmCostMicros ?? 0,
			patch.abortedAt ?? null,
			patch.abortReason ?? null,
			patch.stepCountTotal ?? 0,
			patch.stepCountFailed ?? 0,
			runId,
		);
}

/** Insert a "stillborn" run (e.g. webhook signature_invalid, concurrency_skipped). */
export function insertAbortedRun(input: {
	routineId: string;
	triggerKind: "cron" | "manual" | "webhook" | "event";
	triggerPayload?: string;
	abortReason: string;
	error?: string;
}): string {
	const runId = `run_${id().toLowerCase().slice(0, 18)}`;
	const now = nowIso();
	getDb()
		.prepare<
			unknown,
			[string, string, string, string, string | null, string, string, string | null]
		>(
			`INSERT INTO routine_runs
			   (id, routine_id, started_at, trigger, trigger_payload, ended_at, abort_reason, error)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			runId,
			input.routineId,
			now,
			input.triggerKind,
			input.triggerPayload ?? null,
			now,
			input.abortReason,
			input.error ?? null,
		);
	return runId;
}
