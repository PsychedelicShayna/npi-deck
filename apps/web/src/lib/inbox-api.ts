import type {
	CreateInboxItemRequest,
	InboxItem,
	InboxKind,
	ListInboxResponse,
	PromoteInboxItemRequest,
	PromoteInboxItemResponse,
	UpdateInboxItemRequest,
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

export const inboxApi = {
	list(opts: { kind?: InboxKind; includeProcessed?: boolean } = {}): Promise<ListInboxResponse> {
		const q = new URLSearchParams();
		if (opts.kind) q.set("kind", opts.kind);
		if (opts.includeProcessed) q.set("includeProcessed", "1");
		const qs = q.toString();
		return req<ListInboxResponse>(`/inbox${qs ? `?${qs}` : ""}`);
	},
	create(body: CreateInboxItemRequest): Promise<InboxItem> {
		return req<InboxItem>("/inbox", { method: "POST", body: JSON.stringify(body) });
	},
	update(id: string, body: UpdateInboxItemRequest): Promise<InboxItem> {
		return req<InboxItem>(`/inbox/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		});
	},
	remove(id: string): Promise<{ ok: boolean }> {
		return req(`/inbox/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	promote(id: string, body: PromoteInboxItemRequest = {}): Promise<PromoteInboxItemResponse> {
		return req<PromoteInboxItemResponse>(`/inbox/${encodeURIComponent(id)}/promote`, {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
};
