import type {
	CreateSkillRequest,
	ListSkillsResponse,
	SkillDetailResponse,
	SkillSummary,
	UpdateSkillRequest,
} from "@npi-deck/protocol";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		// Authoring refusals carry `{ error }`: show that sentence, not the opaque id in the path.
		const text = await res.text().catch(() => "");
		let reason: string | undefined;
		try {
			const parsed = JSON.parse(text) as { error?: unknown };
			if (typeof parsed.error === "string") reason = parsed.error;
		} catch {
			// not JSON; fall back to the raw text
		}
		throw new Error(reason ?? `HTTP ${res.status} ${path}: ${text}`);
	}
	return (await res.json()) as T;
}

function withCwd(path: string, cwd: string | undefined): string {
	if (!cwd) return path;
	const sep = path.includes("?") ? "&" : "?";
	return `${path}${sep}cwd=${encodeURIComponent(cwd)}`;
}

export const skillsApi = {
	list(cwd?: string): Promise<ListSkillsResponse> {
		return req<ListSkillsResponse>(withCwd("/skills", cwd));
	},
	detail(id: string, cwd?: string): Promise<SkillDetailResponse> {
		// `id` is server-issued (base64url of the SKILL.md path). Clients
		// pass it back opaquely; the server validates that the decoded path
		// was actually returned by loadCapability before reading.
		return req<SkillDetailResponse>(withCwd(`/skills/${encodeURIComponent(id)}`, cwd));
	},
	/** Author an OMP user skill under the agent dir. */
	create(body: CreateSkillRequest): Promise<SkillSummary> {
		return req<SkillSummary>("/skills", { method: "POST", body: JSON.stringify(body) });
	},
	/** Replace an editable skill's description and body; 409 when SKILL.md changed since `revision`. */
	update(id: string, body: UpdateSkillRequest): Promise<SkillSummary> {
		return req<SkillSummary>(`/skills/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) });
	},
	remove(id: string): Promise<{ ok: true }> {
		return req<{ ok: true }>(`/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
};
