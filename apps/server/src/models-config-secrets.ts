/**
 * Credential masking for models.yml as the Settings editor shows it. Fails
 * closed: when a credential cannot be removed from the text unambiguously, the
 * text is withheld rather than partially masked.
 *
 * Masked (replaced by a placeholder `<npi-deck-masked:ID>`):
 * - every value in a credential position of NeoPi's schema: a provider's
 *   `apiKey`, every header value under any name (provider, model and model
 *   override headers) and every `requestMetadata` value;
 * - every value under a credential-like key anywhere else (`token`, `secret`,
 *   `password`, `*key`, …), following aliases and merge keys;
 * - every other occurrence of such a value at least MIN_REPLACE long, in any
 *   scalar or key;
 * - in a comment, everything after a credential-like word, a known credential,
 *   a long token-like string or placeholder-looking text.
 * A known credential still present anywhere (a short one, one hidden by an
 * escape) withholds the whole text.
 *
 * ID is an HMAC of the value under a per-process key. Saving restores a
 * placeholder only where it is the whole value of a credential position; a
 * placeholder anywhere else is refused, so a credential can never be moved
 * into a field the deck shows.
 */
import { createHmac, randomBytes } from "node:crypto";
import { isAlias, isMap, isScalar, isSeq, parseDocument, Parser, type Document, type Scalar } from "yaml";

export const MASK_MARK = "npi-deck-masked";
const PLACEHOLDER_EXACT = /^<npi-deck-masked:[0-9a-f]{16}>$/;
const SECRET_KEY_SUFFIXES = ["key", "authorization", "token", "secret", "password", "cookie", "credential", "credentials"];
/** Shorter credentials are not substituted inside other text (the match would be ambiguous); their presence withholds the text. */
const MIN_REPLACE = 8;
/** Token-like runs in comments that could be a credential nobody labelled. */
const TOKEN_LIKE = /[A-Za-z0-9_\-+/=.]{20,}/g;
/** Walk budget: aliases can multiply a document exponentially. */
const MAX_VISITS = 100_000;

const hmacKey = randomBytes(32);

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

function placeholderFor(text: string): string {
	return `<${MASK_MARK}:${createHmac("sha256", hmacKey).update(text).digest("hex").slice(0, 16)}>`;
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
	| { ok: true; masked: string; secrets: Map<string, Secret>; known: string[] }
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
	/** Scalars reached through a credential position or under a credential-like key: masked. */
	masked: Set<Scalar>;
	/** Scalars reached through a credential position of the schema. */
	credential: Set<Scalar>;
	/** Scalars reached through any other position. */
	elsewhere: Set<Scalar>;
}

/**
 * Classify every scalar by each position it is reachable from, following
 * aliases and `<<` merge keys to the data paths NeoPi sees. Undefined when the
 * document exceeds the walk budget.
 */
