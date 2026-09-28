import { createHash } from "node:crypto";
import * as path from "node:path";
import { Hono } from "hono";
import { feature, sdk } from "./backend/runtime.ts";
import type { AgentBridge } from "./bridge/types.ts";
import { logger } from "./log.ts";
import { spawnOwnedSync } from "./owned-process.ts";

const log = logger("routes:advisors");
type AdvisorSdk = ReturnType<typeof feature<"advisors">>;
type Doc = Awaited<ReturnType<AdvisorSdk["loadWatchdogConfigFile"]>>;
type Discovered = Awaited<ReturnType<AdvisorSdk["discoverAdvisorConfigs"]>>;
type AdvisorSession = {
	cwd: string;
	advisorStatus(): unknown;
	/** Run exactly `names` for this live session; the roster files are untouched. */
	selectAdvisors(names: readonly string[], config: Discovered): void;
	/** Apply a rediscovered roster, keeping the session's selection. */
	applyAdvisorConfigs(config: Discovered): void;
};
type AdvisorBridge = AgentBridge & { advisorSession(id: string): AdvisorSession | undefined; liveAdvisorSessions(): AdvisorSession[] };
const WATCHDOG_NAMES = ["WATCHDOG.yml", "WATCHDOG.yaml"];
const digest = (value: string | null) => createHash("sha256").update(value === null ? "missing\0" : `present\0${value}`).digest("hex");
const errorText = (err: unknown) => err instanceof Error ? err.message : String(err);

async function fileSnapshot(file: string): Promise<{ hash: string; text: string | null }> {
	const entry = Bun.file(file);
	const text = await entry.exists() ? await entry.text() : null;
	return { hash: digest(text), text };
}

// NeoPi's TUI edits the VCS root, falling back to cwd. Avoid accepting arbitrary
// file paths from the browser: the scope and cwd select a discovered destination.
function projectRoot(cwd: string): string {
	const result = spawnOwnedSync(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" });
	return result.exitCode === 0 ? result.stdout.toString().trim() || cwd : cwd;
}
function directories(cwd: string): { projectDir: string; agentDir: string } {
	return { projectDir: projectRoot(cwd), agentDir: sdk().getAgentDir() };
}
async function scopeDoc(api: AdvisorSdk, scope: "user" | "project", cwd: string) {
	const file = await api.resolveAdvisorConfigEditPath(scope, directories(cwd));
	const snapshot = await fileSnapshot(file);
	return { file, hash: snapshot.hash, doc: await api.loadWatchdogConfigFile(file) };
}
async function discovery(api: AdvisorSdk, cwd: string) {
	const agentDir = sdk().getAgentDir();
	const merged = await api.discoverAdvisorConfigs(cwd, agentDir);
	const sources = new Map<string, string>();
	// Follow the same ordered user→project ancestor→leaf candidate walk as NeoPi;
	// never infer provenance from the merged advisor, which has none.
	const candidates = await api.collectConfigCandidates(cwd, agentDir, WATCHDOG_NAMES);
	for (const candidate of candidates) {
		const document = await api.loadWatchdogConfigFile(candidate.path);
		for (const advisor of document.advisors) sources.set(api.slugifyAdvisorName(advisor.name), candidate.path);
	}
	return { ...merged, advisors: merged.advisors.map((advisor) => ({ ...advisor, source: sources.get(api.slugifyAdvisorName(advisor.name)) ?? null })) };
}

// Serialize WATCHDOG compare-and-save, enabled toggles and session roster
// selection across browser editors in this process, so each applies against
// the roster the previous one wrote. The final re-read also catches external
// edits; NeoPi owns YAML serialization.
let saveQueue: Promise<void> = Promise.resolve();
function serialize<T>(run: () => Promise<T>): Promise<T> {
	const result = saveQueue.then(run);
	saveQueue = result.then(() => {}, () => {});
	return result;
}
function validDoc(value: unknown): value is Doc {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const doc = value as Record<string, unknown>;
	if (!Array.isArray(doc.advisors) || (doc.instructions !== undefined && typeof doc.instructions !== "string") ||
		(doc.maxNotesPerUpdate !== undefined && (!Number.isInteger(doc.maxNotesPerUpdate) || (doc.maxNotesPerUpdate as number) < 1))) return false;
	return doc.advisors.every((entry: unknown) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
		const a = entry as Record<string, unknown>;
		return typeof a.name === "string" && !!a.name.trim() &&
			["model", "instructions", "systemPrompt"].every(k => a[k] === undefined || typeof a[k] === "string") &&
			(a.enabled === undefined || typeof a.enabled === "boolean") &&
			(a.tools === undefined || (Array.isArray(a.tools) && a.tools.every((tool: unknown) => typeof tool === "string"))) &&
			(a.maxNotesPerUpdate === undefined || (Number.isInteger(a.maxNotesPerUpdate) && (a.maxNotesPerUpdate as number) >= 1));
	});
}


