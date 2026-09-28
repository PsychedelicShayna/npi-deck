import * as path from "node:path";
import { activeBackend, resolveBackendSelection } from "../backend/runtime.ts";
import { resolveBunExecutable } from "../runtime-bun.ts";

/** One authority for the headless agent entrypoint used by every routine action. */
export function routineAgentCommand(args: string[]): string[] {
	const tree = activeBackend()?.selection.path ?? resolveBackendSelection().path;
	return [resolveBunExecutable(), path.join(tree, "packages/coding-agent/src/cli.ts"), ...args];
}
