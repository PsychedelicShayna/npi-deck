import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, RotateCcw, Save } from "lucide-react";
import type { ModelsConfigProviderSummary, ModelsConfigResponse, ModelsConfigSaveResponse } from "@npi-deck/protocol";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { modelsConfigApi } from "@/lib/models-config-api";
import { cn } from "@/lib/utils";

type Check =
	| { state: "idle" }
	| { state: "checking" }
	| { state: "valid"; providers: ModelsConfigProviderSummary[] }
	| { state: "invalid"; error: string };

const VALIDATE_DELAY_MS = 500;

/**
 * models.yml: custom providers, models, overrides and discovery. The structured
 * view is what NeoPi loads from disk; the editor holds the whole document with
 * credentials masked, validated by NeoPi as you type and again on save.
 */
export function ModelsConfigSection() {
	const [data, setData] = useState<ModelsConfigResponse | null>(null);
	const [loadError, setLoadError] = useState<string | undefined>();
	const [text, setText] = useState("");
	const [check, setCheck] = useState<Check>({ state: "idle" });
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | undefined>();
	const [report, setReport] = useState<ModelsConfigSaveResponse | undefined>();

	const adopt = useCallback((next: ModelsConfigResponse) => {
		setData(next);
		setText(next.raw ?? "");
		setCheck({ state: "idle" });
	}, []);

	const reload = useCallback(async () => {
		try {
			adopt(await modelsConfigApi.load());
			setLoadError(undefined);
			setSaveError(undefined);
			setReport(undefined);
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : String(err));
		}
	}, [adopt]);
	useEffect(() => { void reload(); }, [reload]);

	const baseline = data?.raw ?? "";
	const dirty = data !== null && text !== baseline;

	// NeoPi judges every edit; only the latest request's answer is shown.
	useEffect(() => {
		if (!dirty) { setCheck({ state: "idle" }); return; }
		let current = true;
		setCheck({ state: "checking" });
		const timer = setTimeout(() => {
			modelsConfigApi.validate(text).then(
				result => { if (current) setCheck({ state: "valid", providers: result.providers }); },
				(err: unknown) => { if (current) setCheck({ state: "invalid", error: err instanceof Error ? err.message : String(err) }); },
			);
		}, VALIDATE_DELAY_MS);
		return () => { current = false; clearTimeout(timer); };
	}, [text, dirty]);

	async function save() {
		if (!data || !dirty || saving) return;
		setSaving(true);
		setSaveError(undefined);
		setReport(undefined);
		try {
			const result = await modelsConfigApi.save(text, data.revision);
			adopt(result);
			setReport(result);
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	const canSave = dirty && !saving && check.state !== "invalid" && check.state !== "checking";
	return (
		<div className="mx-auto max-w-6xl space-y-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h1 className="text-xl font-semibold tracking-tight">Models &amp; providers</h1>
					<p className="mt-1 max-w-3xl text-sm text-ink-3">
						Custom providers, models, model overrides and discovery from NeoPi's models.yml. Edits are checked
						with NeoPi's own schema and provider rules before anything is written; saving keeps a backup of the
						previous file and refreshes the model picker without a restart.
					</p>
				</div>
				<Button variant="outline" size="sm" onClick={() => void reload()}>
					<RotateCcw className="h-3.5 w-3.5" />
					Reload
				</Button>
			</div>
			{loadError ? <Alert tone="danger">{loadError}</Alert> : null}
			{data ? (
				<>
					<div className="rounded-md border border-line bg-paper-2 px-3 py-2 font-mono text-2xs text-ink-3">
						<div>file: {data.path}{data.exists ? "" : " (not created yet)"}</div>
						<div>{data.maskedSecrets} credential{data.maskedSecrets === 1 ? "" : "s"} masked · revision {data.revision.slice(0, 12)}</div>
					</div>
					{data.error ? (
						<Alert tone="warn">
							<div className="mb-1 font-sans font-medium">NeoPi rejects this file and ignores it, so no custom provider from it is in effect:</div>
							<div className="whitespace-pre-wrap">{data.error}</div>
						</Alert>
					) : null}
					<ProvidersView providers={data.providers} exists={data.exists} invalid={data.error !== undefined} />
					<div className="overflow-hidden rounded-md border border-line bg-paper">
						<div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-paper-2 px-3 py-2">
							<div className="meta">models.yml</div>
							<CheckStatus check={check} dirty={dirty} />
						</div>
						<div className="space-y-2 p-3">
							{data.raw === null ? <Alert tone="warn">{data.rawUnavailable}</Alert> : null}
							<p className="text-xs text-ink-3">
								Credentials appear as <code className="font-mono text-2xs">&lt;npi-deck-masked:…&gt;</code>, including any whole{" "}
								<code className="font-mono text-2xs">baseUrl</code> with a user name, password, query or fragment (the provider list shows
								its host and path). A placeholder that is the whole value of an <code className="font-mono text-2xs">apiKey</code>, a
								header or a requestMetadata entry keeps the stored value on save (it may be moved or copied between those), and a
								masked URL does the same as a whole baseUrl. Anywhere else a save is refused: replace it with the full value, a new
								key, an environment variable name or a{" "}
								<code className="font-mono text-2xs">!command</code>, or delete it. Comments are never shown: each appears as{" "}
								<code className="font-mono text-2xs"># &lt;npi-deck-comment:…&gt;</code> and is saved back verbatim if left exactly as
								it is. Delete one to remove it; a comment you write, or write in place of one, is saved as typed.
							</p>
							<textarea
								aria-label="models.yml document"
								value={text}
								spellCheck={false}
								disabled={saving}
								rows={Math.min(40, Math.max(12, text.split("\n").length + 2))}
								onChange={e => setText(e.target.value)}
								onKeyDown={e => {
									if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (canSave) void save(); }
								}}
								placeholder={"providers:\n  my-provider:\n    baseUrl: https://…/v1\n    api: openai-completions\n    apiKey: MY_PROVIDER_API_KEY\n    models:\n      - id: my-model"}
								className="field w-full resize-y px-2 py-1.5 font-mono text-xs leading-5"
							/>
							{check.state === "invalid" ? <Alert tone="danger">{check.error}</Alert> : null}
							{saveError ? <Alert tone="danger">{saveError}</Alert> : null}
							{report ? <SaveReport report={report} /> : null}
							<div className="flex flex-wrap items-center gap-2">
								<Button variant="primary" size="sm" disabled={!canSave} onClick={() => void save()}>
									<Save className="h-3.5 w-3.5" />
									{saving ? "Saving…" : "Save"}
								</Button>
								{dirty ? <Button variant="ghost" size="sm" disabled={saving} onClick={() => setText(baseline)}>Discard</Button> : null}
							</div>
						</div>
					</div>
				</>
			) : loadError ? null : <div className="text-sm text-ink-3">Loading...</div>}
		</div>
	);
}

