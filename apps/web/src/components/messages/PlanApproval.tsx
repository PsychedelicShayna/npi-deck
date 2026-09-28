import { useEffect, useState } from "react";
import { Check, Pencil, X } from "lucide-react";

import { useStore } from "@/lib/store";
import type { SessionUi } from "@/lib/types";
import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

/** Review an agent-authored local plan; rejections return feedback to the same planning turn. */
export function PlanApproval({ session }: { session: SessionUi }) {
	const approval = session.pendingPlanApproval;
	const respond = useStore(s => s.respondToPlanApproval);
	const [editing, setEditing] = useState(false);
	const [editedContent, setEditedContent] = useState(approval?.planContent ?? "");
	const [feedback, setFeedback] = useState("");

	useEffect(() => {
		if (!approval) return;
		setEditedContent(approval.planContent);
		setFeedback("");
		setEditing(false);
	}, [approval?.proposalId, approval?.planContent]);
	if (!approval) return null;
	const a = approval;

	return (
		<section aria-label="Plan ready for approval" className={cn("rounded-lg border border-accent-plan/40 bg-accent-plan/[0.04] p-4", "shadow-sm")}>
			<header className="mb-3 flex items-center gap-2">
				<span className="rounded border border-accent-plan/40 bg-accent-plan/10 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta text-accent-plan">Plan ready</span>
				<span className="truncate font-mono text-2xs text-ink-3">{a.suggestedTitle} · {a.planFilePath}</span>
			</header>
			{editing ? (
				<textarea value={editedContent} onChange={e => setEditedContent(e.target.value)} rows={Math.min(24, Math.max(8, editedContent.split("\n").length + 1))}
					className="mb-3 w-full resize-y rounded border border-line bg-paper px-2 py-1.5 font-mono text-xs text-ink focus:border-accent-plan/60 focus:outline-none" aria-label="Edit plan content" />
			) : (
				<div className="mb-3 max-h-[480px] overflow-y-auto rounded border border-line bg-paper p-3"><Markdown>{a.planContent}</Markdown></div>
			)}
			<label className="mb-3 block">
				<span className="meta mb-1 block">Feedback for revision (if rejecting)</span>
				<textarea value={feedback} onChange={e => setFeedback(e.target.value)} rows={2} placeholder="What should the agent change?"
					className="w-full resize-y rounded border border-line bg-paper px-2 py-1.5 text-xs text-ink focus:border-accent-plan/60 focus:outline-none" />
			</label>
			<div className="flex flex-wrap items-center gap-2">
				<button type="button" onClick={() => respond({ sessionId: session.sessionId, proposalId: a.proposalId, approved: false, feedback })}
					className="inline-flex items-center gap-1 rounded border border-line bg-paper px-2.5 py-1 text-xs text-ink-2 hover:border-danger/40 hover:text-danger"><X className="h-3.5 w-3.5" />Reject & request revision</button>
				{editing ? <>
					<button type="button" onClick={() => respond({ sessionId: session.sessionId, proposalId: a.proposalId, approved: true, editedContent })}
						className="inline-flex items-center gap-1 rounded border border-accent-plan/60 bg-accent-plan/15 px-2.5 py-1 text-xs text-accent-plan hover:bg-accent-plan/25"><Check className="h-3.5 w-3.5" />Save & approve</button>
					<button type="button" onClick={() => { setEditedContent(a.planContent); setEditing(false); }} className="ml-1 text-xs text-ink-3 underline-offset-2 hover:underline">Discard edits</button>
				</> : <>
					<button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 rounded border border-line bg-paper px-2.5 py-1 text-xs text-ink-2 hover:border-accent-plan/40 hover:text-accent-plan"><Pencil className="h-3.5 w-3.5" />Edit</button>
					<button type="button" onClick={() => respond({ sessionId: session.sessionId, proposalId: a.proposalId, approved: true })}
						className="inline-flex items-center gap-1 rounded border border-accent-plan/60 bg-accent-plan/15 px-2.5 py-1 text-xs text-accent-plan hover:bg-accent-plan/25"><Check className="h-3.5 w-3.5" />Approve</button>
				</>}
			</div>
		</section>
	);
}
