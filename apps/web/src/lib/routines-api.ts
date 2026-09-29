import type {
	CreateRoutineRequest,
	ListRoutineRunsResponse,
	ListRoutineStepRunsResponse,
	ListRoutinesResponse,
	Routine,
	RoutineWebhookStatus,
	UpdateRoutineRequest,
} from "@npi-deck/protocol";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status} ${path}: ${body}`);
	}
	return (await res.json()) as T;
}

export interface RoutineMetrics {
	total: number;
	successCount: number;
	successRate30d: number;
	p50DurationMs: number | null;
	p95DurationMs: number | null;
	mtdCostMicros: number;
	last30: Array<{ runId: string; status: "success" | "failed" | "aborted" | "running"; durationMs: number | null }>;
}

export interface TemplateSummary {
	slug: string;
	name: string;
	description?: string;
	tags?: string[];
	steps: number;
	triggers: number;
}

export const routinesApi = {
	list(): Promise<ListRoutinesResponse> {
		return req<ListRoutinesResponse>("/routines");
	},
	get(id: string): Promise<Routine> {
		return req<Routine>(`/routines/${encodeURIComponent(id)}`);
	},
	create(body: CreateRoutineRequest & { specYaml?: string }): Promise<Routine> {
		return req<Routine>("/routines", { method: "POST", body: JSON.stringify(body) });
	},
	update(id: string, body: UpdateRoutineRequest & { specYaml?: string }): Promise<Routine> {
		return req<Routine>(`/routines/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		});
	},
	remove(id: string): Promise<{ ok: boolean }> {
		return req(`/routines/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	runNow(id: string, params?: Record<string, unknown>): Promise<{ ok: boolean; queued: boolean }> {
		return req(`/routines/${encodeURIComponent(id)}/run`, {
			method: "POST",
			body: JSON.stringify(params ?? {}),
		});
	},
	runs(id: string, limit = 10): Promise<ListRoutineRunsResponse> {
		return req<ListRoutineRunsResponse>(
			`/routines/${encodeURIComponent(id)}/runs?limit=${limit}`,
		);
	},
	steps(id: string, runId: string): Promise<ListRoutineStepRunsResponse> {
		return req<ListRoutineStepRunsResponse>(
			`/routines/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/steps`,
		);
	},
	metrics(id: string): Promise<RoutineMetrics> {
		return req<RoutineMetrics>(`/routines/${encodeURIComponent(id)}/metrics`);
	},
	templates: {
		list(): Promise<{ templates: TemplateSummary[] }> {
			return req<{ templates: TemplateSummary[] }>("/routine-templates");
		},
		install(slug: string): Promise<Routine> {
			return req<Routine>(`/routine-templates/${encodeURIComponent(slug)}`, { method: "POST" });
		},
	},
	rotateWebhookSecret(id: string): Promise<{ ok: boolean; secret: string; path: string }> {
		return req(`/routines/${encodeURIComponent(id)}/webhook-secret/rotate`, { method: "POST" });
	},
	/** Null when the routine has no webhook registration. */
	async webhookStatus(id: string): Promise<RoutineWebhookStatus | null> {
		const res = await fetch(`${BASE}/routines/${encodeURIComponent(id)}/webhook`);
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`HTTP ${res.status} /routines/${id}/webhook: ${await res.text().catch(() => "")}`);
		return (await res.json()) as RoutineWebhookStatus;
	},
	/** One-way: the server never accepts the bare secret again once refused. */
	refuseWebhookBareSecret(id: string): Promise<RoutineWebhookStatus> {
		return req<RoutineWebhookStatus>(`/routines/${encodeURIComponent(id)}/webhook`, {
			method: "PATCH",
			body: JSON.stringify({ acceptBareSecret: false }),
		});
	},
};