function Alert({ tone, children }: { tone: "danger" | "warn" | "success"; children: ReactNode }) {
	return (
		<div
			role={tone === "success" ? "status" : "alert"}
			className={cn(
				"rounded-md border px-3 py-2 font-mono text-xs",
				tone === "danger" && "border-danger/30 bg-danger/10 text-danger",
				tone === "warn" && "border-warn/30 bg-warn/10 text-warn",
				tone === "success" && "border-success/30 bg-success/10 text-success",
			)}
		>
			{children}
		</div>
	);
}

function CheckStatus({ check, dirty }: { check: Check; dirty: boolean }) {
	if (!dirty) return <span className="text-2xs text-ink-4">No unsaved changes</span>;
	if (check.state === "checking" || check.state === "idle") return <span className="text-2xs text-ink-3">Checking with NeoPi…</span>;
	if (check.state === "invalid") return <Badge tone="danger">rejected by NeoPi</Badge>;
	const models = check.providers.reduce((sum, p) => sum + p.models.length, 0);
	return (
		<span className="inline-flex items-center gap-1 text-2xs text-success">
			<CheckCircle2 className="h-3.5 w-3.5" />
			Valid · {check.providers.length} provider{check.providers.length === 1 ? "" : "s"}, {models} model{models === 1 ? "" : "s"}
		</span>
	);
}

