/**
 * MIXTURES.toml authoring for the Mixtures view (#80). NeoPi supplies the
 * search path, parsing, serialization, resolution and validation; this
 * service picks a file from NeoPi's search path by opaque id (never a client
 * path), writes it without following links under NeoPi's cross-process file
 * lock, compares against the hash the editor loaded, verifies what landed on
 * disk, and re-discovers the picker roster so a saved mixture is selectable.
 */
import type {
	MixtureDefinition,
	MixtureDefinitionReport,
	MixtureDraftRequest,
	MixtureDraftResponse,
	MixtureGatedFeature,
	MixtureGateProbe,
	MixtureIssue,
	MixtureDiscovered,
	MixtureModelMember,
	MixtureSaveRequest,
	MixtureSaveResponse,
	MixtureSourceDocument,
	MixturesDocument,
	MixturesResponse,
} from "@npi-deck/protocol";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import type { FeatureExports } from "./backend/manifest.ts";
import { activeBackend, feature, formatDiagnostic, hasFeature, sdk } from "./backend/runtime.ts";
import { digest, mixtureSources, readSource, SourceConflictError, sourceId, writeSource, type MixtureSource } from "./mixture-files.ts";
import { spawnOwnedSync } from "./owned-process.ts";

type ConfigApi = FeatureExports<"mixture-config">;
type MixtureRegistrationContext = Parameters<ConfigApi["discoverRegistrableMixtures"]>[0];
type SdkDoc = Parameters<ConfigApi["serializeMixturesConfig"]>[0];
type SdkDefinition = Parameters<ConfigApi["resolveMixture"]>[0];

const empty = (): MixturesDocument => ({ mixtures: [] });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const UNREADABLE = "unreadable:";

export class MixtureServiceError extends Error {
	constructor(
		readonly status: 400 | 409 | 422 | 500 | 503,
		message: string,
		readonly details: Record<string, unknown> = {},
	) {
		super(message);
	}
}

