import { useEffect, useState } from "react";
import type { AgentMessageJson, SubagentNode } from "@npi-deck/protocol";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";

function textOf(message: AgentMessageJson): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part: unknown) => {
		if (typeof part === "string") return part;
		if (part && typeof part === "object") {
			const block = part as { text?: string; thinking?: string; name?: string };
			return block.text ?? block.thinking ?? (block.name ? `Tool: ${block.name}` : "");
		}
		return "";
	}).filter(Boolean).join("\n");
	return "";
}

export function SubagentTreePanel({ sessionId }: { sessionId: string }) {
	const nodes = useStore(s => s.subagentsBySession[sessionId] ?? []);
	const [selected, setSelected] = useState<string>();
	const [messages, setMessages] = useState<AgentMessageJson[]>([]);
	const [cursor, setCursor] = useState(0);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => { setSelected(undefined); setMessages([]); setCursor(0); setError(""); }, [sessionId]);
	useEffect(() => {
		if (!selected) return;
		let cancelled = false;
		let offset = 0;
		setMessages([]);
		setCursor(0);
		setError("");
		const update = async () => {
			try {
				const response = await api.getSubagentTranscript(sessionId, selected, offset);
				if (cancelled) return;
				offset = response.nextByte;
				setCursor(offset);
				setMessages(prev => response.reset ? response.messages : [...prev, ...response.messages]);
				setError("");
			} catch (cause) { if (!cancelled) setError(String(cause)); }
		};
		void update();
		const timer = setInterval(() => { void update(); }, 1800);
		return () => { cancelled = true; clearInterval(timer); };
	}, [sessionId, selected]);

	if (nodes.length === 0) return null;
	const byParent = new Map<string, SubagentNode[]>();
	const ids = new Set(nodes.map(n => n.id));
	for (const node of nodes) {
		const parent = ids.has(node.parentId) ? node.parentId : "root";
		byParent.set(parent, [...(byParent.get(parent) ?? []), node]);
	}
	const render = (parent: string, depth: number): React.ReactNode => (byParent.get(parent) ?? []).map(node => (
		<div key={node.id} style={{ paddingLeft: depth * 16 }}>
			<div className="flex items-center gap-2 border-b border-line/40 py-2 text-xs">
				<button type="button" className="min-w-0 flex-1 truncate text-left text-ink-1 hover:underline" onClick={() => setSelected(node.id)}>
					<span className="mr-2 text-ink-3">{node.status}</span>{node.name}
					{node.activity || node.description ? <span className="ml-2 text-ink-3">{node.activity ?? node.description}</span> : null}
				</button>
				{node.status === "running" ? <button type="button" className="text-red-400 hover:underline" disabled={busy} onClick={async () => {
					if (!window.confirm(`Abort ${node.name}?`)) return;
					setBusy(true);
					try { await api.abortSubagent(sessionId, node.id); } catch (cause) { setError(String(cause)); }
					finally { setBusy(false); }
				}}>Abort</button> : null}
			</div>
			{render(node.id, depth + 1)}
		</div>
	));
	return <details className="mx-auto w-full max-w-[760px] border-b border-line/60 px-6 py-3" open>
		<summary className="cursor-pointer font-mono text-xs uppercase text-ink-2">Subagents · {nodes.length}</summary>
		<div className="mt-2">{render("root", 0)}</div>
		{selected ? <section className="mt-3 max-h-96 overflow-y-auto rounded border border-line/60 p-3 text-xs">
			<div className="mb-2 flex items-center justify-between font-mono text-ink-2"><span>Read-only transcript · {nodes.find(n => n.id === selected)?.name ?? selected}</span><button type="button" onClick={() => setSelected(undefined)}>Close</button></div>
			{messages.map((m, index) => <div key={index} className="mb-3 whitespace-pre-wrap break-words"><strong>{m.role}</strong><div>{textOf(m)}</div></div>)}
			{!messages.length && !error ? <span className="text-ink-3">No transcript messages yet.</span> : null}
			{error ? <p role="alert" className="text-red-400">{error}</p> : null}
			<span className="sr-only">Read through byte {cursor}</span>
		</section> : null}
	</details>;
}
