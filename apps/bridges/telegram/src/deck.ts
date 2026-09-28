import type { CreateSessionRequest, CreateSessionResponse, ImageAttachment, ServerFrame } from "@omp-deck/protocol";

export class SessionNotActiveError extends Error {
	constructor(sessionId: string) {
		super(`session not active: ${sessionId}`);
	}
}

export class DeckClient {
	constructor(
		private readonly apiBase: string,
		private readonly wsUrl: string,
	) {}

	async createSession(opts: { cwd: string; resumeFromPath?: string }): Promise<CreateSessionResponse> {
		const body: CreateSessionRequest = {
			cwd: opts.cwd,
			suppressAutoStart: true,
			...(opts.resumeFromPath ? { resumeFromPath: opts.resumeFromPath } : {}),
		};
		return this.request<CreateSessionResponse>("/api/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
	}

	async deleteSession(sessionId: string): Promise<void> {
		const res = await fetch(`${this.apiBase}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
		if (res.status === 404) return;
		if (!res.ok) throw new Error(`deck delete session failed: ${res.status}`);
	}

	promptSession(args: {
		sessionId: string;
		text: string;
		images?: ImageAttachment[];
		onText: (text: string) => void;
	}): Promise<string> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(this.wsUrl);
			let promptSent = false;
			let settled = false;
			let latestText = "";
			let sawAssistant = false;

			const finish = (err?: Error) => {
				if (settled) return;
				settled = true;
				try {
					ws.close();
				} catch {
					// already closed
				}
				if (err) reject(err);
				else resolve(latestText.trim() || (sawAssistant ? "" : "Turn complete."));
			};

			ws.onopen = () => {
				ws.send(JSON.stringify({ type: "subscribe", sessionId: args.sessionId }));
			};
			ws.onerror = () => finish(new Error("deck websocket failed"));
			ws.onclose = () => {
				if (!settled) finish(new Error("deck websocket closed before turn ended"));
			};
			ws.onmessage = (ev) => {
				let frame: ServerFrame;
				try {
					frame = JSON.parse(String(ev.data)) as ServerFrame;
				} catch {
					finish(new Error("deck websocket sent invalid json"));
					return;
				}
				if (frame.type === "subscribed" && frame.sessionId === args.sessionId && !promptSent) {
					promptSent = true;
					ws.send(
						JSON.stringify({
							type: "prompt",
							sessionId: args.sessionId,
							text: args.text,
							...(args.images && args.images.length > 0 ? { images: args.images } : {}),
						}),
					);
					return;
				}
				if (frame.type === "error" && (!frame.sessionId || frame.sessionId === args.sessionId)) {
					const message = frame.error.toLowerCase();
					finish(message.includes("session not active") ? new SessionNotActiveError(args.sessionId) : new Error(frame.error));
					return;
				}
				if (frame.type !== "session_event" || frame.sessionId !== args.sessionId) return;
				const event = frame.event as Record<string, unknown>;
				if (event.type === "message_update" || event.type === "message_end" || event.type === "message_start") {
					const msg = event.message as Record<string, unknown> | undefined;
					if (msg?.role === "assistant") {
						sawAssistant = true;
						const next = extractAssistantText(msg.content);
						if (next) {
							latestText = next;
							args.onText(latestText);
						}
					}
					return;
				}
				// `turn_end` fires after every tool turn, and NeoPi may emit a
				// non-terminal `agent_end` (`isTerminal: false`) as a scheduling
				// pause. Only a terminal `agent_end` means the answer is complete.
				if (event.type === "agent_end" && event.isTerminal !== false) finish();
			};
		});
	}

	private async request<T>(path: string, init: RequestInit): Promise<T> {
		const res = await fetch(`${this.apiBase}${path}`, {
			...init,
			headers: { "content-type": "application/json", ...(init.headers ?? {}) },
		});
		if (!res.ok) throw new Error(`deck request failed ${path}: HTTP ${res.status} ${await res.text()}`);
		return (await res.json()) as T;
	}
}

function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") out += block.text;
	}
	return out;
}
