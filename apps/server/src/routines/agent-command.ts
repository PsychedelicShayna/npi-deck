import { readFileSync } from "node:fs";
import * as path from "node:path";
import { activeBackend, resolveBackendSelection } from "../backend/runtime.ts";
import { resolveBunExecutable } from "../runtime-bun.ts";

/** One authority for the headless agent entrypoint used by every routine action. */
export function routineAgentCommand(args: string[]): string[] {
	const tree = activeBackend()?.selection.path ?? resolveBackendSelection()?.path;
	if (!tree) throw new Error("no backend configured for routine agent");
	return [resolveBunExecutable(), path.join(tree, "packages/coding-agent/src/cli.ts"), ...args];
}

/** Require both the CLI flag and the settings key; a partial backend must fail closed. */
export function routineAgentSupportsMcpAllowlist(command: readonly string[]): boolean {
	const cli = command[1];
	if (!cli) return false;
	const root = path.resolve(path.dirname(cli), "../../..");
	try {
		const flags = readFileSync(path.join(root, "packages/coding-agent/src/cli/flag-tables.ts"), "utf8");
		const settings = readFileSync(path.join(root, "packages/coding-agent/src/config/settings-schema.ts"), "utf8");
		return flags.includes('"--mcp"') && settings.includes("includeServers");
	} catch {
		return false;
	}
}
