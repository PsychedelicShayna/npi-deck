import { hasFeature, activeBackend, resolveBackendSelection } from "../backend/runtime.ts";
import * as path from "node:path";
import { resolveBunExecutable } from "../runtime-bun.ts";

/** One authority for the headless agent entrypoint used by every routine action. */
export function routineAgentCommand(args: string[]): string[] {
	const tree = activeBackend()?.selection.path ?? resolveBackendSelection()?.path;
	if (!tree) throw new Error("no backend configured for routine agent");
	return [resolveBunExecutable(), path.join(tree, "packages/coding-agent/src/cli.ts"), ...args];
}

/** Only a probed backend with both MCP exports may accept an MCP restriction. */
export function routineAgentSupportsMcpAllowlist(command: readonly string[]): boolean {
	const backend = activeBackend();
	return !!backend && command[1] === path.join(backend.selection.path, "packages/coding-agent/src/cli.ts")
		&& hasFeature("mcp-allowlist");
}
