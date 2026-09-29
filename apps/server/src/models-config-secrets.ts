/**
 * Credential masking for models.yml as the Settings editor shows it. Fails
 * closed: when a credential cannot be removed from the text unambiguously, the
 * text is withheld rather than partially masked.
 *
 * Masked (replaced by a placeholder `<npi-deck-masked:ID>`):
 * - every value in a credential position of NeoPi's schema: a provider's
 *   `apiKey`, every header value under any name (provider, model and model
 *   override headers) and every `requestMetadata` value;
 * - every `baseUrl` (provider, model, model override) with userinfo, a query or
 *   a fragment (percent-encoded delimiters included), whole; its credential
 *   pieces join the known credentials;
 * - every value under a credential-like key anywhere else (`token`, `secret`,
 *   `password`, `*key`, …), following aliases and merge keys;
 * - every other occurrence of such a value at least MIN_REPLACE long, in any
 *   scalar or key.
 * A known credential still present anywhere (a short one, one hidden by an
 * escape) withholds the whole text.
 *
 * No comment text is ever shown: every comment becomes `# <npi-deck-comment:ID>`,
 * restored verbatim on save only when it stands unchanged as a whole comment.
 * A comment the user writes or edits is saved as typed.
 *
 * IDs are HMACs under a per-process key, as is the file revision, so neither
 * can be checked against a guessed credential offline. Saving restores a
 * credential placeholder only where it is the whole value of a credential
 * position; a placeholder anywhere else is refused, so a credential can never
 * be moved into a field the deck shows.
 */
import { createHmac, randomBytes } from "node:crypto";
import { isAlias, isMap, isScalar, isSeq, parseDocument, Parser, type Document, type Scalar } from "yaml";

export const MASK_MARK = "npi-deck-masked";
export const COMMENT_MARK = "npi-deck-comment";
const PLACEHOLDER_EXACT = /^<npi-deck-masked:[0-9a-f]{16}>$/;
const COMMENT_EXACT = /^# <npi-deck-comment:[0-9a-f]{16}>$/;
const SECRET_KEY_SUFFIXES = ["key", "authorization", "token", "secret", "password", "cookie", "credential", "credentials"];
/** Shorter credentials are not substituted inside other text (the match would be ambiguous); their presence withholds the text. */
const MIN_REPLACE = 8;
/** Walk budget: aliases can multiply a document exponentially. */
const MAX_VISITS = 100_000;
const ABSENT = "absent";

const hmacKey = randomBytes(32);

function keyed(domain: string, text: string): string {
	return createHmac("sha256", hmacKey).update(domain).update("\0").update(text).digest("hex");
}

/** Opaque revision of a file's exact text, keyed per process: it identifies the text without allowing an offline guess at its credentials. */
export function revisionOf(text: string | null): string {
	return text === null ? ABSENT : keyed("revision", text);
}

