import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore, selectActiveSession } from "@/lib/store";
import { MAX_RENDERED, MESSAGE_PAGE, windowRange, type WindowAnchor } from "@/lib/transcript-window";
import type { ChatMessage, SessionUi } from "@/lib/types";
import { ChatHeader } from "./chat/ChatHeader";
import { SessionPicker } from "./chat/SessionPicker";
import { SubagentTreePanel } from "./chat/SubagentTreePanel";
import { UserMessage } from "./messages/UserMessage";
import { AssistantMessage } from "./messages/AssistantMessage";
import { Notice } from "./messages/Notice";
import { CompactionLine } from "./messages/CompactionLine";
import { TtsrLine } from "./messages/TtsrLine";
import { IrcLine } from "./messages/IrcLine";
import { MixtureTraceLine } from "./messages/MixtureTraceLine";
import { QueuedMessage } from "./messages/QueuedMessage";
import { PlanApproval } from "./messages/PlanApproval";

export function Chat() {
	const session = useStore(selectActiveSession);

	// No active session — show the picker as the main pane instead of a
	// dead-end "go to sidebar" message.
	if (!session) {
		return <SessionPicker />;
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<ChatHeader />
			{session.endedByRestart ? (
				<div className="border-b border-warn/30 bg-warn/10 px-6 py-2 text-xs text-warn">
					This session ended when the server worker restarted. Its transcript is preserved; sending a new prompt explicitly resumes it.
					{session.backendLastRan ? ` Last backend: ${session.backendLastRan.commit?.slice(0, 10) ?? session.backendLastRan.path}.` : ""}
				</div>
			) : null}
			{!session.readOnly ? <SubagentTreePanel sessionId={session.sessionId} /> : null}
			{/* Keyed so each session starts at its newest messages, scrolled to the bottom. */}
			<ChatTranscript key={session.sessionId} session={session} />
		</div>
	);
}

/**
 * Where the reader was before a window change: a mounted message and its
 * offset in the viewport, else the distance from the bottom (used when the
 * change replaced every message, as a full load does).
 */
interface ViewportMark {
	el: Element | null;
	top: number;
	fromBottom: number;
}

function nearBottom(el: HTMLElement): boolean {
	return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
}

