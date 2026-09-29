import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import type { ModelInfo, NpiConfigSetting, SessionFallbackChainResponse } from "@npi-deck/protocol";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import {
	addRefusal,
	chainAt,
	describeChainKey,
	withFallbackAdded,
	withFallbackMoved,
	withFallbackRemoved,
} from "@/lib/fallback-chain";
import { npiConfigApi } from "@/lib/npi-config-api";

const SETTING_ID = "retry.fallbackChains";

export interface FallbackChain {
	loading: boolean;
	error?: string;
	info?: SessionFallbackChainResponse;
	/** The chain configured under `info.key` in config.yml; what the editor changes. */
	chain: string[];
	/** Why the chain cannot be edited here; undefined when it can. */
	readOnly?: string;
	busy: boolean;
	/** Append `entry`; a refusal (the primary itself, a duplicate) becomes `error`. */
	add(entry: string): void;
	remove(index: number): void;
	move(index: number, delta: -1 | 1): void;
	/** Give the model its own chain, starting from the entries now in effect. */
	adopt(entries: string[]): void;
}

/**
 * The active model's fallback chain (#31). Reads come from the chat's live
 * resolution and the NeoPi config registry; writes are single-key `entries`
 * edits of `retry.fallbackChains` through the Settings write path, which
 * validates, writes config.yml and reloads open chats.
 */
