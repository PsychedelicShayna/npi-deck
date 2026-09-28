/**
 * The deck server as a function. `startDeck()` does everything the process
 * needs (managed env, generation marker, backend, db, listener) and returns a
 * handle; importing this module has no side effects. `index.ts` is the thin
 * process entry, and a future `npi deck` subcommand can call this directly.
 */
import type { Server, ServerWebSocket } from "bun";
import * as path from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { InProcessAgentBridge } from "./bridge/in-process.ts";
import { RoutinesRunner } from "./routines-runner.ts";
import { closeDb, openDb } from "./db/index.ts";
import { loadConfig } from "./config.ts";
import { getDataDir, loadManagedEnvIntoProcess } from "./env-store.ts";
import { initializeOwnedGeneration, stopOwnedProcesses, sweepOwnedProcesses } from "./owned-process.ts";
import { launcherFromEnv, RESTART_EXIT_CODE, watchLauncher } from "./owned/launcher.ts";
import { workRegistry } from "./work-registry.ts";
import { logger } from "./log.ts";
import { buildRouter } from "./routes.ts";
import { serveUpload } from "./routes-uploads.ts";
import { WsHub, type ConnectionData } from "./ws.ts";
import { MarketplaceService } from "./marketplace-service.ts";
import { SkillsService } from "./skills-service.ts";
import { startSkillsWatcher } from "./skills-watcher.ts";
import { KbService, resolveKbRoot } from "./kb-service.ts";
import { startKbWatcher } from "./kb-watcher.ts";
import { KbProtocolHandler } from "./kb-protocol.ts";
import { installStarterSkills } from "./starter-skills.ts";
import { installStarterExtensions } from "./starter-extensions.ts";
import { buildDefaultBridgeSupervisor } from "./bridge-supervisor.ts";
import { abortOAuthFlows } from "./routes-auth-oauth.ts";
import { activeBackend, formatDiagnostic, listBackends, loadBackend, readBackendConfig, resolveBackendSelection, sdk, writeActiveBackend, type BackendSelection } from "./backend/runtime.ts";
import { preflight, type ProbeResult } from "./backend/probe.ts";
import {
	BrowserNotificationChannel,
	notificationService,
} from "./notifications/index.ts";
import type { RestartServerResponse } from "@npi-deck/protocol";
import type { BackendStatusResponse, BackendSwitchResponse } from "@npi-deck/protocol";

const log = logger("server");
/** Leave room for the 1s launcher poll and cgroup teardown within W9's 5s limit. */
const SHUTDOWN_DEADLINE_MS = 3_000;

/** An unready switched worker must hand control back to the launcher. */
export function rollbackFailedBoot(): boolean {
	const file = path.join(getDataDir(), "run", "backend-switch.json");
	if (!existsSync(file) || process.env.NPI_DECK_BACKEND?.trim()) return false;
	const pending = JSON.parse(readFileSync(file, "utf8")) as { previous: string | null };
	writeActiveBackend(pending.previous);
	rmSync(file, { force: true });
	return true;
}

export interface StartDeckOptions {
	/** Overrides NPI_DECK_HOST. */
	host?: string;
	/** Overrides NPI_DECK_PORT. */
	port?: number;
	/** Stop and exit on SIGINT/SIGTERM. Default true. */
	handleSignals?: boolean;
}

export interface DeckHandle {
	/** Base URL the listener is bound to. */
	url: string;
	/** Graceful shutdown; idempotent. Does not exit the process. */
	stop(reason?: string): Promise<void>;
}

