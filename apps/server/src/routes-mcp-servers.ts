import * as path from "node:path";
import { Hono, type Context } from "hono";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type {
	McpArg,
	McpArgInput,
	McpDisabledReason,
	McpKeyRef,
	McpKeyValueInput,
	McpLiveApply,
	McpServerCreateRequest,
	McpServerEnabledRequest,
	McpServerMutationResponse,
	McpServerRow,
	McpServerScope,
	McpServerTargetRequest,
	McpServersResponse,
	McpServerWriteRequest,
	McpTransport,
} from "@npi-deck/protocol";

import { feature, sdk } from "./backend/runtime.ts";
import type { AgentBridge } from "./bridge/types.ts";
import type { Config } from "./config.ts";
import { logger } from "./log.ts";

const log = logger("routes:mcp-servers");
// A JSON parse failure quotes the offending text, which can be a header or env
// value. Clients get this sentence; the deck log keeps the real error.
const LOAD_FAILED = "NeoPi could not read the MCP configuration; the deck server log has the details.";
const WRITE_FAILED = "NeoPi could not save the MCP configuration; the deck server log has the details.";

/**
 * A flag whose argument is a credential. Used only to decide what to hide;
 * anything it misses is still safe, because values the deck shows are limited
 * to arguments and URLs the user typed, and env/header values are never sent.
 */
const SECRET_FLAG = /(key|token|secret|password|passwd|credential|auth|cookie|session|bearer|pat)/i;
const REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

/** Names and set-state only: any env or header value can be a credential, so none is sent. */
function keyRefs(record: Record<string, string> | undefined): McpKeyRef[] {
	return Object.entries(record ?? {}).map(([key, value]) => ({ key, set: typeof value === "string" && value !== "" }));
}

/**
 * Arguments as a client may show them. `--api-key X` and `--api-key=X` keep the
 * flag and drop the value; an argument that is only a secret (the one after the
 * flag) shows nothing else. Any argument carrying a URL also loses that URL's
 * userinfo and query values, so a connection string under an innocuous flag
 * (`--db=postgres://user:pw@host/db`) is not echoed either.
 */
function redactArgs(args: readonly string[] | undefined): McpArg[] {
	const out: McpArg[] = [];
	let valueOfSecretFlag = false;
	for (const raw of args ?? []) {
		const arg = String(raw);
		if (valueOfSecretFlag) {
			valueOfSecretFlag = false;
			out.push({ display: REDACTED, redacted: true });
			continue;
		}
		const equals = arg.indexOf("=");
		const flagged = arg.startsWith("-") && equals > 0 && SECRET_FLAG.test(arg.slice(0, equals));
		if (flagged) {
			out.push({ display: `${arg.slice(0, equals)}=${REDACTED}`, redacted: true });
			continue;
		}
		if (arg.startsWith("-") && equals === -1 && SECRET_FLAG.test(arg)) valueOfSecretFlag = true;
		// `--db=postgres://…`, or a bare URL argument.
		const prefix = equals > 0 ? arg.slice(0, equals + 1) : "";
		const rest = arg.slice(prefix.length);
		if (rest.includes("://")) {
			const url = redactUrl(rest);
			if (url.redacted) {
				out.push({ display: `${prefix}${url.display}`, redacted: true });
				continue;
			}
		}
		out.push({ display: arg, redacted: false });
	}
	return out;
}