export function isSecretKey(key: unknown): boolean {
	if (typeof key !== "string") return false;
	const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
	return SECRET_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

type PathKey = string | number | undefined;

/**
 * Credential positions in NeoPi's models.yml schema: `providers.P.apiKey`,
 * `providers.P.headers.H`, `providers.P.requestMetadata.K`,
 * `providers.P.models[i].headers.H` and `providers.P.modelOverrides.M.headers.H`.
 */
export function isCredentialPath(path: readonly PathKey[]): boolean {
	if (path[0] !== "providers" || path.length < 3) return false;
	const rest = path.slice(2);
	if (rest.length === 1) return rest[0] === "apiKey";
	if (rest.length === 2) return rest[0] === "headers" || rest[0] === "requestMetadata";
	if (rest.length === 4) {
		return rest[2] === "headers" && ((rest[0] === "models" && typeof rest[1] === "number") || rest[0] === "modelOverrides");
	}
	return false;
}

/** `baseUrl` of a provider, a model or a model override. */
export function isUrlPath(path: readonly PathKey[]): boolean {
	if (path[0] !== "providers" || path.length < 3) return false;
	const rest = path.slice(2);
	if (rest.length === 1) return rest[0] === "baseUrl";
	if (rest.length === 3) return rest[2] === "baseUrl" && ((rest[0] === "models" && typeof rest[1] === "number") || rest[0] === "modelOverrides");
	return false;
}

const REDACTED = "••••••";
const URL_DELIMITERS = /[?#@]/;

function decoded(text: string): string | undefined {
	try {
		return decodeURIComponent(text);
	} catch {
		return undefined;
	}
}

/**
 * A URL that can carry a credential: userinfo, a query or a fragment, including
 * their percent-encoded delimiters. Text that does not decode counts as one.
 */
export function isSensitiveUrl(value: string): boolean {
	const plain = decoded(value);
	return plain === undefined || URL_DELIMITERS.test(value) || URL_DELIMITERS.test(plain);
}

/** The pieces of a sensitive URL that could be a credential, raw and decoded, for the survival checks. */
function urlCredentialParts(value: string): string[] {
	const parts = new Set<string>([value]);
	const add = (text: string | undefined) => {
		if (!text) return;
		parts.add(text);
		const plain = decoded(text);
		if (plain) parts.add(plain);
	};
	const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value)?.[1];
	const at = authority?.lastIndexOf("@") ?? -1;
	if (authority !== undefined && at >= 0) {
		const userinfo = authority.slice(0, at);
		add(userinfo);
		for (const piece of userinfo.split(":")) add(piece);
	}
	const hash = value.indexOf("#");
	const query = value.indexOf("?");
	if (hash >= 0) add(value.slice(hash + 1));
	if (query >= 0 && (hash < 0 || query < hash)) {
		const search = value.slice(query + 1, hash > query ? hash : undefined);
		add(search);
		for (const pair of search.split("&")) { add(pair); add(pair.slice(pair.indexOf("=") + 1)); }
	}
	try {
		const url = new URL(value);
		add(url.username);
		add(url.password);
		add(url.search.slice(1));
		add(url.hash.slice(1));
		for (const param of url.searchParams.values()) add(param);
		if (URL_DELIMITERS.test(decoded(url.pathname) ?? "?")) add(url.pathname);
	} catch {
		// The whole value is already listed.
	}
	return [...parts];
}

/** `scheme://host[:port]/path` with `••••••` for each credential-bearing component; `••••••` when it is not such a URL. */
export function redactUrl(value: string): string {
	const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value)?.[1];
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return REDACTED;
	}
	if (authority === undefined || url.host === "") return REDACTED;
	const path = URL_DELIMITERS.test(decoded(url.pathname) ?? "?") ? `/${REDACTED}` : url.pathname;
	const userinfo = authority.includes("@") ? `${REDACTED}@` : "";
	const hash = value.indexOf("#");
	const query = value.indexOf("?");
	const search = query >= 0 && (hash < 0 || query < hash) ? `?${REDACTED}` : "";
	return `${url.protocol}//${userinfo}${url.host}${path}${search}${hash >= 0 ? `#${REDACTED}` : ""}`;
}

/**
 * A baseUrl as a summary may show it: a placeholder for a masked URL becomes
 * that URL's redacted form, a typed sensitive URL is redacted, any other text
 * carrying a placeholder becomes `••••••`.
 */
export function displayUrl(value: string | undefined, secrets: Map<string, Secret>): string | undefined {
	if (value === undefined) return undefined;
	if (PLACEHOLDER_EXACT.test(value)) {
		const secret = secrets.get(value);
		return typeof secret?.value === "string" && isSensitiveUrl(secret.value) ? redactUrl(secret.value) : REDACTED;
	}
	if (value.includes(MASK_MARK)) return REDACTED;
	return isSensitiveUrl(value) ? redactUrl(value) : value;
}

