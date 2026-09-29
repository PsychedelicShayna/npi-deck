/**
 * Dep-free transport projections of NeoPi's `MIXTURES.toml` document and
 * mixture trace payloads (`@oh-my-pi/pi-tui/overlays/mixture-types`). NeoPi
 * owns parsing, resolution, validation, persistence and execution; the deck
 * only carries its results.
 */
export type MixtureScope = "user" | "project";
export type MixturePart = "output" | "input" | "reasoning" | "toolTrace" | "transcript";
export type MixtureDecisionPart = "output" | "input" | "toolTrace";
export type MixtureShow = "always" | "never" | "final";

export interface MixtureTransit {
	output?: true;
	input?: true;
	reasoning?: true;
	toolTrace?: true;
	transcript?: true | { optimize?: "verbatim" | "compact" | "snapcompact"; budgetTokens?: number };
}
export interface MixtureRoute {
	instructions: string;
	state?: MixtureDecisionPart[];
	minConfidence?: number;
	fallback?: string;
}
export interface MixtureTerminate {
	instructions: string;
	criteria?: { true?: string; false?: string };
	state?: MixtureDecisionPart[];
	threshold?: number;
}
export type MixtureQuestion =
	| { type: "choice"; instructions: string; criteria: Record<string, string | null> }
	| { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
	| { type: "score"; instructions: string; criteria: readonly [string, string, ...string[]] };
interface MixtureMemberBase {
	id: string;
	description?: string;
	show?: MixtureShow;
}
export interface MixtureModelMember extends MixtureMemberBase {
	kind?: "model";
	model: string;
	role?: string;
	systemPrompt?: string;
	inherit?: boolean;
	tools?: boolean | string[];
	maxTokens?: number;
	route?: MixtureRoute;
	terminate?: MixtureTerminate;
}
export interface MixtureVerdictMember extends MixtureMemberBase {
	kind: "verdict";
	question: MixtureQuestion;
	state?: MixturePart[];
	render?: string;
}
export type MixtureMember = MixtureModelMember | MixtureVerdictMember;
interface MixtureEdgeBase {
	id?: string;
	from: string;
	x: MixtureTransit;
	envelope?: string;
	when?: string;
	show?: "always" | "never";
	maxTraversals?: number;
}
export type MixtureEdge =
	| (MixtureEdgeBase & { to: string })
	| (MixtureEdgeBase & {
			to: string[];
			join: string;
			slices?: "same" | "auto" | string[];
			joinX?: MixtureTransit;
			joinEnvelope?: string;
			quorum?: number;
			graceMs?: number;
			anonymize?: boolean;
	  });
export interface MixtureLimits {
	maxHops?: number;
	budgetUsd?: number;
	wallClockMinutes?: number;
	onLimit?: "stop" | "pause" | "judge";
	limitTarget?: string;
}
export interface MixtureDefinition {
	name: string;
	description?: string;
	entry: string;
	serve?: boolean;
	members: MixtureMember[];
	edges: MixtureEdge[];
	limits?: MixtureLimits;
	steering?: { target: string };
	envelopes?: Record<string, string>;
	roles?: Record<string, string>;
}
export interface MixturesDocument {
	envelopes?: Record<string, string>;
	roles?: Record<string, string>;
	mixtures: MixtureDefinition[];
	warnings?: string[];
}

/** One `resolveMixture` + `validateMixture` issue; `path` uses NeoPi's snake_case TOML paths. */
export interface MixtureIssue {
	code: string;
	path: string;
	message: string;
}

/**
 * NeoPi's verdict on one definition in a document. `runnable` is exactly
 * "no validateMixture errors": the same predicate NeoPi applies before it
 * registers a mixture as a picker model. `unsupported` lists the capability
 * gate's `unsupported.feature` errors (features a later milestone adds).
 */
export interface MixtureDefinitionReport {
	index: number;
	name: string;
	runnable: boolean;
	errors: MixtureIssue[];
	warnings: MixtureIssue[];
	unsupported: MixtureIssue[];
	/** NeoPi's resolution revision; equal revisions resolve to the same executable mixture. */
	revision?: string;
}

/** Syntax conversion plus NeoPi validation of every definition in the draft. */
export interface MixtureDraftResponse {
	doc: MixturesDocument;
	toml: string;
	parseDiagnostics: string[];
	validation: MixtureDefinitionReport[];
}
/** One MIXTURES.toml on NeoPi's search path for a workspace. */
export interface MixtureSourceDocument {
	/** Opaque id the server derives; send it back to save. */
	id: string;
	kind: MixtureScope;
	path: string;
	/** Precedence: a higher `order` shadows a lower one by mixture name. */
	order: number;
	/** Why the deck will not write this file (a symlink, outside the workspace root); absent when editable. */
	readOnly?: string;
	/** Whether the file exists on disk. */
	exists: boolean;
	/** sha256 of the file bytes (or "absent"); required as `baseHash` to save. */
	hash: string;
	doc: MixturesDocument;
	/** Canonical parsed representation, not original source or a lossless file snapshot. */
	toml: string;
	parseDiagnostics: string[];
	validation: MixtureDefinitionReport[];
}
/** Authoring features NeoPi's capability gate may refuse on a given build. */
export type MixtureGatedFeature =
	| "verdict"
	| "route"
	| "terminate"
	| "tools"
	| "routing"
	| "fanout"
	| "transcript"
	| "toolTrace"
	| "maxTraversals"
	| "cycles"
	| "steering"
	| "budgetUsd"
	| "wallClockMinutes"
	| "onLimit"
	| "limitTarget"
	| "serve";
/** One probe of the backend's gate: a minimal definition using only `feature`, validated by NeoPi. */
export interface MixtureGateProbe {
	feature: MixtureGatedFeature;
	/** NeoPi refused the feature with `unsupported.feature`; `message` is its reason. */
	gated: boolean;
	message?: string;
}
/**
 * What NeoPi would register for a workspace: its MIXTURES.toml search path
 * (user, then project ancestors → cwd, `.omp/` included), resolved and
 * validated. The definitions a `mixture/<name>` chat in that workspace runs.
 */
export interface MixtureDiscovered {
	cwd: string;
	mixtures: Array<{ name: string; revision: string; definition: MixtureDefinition }>;
}
export interface MixturesResponse {
	cwd: string;
	capabilities: {
		drafting: boolean;
		validation: boolean;
		persistence: boolean;
		/** Saving refreshes the picker roster without a restart. */
		apply: boolean;
		/** Milestone this backend's capability gate implements (e.g. "M1"). */
		milestone?: string;
		/** Which authoring features this backend's gate refuses, probed through NeoPi's validator. */
		gates: MixtureGateProbe[];
		diagnostics: string[];
	};
	/**
	 * Every MIXTURES.toml NeoPi reads for this workspace, in its precedence
	 * order: a later source's definition shadows an earlier one of the same
	 * name. Includes the user and workspace-root files even when absent.
	 */
	sources: MixtureSourceDocument[];
	/** The workspace root's MIXTURES.toml: the source a new mixture goes to by default. */
	defaultSource: string;
	/** Mixture names the model picker lists for a chat in this workspace (`mixture/<name>`). */
	picker: string[];
}
export interface MixtureDraftRequest {
	input: { kind: "toml"; text: string } | { kind: "document"; doc: MixturesDocument };
	/** Validate against this workspace's models, roles and settings. */
	cwd: string;
}
export interface MixtureSaveRequest {
	cwd: string;
	/** A `MixtureSourceDocument.id` from this workspace's load; never a path. */
	source: string;
	doc: MixturesDocument;
	/** `hash` of the source document this edit started from; a mismatch is a 409. */
	baseHash: string;
	/** Required when the file on disk holds content NeoPi's parser does not keep (a 409 `rewrite-loses-source`). */
	confirmCanonicalRewrite?: boolean;
}
export interface MixtureSaveResponse {
	source: MixtureSourceDocument;
	/** The picker after the save re-registered this workspace's mixtures. */
	picker: string[];
}

/** Display-only trace data. Never append these payloads to replayable assistant messages. */
export interface MixtureTraceHeader {
	v: 1;
	runId: string;
	mixture: string;
	seq: number;
	at: number;
	run: {
		status: "running" | "awaiting_tools" | "checkpoint" | "paused" | "done" | "error";
		phase: string;
		activeMemberId?: string;
		hops: number;
		usd: number;
		window: { hops: number; usd: number };
		endReason?: string;
	};
}
export interface MixtureTraceUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export type MixtureAnswer =
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "noul"; noul: number }
	| { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };
export interface MixtureDecision {
	kind: "route" | "terminate" | "steering" | "verdict";
	answer: MixtureAnswer;
	confidence?: number;
	judge: string;
	judgeKind: "native" | "local" | "online";
}
export type MixtureHopTrace = MixtureTraceHeader & {
	kind: "hop" | "branch";
	hop: number;
	memberId: string;
	model: string;
	edgeInId?: string;
	edgeOutId?: string;
	output?: string;
	reasoning?: string;
	toolTrace?: string;
	usage: MixtureTraceUsage;
	elapsedMs: number;
	status: "running" | "awaiting_tools" | "done" | "failed" | "aborted";
	visible: boolean;
	branchOf?: string;
};
export type MixtureTrace =
	| (MixtureTraceHeader & { kind: "run_start"; topic: string; members: Array<{ id: string; model?: string; description?: string }> })
	| MixtureHopTrace
	| (MixtureTraceHeader & { kind: "decision"; hop: number; memberId: string; decision: MixtureDecision })
	| (MixtureTraceHeader & { kind: "steering"; hop: number; targetMemberId: string; text: string })
	| (MixtureTraceHeader & { kind: "limit"; limit: "hops" | "budget" | "wall_clock" | "hard_cap"; action: "stop" | "pause" | "judge"; value: string })
	| (MixtureTraceHeader & { kind: "checkpoint"; reason: string; note?: string })
	| (MixtureTraceHeader & { kind: "run_end"; endReason: string; usage: MixtureTraceUsage });