export async function startDeck(opts: StartDeckOptions = {}): Promise<DeckHandle> {
	loadManagedEnvIntoProcess();
	const config = loadConfig();
	if (opts.host !== undefined) config.host = opts.host;
	if (opts.port !== undefined) config.port = opts.port;
	log.info(`npi-deck server starting`, {
		host: config.host,
		port: config.port,
		defaultCwd: config.defaultCwd,
		webDist: config.webDist,
		devMode: config.devMode,
	});

	// Kill what an earlier generation left behind and mark everything this
	// process spawns from here on (no-orphans layer 2). MUST precede any spawn.
	initializeOwnedGeneration();
	await sweepOwnedProcesses();

	const transactionFile = path.join(getDataDir(), "run", "backend-switch.json");
	const pending = existsSync(transactionFile) ? JSON.parse(readFileSync(transactionFile, "utf8")) as { previous: string | null; target: string } : null;
	const bootDeadline = pending ? setTimeout(() => {
		log.error("backend switch boot timed out; restoring previous selection");
		try { rollbackFailedBoot(); } catch (err) { log.error("rollback failed", err); }
		process.exit(RESTART_EXIT_CODE);
	}, 40_000) : undefined;
	let backendReason: string | undefined;
	let backendImportFailed = false;
	let validated: { id: string | null; result: Extract<ProbeResult, { ok: true }> } | null = null;
	let bootSelection: BackendSelection | undefined;
	try { bootSelection = resolveBackendSelection(); }
	catch (err) { backendReason = String(err); }
	if (bootSelection) {
		const probe = await preflight(bootSelection.path);
		if (!probe.ok) backendReason = probe.reason;
		else {
			validated = { id: bootSelection.id, result: probe };
			try {
				const backend = await loadBackend(bootSelection);
				log.info("NeoPi backend loaded", { ...backend.identity, source: backend.selection.source });
				for (const [name, status] of Object.entries(backend.features)) {
					if (!status.available) log.warn(`backend feature ${name} unavailable: ${status.diagnostics.map(formatDiagnostic).join("; ")}`);
				}
			} catch (err) { backendReason = String(err); backendImportFailed = true; }
		}
	}
	if (!activeBackend() && pending && !process.env.NPI_DECK_BACKEND) {
		if (backendImportFailed) {
			log.error(`candidate import failed; rolling back in a fresh worker: ${backendReason}`);
			rollbackFailedBoot();
			process.exit(RESTART_EXIT_CODE);
		}
		log.warn(`backend switch to ${pending.target} failed: ${backendReason}; restoring ${pending.previous ?? "no backend"}`);
		writeActiveBackend(pending.previous);
		if (pending.previous) {
			try {
				const previous = resolveBackendSelection();
				if (previous) {
					const probe = await preflight(previous.path);
					if (!probe.ok) throw new Error(probe.reason);
					validated = { id: previous.id, result: probe };
					try { await loadBackend(previous); }
					catch (err) {
						writeActiveBackend(null);
						rmSync(transactionFile, { force: true });
						log.error(`previous backend import failed; restarting backendless: ${String(err)}`);
						process.exit(RESTART_EXIT_CODE);
					}
					// If this fallback fails before ready, the next generation is backendless.
					writeFileSync(transactionFile, JSON.stringify({ previous: null, target: previous.id }), { mode: 0o600 });
					backendReason = undefined;
				}
			} catch (err) {
				backendReason = `candidate failed; previous backend failed: ${String(err)}`;
				validated = null;
				writeActiveBackend(null);
			}
		}
	}
	// Keep the transaction until the listener is ready; fatal startup paths
	// restore the previous selection and request another worker generation.
	if (!activeBackend()) log.warn(`running without a backend: ${backendReason ?? "none configured"}`);

	// Tell the maintenance-gate extension (~/.omp/agent/extensions/maintenance-gate)
	// that every session this server spawns IS a deck-managed org root, regardless
	// of session cwd. Without this, the extension stays inactive in deck sessions
	// because cwd rarely has the flat-file org markers (inbox/, tasks/, knowledge/)
	// that the upstream detector looks for. Routine agent subprocesses inherit
	// this env via Bun.spawn defaults, so a single set here covers both surfaces.
	//
	// Honors NPI_DECK_MAINTENANCE_GATE_DISABLED (set via Settings → Starters):
	// when truthy we don't set the org root, so even an unaltered installed copy
	// of the extension stays inactive. The extension itself also checks the flag.
	const gateDisabledRaw = (process.env.NPI_DECK_MAINTENANCE_GATE_DISABLED ?? "").trim().toLowerCase();
	const gateDisabled = ["1", "true", "yes", "on"].includes(gateDisabledRaw);
	if (!process.env.NPI_DECK_ORG_ROOT && !gateDisabled) {
		process.env.NPI_DECK_ORG_ROOT = resolveKbRoot();
	}

	// Register the deck's `kb://` URI handler on the SDK's process-global
	// router so `read kb://system/foo.md` resolves the same way the user's
	// configured KB root (NPI_DECK_KB_ROOT or ~/kb) is served over REST.
	// MUST run before the first `createAgentSession` — the router is a
	// process singleton consulted by the `read` tool on every call.
	if (activeBackend()) sdk().InternalUrlRouter.instance().register(new KbProtocolHandler());

	openDb({ path: config.dbPath });

	// Initialize pi-tui's global `theme` so tools that reference symbols
	// (e.g. ask -> getDoneOptionLabel -> `theme.status.success`) don't throw
	// "undefined is not an object (evaluating 'theme.status')" when invoked
	// from the deck. `dark` is a built-in theme JSON so no filesystem touch.
	// Without this the `ask` tool fails at the first `askSingleQuestion`
	// call, even though the deck UI doesn't render any SDK glyphs.
	if (activeBackend()) {
		try {
			const { getThemeByName, setThemeInstance } = sdk();
			const darkTheme = await getThemeByName("dark");
			if (darkTheme) setThemeInstance(darkTheme);
		} catch (err) {
			log.warn(`SDK theme init failed; ask tool labels may not render`, err);
		}
	}
	// Only a loaded SDK has an agent directory. Backendless boot must still
	// serve the picker; starter installation is deferred until the next boot.
	if (activeBackend()) {
		await installStarterSkills();
		await installStarterExtensions();
	}

	// Register the default browser notification channel. It broadcasts a
	// `notification` ServerFrame to every connected web client. Future channels
	// (telegram, email, push) self-register here without engine changes.
	notificationService.register(new BrowserNotificationChannel());


	const bridge = new InProcessAgentBridge({
		idleTimeoutMs: config.idleTimeoutMs,
	});
	const routinesRunner = new RoutinesRunner();
	routinesRunner.start();
	let server: Server<ConnectionData>;
	const supervisor = buildDefaultBridgeSupervisor();
	const marketplaceService = new MarketplaceService();
	const skillsService = new SkillsService(config, marketplaceService);
	const kbService = new KbService({ root: resolveKbRoot() });
	const router = buildRouter(
		bridge,
		config,
		routinesRunner,
		supervisor,
		marketplaceService,
		skillsService,
		kbService,
		{ restartServer: () => scheduleRestart(stop) },
	);
	const skillsWatcherDispose = activeBackend() ? startSkillsWatcher(config) : () => {};
	const kbWatcherDispose = startKbWatcher(kbService);
	const workerGeneration = crypto.randomUUID();
	const ws = new WsHub(bridge, workerGeneration);
	let switching = false;
	function status(): BackendStatusResponse {
		const backend = activeBackend();
		const selection = backend?.selection;
		let desired: string | null = null;
		let backends: BackendStatusResponse["backends"] = [];
		let configReason: string | undefined;
		try { desired = readBackendConfig().activeBackend ?? null; backends = listBackends(); }
		catch (err) { configReason = String(err); }
		return {
			workerGeneration,
			running: backend ? { id: selection!.id, path: backend.identity.path, source: selection!.source, version: backend.identity.version, commit: backend.identity.commit } : null,
			validated: validated ? { id: validated.id, ...validated.result.identity, pinned: validated.result.pinned } : null,
			desired,
			pinned: Boolean(process.env.NPI_DECK_BACKEND?.trim()),
			...(backendReason || configReason ? { reason: backendReason ?? configReason } : {}),
			backends,
		};
	}
	async function switchBackend(id: string, force: boolean): Promise<{ code: number; body: BackendSwitchResponse }> {
		if (process.env.NPI_DECK_BACKEND?.trim()) return { code: 409, body: { ok: false, message: "NPI_DECK_BACKEND pins this launch; remove it before switching" } };
		if (switching) return { code: 409, body: { ok: false, message: "backend switch already in progress" } };
		if (!launcherFromEnv()) return { code: 409, body: { ok: false, message: "backend switch requires the npi-deck launcher" } };
		const candidate = listBackends().find(b => b.id === id);
		if (!candidate) return { code: 404, body: { ok: false, message: `unknown backend ${id}` } };
		if (candidate.kind !== "source") return { code: 400, body: { ok: false, message: "gateway backends are reserved and unsupported" } };
		if (activeBackend()?.selection.id === id && !backendReason) return { code: 200, body: { ok: true, message: "backend already running" } };
		switching = true;
		let committed = false;
		try {
			const probe = await preflight(candidate.path);
			if (!probe.ok) return { code: 422, body: { ok: false, message: probe.reason ?? "backend preflight failed" } };
			const previousValidated = validated;
			validated = { id, result: probe };
			workRegistry.closeAdmissions();
			const busy = workRegistry.snapshot();
			if (busy.length && !force) {
				workRegistry.reopenAdmissions();
				validated = previousValidated;
				return { code: 409, body: { ok: false, message: "work in progress; use Force to abort it", busy } };
			}
			try {
				mkdirSync(path.dirname(transactionFile), { recursive: true });
				writeFileSync(transactionFile, JSON.stringify({ previous: readBackendConfig().activeBackend ?? null, target: id }), { mode: 0o600 });
				writeActiveBackend(id);
				committed = true;
			} catch (err) {
				rmSync(transactionFile, { force: true });
				workRegistry.reopenAdmissions();
				validated = previousValidated;
				throw err;
			}
			setTimeout(() => exitAfterShutdown(stop, "backend switch", RESTART_EXIT_CODE), 50);
			return { code: 202, body: { ok: true, message: `switching to ${id}${force ? "; aborting active work" : ""}` } };
		} finally { if (!committed) switching = false; }
	}

	server = Bun.serve<ConnectionData>({
		hostname: config.host,
		port: config.port,
		async fetch(req, srv) {
			const url = new URL(req.url);

			if (url.pathname === "/ws") {
				const data = ws.createConnectionData();
				const upgraded = srv.upgrade(req, { data });
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (url.pathname.startsWith("/api/")) {
				const endpoint = url.pathname.slice(4) || "/";
				if (endpoint === "/backend" && req.method === "GET") {
					try { return Response.json(status()); } catch (err) { return Response.json({ error: String(err) }, { status: 500 }); }
				}
				if (endpoint === "/backend/probe" && req.method === "POST") {
					if (process.env.NPI_DECK_BACKEND?.trim()) return Response.json({ ok: false, reason: "NPI_DECK_BACKEND pins this launch" }, { status: 409 });
					const body = await req.json().catch(() => ({})) as { id?: unknown };
					const candidate = listBackends().find(b => b.id === body.id);
					if (!candidate) return Response.json({ ok: false, reason: "unknown backend" }, { status: 404 });
					if (candidate.kind !== "source") return Response.json({ ok: false, reason: "gateway backends are reserved and unsupported" }, { status: 400 });
					return Response.json(await preflight(candidate.path));
				}
				if (endpoint === "/backend/switch" && req.method === "POST") {
					const body = await req.json().catch(() => ({})) as { id?: unknown; force?: unknown };
					if (typeof body.id !== "string") return Response.json({ ok: false, message: "backend id required" }, { status: 400 });
					try {
						const result = await switchBackend(body.id, body.force === true);
						return Response.json(result.body, { status: result.code });
					} catch (err) { return Response.json({ ok: false, message: String(err) }, { status: 500 }); }
				}
				if (!activeBackend() && (/^\/(sessions|workspaces|models|subagents|advisors|auth\/oauth|bridges|skills|marketplace|slash-commands|fs)(\/|$)/.test(endpoint) || /^\/settings\/(providers|models|auth)(\/|$)/.test(endpoint))) {
					return Response.json({ error: "backend_unavailable", reason: backendReason ?? "no backend configured" }, { status: 503 });
				}
				const trimmed = new URL(req.url);
				trimmed.pathname = endpoint;
				return router.fetch(new Request(trimmed.toString(), req));
			}

			// Pasted-image uploads. The uploads route returns URLs rooted at
			// `/uploads/...` so they work for both browser <img src> and agent-
			// written markdown. Stream the file straight off disk; reject path
			// traversal the same way the SPA static handler does.
			if (url.pathname.startsWith("/uploads/")) {
				return serveUpload(req, config.uploadsRoot);
			}

			// Serve built web assets if a dist directory is available; otherwise
			// fall back to the landing stub. Vite dev server proxies through us
			// for /api and /ws, so its own routes never reach this branch.
			if (config.webDist) {
				return serveStatic(req, config.webDist);
			}

			if (url.pathname === "/" || url.pathname === "/index.html") {
				return new Response(LANDING_HTML, {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}

			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(socket: ServerWebSocket<ConnectionData>) {
				ws.onOpen(socket);
			},
			async message(socket: ServerWebSocket<ConnectionData>, raw) {
				await ws.onMessage(socket, raw as string | Buffer);
			},
			close(socket: ServerWebSocket<ConnectionData>) {
				ws.onClose(socket);
			},
			perMessageDeflate: false,
		},
	});

	log.info(`listening on http://${server.hostname}:${server.port}`);
	if (bootDeadline) clearTimeout(bootDeadline);
	if (pending) rmSync(transactionFile, { force: true });

	let stopping: Promise<void> | undefined;
	function stop(reason = "stop"): Promise<void> {
		stopping ??= shutdown(reason);
		return stopping;
	}
	// Order (R23): close admissions, stop the listener, drain work, reap owned
	// processes, then release the SDK and the db.
	async function shutdown(reason: string): Promise<void> {
		log.info(`shutdown via ${reason}`);
		const steps: Array<[string, () => unknown]> = [
			["work admissions close", () => workRegistry.closeAdmissions()],
			["runner close admissions", () => routinesRunner.closeAdmissions()],
			["listener stop", () => server.stop(true)],
			["oauth flows abort", () => abortOAuthFlows()],
			["skills watcher dispose", () => skillsWatcherDispose()],
			["kb watcher dispose", () => kbWatcherDispose()],
			["runner dispose", () => routinesRunner.dispose()],
			["owned processes stop", () => stopOwnedProcesses()],
			["bridge supervisor shutdown", () => supervisor.shutdown()],
			["bridge dispose", () => bridge.dispose()],
			["db close", () => closeDb()],
		];
		for (const [name, step] of steps) {
			try {
				await step();
			} catch (err) {
				log.error(`${name} threw`, err);
			}
		}
	}

	if (opts.handleSignals !== false) {
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			process.once(signal, () => {
				void stop(signal).then(() => process.exit(0));
			});
		}
	}

	// A lost launcher cannot stop a hung worker's systemd unit.
	const launcher = launcherFromEnv();
	if (launcher) {
		watchLauncher(launcher, () => {
			log.warn(`launcher pid ${launcher.pid} is gone; shutting down`);
			exitAfterShutdown(stop, "launcher gone", 0, 1);
		});
	}

	return { url: `http://${server.hostname}:${server.port}`, stop };
}

/** A blocked SDK/routine teardown must never strand the current worker generation. */
function exitAfterShutdown(stop: (reason: string) => Promise<void>, reason: string, exitCode: number, forcedExitCode = exitCode): void {
	const deadline = setTimeout(() => {
		log.error(`${reason} shutdown exceeded ${SHUTDOWN_DEADLINE_MS}ms; forcing worker exit`);
		process.exit(forcedExitCode);
	}, SHUTDOWN_DEADLINE_MS);
	void stop(reason).then(
		() => { clearTimeout(deadline); process.exit(exitCode); },
		(error) => { clearTimeout(deadline); log.error(`${reason} shutdown failed`, error); process.exit(1); },
	);
}

/**
 * A restart is the process exiting with the reserved status; the launcher's
 * supervisor (systemd `RestartForceExitStatus`, or the `--no-systemd` loop)
 * starts the next generation. Without a launcher there is nobody to do that.
 */
function scheduleRestart(stop: (reason: string) => Promise<void>): RestartServerResponse {
	if (!launcherFromEnv()) {
		return { ok: false, message: "Restart needs the npi-deck launcher; this server was started directly. Restart it yourself." };
	}
	setTimeout(() => {
		log.info(`restart requested; exiting with ${RESTART_EXIT_CODE}`);
		exitAfterShutdown(stop, "restart", RESTART_EXIT_CODE);
	}, 100);
	return { ok: true, message: "Restart scheduled" };
}

const LANDING_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>npi-deck server</title>
<style>body{font-family:system-ui;max-width:48em;margin:4em auto;padding:0 1em;color:#e6edf3;background:#0d1117}code{background:#161b22;padding:.1em .4em;border-radius:.3em}a{color:#58a6ff}</style>
</head><body>
<h1>npi-deck server</h1>
<p>Backend is running. The browser UI is served by the <code>@npi-deck/web</code> Vite dev server (typically <a href="http://127.0.0.1:5173">http://127.0.0.1:5173</a> in dev), or the built static assets in production.</p>
<p>API base: <code>/api</code> &nbsp;&nbsp; WebSocket: <code>/ws</code></p>
</body></html>`;

async function serveStatic(req: Request, root: string): Promise<Response> {
	const url = new URL(req.url);
	let rel = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
	if (rel === "" || rel === "index.html") rel = "index.html";

	// Reject path traversal.
	if (rel.includes("..")) return new Response("forbidden", { status: 403 });

	const full = path.join(root, rel);
	const resolved = path.resolve(full);
	const rootResolved = path.resolve(root);
	if (!resolved.startsWith(rootResolved)) {
		return new Response("forbidden", { status: 403 });
	}

	const direct = Bun.file(resolved);
	if (await direct.exists()) {
		return new Response(direct);
	}

	// SPA fallback — serve index.html so client-side routing works.
	const index = Bun.file(path.join(rootResolved, "index.html"));
	if (await index.exists()) {
		return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
	}
	return new Response("not found", { status: 404 });
}
