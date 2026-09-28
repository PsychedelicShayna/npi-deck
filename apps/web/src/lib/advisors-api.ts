export interface AdvisorConfig {
	name: string;
	model?: string;
	tools?: string[];
	instructions?: string;
	systemPrompt?: string;
	enabled?: boolean;
	maxNotesPerUpdate?: number;
	source?: string | null;
}
export interface WatchdogDoc { instructions?: string; maxNotesPerUpdate?: number; advisors: AdvisorConfig[]; warnings?: string[] }
export interface ScopeDocument { file: string; hash: string; doc: WatchdogDoc }
export interface AdvisorConfiguration {
	cwd: string;
	user: ScopeDocument;
	project: ScopeDocument;
	merged: { advisors: AdvisorConfig[]; warnings: string[] };
	settings: { enabled: boolean; syncBacklog: string; maxNotesPerUpdate: number; evictStaleResults: boolean; model: string };
}
export interface LiveAdvisorStatus {
	overview: { configured: boolean; advisors: Array<{ name: string; status: string; yielded: boolean }> };
	stats: { cost: number; advisors: Array<{ name: string; status: string; cost: number; tokens: { total: number }; model?: { provider: string; id: string } }> };
	notes: Array<{ advisor: string; severity: "nit" | "concern" | "blocker"; note: string; timestamp: number }>;
	events: Array<{ type: "advisor_cost_changed" | "advisor_yielded"; timestamp: number }>;
}
async function request<T>(route: string, method = "GET", body?: unknown): Promise<T> {
	const response = await fetch(`/api${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
	if (!response.ok) {
		const details = await response.json().catch(() => ({})) as { error?: string };
		throw new Error(details.error ?? `HTTP ${response.status}`);
	}
	return await response.json() as T;
}
export const advisorsApi = {
	config: (cwd: string) => request<AdvisorConfiguration>(`/advisors?cwd=${encodeURIComponent(cwd)}`),
	saveWatchdog: (cwd: string, scope: "user" | "project", hash: string, doc: WatchdogDoc) =>
		request<{ saved: ScopeDocument; merged: AdvisorConfiguration["merged"] }>("/advisors/watchdog", "PUT", { cwd, scope, hash, doc }),
	saveSettings: (cwd: string, settings: Partial<AdvisorConfiguration["settings"]>) => request<{ ok: true }>("/advisors/settings", "PATCH", { cwd, ...settings }),
	status: (id: string) => request<LiveAdvisorStatus>(`/sessions/${encodeURIComponent(id)}/advisors`),
	toggle: (id: string, enabled: boolean) => request<LiveAdvisorStatus>(`/sessions/${encodeURIComponent(id)}/advisors`, "PATCH", { enabled }),
};
