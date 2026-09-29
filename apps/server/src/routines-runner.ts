/**
 * Top-level routines runner. Dispatches by `routine.specVersion`:
 *   - V0 (specVersion=0): legacy single-action shell-out (bash/script/prompt)
 *   - V1 (specVersion=1): multi-step pipeline via runV1Pipeline()
 *
 * Also owns the Cron scheduler. For V0 routines, schedule from `routine.cron`.
 * For V1 routines, parse `spec.trigger` and schedule a Cron per cron-trigger
 * entry. Non-cron triggers (webhook, manual, event) sit passive and are
 * invoked from routes-hooks.ts / routes-routines.ts.
 */

import { Cron } from "croner";
import { parse as parseYaml } from "yaml";
import * as path from "node:path";

import type { Routine, RoutineActionKind, RoutineSpec, RoutineTrigger } from "@npi-deck/protocol";

import { logger } from "./log.ts";
import {
	finishRun,
	listRoutines,
	setRoutineSchedule,
	startRun,
} from "./db/routines.ts";
import { ConcurrencyController } from "./routines/concurrency.ts";
import { runV1Pipeline } from "./routines/v1-runner.ts";
import { finalizeRun, insertAbortedRun } from "./db/routine-step-runs.ts";
import { loadConfig } from "./config.ts";
import { spawnOwned, terminateOwned } from "./owned-process.ts";
import { routineAgentCommand } from "./routines/agent-command.ts";
import { workRegistry } from "./work-registry.ts";

const log = logger("routines-runner");

const MAX_EXCERPT = 8 * 1024;
const MAX_RUNTIME_MS = 10 * 60_000;

interface ScheduledCron {
	cron: Cron;
	routineId: string;
}

/** Earliest upcoming fire across every cron of a routine, as persisted `nextRunAt`. */
function earliestNextRun(entries: readonly ScheduledCron[]): string | null {
	let earliest: Date | null = null;
	for (const { cron } of entries) {
		const next = cron.nextRun();
		if (next && (!earliest || next < earliest)) earliest = next;
	}
	return earliest?.toISOString() ?? null;
}

export class RoutinesRunner {
	private crons = new Map<string, ScheduledCron[]>();
	private disposed = false;
	private closing = false;
	private readonly runs = new Map<string, { abort: AbortController; finished: Promise<void> }>();
	readonly concurrency = new ConcurrencyController();
	constructor(private readonly agentCommand: () => string[] = () => routineAgentCommand([])) {}
	get busy(): boolean { return this.runs.size > 0; }
	get workSnapshot(): Array<{ runId: string; routineId: string }> {
		return [...this.runs.keys()].map((key) => ({ routineId: key.split(":")[0]!, runId: key.split(":")[1]! }));
	}
	closeAdmissions(): void { this.closing = true; }

	start(): void {
		const routines = listRoutines();
		for (const r of routines) {
			if (r.enabled) this.schedule(r);
		}
		log.info(`scheduled ${routines.filter((r) => r.enabled).length} routine(s)`);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.closeAdmissions();
		this.disposed = true;
		for (const entries of this.crons.values()) {
			for (const entry of entries) {
				try { entry.cron.stop(); } catch (err) { log.warn(`stop failed for routine ${entry.routineId}`, err); }
			}
		}
		this.crons.clear();
		for (const run of this.runs.values()) run.abort.abort();
		await Promise.allSettled([...this.runs.values()].map((run) => run.finished));
	}

	schedule(r: Routine): void {
		this.unschedule(r.id);
		const cronExprs = r.enabled ? collectCronExpressions(r) : [];
		if (cronExprs.length === 0) {
			setRoutineSchedule(r.id, { nextRunAt: null });
			return;
		}

		const scheduled: ScheduledCron[] = [];
		for (const expr of cronExprs) {
			try {
				const cron = new Cron(
					expr,
					{
						catch: true,
						protect: true,
						...(r.timezone ? { timezone: r.timezone } : {}),
					},
					() => {
						void this.fire(r.id, "cron").catch((err) => log.warn(`cron fire failed`, err));
					},
				);
				scheduled.push({ cron, routineId: r.id });
			} catch (err) {
				log.warn(`failed to schedule cron '${expr}' for ${r.id}`, err);
			}
		}
		this.crons.set(r.id, scheduled);
		setRoutineSchedule(r.id, { nextRunAt: earliestNextRun(scheduled) });
	}