function ChatTranscript({ session }: { session: SessionUi }) {
	const loadEarlierTranscript = useStore((s) => s.loadEarlierTranscript);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickyRef = useRef(true);
	/** Viewport to restore once the window change has mounted. */
	const restoreRef = useRef<ViewportMark | undefined>(undefined);
	/**
	 * From an earlier-message request until its restored viewport has
	 * painted: bottom-following is off and scroll events don't re-pin, so
	 * neither undoes the restore.
	 */
	const settlingRef = useRef(false);
	const [anchor, setAnchor] = useState<WindowAnchor | undefined>(undefined);
	const [loadingEarlier, setLoadingEarlier] = useState(false);

	const { messages, toolCalls, queuedPrompts } = session;
	const { start, end } = windowRange(messages, anchor);
	const shown = useMemo(() => messages.slice(start, end), [messages, start, end]);
	const notLoaded = session.readOnly?.earlier ?? 0;
	const newer = messages.length - end;

	function settle(): void {
		requestAnimationFrame(() => {
			settlingRef.current = false;
			const el = scrollRef.current;
			if (el) stickyRef.current = nearBottom(el);
		});
	}

	useLayoutEffect(() => {
		const el = scrollRef.current;
		const mark = restoreRef.current;
		if (!el || !mark) return;
		restoreRef.current = undefined;
		if (mark.el?.isConnected) el.scrollTop += mark.el.getBoundingClientRect().top - mark.top;
		else el.scrollTop = el.scrollHeight - mark.fromBottom;
		settle();
	}, [start, end, messages]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el || settlingRef.current) return;
		if (stickyRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages, toolCalls, queuedPrompts, start, end]);

	function handleScroll(): void {
		const el = scrollRef.current;
		if (!el || settlingRef.current) return;
		stickyRef.current = nearBottom(el);
		if (!stickyRef.current) {
			// A reader who scrolls up keeps the messages above them; new ones
			// are then counted below instead of sliding the window.
			if (anchor?.id === undefined && shown[0]) setAnchor({ id: shown[0].id, fromEnd: messages.length - start, count: end - start });
		} else if (anchor?.id !== undefined && newer === 0) {
			// Back at the newest message: follow new ones again, keeping as
			// many messages mounted as the reader had.
			setAnchor({ fromEnd: end - start, count: end - start });
		}
	}

	function beginRestore(el: HTMLElement): void {
		const first = el.querySelector("[data-message-id]");
		stickyRef.current = false;
		settlingRef.current = true;
		restoreRef.current = { el: first, top: first ? first.getBoundingClientRect().top : 0, fromBottom: el.scrollHeight - el.scrollTop };
	}

	async function showEarlier(): Promise<void> {
		const el = scrollRef.current;
		if (!el) return;
		if (start > 0) {
			const earlier = Math.max(0, start - MESSAGE_PAGE);
			beginRestore(el);
			setAnchor({ id: messages[earlier]!.id, fromEnd: messages.length - earlier, count: Math.min(end - earlier, MAX_RENDERED) });
			return;
		}
		// Everything loaded is shown; fetch the rest of a read-only
		// transcript. Its messages are rebuilt, so the window keeps its place
		// by distance from the newest message.
		beginRestore(el);
		const reach = messages.length + MESSAGE_PAGE;
		setAnchor({ fromEnd: reach, count: reach });
		setLoadingEarlier(true);
		try {
			await loadEarlierTranscript(session.sessionId);
		} catch (err) {
			console.error("load earlier messages failed", err);
		} finally {
			// Nothing replaced (failed, or resumed or reopened meanwhile):
			// drop the restore so no later, unrelated update applies it.
			if (useStore.getState().sessionsById[session.sessionId]?.messages === messages && restoreRef.current) {
				restoreRef.current = undefined;
				settle();
			}
			setLoadingEarlier(false);
		}
	}

	function jumpToLatest(): void {
		stickyRef.current = true;
		setAnchor(undefined);
	}

	return (
		<div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
			<div className="mx-auto flex max-w-[760px] flex-col gap-7 px-6 py-10">
				{messages.length === 0 ? (
					<div className="text-center font-mono text-2xs uppercase tracking-meta text-ink-3">
						Empty session — send a prompt below.
					</div>
				) : null}

				{start > 0 || notLoaded > 0 ? (
					<button
						type="button"
						onClick={() => void showEarlier()}
						disabled={loadingEarlier}
						className="btn-ghost self-center font-mono text-2xs uppercase tracking-meta text-ink-3"
					>
						{start > 0
							? `Show ${Math.min(MESSAGE_PAGE, start)} earlier · ${start} hidden`
							: loadingEarlier
								? "Loading earlier messages…"
								: "Load earlier messages"}
					</button>
				) : null}

				{shown.map((m) => (
					<div key={m.id} data-message-id={m.id}>
						<ChatMessageView msg={m} toolCalls={toolCalls} />
					</div>
				))}

				{newer > 0 ? (
					<button
						type="button"
						onClick={jumpToLatest}
						className="btn-ghost self-center font-mono text-2xs uppercase tracking-meta text-accent"
					>
						{newer} newer {newer === 1 ? "message" : "messages"} · jump to latest
					</button>
				) : null}

				{queuedPrompts.map((q) => (
					<QueuedMessage key={q.id} msg={q} />
				))}
				{session.pendingPlanApproval ? (
					<PlanApproval session={session} />
				) : null}
			</div>
		</div>
	);
}

function ChatMessageView({ msg, toolCalls }: { msg: ChatMessage; toolCalls: SessionUi["toolCalls"] }) {
	switch (msg.role) {
		case "user":
			return <UserMessage msg={msg} />;
		case "assistant":
			return <AssistantMessage msg={msg} toolCalls={toolCalls} />;
		case "notice":
			return <Notice msg={msg} />;
		case "compaction":
			return <CompactionLine msg={msg} />;
		case "ttsr":
			return <TtsrLine msg={msg} />;
		case "irc":
			return <IrcLine msg={msg} />;
		case "mixtureTrace":
			return <MixtureTraceLine msg={msg} />;
		default:
			return null;
	}
}
