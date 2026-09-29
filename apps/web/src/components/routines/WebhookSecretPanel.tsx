/**
 * Settings-tab panel for a routine's webhook: rotate the secret (shown once),
 * and, for a registration from before signed deliveries, a deprecation
 * warning while it still accepts the bare secret as its signature, with the
 * switch that stops accepting it. The server never sends the stored secret or
 * its hash here; the only plaintext is the one a rotation returns.
 */
import { useEffect, useState } from "react";
import { Copy, RefreshCcw } from "lucide-react";

import type { RoutineWebhookStatus } from "@npi-deck/protocol";

import { routinesApi } from "@/lib/routines-api";

export function WebhookSecretPanel({
	routineId,
	refreshKey,
	onError,
}: {
	routineId: string;
	/** Changes when the routine is saved, which can add, move or remove the webhook. */
	refreshKey: string;
	onError: (msg: string) => void;
}) {
	const [status, setStatus] = useState<RoutineWebhookStatus | null>(null);
	const [secret, setSecret] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let live = true;
		setSecret(undefined);
		void routinesApi.webhookStatus(routineId).then((s) => {
			if (live) setStatus(s);
		}, (e: unknown) => {
			if (live) onError(String(e));
		});
		return () => { live = false; };
	}, [routineId, refreshKey, onError]);

	async function rotate(): Promise<void> {
		setBusy(true);
		try {
			const res = await routinesApi.rotateWebhookSecret(routineId);
			setSecret(res.secret);
			setStatus(await routinesApi.webhookStatus(routineId));
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(false);
		}
	}

	async function refuseBareSecret(): Promise<void> {
		setBusy(true);
		try {
			setStatus(await routinesApi.setWebhookAcceptBareSecret(routineId, false));
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-2 rounded border border-line bg-paper-2/40 p-2">
			<div className="meta">Webhook secret</div>
			{status ? (
				<div className="font-mono text-2xs text-ink-3">
					Senders sign each delivery: <code>X-Routine-Timestamp: &lt;unix seconds&gt;</code> and{" "}
					<code>X-Routine-Signature: sha256=&lt;hex HMAC-SHA256(secret, "&lt;timestamp&gt;.&lt;raw body&gt;")&gt;</code>.
					Deliveries more than five minutes from the deck's clock are refused.
				</div>
			) : null}
			{status?.acceptsBareSecret ? (
				<div
					role="alert"
					data-testid="webhook-bare-secret-warning"
					className="space-y-1.5 rounded border border-warn/40 bg-warn/5 px-2 py-1.5 font-mono text-2xs text-warn"
				>
					<div>
						Deprecated: this webhook still accepts the bare secret as <code>X-Routine-Signature</code>. Anyone who
						sees one such delivery can replay it with any body, at any time.
					</div>
					<div>
						Last bare-secret delivery:{" "}
						{status.lastBareSecretAt ? new Date(status.lastBareSecretAt).toLocaleString() : "none since the upgrade"}.
					</div>
					{status.signingKeyStored ? (
						<div>Switch the sender to signed deliveries with the same secret, then stop accepting the bare secret.</div>
					) : (
						<div>
							The deck learns the secret from its next bare-secret delivery; until then only a rotated secret can sign.
						</div>
					)}
					<button
						type="button"
						disabled={busy}
						onClick={() => void refuseBareSecret()}
						className="btn-ghost h-7 text-2xs"
					>
						Stop accepting the bare secret
					</button>
				</div>
			) : null}
			<button type="button" disabled={busy} onClick={() => void rotate()} className="btn-ghost h-7 text-2xs">
				<RefreshCcw className="h-3 w-3" />
				Rotate secret
			</button>
			{secret ? (
				<div className="space-y-1">
					<div className="font-mono text-2xs text-warn">Copy now — the secret is shown ONCE.</div>
					<div className="flex items-center gap-1">
						<code className="flex-1 truncate rounded border border-line bg-paper-code px-2 py-1 font-mono text-2xs">
							{secret}
						</code>
						<button
							type="button"
							onClick={() => {
								void navigator.clipboard.writeText(secret);
							}}
							className="btn-ghost h-7 w-7 p-0"
							aria-label="Copy"
						>
							<Copy className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}
