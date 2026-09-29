import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import type { BackendStatusResponse, ListEnvSettingsResponse } from "@npi-deck/protocol";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { settingsApi } from "@/lib/settings-api";
import { useStore } from "@/lib/store";
import { formatUptime } from "@/lib/time";
import { apiErrorText } from "./api-error";

/**
 * Settings → About: what is running (deck server, NeoPi backend, browser
 * connection) and where the deck keeps its files, with a copyable summary
 * for bug reports.
 */
export function AboutSection() {
	const heartbeat = useStore((s) => s.heartbeat);
	const wsStatus = useStore((s) => s.wsStatus);
	const generation = useStore((s) => s.workerGeneration);
	const [backend, setBackend] = useState<BackendStatusResponse | null>(null);
	const [env, setEnv] = useState<ListEnvSettingsResponse | null>(null);
	const [error, setError] = useState<string | undefined>();
	const [copied, setCopied] = useState(false);
	const [nowMs, setNowMs] = useState(() => Date.now());

	useEffect(() => {
		Promise.all([settingsApi.backendStatus(), settingsApi.listEnv()])
			.then(([b, e]) => {
				setBackend(b);
				setEnv(e);
				setError(undefined);
			})
			.catch((err) => setError(apiErrorText(err)));
	}, [generation]);

	// Keeps "last heartbeat Ns ago" and uptime moving between frames.
	useEffect(() => {
		const handle = window.setInterval(() => setNowMs(Date.now()), 1000);
		return () => window.clearInterval(handle);
	}, []);

	const dbEntry = env?.entries.find((e) => e.key === "NPI_DECK_DB_PATH");
	const dbPath = env ? (dbEntry?.isSet ? dbEntry.masked : `${env.dataDir}/deck.db`) : undefined;
	const running = backend?.running ?? null;

	const rows: Array<[string, string]> = [
		["deck version", heartbeat?.version ?? "waiting for heartbeat"],
		["deck build", heartbeat?.buildSha ? heartbeat.buildSha.slice(0, 12) : "unknown"],
		["server pid", heartbeat ? String(heartbeat.pid) : "waiting for heartbeat"],
		["server started", heartbeat ? new Date(heartbeat.serverStartedAt).toLocaleString() : "waiting for heartbeat"],
		["server uptime", heartbeat ? formatUptime(heartbeat.serverStartedAt, nowMs) : "waiting for heartbeat"],
		["browser link", wsStatus],
		["NeoPi backend", running ? running.path : backend ? "none loaded" : "loading"],
		["NeoPi version", running?.version ?? "unknown"],
		["NeoPi commit", running?.commit ? running.commit.slice(0, 12) : "unknown"],
		["data dir", env?.dataDir ?? "loading"],
		["managed .env", env?.envFilePath ?? "loading"],
		["database", dbPath ?? "loading"],
	];

	async function copy(): Promise<void> {
		const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 2000);
		} catch (err) {
			setError(`Clipboard refused the copy: ${String(err)}`);
		}
	}

	const ageMs = heartbeat ? Math.max(0, nowMs - heartbeat.lastReceivedAtMs) : null;
	const ageTone: "success" | "warn" | "danger" = ageMs === null || ageMs >= 30_000 ? "danger" : ageMs < 10_000 ? "success" : "warn";

	return (
		<div className="mx-auto max-w-3xl space-y-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h1 className="text-xl font-semibold tracking-tight">About</h1>
					<p className="mt-1 text-sm text-ink-3">
						What is running and where the deck keeps its files. Copy the summary into a bug report.
					</p>
				</div>
				<Button size="sm" variant="outline" onClick={() => void copy()}>
					<Copy className="h-3.5 w-3.5" />
					{copied ? "Copied" : "Copy summary"}
				</Button>
			</div>

			{error ? (
				<div role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}

			<div className="rounded-md border border-line bg-paper-2 p-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="meta">Diagnostics</div>
					<Badge tone={ageTone}>
						{ageMs === null ? "no heartbeat yet" : `last heartbeat ${ageMs < 1_000 ? "just now" : `${Math.round(ageMs / 1000)}s ago`}`}
					</Badge>
				</div>
				<dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono text-xs text-ink-2">
					{rows.map(([k, v]) => (
						<div key={k} className="contents">
							<dt className="text-ink-3">{k}</dt>
							<dd className="break-all">{v}</dd>
						</div>
					))}
				</dl>
			</div>
		</div>
	);
}
