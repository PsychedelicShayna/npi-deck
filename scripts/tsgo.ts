#!/usr/bin/env bun
/**
 * Run the NeoPi tree's own `tsgo` with the given arguments. The server's
 * program includes NeoPi's .ts sources, so it is checked with the compiler
 * that tree is developed against. The tree is the one tsconfig.neopi.json
 * extends (written by scripts/neopi-setup.ts).
 *
 *   bun scripts/tsgo.ts --noEmit -p apps/server
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const DECK_ROOT = path.resolve(import.meta.dir, "..");
const tsconfig = path.join(DECK_ROOT, "tsconfig.neopi.json");

function die(message: string): never {
	console.error(`tsgo: ${message}`);
	process.exit(1);
}

if (!existsSync(tsconfig)) die(`${tsconfig} is missing; run \`bun scripts/neopi-setup.ts\` first`);
const match = /"extends"\s*:\s*"([^"]+)\/tsconfig\.base\.json"/.exec(readFileSync(tsconfig, "utf8"));
if (!match) die(`${tsconfig} does not extend a NeoPi tree's tsconfig.base.json`);
const tsgo = path.join(match[1]!, "node_modules/.bin/tsgo");
if (!existsSync(tsgo)) die(`${tsgo} not found; re-run \`bun scripts/neopi-setup.ts\` for that tree`);

const proc = Bun.spawnSync([tsgo, ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(proc.exitCode ?? 1);
