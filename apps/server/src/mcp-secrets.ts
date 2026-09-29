/**
 * Credentials an MCP server config can carry, and a scrubber that removes
 * them from text the deck shows or stores. Settings → MCP servers never sends
 * a value; routine `mcp` steps and the Integrations probe relay what a server
 * said, and a server can echo its own env, argv or URL back, so everything
 * they record passes through {@link scrubberFor} first.
 */
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

/**
 * A flag whose argument is a credential. Used only to decide what to hide;
 * anything it misses is still safe, because values the deck shows are limited
 * to arguments and URLs the user typed, and env/header values are never sent.
 */
export const SECRET_FLAG = /(key|token|secret|password|passwd|credential|auth|cookie|session|bearer|pat)/i;
export const REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

/**
 * Shorter values are not scrubbed: replacing every `1`, `true` or `mcp` in a
 * tool result would destroy it, and no credential is that short.
 */
const MIN_SECRET_LENGTH = 6;

/** An argument that is a credential only because a `--api-key`-shaped flag precedes it. */
export function isSecretFlag(arg: string | undefined): boolean {
	return arg !== undefined && arg.startsWith("-") && !arg.includes("=") && SECRET_FLAG.test(arg);
}

function decoded(part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}

/**
 * Parts of a URL that can be a credential: the whole URL, userinfo, host,
 * every path segment, query value and the fragment. Mirrors Settings → MCP
 * servers, which shows none of them.
 */
function urlSecrets(raw: string, out: Set<string>): void {
	out.add(raw);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return;
	}
	out.add(`${url.origin}${url.pathname}`);
	for (const part of [url.username, url.password, url.hostname, url.hash.slice(1)]) out.add(decoded(part));
	for (const segment of url.pathname.split("/")) out.add(decoded(segment));
	for (const [, value] of url.searchParams) out.add(value);
	// `#access_token=…` style fragments carry their values like a query.
	for (const [, value] of new URLSearchParams(url.hash.slice(1))) out.add(value);
}

function collectStrings(value: unknown, out: Set<string>): void {
	if (typeof value === "string") out.add(value);
	else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
	else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, out);
}

/**
 * Every value in `config` that can be a credential: env and header values
 * (and the token of an `Authorization: Bearer …` value), the URL and its
 * parts, any URL inside an argument, the value after a key-shaped flag or
 * right of `--key=`, and every string under `auth`/`oauth`. Pass the config
 * NeoPi resolved as well as the stored one, so `!command` env values and
 * injected OAuth tokens are covered.
 */
export function configSecrets(config: MCPServerConfig): string[] {
	const out = new Set<string>();
	if ("env" in config) for (const value of Object.values(config.env ?? {})) out.add(value);
	if ("headers" in config) {
		for (const value of Object.values(config.headers ?? {})) {
			out.add(value);
			const token = /^\s*\S+\s+(\S+)\s*$/.exec(value)?.[1];
			if (token) out.add(token);
		}
	}
	if ("url" in config && typeof config.url === "string") urlSecrets(config.url, out);
	if ("args" in config) {
		let valueOfSecretFlag = false;
		for (const raw of config.args ?? []) {
			const arg = String(raw);
			if (valueOfSecretFlag) out.add(arg);
			valueOfSecretFlag = isSecretFlag(arg);
			const equals = arg.indexOf("=");
			if (arg.startsWith("-") && equals > 0 && SECRET_FLAG.test(arg.slice(0, equals))) out.add(arg.slice(equals + 1));
			for (const match of arg.matchAll(/[a-z][a-z0-9+.-]*:\/\/\S+/gi)) urlSecrets(match[0], out);
		}
	}
	collectStrings(config.auth, out);
	collectStrings(config.oauth, out);
	return [...out];
}

export type Scrub = (text: string) => string;

/** Replace every occurrence of each secret (and its URL-encoded form), longest first. */
export function scrubberFor(secrets: Iterable<string>): Scrub {
	const needles = new Set<string>();
	for (const secret of secrets) {
		if (typeof secret !== "string" || secret.trim().length < MIN_SECRET_LENGTH) continue;
		needles.add(secret);
		const encoded = encodeURIComponent(secret);
		if (encoded !== secret) needles.add(encoded);
	}
	const ordered = [...needles].sort((a, b) => b.length - a.length);
	if (ordered.length === 0) return text => text;
	return text => {
		let out = text;
		for (const needle of ordered) if (out.includes(needle)) out = out.split(needle).join(REDACTED);
		return out;
	};
}

/** {@link Scrub} applied to every string, key included, of a JSON-shaped value. */
export function scrubDeep<T>(value: T, scrub: Scrub): T {
	if (typeof value === "string") return scrub(value) as T;
	if (Array.isArray(value)) return value.map(item => scrubDeep(item, scrub)) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[scrub(key)] = scrubDeep(item, scrub);
		return out as T;
	}
	return value;
}