/** Whether a restored placeholder's credential may stand at `path`: any at a credential position, a sensitive URL at a baseUrl. */
function restorableAt(path: readonly PathKey[], secret: Secret): boolean {
	return isCredentialPath(path) || (isUrlPath(path) && typeof secret.value === "string" && isSensitiveUrl(secret.value));
}

function placeholderFor(text: string): string {
	return `<${MASK_MARK}:${keyed("credential", text).slice(0, 16)}>`;
}

function commentPlaceholderFor(source: string): string {
	return `# <${COMMENT_MARK}:${keyed("comment", source).slice(0, 16)}>`;
}

/** A masked credential: its scalar value (typed, for exact restores) and its text. */
export interface Secret {
	value: unknown;
	text: string;
}

/** Keys the user names freely (providers, overridden model ids); a name is not a credential label. */
function isNamePosition(path: readonly PathKey[]): boolean {
	return path[0] === "providers" && (path.length === 2 || (path.length === 4 && path[2] === "modelOverrides"));
}

export type MaskResult =
	| { ok: true; masked: string; secrets: Map<string, Secret>; comments: Map<string, string>; known: string[] }
	/** `known` holds the credentials that could be located, for scrubbing messages. */
	| { ok: false; known: string[] };

export class PlaceholderError extends Error {
	constructor(message: string, readonly status: 400 | 409) {
		super(message);
	}
}

interface Edit {
	start: number;
	end: number;
	text: string;
}

function applyEdits(source: string, edits: Edit[]): string {
	let out = source;
	for (const edit of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
	return out;
}

function parse(text: string): Document | undefined {
	const doc = parseDocument(text, { uniqueKeys: true });
	return doc.errors.length === 0 ? doc : undefined;
}

/** Every scalar in the document, map keys included. */
function allScalars(doc: Document): Scalar[] {
	const out: Scalar[] = [];
	const walk = (node: unknown): void => {
		if (isScalar(node)) out.push(node);
		else if (isMap(node)) for (const pair of node.items) { walk(pair.key); walk(pair.value); }
		else if (isSeq(node)) for (const item of node.items) walk(item);
	};
	walk(doc.contents);
	return out;
}

interface Reach {
	/** Scalars reached through a credential position, a sensitive baseUrl or under a credential-like key: masked. */
	masked: Set<Scalar>;
	/** Scalars reached through a credential position of the schema. */
	credential: Set<Scalar>;
	/** Scalars reached through a baseUrl. */
	url: Set<Scalar>;
	/** Scalars reached through any other position. */
	elsewhere: Set<Scalar>;
}

/**
 * Classify every scalar by each position it is reachable from, following
 * aliases and `<<` merge keys to the data paths NeoPi sees. Undefined when the
 * document exceeds the walk budget.
 */
function reach(doc: Document): Reach | undefined {
	const result: Reach = { masked: new Set(), credential: new Set(), url: new Set(), elsewhere: new Set() };
	const onPath = new Set<unknown>();
	let visits = 0;
	const walk = (node: unknown, path: PathKey[], secret: boolean): boolean => {
		if (++visits > MAX_VISITS) return false;
		if (isAlias(node)) {
			const target = node.resolve(doc);
			if (target === undefined || onPath.has(target)) return true;
			onPath.add(target);
			const ok = walk(target, path, secret);
			onPath.delete(target);
			return ok;
		}
		if (isScalar(node)) {
			const credential = isCredentialPath(path);
			const url = !credential && isUrlPath(path);
			(credential ? result.credential : url ? result.url : result.elsewhere).add(node);
			const sensitiveUrl = url && typeof node.value === "string" && isSensitiveUrl(node.value);
			if (secret || credential || sensitiveUrl) result.masked.add(node);
			return true;
		}
		if (isMap(node)) {
			for (const pair of node.items) {
				const key = isScalar(pair.key) ? pair.key.value : undefined;
				const merge = key === "<<";
				const childKey: PathKey = typeof key === "string" || typeof key === "number" ? key : undefined;
				const childPath = merge ? path : [...path, childKey];
				if (!walk(pair.value, childPath, secret || (!merge && !isNamePosition(childPath) && isSecretKey(key)))) return false;
			}
			return true;
		}
		if (isSeq(node)) {
			for (const [index, item] of node.items.entries()) if (!walk(item, [...path, index], secret)) return false;
		}
		return true;
	};
	return walk(doc.contents, [], false) ? result : undefined;
}

/** Offsets and text of every comment, from the concrete syntax tree. */
function comments(text: string): Array<{ offset: number; source: string }> {
	const out: Array<{ offset: number; source: string }> = [];
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) { for (const item of value) walk(item); return; }
		if (!value || typeof value !== "object") return;
		const token = value as { type?: unknown; offset?: unknown; source?: unknown };
		if (token.type === "comment" && typeof token.offset === "number" && typeof token.source === "string") {
			out.push({ offset: token.offset, source: token.source });
			return;
		}
		for (const [key, child] of Object.entries(value)) if (key !== "source") walk(child);
	};
	for (const token of new Parser().parse(text)) walk(token);
	return out;
}
/** Whether every comment in `text` is a comment placeholder: no comment text survives. */
function onlyCommentPlaceholders(text: string): boolean {
	return comments(text).every(comment => COMMENT_EXACT.test(comment.source));
}

