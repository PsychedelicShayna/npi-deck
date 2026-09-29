import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import type { WorkspaceSettingsResponse } from "@npi-deck/protocol";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { settingsApi } from "@/lib/settings-api";
import { useStore } from "@/lib/store";
import { apiErrorText } from "./api-error";

/**
 * Settings → Workspaces: the extra roots (`NPI_DECK_WORKSPACES`) the session
 * picker lists. A save applies to the running server at once and refreshes
 * this tab's picker.
 */
export function WorkspacesSection() {
	const [data, setData] = useState<WorkspaceSettingsResponse | null>(null);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const refreshWorkspaces = useStore((s) => s.refreshWorkspaces);

	const refresh = useCallback(async () => {
		try {
			setData(await settingsApi.getWorkspaces());
			setError(undefined);
		} catch (err) {
			setError(apiErrorText(err));
		}
	}, []);
	useEffect(() => { void refresh(); }, [refresh]);

	async function save(pinned: string[]): Promise<boolean> {
		setBusy(true);
		try {
			setData(await settingsApi.putWorkspaces(pinned));
			setError(undefined);
			await refreshWorkspaces();
			return true;
		} catch (err) {
			setError(apiErrorText(err));
			return false;
		} finally {
			setBusy(false);
		}
	}

	async function add(): Promise<void> {
		const path = draft.trim();
		if (!path || !data) return;
		if (await save([...data.pinned.map((p) => p.cwd), path])) setDraft("");
	}

	const editable = data?.setting.editable ?? false;

	return (
		<div className="mx-auto max-w-3xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Workspaces</h1>
				<p className="mt-1 text-sm text-ink-3">
					Workspaces are the folders the sidebar offers when you start a chat. The list always holds
					your default folder and every folder that already has a saved session. Pin a folder here to
					keep it in the list before it has any sessions. Changes apply at once, with no restart, and
					are saved as <span className="font-mono">NPI_DECK_WORKSPACES</span> in the deck&rsquo;s .env.
				</p>
			</div>

			{error ? (
				<div role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}

			{data ? (
				<>
					{!editable ? (
						<div role="note" className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
							The shell that launched the deck exports <span className="font-mono">NPI_DECK_WORKSPACES</span>,
							and that value overrides the deck&rsquo;s .env. Unset it there and restart the deck to manage
							pinned folders here.
						</div>
					) : null}

					<div className="rounded-md border border-line bg-paper-2 p-4">
						<div className="meta">Default folder</div>
						<div className="mt-1 break-all font-mono text-xs text-ink">{data.defaultCwd}</div>
						<div className="mt-1 text-xs text-ink-3">
							New chats start here. Change it with{" "}
							<Link className="underline" to="/settings?section=env">
								NPI_DECK_DEFAULT_CWD under Env
							</Link>
							.
						</div>
					</div>

					<div className="overflow-hidden rounded-md border border-line bg-paper">
						<div className="border-b border-line bg-paper-2 px-3 py-2">
							<div className="meta">Pinned folders</div>
						</div>
						{data.pinned.length === 0 ? (
							<div className="px-3 py-4 text-xs text-ink-3">No folders are pinned.</div>
						) : (
							<ul className="divide-y divide-line">
								{data.pinned.map((p) => (
									<li key={p.cwd} className="flex items-center gap-3 px-3 py-2">
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2 text-sm font-medium text-ink">
												{p.label}
												{!p.exists ? <Badge tone="warn">missing on disk</Badge> : null}
											</div>
											<div className="break-all font-mono text-2xs text-ink-3">{p.cwd}</div>
										</div>
										<Button
											size="sm"
											variant="ghost"
											disabled={!editable || busy}
											aria-label={`Unpin ${p.cwd}`}
											title="Unpin"
											onClick={() => void save(data.pinned.filter((q) => q.cwd !== p.cwd).map((q) => q.cwd))}
										>
											<Trash2 className="h-3.5 w-3.5" />
										</Button>
									</li>
								))}
							</ul>
						)}
						<form
							className="flex gap-2 border-t border-line p-3"
							onSubmit={(e) => {
								e.preventDefault();
								void add();
							}}
						>
							<input
								aria-label="Folder to pin"
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								placeholder="/absolute/path or ~/path"
								disabled={!editable || busy}
								className="block flex-1 rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-xs text-ink"
							/>
							<Button type="submit" size="sm" variant="primary" disabled={!editable || busy || draft.trim() === ""}>
								<Plus className="h-3.5 w-3.5" />
								Pin folder
							</Button>
						</form>
					</div>
				</>
			) : error ? null : (
				<div className="text-sm text-ink-3">Loading...</div>
			)}
		</div>
	);
}