export function buildAdvisorsRouter(bridge: AgentBridge, config: import("./config.ts").Config): Hono {
	const app = new Hono();
	const sessions = bridge as AdvisorBridge;
	const cwdFor = async (cwd: string | undefined) => {
		const saved = await bridge.listSessions({});
		const allowed = new Set([config.defaultCwd, ...config.extraWorkspaces, ...saved.map(s => s.cwd), ...sessions.liveAdvisorSessions().map(s => s.cwd)]);
		return cwd ? allowed.has(cwd) ? cwd : undefined : config.defaultCwd;
	};

	app.get("/advisors", async c => {
		try {
			const cwd = await cwdFor(c.req.query("cwd"));
			if (!cwd) return c.json({ error: "unknown project workspace" }, 400);
			const api = feature("advisors");
			const [user, project, merged] = await Promise.all([scopeDoc(api, "user", cwd), scopeDoc(api, "project", cwd), discovery(api, cwd)]);
			const settings = await sdk().Settings.loadReadOnly({ cwd, agentDir: sdk().getAgentDir() });
			return c.json({ cwd, user, project, merged, settings: {
				enabled: api.cfgAdvisorEnabled.get(settings), syncBacklog: api.cfgAdvisorSyncBacklog.get(settings),
				maxNotesPerUpdate: api.cfgAdvisorMaxNotesPerUpdate.get(settings),
				evictStaleResults: api.cfgAdvisorEvictStaleResults.get(settings),
				model: sdk().cfgModelRoles.get(settings).advisor ?? "",
			} });
		} catch (err) { log.warn("read advisor config failed", err); return c.json({ error: errorText(err) }, 500); }
	});

	app.put("/advisors/watchdog", async c => {
		try {
			const body = await c.req.json() as { cwd?: string; scope?: string; hash?: string; doc?: unknown };
			const cwd = await cwdFor(body.cwd);
			if (!cwd || !["user", "project"].includes(body.scope ?? "") || typeof body.hash !== "string" || !validDoc(body.doc))
				return c.json({ error: "known workspace, scope, hash and WATCHDOG document required" }, 400);
			return await serialize(async () => {
				const api = feature("advisors");
				const current = await scopeDoc(api, body.scope as "user" | "project", cwd);
				if (current.hash !== body.hash) return c.json({ error: "WATCHDOG file changed; reload before saving", current }, 409);
				if (current.doc.warnings?.length) return c.json({ error: "WATCHDOG contains malformed entries; repair the file before editing", current }, 409);
				await api.saveWatchdogConfigFile(current.file, body.doc as Doc);
				await applyToSessions(sessions, api, cwd);
				return c.json({ saved: await scopeDoc(api, body.scope as "user" | "project", cwd), merged: await discovery(api, cwd) });
			});
		} catch (err) { log.warn("save watchdog failed", err); return c.json({ error: errorText(err) }, 500); }
	});

	// Flip one advisor's `enabled:` in the WATCHDOG file its effective entry
	// comes from (discovery is last-wins by slug), editing the loaded document
	// so NeoPi's patch-save keeps comments and every other field.
	app.patch("/advisors/watchdog/enabled", async c => {
		try {
			const body = await c.req.json() as { cwd?: string; name?: unknown; enabled?: unknown };
			const cwd = await cwdFor(body.cwd);
			if (!cwd || typeof body.name !== "string" || !body.name.trim() || typeof body.enabled !== "boolean")
				return c.json({ error: "known workspace, advisor name and boolean enabled required" }, 400);
			const name = body.name;
			const enabled = body.enabled;
			return await serialize(async () => {
				const api = feature("advisors");
				const slug = api.slugifyAdvisorName(name);
				let source: { file: string; doc: Doc; index: number } | undefined;
				for (const candidate of await api.collectConfigCandidates(cwd, sdk().getAgentDir(), WATCHDOG_NAMES)) {
					const doc = await api.loadWatchdogConfigFile(candidate.path);
					const index = doc.advisors.findLastIndex(advisor => api.slugifyAdvisorName(advisor.name) === slug);
					if (index >= 0) source = { file: candidate.path, doc, index };
				}
				if (!source) return c.json({ error: `advisor ${JSON.stringify(name)} is not in this workspace's roster` }, 404);
				if (source.doc.warnings?.length) return c.json({ error: `${source.file} contains malformed entries; repair the file before editing` }, 409);
				source.doc.advisors[source.index] = { ...source.doc.advisors[source.index]!, enabled };
				await api.saveWatchdogConfigFile(source.file, source.doc);
				// A user or ancestor file can feed sessions outside this project.
				await applyToSessions(sessions, api);
				return c.json({ file: source.file, merged: await discovery(api, cwd) });
			});
		} catch (err) { log.warn("toggle watchdog advisor failed", err); return c.json({ error: errorText(err) }, 500); }
	});

	app.patch("/advisors/settings", async c => {
		try {
			const body = await c.req.json() as { cwd?: string; enabled?: boolean; syncBacklog?: string; maxNotesPerUpdate?: number; evictStaleResults?: boolean; model?: string };
			const cwd = await cwdFor(body.cwd);
			if (!cwd || (body.enabled !== undefined && typeof body.enabled !== "boolean") ||
				(body.syncBacklog !== undefined && !["off", "1", "3", "5"].includes(body.syncBacklog)) ||
				(body.maxNotesPerUpdate !== undefined && (!Number.isInteger(body.maxNotesPerUpdate) || body.maxNotesPerUpdate < 1 || body.maxNotesPerUpdate > 32)) ||
				(body.evictStaleResults !== undefined && typeof body.evictStaleResults !== "boolean") ||
				(body.model !== undefined && typeof body.model !== "string")) return c.json({ error: "invalid advisor settings" }, 400);
			const api = feature("advisors");
			const settings = await sdk().Settings.loadIsolated({ cwd, agentDir: sdk().getAgentDir() });
			if (body.enabled !== undefined) api.cfgAdvisorEnabled.set(settings, body.enabled);
			if (body.syncBacklog !== undefined) api.cfgAdvisorSyncBacklog.set(settings, body.syncBacklog as "off" | "1" | "3" | "5");
			if (body.maxNotesPerUpdate !== undefined) api.cfgAdvisorMaxNotesPerUpdate.set(settings, body.maxNotesPerUpdate);
			if (body.evictStaleResults !== undefined) api.cfgAdvisorEvictStaleResults.set(settings, body.evictStaleResults);
			if (body.model !== undefined) settings.setModelRole("advisor", body.model.trim() || undefined);
			await settings.flush();
			// Reload the persisted layer on each independent live settings instance.
			// NeoPi fires its effective modelRoles change hook on reload, retargeting
			// the live role without queuing a second write to config.yml.
			await bridge.reloadLiveSettings();
			await applyToSessions(sessions, feature("advisors"));
			return c.json({ ok: true });
		} catch (err) { log.warn("save advisor settings failed", err); return c.json({ error: errorText(err) }, 409); }
	});

	app.get("/sessions/:id/advisors", c => {
		const session = sessions.advisorSession(c.req.param("id"));
		return session ? c.json(session.advisorStatus()) : c.json({ error: "live session not found" }, 404);
	});
	// The roster a chat can choose from: this session's discovered WATCHDOG
	// advisors, with each entry's own `enabled` key as written.
	app.get("/sessions/:id/advisors/roster", async c => {
		const session = sessions.advisorSession(c.req.param("id"));
		if (!session) return c.json({ error: "live session not found" }, 404);
		try {
			const merged = await discovery(feature("advisors"), session.cwd);
			return c.json({
				advisors: merged.advisors.map(({ name, model, enabled, source }) => ({ name, model, enabled, source })),
				warnings: merged.warnings,
			});
		} catch (err) { log.warn("read session advisor roster failed", err); return c.json({ error: errorText(err) }, 500); }
	});
	app.put("/sessions/:id/advisors", async c => {
		const session = sessions.advisorSession(c.req.param("id"));
		if (!session) return c.json({ error: "live session not found" }, 404);
		const body = await c.req.json().catch(() => ({})) as { advisors?: unknown };
		const names = body.advisors;
		if (!Array.isArray(names) || !names.every((name): name is string => typeof name === "string"))
			return c.json({ error: "advisors must be an array of roster advisor names" }, 400);
		try {
			return await serialize(async () => {
				const discovered = await feature("advisors").discoverAdvisorConfigs(session.cwd, sdk().getAgentDir());
				const known = new Set(discovered.advisors.map(advisor => advisor.name));
				const unknown = names.filter(name => !known.has(name));
				if (unknown.length) return c.json({ error: `not in this session's roster: ${unknown.join(", ")}` }, 400);
				session.selectAdvisors(names, discovered);
				return c.json(session.advisorStatus());
			});
		} catch (err) { log.warn("select session advisors failed", err); return c.json({ error: errorText(err) }, 500); }
	});
	return app;
}

async function applyToSessions(bridge: AdvisorBridge, api: AdvisorSdk, cwd?: string) {
	for (const session of bridge.liveAdvisorSessions()) {
		if (cwd && path.resolve(projectRoot(session.cwd)) !== path.resolve(projectRoot(cwd))) continue;
		session.applyAdvisorConfigs(await api.discoverAdvisorConfigs(session.cwd, sdk().getAgentDir()));
	}
}
