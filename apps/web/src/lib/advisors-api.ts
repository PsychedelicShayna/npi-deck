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
export type AdvisorRuntimeStatus = "running" | "paused" | "quota_exhausted" | "error" | "no_model";
export interface AdvisorNote { advisor: string; severity: "nit" | "concern" | "blocker"; note: string; timestamp: number }
export interface LiveAdvisorStatus {
	/** `configured`: advisors are switched on for this session. */
	overview: { configured: boolean; advisors: Array<{ name: string; status: AdvisorRuntimeStatus; yielded: boolean }> };
	stats: { active: boolean; cost: number; advisors: Array<{ name: string; status: AdvisorRuntimeStatus; cost: number; tokens: { total: number }; model?: { provider: string; id: string } }> };
	/** Advisors chosen for this session in the deck; `null` when the chat never chose. */
	selection: string[] | null;
	notes: AdvisorNote[];
	events: Array<{ type: "advisor_cost_changed" | "advisor_yielded"; timestamp: number }>;
}
export interface SessionAdvisorRoster {
	/** `enabled` is the entry's own WATCHDOG key; absent means NeoPi treats it as enabled. */
	advisors: Array<{ name: string; model?: string; enabled?: boolean; source: string | null }>;
	warnings: string[];
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
	/** Write `enabled:` for one advisor into the WATCHDOG file its effective entry comes from. */
	setRosterEnabled: (cwd: string, name: string, enabled: boolean) =>
		request<{ file: string; merged: AdvisorConfiguration["merged"] }>("/advisors/watchdog/enabled", "PATCH", { cwd, name, enabled }),
	status: (id: string) => request<LiveAdvisorStatus>(`/sessions/${encodeURIComponent(id)}/advisors`),
	roster: (id: string) => request<SessionAdvisorRoster>(`/sessions/${encodeURIComponent(id)}/advisors/roster`),
	/** Run exactly these roster advisors in the session; an empty list stops them. */
	select: (id: string, advisors: string[]) => request<LiveAdvisorStatus>(`/sessions/${encodeURIComponent(id)}/advisors`, "PUT", { advisors }),
};