	unschedule(routineId: string): void {
		const existing = this.crons.get(routineId);
		if (!existing) return;
		for (const entry of existing) {
			try {
				entry.cron.stop();
			} catch (err) {
				log.warn(`stop failed for ${routineId}`, err);
			}
		}
		this.crons.delete(routineId);
	}

	/** Fire a routine. Branches on specVersion. */
	async fire(
		routineId: string,
		trigger: "cron" | "manual" | "webhook" | "event" = "manual",
		payload: Record<string, unknown> = {},
	): Promise<void> {
		if (this.closing) throw new Error("routine admissions closed");
		const all = listRoutines();
		const routine = all.find((r) => r.id === routineId);
		if (!routine) {
			log.warn(`fire: routine ${routineId} not found`);
			return;
		}
		if (!routine.enabled && (trigger === "cron" || trigger === "webhook" || trigger === "event")) return;

		if (routine.specVersion === 1 && routine.specYaml) {
			await this.fireV1(routine, trigger, payload);
		} else {
			await this.fireV0(routine, trigger === "cron" || trigger === "manual" ? trigger : "manual", payload);
		}

		const next = earliestNextRun(this.crons.get(routineId) ?? []);
		const now = new Date().toISOString();
		setRoutineSchedule(routineId, {
			lastRunAt: now,
			nextRunAt: next,
		});
	}

	private async fireV0(routine: Routine, trigger: "cron" | "manual", payload: Record<string, unknown>): Promise<void> {
		if (!routine.actionKind || routine.actionBody === undefined) {
			log.warn(`V0 routine ${routine.id} missing action_kind/action_body`);
			return;
		}
		const run = startRun(routine.id, trigger, payload);
		const decision = this.concurrency.decide(routine.id, run.id, routine.concurrency);
		if (decision.kind === "skip") {
			finalizeRun(run.id, { endedAt: new Date().toISOString(), abortedAt: new Date().toISOString(), abortReason: "concurrency_skipped" });
			return;
		}
		if (decision.kind === "cancel") decision.toCancel.abort();
		const key = `${routine.id}:${run.id}`;
		const releaseWork = workRegistry.admit(decision.kind === "queue" ? "routine-queued" : "routine-run", key);
		const finished = (async () => {
			if (decision.kind === "queue") await decision.release;
			if (decision.abort.signal.aborted) {
				finalizeRun(run.id, { endedAt: new Date().toISOString(), abortedAt: new Date().toISOString(), abortReason: "cancelled" });
				return;
			}
			if (decision.kind === "queue") workRegistry.transition("routine-queued", "routine-run", key);
			const cwd = routine.actionCwd?.trim() || process.cwd();
			log.info(`firing V0 routine ${routine.name} (${routine.actionKind})`);
			try {
				const result = await runV0Action(routine.actionKind!, routine.actionBody!, cwd, decision.abort.signal);
				finishRun(run.id, result);
			} catch (err) {
				finishRun(run.id, { error: String(err) });
			} finally {
				this.concurrency.finish(routine.id, run.id);
			}
		})();
		this.runs.set(key, { abort: decision.abort, finished });
		try { await finished; } finally { this.runs.delete(key); releaseWork(); }
	}

