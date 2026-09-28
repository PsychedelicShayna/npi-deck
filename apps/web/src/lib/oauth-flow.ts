import type { ServerFrame } from "@omp-deck/protocol";

export type OAuthFlowFrame = Extract<
	ServerFrame,
	{ type: "oauth_consent" | "oauth_progress" | "oauth_prompt" | "oauth_complete" | "oauth_failed" }
>;

const OAUTH_FRAME_TYPES = new Set<string>([
	"oauth_consent",
	"oauth_progress",
	"oauth_prompt",
	"oauth_complete",
	"oauth_failed",
]);

export interface OAuthFrameGate {
	/** Feed every WS frame; non-OAuth and other-provider frames are ignored. */
	push(frame: ServerFrame): void;
	/** The start response named the flow: replay its buffered frames, then pass it live. */
	bind(flowId: string): void;
}

/**
 * The server broadcasts a flow's frames as soon as the provider emits them,
 * which can be before the start request returns the flow id (a provider may
 * call onAuth and onPrompt synchronously). Subscribe with a gate before
 * starting the flow: it buffers the provider's frames until `bind`, then
 * delivers only the bound flow's frames, in order.
 */
export function createOAuthFrameGate(provider: string, deliver: (frame: OAuthFlowFrame) => void): OAuthFrameGate {
	let flowId: string | null = null;
	let buffered: OAuthFlowFrame[] = [];
	return {
		push(frame) {
			if (!OAUTH_FRAME_TYPES.has(frame.type)) return;
			const oauth = frame as OAuthFlowFrame;
			if (oauth.provider !== provider) return;
			if (flowId === null) buffered.push(oauth);
			else if (oauth.flowId === flowId) deliver(oauth);
		},
		bind(id) {
			flowId = id;
			const pending = buffered;
			buffered = [];
			for (const frame of pending) if (frame.flowId === id) deliver(frame);
		},
	};
}