export function useFallbackChain(open: boolean, sessionId: string): FallbackChain {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [info, setInfo] = useState<SessionFallbackChainResponse | undefined>();
	const [setting, setSetting] = useState<NpiConfigSetting | undefined>();
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		setError(undefined);
		setInfo(undefined);
		setSetting(undefined);
		void Promise.all([api.getSessionFallbackChain(sessionId), npiConfigApi.list()])
			.then(([chainInfo, config]) => {
				if (cancelled) return;
				const found = config.settings.find((s) => s.id === SETTING_ID);
				if (!found) throw new Error(`This NeoPi backend does not register ${SETTING_ID}.`);
				setInfo(chainInfo);
				setSetting(found);
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, sessionId]);

	const chain = info && setting ? chainAt(setting.value, info.key) : [];
	const readOnly = setting?.lockedReason
		?? (setting?.invalidGlobalValue
			? `config.yml holds a ${SETTING_ID} value NeoPi rejects; fix or reset it in Settings → NeoPi.`
			: undefined);

	const save = useCallback(
		async (next: string[]) => {
			if (!info || readOnly || busy) return;
			setBusy(true);
			setError(undefined);
			try {
				// An empty chain removes the model's key instead of leaving `key: []`.
				const saved = await npiConfigApi.setEntries(SETTING_ID, { [info.key]: next.length > 0 ? next : null });
				setSetting(saved.setting);
				// The save reloaded the chat's settings; show what it resolves now.
				setInfo(await api.getSessionFallbackChain(sessionId));
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[info, readOnly, busy, sessionId],
	);

	return {
		loading,
		error,
		info,
		chain,
		readOnly,
		busy,
		add(entry) {
			if (!info) return;
			const refusal = addRefusal(chain, entry, info.model);
			if (refusal) setError(refusal);
			else void save(withFallbackAdded(chain, entry));
		},
		remove(index) {
			void save(withFallbackRemoved(chain, index));
		},
		move(index, delta) {
			const next = withFallbackMoved(chain, index, delta);
			if (next) void save(next);
		},
		adopt(entries) {
			void save(entries);
		},
	};
}

interface Props {
	state: FallbackChain;
	models: ModelInfo[];
	adding: boolean;
	onAddingChange: (adding: boolean) => void;
}

/** Summary and editor for the active model's fallback chain, above the picker's model list. */
export function FallbackChainPanel({ state, models, adding, onAddingChange }: Props) {
	const [expanded, setExpanded] = useState(false);
	const { info, chain, readOnly, busy } = state;
	const resolved = info?.resolved;
	const ownInEffect = resolved !== undefined && resolved.key === info?.key;
	const labelOf = (selector: string) => modelLabel(models, selector);

	useEffect(() => {
		if (adding) setExpanded(true);
	}, [adding]);

	return (
		<section aria-label="Fallback chain" className="border-b border-line bg-paper-2/60">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-paper-3/60"
			>
				{expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-3" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-3" />}
				<span className="meta shrink-0">Fallbacks</span>
				<span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-2">
					{state.loading
						? "loading..."
						: !info
							? state.error ? "unavailable" : ""
							: resolved
								? resolved.chain.join(" → ") || "none"
								: "none"}
				</span>
				{resolved && !ownInEffect ? (
					<Badge tone="muted" title={`Not this model's own chain: ${describeChainKey(resolved.key)}`}>
						{resolved.deckDefault ? "deck default" : "inherited"}
					</Badge>
				) : null}
			</button>
			{expanded ? (
				<div className="space-y-2 px-3 pb-3">
					{state.error ? (
						<p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-2 py-1 font-mono text-xs text-danger">{state.error}</p>
					) : null}
					{readOnly ? (
						<p role="note" className="rounded-md border border-warn/30 bg-warn/10 px-2 py-1 text-xs text-warn">{readOnly}</p>
					) : null}
					{info ? (
						<>
							<div className="text-2xs text-ink-3">
								When <span className="font-mono text-ink-2">{info.model}</span> fails or hits a rate limit, NeoPi retries these in
								order. Saved to <span className="font-mono">retry.fallbackChains</span> under{" "}
								<span className="font-mono text-ink-2">{info.key}</span>.
							</div>
							{chain.length === 0 ? (
								<div className="text-xs text-ink-3">This model has no fallback chain of its own.</div>
							) : (
								<ol className="space-y-1">
									{chain.map((entry, index) => (
										<li key={entry} className="flex items-center gap-2 rounded-md border border-line bg-paper px-2 py-1">
											<span className="w-4 shrink-0 text-right font-mono text-2xs text-ink-3">{index + 1}</span>
											<div className="min-w-0 flex-1">
												<div className="truncate text-sm text-ink">{labelOf(entry) ?? entry}</div>
												{labelOf(entry) ? <div className="truncate font-mono text-2xs text-ink-3">{entry}</div> : null}
											</div>
											{readOnly ? null : (
												<>
													<Button variant="ghost" size="icon" className="h-6 w-6" disabled={busy || index === 0} onClick={() => state.move(index, -1)} aria-label={`Move ${entry} up`}>
														<ArrowUp className="h-3.5 w-3.5" />
													</Button>
													<Button variant="ghost" size="icon" className="h-6 w-6" disabled={busy || index === chain.length - 1} onClick={() => state.move(index, 1)} aria-label={`Move ${entry} down`}>
														<ArrowDown className="h-3.5 w-3.5" />
													</Button>
													<Button variant="ghost" size="icon" className="h-6 w-6" disabled={busy} onClick={() => state.remove(index)} aria-label={`Remove ${entry}`}>
														<X className="h-3.5 w-3.5" />
													</Button>
												</>
											)}
										</li>
									))}
								</ol>
							)}
							{resolved && !ownInEffect ? (
								<div className="flex flex-wrap items-center gap-2 text-2xs text-ink-3">
									<span>
										{resolved.deckDefault ? "Until it has one, the deck's default for new chats applies: " : `In effect now, from ${describeChainKey(resolved.key)}: `}
										<span className="font-mono text-ink-2">{resolved.chain.join(" → ")}</span>
									</span>
									{!readOnly && chain.length === 0 && resolved.chain.length > 0 ? (
										<Button variant="outline" size="sm" disabled={busy} onClick={() => state.adopt(resolved.chain)}>
											Start from these
										</Button>
									) : null}
								</div>
							) : null}
							{readOnly ? null : (
								<div className="flex items-center gap-2">
									{adding ? (
										<>
											<span className="text-xs text-accent">Pick a model below to append it.</span>
											<Button variant="outline" size="sm" onClick={() => onAddingChange(false)}>
												Done
											</Button>
										</>
									) : (
										<Button variant="outline" size="sm" disabled={busy} onClick={() => onAddingChange(true)}>
											<Plus className="h-3.5 w-3.5" />
											Add fallback
										</Button>
									)}
									{busy ? <span className="text-2xs text-ink-3">saving...</span> : null}
								</div>
							)}
						</>
					) : null}
				</div>
			) : null}
		</section>
	);
}

/** The picker label of a selector's model (`provider/id`, optionally `:effort`), when the catalog has it. */
function modelLabel(models: ModelInfo[], selector: string): string | undefined {
	const exact = models.find((m) => `${m.provider}/${m.id}` === selector);
	if (exact) return exact.label;
	const colon = selector.lastIndexOf(":");
	if (colon < 0) return undefined;
	const base = models.find((m) => `${m.provider}/${m.id}` === selector.slice(0, colon));
	return base ? `${base.label} · ${selector.slice(colon + 1)}` : undefined;
}
