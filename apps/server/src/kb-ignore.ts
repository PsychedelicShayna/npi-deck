/**
 * `.kbignore` matcher: gitignore syntax, evaluated against forward-slash
 * paths relative to the KB root.
 *
 * Supported, with git's semantics:
 * - blank lines and `#` comments; `\#` and `\!` for a literal leading `#`/`!`
 * - trailing spaces are dropped unless escaped (`\ `)
 * - `!pattern` re-includes a path an earlier pattern excluded; the last
 *   matching pattern wins
 * - `pattern/` matches directories only
 * - a `/` at the start or in the middle anchors the pattern to the KB root;
 *   otherwise it matches a name at any depth
 * - `*`, `?` and `[...]` (with `!`/`^` negation and `[:class:]` names) never
 *   match `/`; `**` as a whole segment spans directories (`**` + `/x`,
 *   `x/` + `**`, `a/` + `**` + `/b`); any other `**` is a plain `*`
 * - a path inside an excluded directory stays excluded, whatever later
 *   negations say (git cannot re-include a file whose parent is excluded)
 *
 * Matching is case-sensitive, like git's default on Linux.
 */

export const KB_IGNORE_FILE = ".kbignore";

interface Rule {
	regex: RegExp;
	negated: boolean;
	dirOnly: boolean;
}

const POSIX_CLASSES: Record<string, string> = {
	alnum: "a-zA-Z0-9",
	alpha: "a-zA-Z",
	blank: " \\t",
	cntrl: "\\x00-\\x1f\\x7f",
	digit: "0-9",
	graph: "\\x21-\\x7e",
	lower: "a-z",
	print: "\\x20-\\x7e",
	punct: "!-\\/:-@\\[-`{-~",
	space: " \\t\\n\\r\\f\\v",
	upper: "A-Z",
	xdigit: "0-9A-Fa-f",
};

export class KbIgnore {
	private constructor(private readonly rules: readonly Rule[]) {}

	static readonly empty = new KbIgnore([]);

	/** Parse `.kbignore` text. Lines that cannot form a pattern are skipped. */
	static parse(text: string): KbIgnore {
		const rules: Rule[] = [];
		for (const line of text.split(/\r?\n/)) {
			const rule = parseLine(line);
			if (rule) rules.push(rule);
		}
		return new KbIgnore(rules);
	}

	/**
	 * Is `rel` excluded? Checks every ancestor directory first, so a path
	 * under an excluded directory is excluded even if a later `!` pattern
	 * names it. `isDir` describes the last segment only.
	 */
	ignores(rel: string, isDir: boolean): boolean {
		if (this.rules.length === 0 || !rel) return false;
		let slash = rel.indexOf("/");
		while (slash >= 0) {
			if (this.ignoresEntry(rel.slice(0, slash), true)) return true;
			slash = rel.indexOf("/", slash + 1);
		}
		return this.ignoresEntry(rel, isDir);
	}

	/**
	 * Last-match-wins verdict for `rel` itself. For a tree walk that has
	 * already pruned excluded directories, so ancestors need no recheck.
	 */
	ignoresEntry(rel: string, isDir: boolean): boolean {
		for (let i = this.rules.length - 1; i >= 0; i--) {
			const rule = this.rules[i]!;
			if (rule.dirOnly && !isDir) continue;
			if (rule.regex.test(rel)) return !rule.negated;
		}
		return false;
	}
}

function parseLine(raw: string): Rule | undefined {
	let line = stripTrailingSpaces(raw);
	if (!line || line.startsWith("#")) return undefined;

	let negated = false;
	if (line.startsWith("!")) {
		negated = true;
		line = line.slice(1);
	}

	let dirOnly = false;
	if (line.endsWith("/")) {
		dirOnly = true;
		line = line.replace(/\/+$/, "");
	}

	// A separator at the start or in the middle anchors the pattern.
	const anchored = line.includes("/");
	line = line.replace(/^\/+/, "");
	if (!line) return undefined;

	const body = compileSegments(line.split("/"));
	if (body === undefined) return undefined;
	const prefix = anchored ? "^" : "^(?:.*/)?";
	return { regex: new RegExp(`${prefix}${body}$`), negated, dirOnly };
}

/**
 * Drop unescaped trailing spaces. `foo\ ` keeps one space; the backslash
 * itself is removed later by the glob compiler.
 */
function stripTrailingSpaces(line: string): string {
	let end = line.length;
	while (end > 0 && line[end - 1] === " ") {
		let backslashes = 0;
		for (let i = end - 2; i >= 0 && line[i] === "\\"; i--) backslashes++;
		if (backslashes % 2 === 1) break;
		end--;
	}
	return line.slice(0, end);
}

function compileSegments(segments: string[]): string | undefined {
	let out = "";
	const last = segments.length - 1;
	for (let i = 0; i <= last; i++) {
		const seg = segments[i]!;
		if (seg === "**") {
			if (i === last) {
				// `x/**`: everything inside, not `x` itself.
				out += i === 0 ? ".*" : ".+";
			} else {
				// `**/x` and `a/**/b`: zero or more whole directories.
				out += "(?:.*/)?";
			}
			continue;
		}
		const glob = compileGlob(seg);
		if (glob === undefined) return undefined;
		out += glob;
		if (i < last) out += "/";
	}
	return out;
}

function compileGlob(seg: string): string | undefined {
	let out = "";
	for (let i = 0; i < seg.length; i++) {
		const ch = seg[i]!;
		if (ch === "\\") {
			// A trailing lone backslash cannot escape anything; git treats
			// the pattern as invalid.
			if (i + 1 >= seg.length) return undefined;
			out += escapeRegex(seg[++i]!);
			continue;
		}
		if (ch === "*") {
			while (seg[i + 1] === "*") i++;
			out += "[^/]*";
			continue;
		}
		if (ch === "?") {
			out += "[^/]";
			continue;
		}
		if (ch === "[") {
			const cls = compileClass(seg, i);
			if (cls) {
				out += cls.regex;
				i = cls.end;
				continue;
			}
			out += "\\[";
			continue;
		}
		out += escapeRegex(ch);
	}
	return out;
}

/**
 * Compile a bracket expression starting at `seg[start] === "["`. Returns
 * undefined for an unterminated bracket, which then matches a literal `[`.
 */
function compileClass(seg: string, start: number): { regex: string; end: number } | undefined {
	let i = start + 1;
	let negated = false;
	if (seg[i] === "!" || seg[i] === "^") {
		negated = true;
		i++;
	}
	let body = "";
	let first = true;
	while (i < seg.length) {
		const ch = seg[i]!;
		if (ch === "]" && !first) {
			const regex = negated ? `[^/${body}]` : `(?!/)[${body}]`;
			return { regex, end: i };
		}
		first = false;
		if (ch === "[" && seg[i + 1] === ":") {
			const close = seg.indexOf(":]", i + 2);
			const name = close >= 0 ? seg.slice(i + 2, close) : "";
			const posix = POSIX_CLASSES[name];
			if (posix === undefined) return undefined;
			body += posix;
			i = close + 2;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= seg.length) return undefined;
			body += escapeClassChar(seg[i + 1]!);
			i += 2;
			continue;
		}
		body += escapeClassChar(ch);
		i++;
	}
	return undefined;
}

function escapeRegex(ch: string): string {
	return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

function escapeClassChar(ch: string): string {
	// `-` stays live so ranges like `a-z` work.
	return /[\]\\^[]/.test(ch) ? `\\${ch}` : ch;
}