/** Replacement text for a scalar's source range; a block scalar's range ends with its line break, which must stay. */
function scalarEdit(node: Scalar, source: string, text: string): Edit {
	const [start, end] = node.range!;
	const trailing = /\s*$/.exec(source.slice(start, end))![0];
	return { start, end, text: text + trailing };
}

/** Every string a parsed value holds, keys included. */
function strings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) strings(item, out);
	else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { out.push(key); strings(item, out); }
	return out;
}

/** Whether any string in `value` (keys included) contains a known credential. */
export function leaksSecret(value: unknown, known: readonly string[]): boolean {
	const texts = strings(value);
	return known.some(secret => texts.some(text => text.includes(secret)));
}

/** Mask every credential in `text`, or `{ ok: false }` when that cannot be done unambiguously. */
export function maskModelsYaml(text: string): MaskResult {
	const doc = parse(text);
	const reached = doc && reach(doc);
	if (!doc || !reached) return { ok: false, known: [] };
	const secrets = new Map<string, Secret>();
	const knownSet = new Set<string>();
	for (const node of reached.masked) {
		if (node.value === null || node.value === undefined) continue;
		const value = String(node.value);
		if (value === "") continue;
		knownSet.add(value);
		// A masked URL's credential pieces must not survive anywhere either.
		if (reached.url.has(node) && isSensitiveUrl(value)) for (const part of urlCredentialParts(value)) knownSet.add(part);
		secrets.set(placeholderFor(value), { value: node.value, text: value });
	}
	const known = [...knownSet];
	// Longest first, so a credential containing another is replaced whole.
	const replaceable = known.filter(secret => secret.length >= MIN_REPLACE).sort((a, b) => b.length - a.length);
	const edits: Edit[] = [];
	for (const node of allScalars(doc)) {
		if (!node.range) continue;
		if (reached.masked.has(node)) {
			if (knownSet.has(String(node.value))) edits.push(scalarEdit(node, text, JSON.stringify(placeholderFor(String(node.value)))));
		} else if (typeof node.value === "string") {
			let value = node.value;
			for (const secret of replaceable) value = value.split(secret).join(placeholderFor(secret));
			if (value !== node.value) edits.push(scalarEdit(node, text, JSON.stringify(value)));
		}
	}
	// A comment inside a rewritten scalar (a block scalar's header comment) goes with it.
	const rewritten = [...edits];
	const commentSources = new Map<string, string>();
	for (const comment of comments(text)) {
		if (rewritten.some(edit => comment.offset >= edit.start && comment.offset < edit.end)) continue;
		const placeholder = commentPlaceholderFor(comment.source);
		commentSources.set(placeholder, comment.source);
		edits.push({ start: comment.offset, end: comment.offset + comment.source.length, text: placeholder });
	}
	const masked = applyEdits(text, edits);
	// Nothing known may survive: not in the text, not in a decoded (escaped) scalar, not in what NeoPi's parser reads.
	if (known.some(secret => masked.includes(secret))) return { ok: false, known };
	const check = parse(masked);
	if (!check || known.some(secret => allScalars(check).some(node => String(node.value).includes(secret)))) return { ok: false, known };
	if (!onlyCommentPlaceholders(masked)) return { ok: false, known };
	try {
		if (leaksSecret(Bun.YAML.parse(masked), known)) return { ok: false, known };
	} catch {
		return { ok: false, known };
	}
	return { ok: true, masked, secrets, comments: commentSources, known };
}