	private async fireV1(
		routine: Routine,
		trigger: "cron" | "manual" | "webhook" | "event",
		payload: Record<string, unknown>,
	): Promise<void> {
		let spec: RoutineSpec;
		try {
			spec = parseYaml(routine.specYaml!) as RoutineSpec;
		} catch (err) {
			log.warn(`V1 routine ${routine.id} has malformed spec_yaml`, err);
			insertAbortedRun({
				routineId: routine.id,
				triggerKind: trigger,
				triggerPayload: payload,
				abortReason: "failure",
				error: `spec_yaml parse failure: ${String(err)}`,
			});
			return;
		}

		const run = startRun(routine.id, trigger, payload);
		const decision = this.concurrency.decide(routine.id, run.id, routine.concurrency);
		if (decision.kind === "skip") {
			finalizeRun(run.id, {
				endedAt: new Date().toISOString(),
				abortedAt: new Date().toISOString(),
				abortReason: "concurrency_skipped",
				error: "skipped: another run is in flight",
			});
			return;
		}
		if (decision.kind === "cancel") {
			decision.toCancel.abort();
		}

		const key = `${routine.id}:${run.id}`;
		const releaseWork = workRegistry.admit(decision.kind === "queue" ? "routine-queued" : "routine-run", key);
		const finished = (async () => {
			if (decision.kind === "queue") await decision.release;
			if (decision.abort.signal.aborted) {
				finalizeRun(run.id, { endedAt: new Date().toISOString(), abortedAt: new Date().toISOString(), abortReason: "cancelled" });
				return;
			}
			if (decision.kind === "queue") workRegistry.transition("routine-queued", "routine-run", key);
			log.info(`firing V1 routine ${routine.name} (${spec.steps.length} steps, trigger=${trigger})`);
			const config = loadConfig();
			try {
				await runV1Pipeline({
					routine, spec, runId: run.id, triggerKind: trigger, triggerPayload: payload,
					abortSignal: decision.abort.signal, defaultCwd: config.defaultCwd,
					agentSandboxRoot: path.join(path.dirname(config.dbPath), "routine-runs"),
					agentCommand: this.agentCommand,
				});
			} catch (err) {
				log.error(`V1 pipeline threw for ${routine.id}`, err);
			} finally {
				this.concurrency.finish(routine.id, run.id);
			}
		})();
		this.runs.set(key, { abort: decision.abort, finished });
		try { await finished; } finally { this.runs.delete(key); releaseWork(); }
	}
}

/** Pull every cron expression out of a routine. Handles V0 (`routine.cron`) and V1 (parses spec_yaml). */
function collectCronExpressions(routine: Routine): string[] {
	if (routine.specVersion === 1 && routine.specYaml) {
		try {
			const spec = parseYaml(routine.specYaml) as RoutineSpec;
			const out: string[] = [];
			for (const t of spec.trigger ?? []) {
				if ("cron" in t && typeof (t as { cron?: unknown }).cron === "string") {
					out.push((t as RoutineTrigger & { cron: string }).cron);
				}
			}
			return out;
		} catch {
			return [];
		}
	}
	return routine.cron ? [routine.cron] : [];
}

// ─── V0 single-action executor (preserved for backward compat) ────────────

async function runV0Action(
	kind: RoutineActionKind,
	body: string,
	cwd: string,
	signal: AbortSignal,
): Promise<{ exitCode?: number; stdoutExcerpt: string; stderrExcerpt: string; error?: string }> {
	const cmd = buildV0Cmd(kind, body);
	if (!cmd) {
		return { error: `unsupported action kind: ${kind}`, stdoutExcerpt: "", stderrExcerpt: "" };
	}
	const proc = spawnOwned(cmd, {
		cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
	});
	const onAbort = () => { void terminateOwned(proc); };
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	const timer = setTimeout(() => { void terminateOwned(proc); }, MAX_RUNTIME_MS);
	timer.unref?.();
	const [stdout, stderr, exitCode] = await Promise.all([
		readClipped(proc.stdout),
		readClipped(proc.stderr),
		proc.exited,
	]);
	clearTimeout(timer);
	signal.removeEventListener("abort", onAbort);
	return {
		exitCode: typeof exitCode === "number" ? exitCode : undefined,
		stdoutExcerpt: stdout,
		stderrExcerpt: stderr,
	};
}

function buildV0Cmd(kind: RoutineActionKind, body: string): string[] | null {
	const isWin = process.platform === "win32";
	switch (kind) {
		case "bash":
			return isWin ? ["cmd", "/c", body] : ["bash", "-lc", body];
		case "script": {
			const parts = body.trim().split(/\s+/);
			if (parts.length === 0 || !parts[0]) return null;
			return parts as string[];
		}
		case "prompt":
			return routineAgentCommand(["-p", body]);
		default:
			return null;
	}
}

async function readClipped(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8");
	let acc = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		acc += decoder.decode(value, { stream: true });
		if (acc.length > MAX_EXCERPT) {
			acc = acc.slice(0, MAX_EXCERPT) + "\n…(truncated)";
			try {
				await reader.cancel();
			} catch {
				/* ignore */
			}
			break;
		}
	}
	acc += decoder.decode();
	return acc;
}