function SaveReport({ report }: { report: ModelsConfigSaveResponse }) {
	const { registry } = report;
	const lines = [`Saved ${report.path}.${report.backupPath ? ` Previous file kept at ${report.backupPath}.` : ""}`];
	if (registry.refreshed) lines.push("The model picker and every chat now use the new models.");
	if (registry.error) lines.push(registry.error);
	if (registry.missingModels.length) lines.push(`Not listed by the model registry: ${registry.missingModels.join(", ")}.`);
	if (registry.discovering.length) lines.push(`Discovering models for ${registry.discovering.join(", ")} in the background; they appear in the picker when it finishes.`);
	const complete = registry.refreshed && !registry.error && registry.missingModels.length === 0;
	return <Alert tone={complete ? "success" : "warn"}>{lines.map(line => <div key={line}>{line}</div>)}</Alert>;
}

function ProvidersView({ providers, exists, invalid }: { providers: ModelsConfigProviderSummary[]; exists: boolean; invalid: boolean }) {
	if (invalid) return null;
	if (providers.length === 0) {
		return (
			<div className="rounded-md border border-dashed border-line bg-paper-2 px-3 py-3 text-sm text-ink-3">
				{exists ? "models.yml defines no providers." : "No models.yml yet. Write one below to add custom providers and models."}
			</div>
		);
	}
	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="meta">In effect · {providers.length} provider{providers.length === 1 ? "" : "s"}</div>
			</div>
			<div className="divide-y divide-line">
				{providers.map(provider => <ProviderRow key={provider.name} provider={provider} />)}
			</div>
		</div>
	);
}

function ProviderRow({ provider }: { provider: ModelsConfigProviderSummary }) {
	return (
		<div className="space-y-2 px-3 py-3 text-sm">
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="font-mono font-medium text-ink">{provider.name}</span>
				{provider.api ? <Badge>{provider.api}</Badge> : null}
				<Badge tone={provider.auth === "none" ? "muted" : "accent"}>auth {provider.auth}</Badge>
				{provider.auth === "apiKey" ? (
					<Badge tone={provider.apiKeySet ? "success" : "warn"} title="The key itself is never shown">
						{provider.apiKeySet ? "api key set" : "no api key"}
					</Badge>
				) : null}
				{provider.discovery ? <Badge tone="thinking">discovery {provider.discovery}</Badge> : null}
				{provider.transport ? <Badge tone="muted">{provider.transport}</Badge> : null}
			</div>
			<div className="space-y-0.5 font-mono text-2xs text-ink-3">
				{provider.baseUrl ? <div className="break-all">baseUrl {provider.baseUrl}</div> : null}
				{provider.headers.length ? <div>headers {provider.headers.join(", ")} <span className="text-ink-4">(values hidden)</span></div> : null}
				{provider.modelOverrides.length ? <div>overrides {provider.modelOverrides.join(", ")}</div> : null}
			</div>
			{provider.models.length ? (
				<table className="w-full table-fixed text-left font-mono text-2xs">
					<thead className="text-ink-4">
						<tr>
							<th className="w-2/5 py-0.5 font-normal">model</th>
							<th className="py-0.5 font-normal">api</th>
							<th className="py-0.5 font-normal">context</th>
							<th className="py-0.5 font-normal">max out</th>
							<th className="py-0.5 font-normal">input</th>
						</tr>
					</thead>
					<tbody className="text-ink-2">
						{provider.models.map(model => (
							<tr key={model.id} className="border-t border-line/60">
								<td className="truncate py-0.5" title={model.name ?? model.id}>
									{model.id}{model.name ? <span className="text-ink-4"> · {model.name}</span> : null}
								</td>
								<td className="py-0.5">{model.api ?? provider.api ?? "—"}</td>
								<td className="py-0.5">{model.contextWindow?.toLocaleString() ?? "—"}</td>
								<td className="py-0.5">{model.maxTokens?.toLocaleString() ?? "—"}</td>
								<td className="py-0.5">{model.input?.join(", ") ?? "—"}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : null}
		</div>
	);
}