/** Line (1-based) of an offset, for messages. */
function lineOf(text: string, offset: number): number {
	return text.slice(0, offset).split("\n").length;
}

/** Walk NeoPi's parse of the submitted and restored documents together; they may differ only where a placeholder was restored. */
function sameExceptRestored(submitted: unknown, restored: unknown, path: PathKey[], secrets: Map<string, Secret>): boolean {
	if (typeof submitted === "string" && submitted.includes(COMMENT_MARK)) return false;
	if (typeof submitted === "string" && submitted.includes(MASK_MARK)) {
		if (!PLACEHOLDER_EXACT.test(submitted)) return false;
		const secret = secrets.get(submitted);
		return secret !== undefined && restorableAt(path, secret) && Bun.deepEquals(secret.value, restored);
	}
	if (Array.isArray(submitted)) {
		return Array.isArray(restored) && submitted.length === restored.length
			&& submitted.every((item, index) => sameExceptRestored(item, restored[index], [...path, index], secrets));
	}
	if (submitted && typeof submitted === "object") {
		if (!restored || typeof restored !== "object" || Array.isArray(restored)) return false;
		const keys = Object.keys(submitted);
		const other = restored as Record<string, unknown>;
		if (keys.length !== Object.keys(other).length || keys.some(key => key.includes(MASK_MARK) || key.includes(COMMENT_MARK) || !(key in other))) return false;
		return keys.every(key => sameExceptRestored((submitted as Record<string, unknown>)[key], other[key], [...path, key], secrets));
	}
	return Bun.deepEquals(submitted, restored);
}

const OUTSIDE_CREDENTIAL = "can only be restored as the whole value of an apiKey, a header or a requestMetadata entry, or a masked URL as a whole baseUrl. Replace it with the full value, or remove it.";
const OUTSIDE_COMMENT = "a comment placeholder is restored only as a whole, unchanged comment. Leave it exactly as shown, or delete it and write the comment you want.";
const STALE_PLACEHOLDER = "does not match the file on disk (it changed, or the deck restarted since the editor loaded). Reload, then reapply your edits.";

/**
 * Put the credentials from `secrets` and the comments from `comments` (the
 * on-disk file's masking) back in place of their placeholders. A credential
 * placeholder is restored only where it is the whole value of a credential
 * position (a masked URL also as a whole baseUrl); anywhere else (a name, id, key, baseUrl, comment, tag, or an alias
 * reaching another field) the document is refused with 400 before anything is
 * validated or written. A comment placeholder is restored only as a whole,
 * unchanged comment, and refused with 400 anywhere else. An unknown
 * placeholder of either kind is refused with 409.
 */
