#!/usr/bin/env bun
/** Reject direct process creation outside the owned-process boundary. */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "../apps/server/src");
const violations: string[] = [];
function scan(dir: string): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) scan(file);
		else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
			if (entry.name === "owned-process.ts") continue;
			const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
			function visit(node: ts.Node): void {
				if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
					&& node.expression.expression.getText(source) === "Bun" && node.expression.name.text === "spawn") {
					const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
					violations.push(`${path.relative(root, file)}:${line}: direct spawn outside spawnOwned`);
				}
				if (ts.isImportDeclaration(node) && /^(node:)?child_process$/.test((node.moduleSpecifier as ts.StringLiteral).text)) violations.push(`${path.relative(root, file)}: child_process import`);
				ts.forEachChild(node, visit);
			}
			visit(source);
		}
	}
}
scan(root);
if (violations.length) { console.error(violations.join("\n")); process.exit(1); }
console.log("server process spawns use spawnOwned");