/** Key-order-independent structure; `undefined` members are absent. */
export function structure(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(structure).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${structure(item)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "undefined";
}

function withoutWarnings(doc: MixturesDocument): MixturesDocument {
	const { warnings: _warnings, ...rest } = doc;
	return rest;
}

const SOURCE_LOSS = "NeoPi's parser drops or changes fields in this TOML; saving writes the canonical form shown here, not the original source.";
/** Parse TOML text through NeoPi's parser; flags fields its parser or serializer would not keep. */
function parseText(api: ConfigApi, text: string, where: string): { doc: MixturesDocument; toml: string; parseDiagnostics: string[] } {
	let raw: unknown;
	try {
		raw = Bun.TOML.parse(text);
	} catch (error) {
		return { doc: empty(), toml: "", parseDiagnostics: [`Invalid TOML: ${message(error)}`] };
	}
	const doc = api.parseMixturesDoc(raw, where) as unknown as MixturesDocument;
	const parseDiagnostics = [...(doc.warnings ?? [])];
	let toml = "";
	try {
		toml = api.serializeMixturesConfig(doc as unknown as SdkDoc);
		if (structure(raw) !== structure(Bun.TOML.parse(toml)))
			parseDiagnostics.push(SOURCE_LOSS);
	} catch (error) {
		parseDiagnostics.push(`Cannot serialize draft: ${message(error)}`);
	}
	return { doc, toml, parseDiagnostics };
}

/** A browser-edited document, normalized by a NeoPi serialize → parse round trip. */
function parseDocument(api: ConfigApi, doc: MixturesDocument): { doc: MixturesDocument; toml: string; parseDiagnostics: string[]; lossy: boolean } {
	let toml: string;
	try {
		toml = api.serializeMixturesConfig(doc as unknown as SdkDoc);
	} catch (error) {
		throw new MixtureServiceError(422, "cannot serialize mixture draft", { parseDiagnostics: [message(error)] });
	}
	const result = parseText(api, toml, "draft MIXTURES.toml");
	const lossy = structure(withoutWarnings(doc)) !== structure(withoutWarnings(result.doc));
	// The TOML here is NeoPi's own output, so only the document comparison is meaningful.
	const parseDiagnostics = result.parseDiagnostics.filter(line => line !== SOURCE_LOSS);
	if (lossy) parseDiagnostics.push("Saving would change or omit the fields above; NeoPi cannot store this draft as shown.");
	return { ...result, parseDiagnostics, lossy };
}

/** NeoPi's TUI edits the VCS root, falling back to cwd; discovery walks cwd up to that root. */
function projectRoot(cwd: string): string {
	const result = spawnOwnedSync(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" });
	return result.exitCode === 0 ? result.stdout.toString().trim() || cwd : cwd;
}

function milestoneOf(gates: readonly MixtureGateProbe[]): string | undefined {
	for (const gate of gates) {
		const match = gate.message ? /this build implements (\S+)$/.exec(gate.message) : null;
		if (match) return match[1];
	}
	return undefined;
}

/**
 * Resolve and validate each definition exactly as NeoPi registration does
 * (document presets, the workspace's settings and models). `runnable` is
 * "no errors", which is also the registration predicate.
 */
export function validateDocument(api: ConfigApi, ctx: MixtureRegistrationContext, doc: MixturesDocument): MixtureDefinitionReport[] {
	const names = doc.mixtures.map(mixture => (typeof mixture?.name === "string" ? mixture.name : ""));
	return doc.mixtures.map((definition, index) => {
		let errors: MixtureIssue[];
		let warnings: MixtureIssue[] = [];
		let revision: string | undefined;
		try {
			const resolved = api.resolveMixture(definition as unknown as SdkDefinition, {
				registry: ctx.registry,
				settings: ctx.settings,
				documentEnvelopes: doc.envelopes ?? {},
				documentRoles: doc.roles ?? {},
			});
			const result = api.validateMixture(resolved, { settings: ctx.settings, names });
			errors = result.errors;
			warnings = result.warnings;
			revision = resolved.revision;
		} catch (error) {
			errors = [{ code: "deck.validation.failed", path: "", message: `NeoPi could not validate this definition: ${message(error)}` }];
		}
		return {
			index,
			name: typeof definition?.name === "string" ? definition.name : "",
			runnable: errors.length === 0,
			errors,
			warnings,
			unsupported: errors.filter(issue => issue.code === "unsupported.feature"),
			...(errors.length === 0 && revision ? { revision } : {}),
		};
	});
}

// One write at a time per process: each compare-and-save sees the file the
// previous one wrote, and the roster refresh follows the write it belongs to.
let writeQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(run: () => Promise<T>): Promise<T> {
	const result = writeQueue.then(run);
	writeQueue = result.catch(() => undefined);
	return result;
}

/** What the service needs from the server; the bridge alone writes NeoPi's mixture catalog. */
export interface MixturesHost {
	/** Workspaces a client may name (config + saved sessions); anything else is refused. */
	workspaces(): Promise<string[]>;
	/** The deck's shared model registry: what members resolve against. */
	registry(): Promise<ModelRegistry>;
	/** Re-register `cwd`'s mixtures in the model picker (AgentBridge.refreshMixtureRoster). */
	refreshRoster(cwd: string): Promise<void>;
	/** Mixture names the model picker lists for a chat in `cwd`. */
	pickerMixtures(cwd: string): Promise<string[]>;
}

export class MixturesService {
	constructor(private readonly host: MixturesHost) {}

	private async known(cwd: unknown): Promise<string> {
		if (typeof cwd !== "string" || !(await this.host.workspaces()).includes(cwd)) throw new MixtureServiceError(400, "unknown project workspace");
		return cwd;
	}

	private api(): ConfigApi {
		if (!hasFeature("mixture-config"))
			throw new MixtureServiceError(503, "this NeoPi backend does not export the mixture authoring API", {
				diagnostics: activeBackend()?.features["mixture-config"].diagnostics.map(formatDiagnostic) ?? [],
			});
		return feature("mixture-config");
	}

	/**
	 * The resolution context NeoPi's registration uses for `cwd`. The
	 * read-only settings loader never migrates or writes the user's config.
	 */
	private async context(cwd: string): Promise<MixtureRegistrationContext> {
		const agentDir = sdk().getAgentDir();
		const [registry, settings] = await Promise.all([this.host.registry(), sdk().Settings.loadReadOnly({ cwd, agentDir })]);
		return { cwd, agentDir, registry, settings };
	}

	/** NeoPi's search path for `cwd`, with the deck's editability decided per file. */
	private async sources(api: ConfigApi, cwd: string): Promise<MixtureSource[]> {
		const agentDir = sdk().getAgentDir();
		return mixtureSources(cwd, api.configCandidatePaths(cwd, agentDir, ["MIXTURES.toml"]), { projectDir: projectRoot(cwd), agentDir });
	}

	private async sourceDoc(api: ConfigApi, ctx: MixtureRegistrationContext, source: MixtureSource): Promise<MixtureSourceDocument> {
		const read = await readSource(source.path, api.MAX_FILE_BYTES);
		const base = { id: source.id, kind: source.kind, path: source.path, order: source.order };
		if (read.state === "refused")
			return { ...base, readOnly: read.reason, exists: true, hash: `${UNREADABLE}${read.reason}`, doc: empty(), toml: "", validation: [], parseDiagnostics: [`${source.path} ${read.reason}; the editor does not read or write it.`] };
		const text = read.state === "file" ? read.text : null;
		const parsed = text === null ? { doc: empty(), toml: "", parseDiagnostics: [] } : parseText(api, text, source.path);
		return {
			...base,
			...(source.readOnly ? { readOnly: source.readOnly } : {}),
			exists: text !== null,
			hash: digest(text),
			doc: parsed.doc,
			toml: parsed.toml,
			parseDiagnostics: parsed.parseDiagnostics,
			validation: validateDocument(api, ctx, parsed.doc),
		};
	}

	async load(cwdInput: unknown): Promise<MixturesResponse> {
		const cwd = await this.known(cwdInput);
		const api = this.api();
		const ctx = await this.context(cwd);
		const listed = await this.sources(api, cwd);
		const [sources, picker] = await Promise.all([Promise.all(listed.map(source => this.sourceDoc(api, ctx, source))), this.host.pickerMixtures(cwd)]);
		const gates = probeGates(api, ctx);
		const milestone = milestoneOf(gates);
		return {
			cwd,
			capabilities: {
				drafting: true,
				validation: true,
				persistence: true,
				apply: hasFeature("mixtures"),
				...(milestone ? { milestone } : {}),
				gates,
				diagnostics: [
					"Saving rewrites MIXTURES.toml in NeoPi's canonical form: comments and formatting are not kept.",
					"Saves hold NeoPi's cross-process file lock and recheck the file just before replacing it. An editor that does not take that lock (NeoPi's own TUI save, a text editor) can still write between that check and the replace, and would be overwritten.",
					...(hasFeature("mixtures") ? [] : ["This backend holds no mixture catalog: saved mixtures cannot reach the model picker."]),
				],
			},
			sources,
			defaultSource: sourceId(path.resolve(projectRoot(cwd), "MIXTURES.toml")),
			picker,
		};
	}

	async draft(request: MixtureDraftRequest): Promise<MixtureDraftResponse> {
		const cwd = await this.known(request.cwd);
		const api = this.api();
		const parsed = request.input.kind === "toml" ? parseText(api, request.input.text, "draft MIXTURES.toml") : parseDocument(api, request.input.doc);
		// Validate what the editor shows, not NeoPi's round trip of it: a field the
		// parser would drop (a route with no instructions) must still be gated.
		const shown = request.input.kind === "document" ? withoutWarnings(request.input.doc) : parsed.doc;
		const validation = validateDocument(api, await this.context(cwd), shown);
		return { doc: parsed.doc, toml: parsed.toml, parseDiagnostics: parsed.parseDiagnostics, validation };
	}

	/** What NeoPi registers for `cwd`: the definitions a `mixture/<name>` chat there runs. */
	async discovered(cwdInput: unknown): Promise<MixtureDiscovered> {
		const cwd = await this.known(cwdInput);
		const registrable = await this.api().discoverRegistrableMixtures(await this.context(cwd));
		return {
			cwd,
			mixtures: registrable.map(mixture => ({
				name: mixture.definition.name,
				revision: mixture.revision,
				definition: mixture.definition as unknown as MixtureDefinition,
			})),
		};
	}

	/**
	 * Compare-and-save one source file. A definition with validation errors
	 * blocks the save unless it is carried over unchanged from the file on
	 * disk (the editor never deletes or flattens what it cannot run).
	 */
	async save(request: MixtureSaveRequest): Promise<MixtureSaveResponse> {
		const cwd = await this.known(request.cwd);
		if (typeof request.source !== "string") throw new MixtureServiceError(400, "source id required");
		if (typeof request.baseHash !== "string") throw new MixtureServiceError(400, "baseHash required");
		const api = this.api();
		const source = (await this.sources(api, cwd)).find(candidate => candidate.id === request.source);
		if (!source) throw new MixtureServiceError(400, "unknown mixture source for this workspace; reload");
		if (source.readOnly) throw new MixtureServiceError(409, `${source.path} is not editable here: ${source.readOnly}`);
		const draft = parseDocument(api, request.doc);
		if (draft.lossy || draft.doc.warnings?.length)
			throw new MixtureServiceError(422, "NeoPi cannot represent this draft without changing it", { parseDiagnostics: draft.parseDiagnostics });
		const content = api.serializeMixturesConfig(withoutWarnings(draft.doc) as unknown as SdkDoc);
		if (Buffer.byteLength(content, "utf8") > api.MAX_FILE_BYTES) throw new MixtureServiceError(422, `the saved file would exceed NeoPi's ${api.MAX_FILE_BYTES}-byte cap`);
		// In-process queue for ordering, NeoPi's lock for other deck processes and lock-aware NeoPi writers.
		return serialize(() =>
			api.withFileLock(source.path, async () => {
				const ctx = await this.context(cwd);
				const current = await this.sourceDoc(api, ctx, source);
				if (current.readOnly) throw new MixtureServiceError(409, `${source.path} is not editable here: ${current.readOnly}`);
				if (current.hash !== request.baseHash)
					throw new MixtureServiceError(409, `${source.path} changed since it was loaded; reload before saving`, { current });
				if (current.exists && current.parseDiagnostics.length > 0 && request.confirmCanonicalRewrite !== true)
					throw new MixtureServiceError(409, `${source.path} has content NeoPi's parser does not keep; saving would drop it`, {
						code: "rewrite-loses-source",
						parseDiagnostics: current.parseDiagnostics,
					});

				const validation = validateDocument(api, ctx, draft.doc);
				const onDisk = new Map(current.doc.mixtures.map(mixture => [mixture.name, structure(mixture)] as const));
				const blocked = validation.filter(report => !report.runnable && onDisk.get(report.name) !== structure(draft.doc.mixtures[report.index]));
				if (blocked.length > 0)
					throw new MixtureServiceError(422, `NeoPi refuses to save definitions with validation errors: ${blocked.map(report => report.name || "(unnamed)").join(", ")}`, {
						validation,
						blocked: blocked.map(report => report.index),
					});

				try {
					// An empty serialization removes the file, as NeoPi's own save does.
					await writeSource(source, content ? content : null, current.hash, api.MAX_FILE_BYTES);
				} catch (error) {
					if (error instanceof SourceConflictError) throw new MixtureServiceError(409, error.message);
					throw error;
				}
				const saved = await this.sourceDoc(api, ctx, source);
				if (structure(withoutWarnings(saved.doc)) !== structure(withoutWarnings(draft.doc)))
					throw new MixtureServiceError(500, `${source.path} does not read back as the saved document`, { source: saved });
				if (hasFeature("mixtures")) await this.host.refreshRoster(cwd);
				return { source: saved, picker: await this.host.pickerMixtures(cwd) };
			}),
		);
	}
}

/**
 * Probe NeoPi's capability gate one feature at a time: a two-member linear
 * chain plus exactly that feature, validated by NeoPi. The editor labels a
 * control "not runnable on this backend" from this, before the user enables
 * it; the gate itself stays the authority at validation and save.
 */
export function probeGates(api: ConfigApi, ctx: MixtureRegistrationContext): MixtureGateProbe[] {
	// The tools gate reads the resolved member, so members need a model that resolves.
	const available = ctx.registry.getAvailable().find(model => model.api !== "mixture");
	const model = available ? `${available.provider}/${available.id}` : "deck-probe/none";
	const base = (): MixtureDefinition => ({
		name: "deck-gate-probe",
		entry: "a",
		members: [
			{ id: "a", model, systemPrompt: "probe", tools: false },
			{ id: "b", model, systemPrompt: "probe", tools: false },
		],
		edges: [{ from: "a", to: "b", x: { output: true } }],
	});
	const with_ = (change: (definition: MixtureDefinition) => void) => {
		const definition = base();
		change(definition);
		return definition;
	};
	const a = (definition: MixtureDefinition) => definition.members[0] as MixtureModelMember;
	const edge = (definition: MixtureDefinition) => definition.edges[0]!;
	const probes: Array<[MixtureGatedFeature, string, MixtureDefinition | undefined]> = [
		["verdict", "members[2]", with_(d => { d.members.push({ kind: "verdict", id: "v", question: { type: "noul", instructions: "probe" } }); })],
		["route", "members[0].route", with_(d => { a(d).route = { instructions: "probe" }; })],
		["terminate", "members[0].terminate", with_(d => { a(d).terminate = { instructions: "probe" }; })],
		["tools", "members[1].tools", available ? with_(d => { (d.members[1] as MixtureModelMember).tools = true; }) : undefined],
		["routing", "members[0]", with_(d => { d.members.push({ id: "c", model, systemPrompt: "probe", tools: false }); d.edges.push({ from: "a", to: "c", x: { output: true } }); })],
		["fanout", "edges[0]", with_(d => { d.members.push({ id: "c", model, systemPrompt: "probe", tools: false }); d.edges = [{ from: "a", to: ["b", "c"], join: "b", x: { output: true } }]; })],
		["transcript", "edges[0].x.transcript", with_(d => { edge(d).x = { output: true, transcript: true }; })],
		["toolTrace", "edges[0].x.tool_trace", with_(d => { edge(d).x = { output: true, toolTrace: true }; })],
		["maxTraversals", "edges[0].max_traversals", with_(d => { edge(d).maxTraversals = 2; })],
		["cycles", "edges", with_(d => { d.edges.push({ from: "b", to: "a", x: { output: true } }); })],
		["steering", "steering", with_(d => { d.steering = { target: "active" }; })],
		["budgetUsd", "limits.budget_usd", with_(d => { d.limits = { budgetUsd: 1 }; })],
		["wallClockMinutes", "limits.wall_clock_minutes", with_(d => { d.limits = { wallClockMinutes: 1 }; })],
		["onLimit", "limits.on_limit", with_(d => { d.limits = { onLimit: "stop" }; })],
		["limitTarget", "limits.limit_target", with_(d => { d.limits = { limitTarget: "a" }; })],
		["serve", "serve", with_(d => { d.serve = true; })],
	];
	return probes.flatMap(([feature, path, definition]) => {
		if (!definition) return [];
		const [report] = validateDocument(api, ctx, { mixtures: [definition] });
		const gate = report?.unsupported.find(issue => issue.path === path);
		return [gate ? { feature, gated: true, message: gate.message } : { feature, gated: false }];
	});
}
