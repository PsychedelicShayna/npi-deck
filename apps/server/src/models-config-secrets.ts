/**
 * Credential masking for models.yml as the Settings editor shows it.
 *
 * Every value under a credential-like key (`apiKey`, `Authorization`,
 * `x-api-key`, …) is replaced in the document text by a placeholder
 * `<npi-deck-masked:ID>`; so is every other occurrence of such a value (inside
 * a URL, under an alias's anchor, in a commented-out line) and, in a comment,
 * everything after the first credential-like key (`# apiKey: sk-…`). All other
 * text, comments and layout included, is kept byte for byte.
 *
 * ID is an HMAC of the value under a per-process key, so a placeholder names
 * a value without revealing it and survives edits that move it. Saving
 * restores each placeholder from the file on disk; a placeholder whose value
 * is no longer there (the file changed, or the server restarted) is refused.
 */
import { createHmac, randomBytes } from "node:crypto";
import { isAlias, isMap, isScalar, isSeq, parseDocument, Parser, type Document, type Scalar } from "yaml";

const PLACEHOLDER = /<npi-deck-masked:([0-9a-f]{16})>/g;
const PLACEHOLDER_PREFIX = "<npi-deck-masked:";
const SECRET_KEY_SUFFIXES = ["key", "authorization", "token", "secret", "password", "cookie", "credential", "credentials"];
/** Values this short are not credentials in any practical sense, and substituting them would garble unrelated text. */
const MIN_SECRET_LENGTH = 4;
/** A `key:` or `key=` inside a comment; after a credential-like one, the rest of the comment is masked. */
const COMMENT_KEY = /([A-Za-z0-9_-]+)["']?[ \t]*[:=][ \t]*/g;

const hmacKey = randomBytes(32);

export function isSecretKey(key: unknown): boolean {
	if (typeof key !== "string") return false;
	const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
	return SECRET_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

function placeholderFor(text: string): string {
	return `${PLACEHOLDER_PREFIX}${createHmac("sha256", hmacKey).update(text).digest("hex").slice(0, 16)}>`;
}

/** A masked credential: its scalar value (typed, for exact restores) and its text. */
interface Secret {
	value: unknown;
	text: string;
}

export type MaskResult =
	| { ok: true; masked: string; secrets: Map<string, Secret> }
	| { ok: false };

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

/** Every scalar in the document, map keys included, in source order. */
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

/** Scalars holding credentials: every scalar under a credential-like key, following aliases to their anchors. */
function credentialScalars(doc: Document): Set<Scalar> {
	const found = new Set<Scalar>();
	const seen = new Set<unknown>();
	const collect = (node: unknown): void => {
		if (seen.has(node)) return;
		seen.add(node);
		if (isAlias(node)) collect(node.resolve(doc));
		else if (isScalar(node)) { if (node.value !== null && node.value !== undefined) found.add(node); }
		else if (isMap(node)) for (const pair of node.items) collect(pair.value);
		else if (isSeq(node)) for (const item of node.items) collect(item);
	};
	const walk = (node: unknown): void => {
		if (isMap(node)) {
			for (const pair of node.items) {
				if (isSecretKey(isScalar(pair.key) ? pair.key.value : undefined)) collect(pair.value);
				else walk(pair.value);
			}
		} else if (isSeq(node)) for (const item of node.items) walk(item);
	};
	walk(doc.contents);
	return found;
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

/** Replacement text for a scalar's source range; a block scalar's range ends with its line break, which must stay. */
function scalarEdit(node: Scalar, source: string, text: string): Edit {
	const [start, end] = node.range!;
	const trailing = /\s*$/.exec(source.slice(start, end))![0];
	return { start, end, text: text + trailing };
}

function replaceAll(text: string, secrets: Map<string, Secret>): string {
	let out = text;
	for (const [id, secret] of secrets) if (secret.text.length >= MIN_SECRET_LENGTH) out = out.split(secret.text).join(id);
	return out;
}

/**
 * Mask everything after the first credential-like `key:` in a comment
 * (`# apiKey: sk-…`, `# Authorization: Bearer …`), keeping trailing blanks.
 * A rest that already holds a placeholder is left alone: a nested one would not restore.
 */
function maskCommentAssignment(comment: string, secrets: Map<string, Secret>): string {
	for (const match of comment.matchAll(COMMENT_KEY)) {
		if (!isSecretKey(match[1])) continue;
		const start = (match.index ?? 0) + match[0].length;
		const value = comment.slice(start).trimEnd();
		if (value === "" || value.includes(PLACEHOLDER_PREFIX)) return comment;
		const id = placeholderFor(value);
		secrets.set(id, { value, text: value });
		return comment.slice(0, start) + id + comment.slice(start + value.length);
	}
	return comment;
}

/**
 * Mask every credential in `text`. Fails closed: `{ ok: false }` when the
 * document cannot be parsed (its credentials cannot be located) or when a
 * credential would still appear in the masked text.
 */
export function maskModelsYaml(text: string): MaskResult {
	const doc = parse(text);
	if (!doc) return { ok: false };
	const secrets = new Map<string, Secret>();
	const credential = credentialScalars(doc);
	for (const node of credential) {
		const value = String(node.value);
		secrets.set(placeholderFor(value), { value: node.value, text: value });
	}
	const edits: Edit[] = [];
	for (const node of allScalars(doc)) {
		if (!node.range) continue;
		if (credential.has(node)) {
			edits.push(scalarEdit(node, text, JSON.stringify(placeholderFor(String(node.value)))));
		} else if (typeof node.value === "string") {
			const masked = replaceAll(node.value, secrets);
			if (masked !== node.value) edits.push(scalarEdit(node, text, JSON.stringify(masked)));
		}
	}
	for (const comment of comments(text)) {
		const masked = maskCommentAssignment(replaceAll(comment.source, secrets), secrets);
		if (masked !== comment.source) edits.push({ start: comment.offset, end: comment.offset + comment.source.length, text: masked });
	}
	const masked = applyEdits(text, edits);
	// Structural credentials must be gone. A comment assignment is masked where it
	// appears only: its "value" may be an ordinary word used elsewhere in the file.
	for (const node of credential) {
		const value = String(node.value);
		if (value.length >= MIN_SECRET_LENGTH && masked.includes(value)) return { ok: false };
	}
	return { ok: true, masked, secrets };
}

export class PlaceholderError extends Error {}

/**
 * Put the credentials from `secrets` (the on-disk file's masking) back in
 * place of their placeholders in a submitted document. A scalar that is a
 * placeholder becomes the original value; a placeholder inside a longer
 * value or a comment becomes the original text. Throws PlaceholderError for a
 * placeholder `secrets` does not hold, or one the document's structure hides.
 */
export function restoreModelsYaml(text: string, secrets: Map<string, Secret>): string {
	if (!text.includes(PLACEHOLDER_PREFIX)) return text;
	const lookup = (id: string): Secret => {
		const secret = secrets.get(id);
		if (!secret) throw new PlaceholderError(`${id} does not match a credential in the file on disk (it changed, or the deck restarted since the editor loaded). Reload, then reapply your edits.`);
		return secret;
	};
	const doc = parse(text);
	if (!doc) throw new PlaceholderError("The document has masked credentials but is not valid YAML, so they cannot be restored.");
	const edits: Edit[] = [];
	for (const node of allScalars(doc)) {
		if (!node.range || typeof node.value !== "string" || !node.value.includes(PLACEHOLDER_PREFIX)) continue;
		const exact = /^<npi-deck-masked:[0-9a-f]{16}>$/.test(node.value) ? lookup(node.value) : undefined;
		const restored = exact
			? JSON.stringify(exact.value)
			: JSON.stringify(node.value.replace(PLACEHOLDER, id => lookup(id).text));
		edits.push(scalarEdit(node, text, restored));
	}
	for (const comment of comments(text)) {
		if (!comment.source.includes(PLACEHOLDER_PREFIX)) continue;
		const restored = comment.source.replace(PLACEHOLDER, id => {
			const value = lookup(id).text;
			if (/[\r\n]/.test(value)) throw new PlaceholderError("A multi-line credential cannot be restored inside a comment; remove its placeholder from the comment.");
			return value;
		});
		edits.push({ start: comment.offset, end: comment.offset + comment.source.length, text: restored });
	}
	const out = applyEdits(text, edits);
	if (out.includes(PLACEHOLDER_PREFIX)) {
		throw new PlaceholderError("A masked credential sits where it cannot be restored (a tag, anchor or directive). Replace it with the full value.");
	}
	return out;
}

/** Every credential value in a parseable document, for scrubbing messages. */
export function credentialValues(text: string): string[] {
	const doc = parse(text);
	if (!doc) return [];
	return [...credentialScalars(doc)].map(node => String(node.value));
}

/** `message` with each of `values` replaced by a placeholder mark, so an error never quotes a credential. */
export function scrubCredentials(message: string, values: Iterable<string>): string {
	let out = message;
	for (const value of [...values].sort((a, b) => b.length - a.length)) {
		if (value.length >= MIN_SECRET_LENGTH) out = out.split(value).join("<masked>");
	}
	return out;
}