function reach(doc: Document): Reach | undefined {
	const result: Reach = { masked: new Set(), credential: new Set(), elsewhere: new Set() };
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
			(credential ? result.credential : result.elsewhere).add(node);
			if (secret || credential) result.masked.add(node);
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

/** Where a comment stops being safe to show, or undefined when all of it is. */
function commentCut(source: string, known: readonly string[]): number | undefined {
	let cut = Number.POSITIVE_INFINITY;
	for (const word of source.matchAll(/[A-Za-z0-9_-]+/g)) {
		if (!isSecretKey(word[0])) continue;
		const end = word.index + word[0].length;
		cut = end + /^["']?[ \t]*[:=]?[ \t]*/.exec(source.slice(end))![0].length;
		break;
	}
	for (const secret of known) {
		const at = source.indexOf(secret);
		if (at >= 0) cut = Math.min(cut, at);
	}
	const mark = source.indexOf(MASK_MARK);
	if (mark >= 0) cut = Math.min(cut, Math.max(0, source.lastIndexOf("<", mark)));
	for (const token of source.matchAll(TOKEN_LIKE)) {
		if (/[A-Za-z]/.test(token[0]) && /[0-9]/.test(token[0])) { cut = Math.min(cut, token.index); break; }
	}
	// Never before the comment's `#`, which must stay for the line to remain a comment.
	return Number.isFinite(cut) ? Math.max(1, cut) : undefined;
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
	for (const comment of comments(text)) {
		const cut = commentCut(comment.source, known);
		if (cut === undefined) continue;
		const tail = comment.source.slice(cut).trimEnd();
		if (tail === "") continue;
		edits.push({ start: comment.offset + cut, end: comment.offset + cut + tail.length, text: placeholderFor(tail) });
	}
	const masked = applyEdits(text, edits);
	// Nothing known may survive: not in the text, not in a decoded (escaped) scalar, not in what NeoPi's parser reads.
	if (known.some(secret => masked.includes(secret))) return { ok: false, known };
	const check = parse(masked);
	if (!check || known.some(secret => allScalars(check).some(node => String(node.value).includes(secret)))) return { ok: false, known };
	try {
		if (leaksSecret(Bun.YAML.parse(masked), known)) return { ok: false, known };
	} catch {
		return { ok: false, known };
	}
	return { ok: true, masked, secrets, known };
}

/** Line (1-based) of an offset, for messages. */
function lineOf(text: string, offset: number): number {
	return text.slice(0, offset).split("\n").length;
}

/** Walk NeoPi's parse of the submitted and restored documents together; they may differ only where a placeholder was restored. */
function sameExceptRestored(submitted: unknown, restored: unknown, path: PathKey[], secrets: Map<string, Secret>): boolean {
	if (typeof submitted === "string" && submitted.includes(MASK_MARK)) {
		if (!isCredentialPath(path) || !PLACEHOLDER_EXACT.test(submitted)) return false;
		const secret = secrets.get(submitted);
		return secret !== undefined && Bun.deepEquals(secret.value, restored);
	}
	if (Array.isArray(submitted)) {
		return Array.isArray(restored) && submitted.length === restored.length
			&& submitted.every((item, index) => sameExceptRestored(item, restored[index], [...path, index], secrets));
	}
	if (submitted && typeof submitted === "object") {
		if (!restored || typeof restored !== "object" || Array.isArray(restored)) return false;
		const keys = Object.keys(submitted);
		const other = restored as Record<string, unknown>;
		if (keys.length !== Object.keys(other).length || keys.some(key => key.includes(MASK_MARK) || !(key in other))) return false;
		return keys.every(key => sameExceptRestored((submitted as Record<string, unknown>)[key], other[key], [...path, key], secrets));
	}
	return Bun.deepEquals(submitted, restored);
}

const OUTSIDE_CREDENTIAL = "can only be restored as the whole value of an apiKey, a header or a requestMetadata entry. Replace it with the full value, or remove it (delete a masked comment).";

/**
 * Put the credentials from `secrets` (the on-disk file's masking) back in
 * place of their placeholders. A placeholder is restored only where it is the
 * whole value of a credential position; anywhere else (a name, id, key,
 * baseUrl, comment, tag, or an alias reaching another field) the document is
 * refused with 400 before anything is validated or written, and an unknown
 * placeholder with 409.
 */
export function restoreModelsYaml(raw: string, secrets: Map<string, Secret>): string {
	if (!raw.includes(MASK_MARK)) return raw;
	const doc = parse(raw);
	const reached = doc && reach(doc);
	if (!doc || !reached) {
		throw new PlaceholderError("The document holds masked credentials but is not valid YAML, so they cannot be located.", 400);
	}
	const edits: Edit[] = [];
	const ranges: Array<[number, number]> = [];
	for (const node of reached.credential) {
		if (reached.elsewhere.has(node) || typeof node.value !== "string" || !node.value.includes(MASK_MARK) || !node.range) continue;
		if (!PLACEHOLDER_EXACT.test(node.value)) {
			throw new PlaceholderError(`Line ${lineOf(raw, node.range[0])}: a masked credential ${OUTSIDE_CREDENTIAL}`, 400);
		}
		ranges.push([node.range[0], node.range[1]]);
		const secret = secrets.get(node.value);
		if (secret) edits.push(scalarEdit(node, raw, JSON.stringify(secret.value)));
	}
	for (let at = raw.indexOf(MASK_MARK); at >= 0; at = raw.indexOf(MASK_MARK, at + 1)) {
		if (!ranges.some(([start, end]) => at >= start && at < end)) {
			throw new PlaceholderError(`Line ${lineOf(raw, at)}: a masked credential ${OUTSIDE_CREDENTIAL}`, 400);
		}
	}
	if (edits.length !== ranges.length) {
		throw new PlaceholderError("A masked credential does not match one in the file on disk (it changed, or the deck restarted since the editor loaded). Reload, then reapply your edits.", 409);
	}
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
