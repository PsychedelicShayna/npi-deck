#!/usr/bin/env bun
/**
 * Fail when any deck source outside apps/server/src/backend/ imports a
 * *value* from `@oh-my-pi/*`. Type-only forms stay allowed everywhere:
 * `import type`, `import { type X }` (when every specifier is type-only),
 * `export type … from`, and `typeof import("…")` type queries.
 *
 * SDK values must come from backend/runtime.ts, which loads the manifest from
 * the selected NeoPi tree by absolute path; the deck's node_modules has no
 * `@oh-my-pi`, so a stray value import would fail at runtime anyway, but only
 * on the path that reaches it.
 *
 *   bun scripts/check-sdk-imports.ts [dir…]    default: apps packages scripts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const DECK_ROOT = path.resolve(import.meta.dir, "..");
const ALLOWED_DIR = path.join(DECK_ROOT, "apps/server/src/backend") + path.sep;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SDK = /^@oh-my-pi(\/|$)/;

function* sourceFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(path.join(dir, entry.name));
		} else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
			yield path.join(dir, entry.name);
		}
	}
}

function isSdk(node: ts.Node | undefined): node is ts.StringLiteralLike {
	return node !== undefined && ts.isStringLiteralLike(node) && SDK.test(node.text);
}

function importIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
	if (!clause) return false; // side-effect import
	if (clause.isTypeOnly) return true;
	if (clause.name) return false; // default import
	const bindings = clause.namedBindings;
	if (!bindings) return true;
	if (ts.isNamespaceImport(bindings)) return false;
	return bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
}

function exportIsTypeOnly(node: ts.ExportDeclaration): boolean {
	if (node.isTypeOnly) return true;
	const clause = node.exportClause;
	if (!clause || ts.isNamespaceExport(clause)) return false;
	return clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
}

interface Violation {
	file: string;
	line: number;
	specifier: string;
	form: string;
}

function scanSource(file: string, text: string): Violation[] {
	const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
	const out: Violation[] = [];
	const report = (node: ts.Node, spec: ts.StringLiteralLike, form: string) => {
		const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
		out.push({ file, line: line + 1, specifier: spec.text, form });
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && isSdk(node.moduleSpecifier)) {
			if (!importIsTypeOnly(node.importClause)) report(node, node.moduleSpecifier, "value import");
		} else if (ts.isExportDeclaration(node) && isSdk(node.moduleSpecifier)) {
			if (!exportIsTypeOnly(node)) report(node, node.moduleSpecifier, "value re-export");
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			!node.isTypeOnly &&
			ts.isExternalModuleReference(node.moduleReference) &&
			isSdk(node.moduleReference.expression)
		) {
			report(node, node.moduleReference.expression, "import = require");
		} else if (ts.isCallExpression(node) && isSdk(node.arguments[0])) {
			const callee = node.expression;
			if (callee.kind === ts.SyntaxKind.ImportKeyword) report(node, node.arguments[0], "dynamic import()");
			else if (ts.isIdentifier(callee) && callee.text === "require") report(node, node.arguments[0], "require()");
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return out;
}

if (import.meta.main) {
	const roots = (process.argv.length > 2 ? process.argv.slice(2) : ["apps", "packages", "scripts"]).map((r) =>
		path.resolve(DECK_ROOT, r),
	);
	const violations: Violation[] = [];
	let scanned = 0;
	for (const root of roots) {
		const files = statSync(root).isDirectory() ? sourceFiles(root) : [root];
		for (const file of files) {
			if (file.startsWith(ALLOWED_DIR)) continue;
			scanned++;
			violations.push(...scanSource(file, readFileSync(file, "utf8")));
		}
	}
	for (const v of violations) {
		console.error(
			`${path.relative(DECK_ROOT, v.file)}:${v.line}: ${v.form} from "${v.specifier}"; use sdk()/feature() from apps/server/src/backend/runtime.ts, or \`import type\``,
		);
	}
	if (violations.length > 0) {
		console.error(`check-sdk-imports: ${violations.length} SDK value import(s) outside apps/server/src/backend/`);
		process.exit(1);
	}
	console.log(`check-sdk-imports: ok (${scanned} files, no SDK value imports outside apps/server/src/backend/)`);
}