export function restoreModelsYaml(raw: string, secrets: Map<string, Secret>, commentSources: Map<string, string>): string {
	if (!raw.includes(MASK_MARK) && !raw.includes(COMMENT_MARK)) return raw;
	const doc = parse(raw);
	const reached = doc && reach(doc);
	if (!doc || !reached) {
		throw new PlaceholderError("The document holds masked credentials or comments but is not valid YAML, so they cannot be located.", 400);
	}
	const edits: Edit[] = [];
	const ranges: Array<[number, number]> = [];
	let unknown = false;
	for (const node of new Set([...reached.credential, ...reached.url])) {
		if (reached.elsewhere.has(node) || typeof node.value !== "string" || !node.value.includes(MASK_MARK) || !node.range) continue;
		if (!PLACEHOLDER_EXACT.test(node.value)) {
			throw new PlaceholderError(`Line ${lineOf(raw, node.range[0])}: a masked credential ${OUTSIDE_CREDENTIAL}`, 400);
		}
		ranges.push([node.range[0], node.range[1]]);
		const secret = secrets.get(node.value);
		if (!secret) { unknown = true; continue; }
		// A baseUrl takes back only a masked URL: any other credential there would be shown on the next read.
		const urlOk = !reached.url.has(node) || (typeof secret.value === "string" && isSensitiveUrl(secret.value));
		if (!urlOk) throw new PlaceholderError(`Line ${lineOf(raw, node.range[0])}: a masked credential ${OUTSIDE_CREDENTIAL}`, 400);
		edits.push(scalarEdit(node, raw, JSON.stringify(secret.value)));
	}
	const commentRanges: Array<[number, number]> = [];
	for (const comment of comments(raw)) {
		if (!comment.source.includes(COMMENT_MARK) || !COMMENT_EXACT.test(comment.source)) continue;
		const end = comment.offset + comment.source.length;
		commentRanges.push([comment.offset, end]);
		const original = commentSources.get(comment.source);
		if (original !== undefined) edits.push({ start: comment.offset, end, text: original });
		else unknown = true;
	}
	const inside = (at: number, within: Array<[number, number]>) => within.some(([start, end]) => at >= start && at < end);
	for (let at = raw.indexOf(MASK_MARK); at >= 0; at = raw.indexOf(MASK_MARK, at + 1)) {
		if (!inside(at, ranges)) throw new PlaceholderError(`Line ${lineOf(raw, at)}: a masked credential ${OUTSIDE_CREDENTIAL}`, 400);
	}
	for (let at = raw.indexOf(COMMENT_MARK); at >= 0; at = raw.indexOf(COMMENT_MARK, at + 1)) {
		if (!inside(at, commentRanges)) throw new PlaceholderError(`Line ${lineOf(raw, at)}: ${OUTSIDE_COMMENT}`, 400);
	}
	if (unknown) throw new PlaceholderError(`A masked credential or comment ${STALE_PLACEHOLDER}`, 409);
	const restored = applyEdits(raw, edits);
	// Cross-check with the parser NeoPi uses: only restored credential positions may differ.
	let submittedData: unknown;
	try {
		submittedData = Bun.YAML.parse(raw);
	} catch {
		return restored; // NeoPi rejects the submitted document itself; nothing is written.
	}
	let restoredData: unknown;
	try {
		restoredData = Bun.YAML.parse(restored);
	} catch {
		throw new PlaceholderError("The masked credentials could not be restored unambiguously. Replace them with the full values.", 400);
	}
	if (!sameExceptRestored(submittedData, restoredData, [], secrets)) {
		throw new PlaceholderError(`A masked credential ${OUTSIDE_CREDENTIAL}`, 400);
	}
	return restored;
}

const WITHHELD = "NeoPi rejects this document; its message is withheld because it would quote a credential. The deck server log has the details.";

/** `message` with known credentials replaced, or a withheld notice when that is ambiguous. */
export function safeMessage(message: string, known: readonly string[]): string {
	let out = message;
	for (const secret of [...known].filter(s => s.length >= MIN_REPLACE).sort((a, b) => b.length - a.length)) out = out.split(secret).join("<masked>");
	return known.some(secret => out.includes(secret)) ? WITHHELD : out;
}

export const WITHHELD_MESSAGE = WITHHELD;
