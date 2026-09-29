import { describe, expect, test } from "bun:test";

import { KbIgnore } from "./kb-ignore.ts";

const file = (rules: string, rel: string): boolean => KbIgnore.parse(rules).ignores(rel, false);
const dir = (rules: string, rel: string): boolean => KbIgnore.parse(rules).ignores(rel, true);

describe(".kbignore syntax", () => {
	test("a bare name matches at any depth, as a file or a directory", () => {
		expect(file("secret.md", "secret.md")).toBe(true);
		expect(file("secret.md", "a/b/secret.md")).toBe(true);
		expect(dir("drafts", "notes/drafts")).toBe(true);
		expect(file("secret.md", "not-secret.md")).toBe(false);
	});

	test("a trailing slash matches directories only", () => {
		expect(dir("drafts/", "drafts")).toBe(true);
		expect(dir("drafts/", "x/drafts")).toBe(true);
		expect(file("drafts/", "drafts")).toBe(false);
		// ...but everything under a matched directory is excluded.
		expect(file("drafts/", "x/drafts/idea.md")).toBe(true);
	});

	test("a leading or middle slash anchors to the kb root", () => {
		expect(dir("/private", "private")).toBe(true);
		expect(dir("/private", "notes/private")).toBe(false);
		expect(file("notes/todo.md", "notes/todo.md")).toBe(true);
		expect(file("notes/todo.md", "x/notes/todo.md")).toBe(false);
	});

	test("*, ? and brackets never cross a slash", () => {
		expect(file("*.tmp.md", "a/x.tmp.md")).toBe(true);
		expect(file("/a/*.md", "a/b/c.md")).toBe(false);
		expect(file("/a/*.md", "a/c.md")).toBe(true);
		expect(file("day-?.md", "day-1.md")).toBe(true);
		expect(file("day-?.md", "day-10.md")).toBe(false);
		expect(file("log-[0-9].md", "log-7.md")).toBe(true);
		expect(file("log-[!0-9].md", "log-7.md")).toBe(false);
		expect(file("log-[!0-9].md", "log-x.md")).toBe(true);
		expect(file("log-[[:digit:]].md", "log-3.md")).toBe(true);
		expect(file("[", "[")).toBe(true); // unterminated bracket is literal
	});

	test("** spans directories only as a whole segment", () => {
		expect(file("**/scratch.md", "scratch.md")).toBe(true);
		expect(file("**/scratch.md", "a/b/scratch.md")).toBe(true);
		expect(file("a/**/b.md", "a/b.md")).toBe(true);
		expect(file("a/**/b.md", "a/x/y/b.md")).toBe(true);
		expect(file("a/**", "a/x/y.md")).toBe(true);
		expect(dir("a/**", "a")).toBe(false);
		expect(file("/a**b.md", "a/x/b.md")).toBe(false); // plain `*`
		expect(file("/a**b.md", "axxb.md")).toBe(true);
	});

	test("the last matching pattern wins, and ! re-includes", () => {
		const rules = "*.md\n!keep.md\n";
		expect(file(rules, "drop.md")).toBe(true);
		expect(file(rules, "sub/keep.md")).toBe(false);
		expect(file("!keep.md\n*.md\n", "keep.md")).toBe(true);
	});

	test("! cannot re-include a file inside an excluded directory", () => {
		expect(file("archive/\n!archive/keep.md\n", "archive/keep.md")).toBe(true);
		// The documented idiom: exclude the contents, not the directory.
		expect(file("archive/**\n!archive/keep.md\n", "archive/keep.md")).toBe(false);
		expect(file("archive/**\n!archive/keep.md\n", "archive/drop.md")).toBe(true);
	});

	test("comments, blanks, escapes and trailing spaces", () => {
		const rules = "# a comment\n\n\\#hash.md\n\\!bang.md\ntrail.md   \nspace\\ \n";
		expect(file(rules, "#hash.md")).toBe(true);
		expect(file(rules, "# a comment")).toBe(false);
		expect(file(rules, "!bang.md")).toBe(true);
		expect(file(rules, "trail.md")).toBe(true);
		expect(file(rules, "space ")).toBe(true);
		expect(file(rules, "space")).toBe(false);
		expect(file("a.md\r\nb.md\r\n", "b.md")).toBe(true); // CRLF
	});

	test("regex metacharacters are literal", () => {
		expect(file("a+b(1).md", "a+b(1).md")).toBe(true);
		expect(file("a.md", "aXmd")).toBe(false);
	});

	test("matching is case-sensitive", () => {
		expect(file("Draft.md", "draft.md")).toBe(false);
	});
});