/** A URL without its userinfo or query values; both routinely carry tokens. */
function redactUrl(raw: string): { display: string; redacted: boolean } {
	let url: URL;
	try { url = new URL(raw); }
	// Not a URL NeoPi can connect to either; show nothing rather than guess where a secret sits.
	catch { return { display: REDACTED, redacted: true }; }
	let redacted = false;
	if (url.username !== "" || url.password !== "") {
		url.username = REDACTED;
		url.password = "";
		redacted = true;
	}
	for (const key of [...url.searchParams.keys()]) {
		url.searchParams.set(key, REDACTED);
		redacted = true;
	}
	return { display: decodeURI(url.toString()), redacted };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

class RequestError extends Error {
	constructor(message: string, readonly status: 400 | 404 | 409) {
		super(message);
	}
}

/** One MCP config write at a time from this process; NeoPi's own file lock guards other writers. */
let saveQueue: Promise<void> = Promise.resolve();
function serializeSave<T>(run: () => Promise<T>): Promise<T> {
	const result = saveQueue.then(run);
	saveQueue = result.then(() => {}, () => {});
	return result;
}

/**
 * Config files NeoPi's own writer owns, per scope. The deck never rewrites a
 * foreign tool's file (opencode.json, .claude.json …); those rows toggle
 * through the user-level deny and force-enable lists instead.
 */
function writableTargets(cwd: string): Record<McpServerScope, string[]> {
	const mcp = feature("mcp-servers");
	const userPath = mcp.getMCPConfigPath("user", cwd);
	const projectPath = mcp.getMCPConfigPath("project", cwd);
	return {
		user: [userPath, path.join(path.dirname(userPath), ".mcp.json")],
		// NeoPi's `mcp-json` provider also reads a bare mcp.json in the project
		// root; an edit there must land in that file rather than create a
		// shadowing `.omp` entry.
		project: [
			projectPath,
			path.join(path.dirname(projectPath), ".mcp.json"),
			path.join(cwd, "mcp.json"),
			path.join(cwd, ".mcp.json"),
		],
	};
}

/** The file a mutation writes: the row's own file when NeoPi's writer owns it, else the scope's canonical mcp.json. */
function targetFile(cwd: string, target: McpServerTargetRequest): string {
	const targets = writableTargets(cwd);
	const allowed = targets[target.scope];
	if (target.sourcePath === undefined) return allowed[0]!;
	const resolved = path.resolve(target.sourcePath);
	if (allowed.includes(resolved)) return resolved;
	const other = target.scope === "user" ? targets.project : targets.user;
	if (other.includes(resolved)) throw new RequestError(`${resolved} is not a ${target.scope}-scope MCP config file`, 400);
	throw new RequestError("That MCP config file is not one NeoPi's writer owns; edit it where it lives.", 400);
}

/** The scope of a discovered row's file, when the deck may rewrite it. */
function writableSource(cwd: string, sourcePath: string): McpServerScope | undefined {
	const targets = writableTargets(cwd);
	if (targets.user.includes(sourcePath)) return "user";
	if (targets.project.includes(sourcePath)) return "project";
	return undefined;
}

function transportOf(server: Pick<MCPServer, "transport" | "command" | "url">): McpTransport {
	return server.transport ?? (server.command ? "stdio" : server.url ? "http" : "stdio");
}

/**
 * Every MCP server NeoPi discovers, enabled or not, with the state and reason
 * NeoPi's own `/mcp list` and extension dashboard report.
 */
async function listServers(cwd: string): Promise<McpServersResponse> {
	const mcp = feature("mcp-servers");
	const core = sdk();
	// NeoPi's discovery reads through a process-lifetime file cache, so an edit
	// made in a terminal (or by another deck route) would otherwise never show
	// up. `/mcp reload` clears it for the same reason.
	mcp.clearFsCache();
	const userConfigPath = mcp.getMCPConfigPath("user", cwd);
	const projectConfigPath = mcp.getMCPConfigPath("project", cwd);
	const settings = await core.Settings.loadReadOnly({ cwd, agentDir: core.getAgentDir() });
	const disabledExtensions = [...mcp.cfgDisabledExtensions.get(settings)];
	const disabledIds = new Set(disabledExtensions);
	const [denied, forced] = await Promise.all([
		mcp.readDisabledServers(userConfigPath).then(list => new Set(list)),
		mcp.readEnabledServers(userConfigPath).then(list => new Set(list)),
	]);
	const loaded = await core.loadCapability<MCPServer>(mcp.mcpCapability.id, {
		cwd,
		// Disabled and shadowed rows are listed too; NeoPi marks them rather
		// than letting them hide a same-named server that does run.
		includeDisabled: true,
		disabledExtensions,
	});

	const servers = loaded.all.map((server): McpServerRow => {
		const source = server._source;
		const shadowed = (server as { _shadowed?: boolean })._shadowed === true;
		const forceEnabled = forced.has(server.name);
		let state: McpServerRow["state"] = "enabled";
		let disabledReason: McpDisabledReason | undefined;
		if (denied.has(server.name)) { state = "disabled"; disabledReason = "denylisted"; }
		else if (disabledIds.has(`mcp:${server.name}`)) { state = "disabled"; disabledReason = "extension-disabled"; }
		else if (server.enabled === false && !forceEnabled) { state = "disabled"; disabledReason = "config-flag"; }
		else if (shadowed) { state = "shadowed"; disabledReason = "shadowed"; }
		else if (!mcp.isProviderEnabled(source.provider)) { state = "disabled"; disabledReason = "provider-disabled"; }
		// A `claude-plugins` row from NeoPi's own marketplace root is native, not the opt-in ~/.claude tree.
		else if (source.provider === "claude-plugins" && source.origin !== undefined && source.origin !== "claude") { /* runs */ }
		else if (source.level === "user" && !mcp.isUserSourceEnabled(source.provider)) { state = "disabled"; disabledReason = "user-opt-in"; }

		const scope = writableSource(cwd, source.path);
		const transport = transportOf(server);
		const url = transport === "stdio" || server.url === undefined ? undefined : redactUrl(server.url);
		return {
			name: server.name,
			transport,
			...(transport === "stdio"
				? {
						...(server.command !== undefined ? { command: server.command } : {}),
						...(server.args !== undefined ? { args: redactArgs(server.args) } : {}),
						...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
					}
				: { ...(url !== undefined ? { url: url.display, ...(url.redacted ? { urlRedacted: true } : {}) } : {}) }),
			env: keyRefs(server.env),
			headers: keyRefs(server.headers),
			...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
			sourcePath: source.path,
			level: source.level,
			provider: source.provider,
			providerName: source.providerName,
			editable: scope !== undefined,
			...(scope !== undefined ? { scope } : {}),
			state,
			...(disabledReason !== undefined ? { disabledReason } : {}),
			forceEnabled,
		};
	});
	servers.sort((a, b) => a.name.localeCompare(b.name) || a.sourcePath.localeCompare(b.sourcePath));

	return {
		cwd,
		userConfigPath,
		projectConfigPath,
		projectConfigEnabled: mcp.cfgMcpEnableProjectConfig.get(settings),
		servers,
		warnings: loaded.warnings,
	};
}

/**
 * The row for `name` after a write: the file written when it still defines the
 * server, else whichever definition NeoPi now resolves — never a shadowed
 * loser, which would misreport both the state and what the live chats run.
 */
async function rowFor(cwd: string, name: string, file: string): Promise<McpServerRow | null> {
	const { servers } = await listServers(cwd);
	const named = servers.filter(row => row.name === name);
	return named.find(row => row.sourcePath === file)
		?? named.find(row => row.state !== "shadowed")
		?? named[0]
		?? null;
}

function parseEntries(entries: unknown, field: string): McpKeyValueInput[] {
	if (!Array.isArray(entries)) throw new RequestError(`${field} must be an array of {key, value} entries`, 400);
	const seen = new Set<string>();
	return entries.map(entry => {
		if (!isRecord(entry) || typeof entry.key !== "string") throw new RequestError(`${field} entries need a string key`, 400);
		const key = entry.key.trim();
		if (!key || /[\s=]/.test(key)) throw new RequestError(`an ${field} key is empty or contains a space or '='`, 400);
		if (seen.has(key)) throw new RequestError(`${field} names ${JSON.stringify(key)} twice`, 400);
		seen.add(key);
		if (entry.value !== null && typeof entry.value !== "string") {
			throw new RequestError(`${field} value for ${JSON.stringify(key)} must be a string, or null to keep the stored value`, 400);
		}
		return { key, value: entry.value as string | null };
	});
}

/**
 * Submitted entries resolved against what the file already holds: a null value
 * means "keep the stored one", which is how a masked secret survives an edit
 * without ever being sent to a client.
 */
function mergeEntries(
	entries: McpKeyValueInput[],
	existing: Record<string, string> | undefined,
	field: string,
): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const { key, value } of entries) {
		if (value !== null) { out[key] = value; continue; }
		const stored = existing?.[key];
		if (stored === undefined) throw new RequestError(`${field} entry ${JSON.stringify(key)} has no stored value to keep; type one`, 400);
		out[key] = stored;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** An argument that is a credential only because a `--api-key`-shaped flag precedes it. */
function isSecretFlag(arg: string | undefined): boolean {
	return arg !== undefined && arg.startsWith("-") && !arg.includes("=") && SECRET_FLAG.test(arg);
}

/**
 * Submitted arguments resolved against the stored list: `{keepIndex}` keeps the
 * argument at that position, which is how a redacted credential survives an
 * edit — including one that reorders or drops other arguments. An omitted list
 * keeps the stored one.
 *
 * A kept argument that is hidden only because its flag precedes it must stay
 * behind such a flag; otherwise the next listing would show a value the file
 * had kept hidden. Replacing it means typing a new one.
 */
function mergeArgs(args: McpArgInput[] | undefined, stored: readonly string[] | undefined): string[] | undefined {
	if (args === undefined) return stored === undefined ? undefined : [...stored];
	if (!Array.isArray(args)) throw new RequestError("args must be an array of strings or {keepIndex} entries", 400);
	const hidden = redactArgs(stored);
	const out: string[] = [];
	for (const arg of args) {
		if (typeof arg === "string") { out.push(arg); continue; }
		if (!isRecord(arg) || typeof arg.keepIndex !== "number" || !Number.isInteger(arg.keepIndex)) {
			throw new RequestError("args must be an array of strings or {keepIndex} entries", 400);
		}
		const kept = stored?.[arg.keepIndex];
		if (typeof kept !== "string") throw new RequestError(`args keepIndex ${arg.keepIndex} has no stored argument; type one`, 400);
		const behindFlag = hidden[arg.keepIndex]?.redacted === true && isSecretFlag(stored?.[arg.keepIndex - 1]);
		if (behindFlag && !isSecretFlag(out[out.length - 1])) {
			throw new RequestError(`args keepIndex ${arg.keepIndex} is a credential; keep it directly after its flag, or type a new value`, 400);
		}
		out.push(kept);
	}
	return out.length > 0 ? out : undefined;
}

/**
 * The entry to write: the editor's fields over everything else NeoPi stores for
 * this server (auth, oauth, policies, enabled flag). An omitted `env`,
 * `headers`, `args` or `cwd` keeps what the file has; send an empty array to
 * clear one.
 */
function buildConfig(name: string, body: McpServerWriteRequest, existing: MCPServerConfig | undefined): MCPServerConfig {
	if (body.transport !== "stdio" && body.transport !== "http" && body.transport !== "sse") {
		throw new RequestError("transport must be stdio, http or sse", 400);
	}
	const prior = existing as Record<string, unknown> | undefined;
	const config: Record<string, unknown> = { ...(prior ?? {}) };
	for (const key of ["command", "args", "cwd", "env", "url", "headers"]) delete config[key];
	config.type = body.transport;

	if (body.transport === "stdio") {
		if (body.headers !== undefined && parseEntries(body.headers, "headers").length > 0) {
			throw new RequestError("headers apply to http and sse servers only", 400);
		}
		if (typeof body.command !== "string" || body.command.trim() === "") {
			throw new RequestError(`Server "${name}": stdio server requires "command" field`, 400);
		}
		config.command = body.command.trim();
		const args = mergeArgs(body.args, prior?.args as string[] | undefined);
		if (args !== undefined) config.args = args;
		if (body.cwd === undefined) {
			if (prior?.cwd !== undefined) config.cwd = prior.cwd;
		} else if (typeof body.cwd === "string" && body.cwd.trim() !== "") {
			config.cwd = body.cwd.trim();
		}
		const priorEnv = prior?.env as Record<string, string> | undefined;
		const env = body.env === undefined ? priorEnv : mergeEntries(parseEntries(body.env, "env"), priorEnv, "env");
		if (env !== undefined) config.env = env;
	} else {
		if (body.env !== undefined && parseEntries(body.env, "env").length > 0) {
			throw new RequestError("env applies to stdio servers only", 400);
		}
		if (body.url === null) {
			// The stored URL carries credentials the client never saw; keep it whole.
			const stored = prior?.url;
			if (typeof stored !== "string" || stored.trim() === "") {
				throw new RequestError(`Server "${name}": there is no stored URL to keep; type one`, 400);
			}
			config.url = stored;
		} else if (typeof body.url !== "string" || body.url.trim() === "") {
			throw new RequestError(`Server "${name}": ${body.transport} server requires "url" field`, 400);
		} else {
			config.url = body.url.trim();
		}
		const priorHeaders = prior?.headers as Record<string, string> | undefined;
		const headers = body.headers === undefined
			? priorHeaders
			: mergeEntries(parseEntries(body.headers, "headers"), priorHeaders, "headers");
		if (headers !== undefined) config.headers = headers;
	}

	if (body.timeout === null) delete config.timeout;
	else if (body.timeout !== undefined) {
		if (typeof body.timeout !== "number" || !Number.isFinite(body.timeout) || body.timeout < 0) {
			throw new RequestError("timeout must be a number of milliseconds, or null to remove it", 400);
		}
		config.timeout = body.timeout;
	}

	// NeoPi's own field rules, so the deck rejects exactly what its writer would.
	const entry = config as unknown as MCPServerConfig;
	const errors = feature("mcp-servers").validateServerConfig(name, entry);
	if (errors.length > 0) throw new RequestError(errors.join("; "), 400);
	return entry;
}

function requireName(raw: string | undefined): string {
	const name = (raw ?? "").trim();
	const error = feature("mcp-servers").validateServerName(name);
	if (error) throw new RequestError(error, 400);
	return name;
}

function requireTarget(body: unknown): McpServerTargetRequest {
	if (!isRecord(body)) throw new RequestError("JSON body required", 400);
	if (body.scope !== "user" && body.scope !== "project") throw new RequestError('scope must be "user" or "project"', 400);
	if (body.sourcePath !== undefined && typeof body.sourcePath !== "string") throw new RequestError("sourcePath must be a string", 400);
	return { scope: body.scope, ...(typeof body.sourcePath === "string" ? { sourcePath: body.sourcePath } : {}) };
}

/**
 * Reconcile one server with the config now on disk in every live chat.
 * `connect` drops any existing connection first, so an edited command or URL
 * cannot leave the previous process attached.
 */
async function reconcileLive(bridge: AgentBridge, name: string, connect: boolean): Promise<McpLiveApply[]> {
	return Promise.all(bridge.liveMcpSessions().map(async (live): Promise<McpLiveApply> => {
		try {
			if (connect) await live.apply(name, false);
			const outcome = await live.apply(name, connect);
			if (outcome === "no-mcp-runtime") return { sessionId: live.sessionId, cwd: live.cwd, outcome };
			return { sessionId: live.sessionId, cwd: live.cwd, outcome, status: live.status(name) ?? "disconnected" };
		} catch (err) {
			log.warn(`applying MCP server ${name} to session ${live.sessionId} failed`, err);
			return { sessionId: live.sessionId, cwd: live.cwd, outcome: "failed" };
		}
	}));
}

/** What the change actually reached; never claims more than the reconcile reported. */
function applyNote(file: string, live: McpLiveApply[], connect: boolean): string {
	const saved = `Saved to ${file}. New chats read it when they start.`;
	if (live.length === 0) return `${saved} No chat is running.`;
	const applied = live.filter(entry => entry.outcome === "applied");
	const parts = [`${applied.length} of ${live.length} live chat${live.length === 1 ? "" : "s"} reloaded this server`];
	if (connect && applied.length > 0) {
		// Each state is named as NeoPi reports it: a handshake still in flight is
		// not a connection, and a server that refused is not one either.
		const connected = applied.filter(entry => entry.status === "connected").length;
		const connecting = applied.filter(entry => entry.status === "connecting").length;
		if (connected > 0) parts.push(`${connected} connected`);
		if (connecting > 0) parts.push(`${connecting} still connecting`);
		const stayed = applied.length - connected - connecting;
		if (stayed > 0) parts.push(`${stayed} did not connect`);
	}
	const without = live.filter(entry => entry.outcome === "no-mcp-runtime").length;
	if (without > 0) parts.push(`${without} run${without === 1 ? "s" : ""} without MCP`);
	const failed = live.filter(entry => entry.outcome === "failed").length;
	if (failed > 0) parts.push(`${failed} failed (see the deck server log)`);
	return `${saved} ${parts.join("; ")}.`;
}

async function readJson<T>(c: Context): Promise<T> {
	try { return await c.req.json() as T; }
	catch { throw new RequestError("JSON body required", 400); }
}

/** Confirm NeoPi's writer left exactly this entry on disk. */
async function verifyWrite(file: string, name: string, entry: MCPServerConfig): Promise<void> {
	const written = await feature("mcp-servers").getMCPServer(file, name);
	if (!sameValue(written, entry)) throw new RequestError(`${file} changed while saving "${name}"; reload and try again.`, 409);
}

async function respond(c: Context, run: () => Promise<McpServerMutationResponse>): Promise<Response> {
	try {
		return c.json(await serializeSave(run));
	} catch (err) {
		if (err instanceof RequestError) return c.json({ error: err.message }, err.status);
		log.warn("MCP server write failed", err);
		return c.json({ error: WRITE_FAILED }, 500);
	}
}

export function buildMcpServersRouter(bridge: AgentBridge, config: Config): Hono {
	const app = new Hono();
	const cwd = config.defaultCwd;

	app.get("/mcp-servers", async c => {
		try {
			return c.json(await listServers(cwd));
		} catch (err) {
			log.warn("listing MCP servers failed", err);
			return c.json({ error: LOAD_FAILED }, 500);
		}
	});

	/** Add a server to a scope's mcp.json; the name must be free in that file. */
	app.post("/mcp-servers", c => respond(c, async () => {
		const body = await readJson<McpServerCreateRequest>(c);
		const target = requireTarget(body);
		const name = requireName(typeof body.name === "string" ? body.name : undefined);
		const file = targetFile(cwd, target);
		const mcp = feature("mcp-servers");
		const entry = buildConfig(name, body, undefined);
		if (await mcp.getMCPServer(file, name) !== undefined) throw new RequestError(`Server "${name}" already exists in ${file}`, 409);
		await mcp.addMCPServer(file, name, entry);
		await verifyWrite(file, name, entry);
		const live = await reconcileLive(bridge, name, true);
		return { path: file, server: await rowFor(cwd, name, file), applyNote: applyNote(file, live, true), live };
	}));

	/**
	 * Replace an existing server's definition in the file that holds it. The
	 * read, the merge (kept env values, kept arguments, kept URL, and every
	 * field the editor does not own) and the write all happen inside NeoPi's own
	 * per-file lock, so a concurrent writer cannot have its change merged away.
	 */
	app.put("/mcp-servers/:name", c => respond(c, async () => {
		const body = await readJson<McpServerWriteRequest>(c);
		const target = requireTarget(body);
		const name = requireName(c.req.param("name"));
		const file = targetFile(cwd, target);
		const mcp = feature("mcp-servers");
		const entry = await mcp.withFileLock(file, async () => {
			const stored = await mcp.readMCPConfigFile(file);
			const existing = stored.mcpServers?.[name];
			if (existing === undefined) throw new RequestError(`Server "${name}" is not defined in ${file}`, 404);
			const merged = buildConfig(name, body, existing);
			await mcp.writeMCPConfigFile(file, { ...stored, mcpServers: { ...stored.mcpServers, [name]: merged } });
			return merged;
		}).catch((err: unknown) => {
			// NeoPi waits ~5s for the lock, then gives up; that is a busy file, not a broken one.
			if (err instanceof Error && err.message.startsWith("Failed to acquire lock")) {
				throw new RequestError(`Another writer is holding ${file}; try again.`, 409);
			}
			throw err;
		});
		await verifyWrite(file, name, entry);
		const connect = entry.enabled !== false;
		const live = await reconcileLive(bridge, name, connect);
		return { path: file, server: await rowFor(cwd, name, file), applyNote: applyNote(file, live, connect), live };
	}));

	app.delete("/mcp-servers/:name", c => respond(c, async () => {
		const target = requireTarget(await readJson<McpServerTargetRequest>(c));
		const name = requireName(c.req.param("name"));
		const file = targetFile(cwd, target);
		const mcp = feature("mcp-servers");
		if (await mcp.getMCPServer(file, name) === undefined) throw new RequestError(`Server "${name}" is not defined in ${file}`, 404);
		await mcp.removeMCPServer(file, name);
		if (await mcp.getMCPServer(file, name) !== undefined) throw new RequestError(`NeoPi kept "${name}" in ${file}; reload and try again.`, 409);
		// Removing one definition can uncover a lower-priority one of the same
		// name: the live chats then have to connect that, not just drop this.
		const survivor = await rowFor(cwd, name, file);
		const connect = survivor !== null && survivor.state === "enabled";
		const live = await reconcileLive(bridge, name, connect);
		return { path: file, server: survivor, applyNote: applyNote(file, live, connect), live };
	}));

	/**
	 * Enable or disable a server wherever it lives: NeoPi writes the `enabled`
	 * flag when it owns the file, and otherwise keeps its user-level deny and
	 * force-enable lists consistent.
	 */
	app.post("/mcp-servers/:name/enabled", c => respond(c, async () => {
		const body = await readJson<McpServerEnabledRequest>(c);
		const target = requireTarget(body);
		if (typeof body.enabled !== "boolean") throw new RequestError("enabled must be a boolean", 400);
		const name = requireName(c.req.param("name"));
		const mcp = feature("mcp-servers");
		const core = sdk();
		const userPath = mcp.getMCPConfigPath("user", cwd);
		// Only a NeoPi-owned file may carry the flag; a foreign tool's config is
		// toggled through the user lists and never rewritten.
		const owned = target.sourcePath !== undefined && writableSource(cwd, path.resolve(target.sourcePath)) !== undefined
			? path.resolve(target.sourcePath)
			: undefined;
		await mcp.setMcpServerEnabled({
			userPath,
			projectPath: mcp.getMCPConfigPath("project", cwd),
			...(owned !== undefined ? { sourcePath: owned } : {}),
			name,
			enabled: body.enabled,
		});
		// A legacy `mcp:<name>` in NeoPi's disabledExtensions outranks mcp.json,
		// so re-enabling has to clear it too (NeoPi's dashboard does the same).
		const settings = await core.Settings.loadReadOnly({ cwd, agentDir: core.getAgentDir() });
		const disabled = [...mcp.cfgDisabledExtensions.get(settings)];
		if (body.enabled && disabled.includes(`mcp:${name}`)) {
			const writable = await core.Settings.loadIsolated({ cwd, agentDir: core.getAgentDir() });
			mcp.cfgDisabledExtensions.set(writable, disabled.filter(id => id !== `mcp:${name}`));
			await writable.flush();
		}
		const file = owned ?? userPath;
		const row = await rowFor(cwd, name, file);
		if (row !== null && (row.state === "enabled") !== body.enabled) {
			throw new RequestError(
				body.enabled
					? `NeoPi still reports "${name}" as ${row.state}${row.disabledReason ? ` (${row.disabledReason})` : ""}.`
					: `NeoPi still reports "${name}" as enabled.`,
				409,
			);
		}
		const live = await reconcileLive(bridge, name, body.enabled);
		return { path: file, server: row, applyNote: applyNote(file, live, body.enabled), live };
	}));

	return app;
}
