import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { NpiConfigPatchResponse, SessionFallbackChainResponse } from "@npi-deck/protocol";
import { loadBackend, resolveBackendSelection } from "../backend/runtime.ts";
import type { Config } from "../config.ts";
import { spawnOwnedSync } from "../owned-process.ts";
import { buildFallbackChainRouter } from "../routes-fallback-chain.ts";
import { buildNpiConfigRouter } from "../routes-npi-config.ts";
import { InProcessAgentBridge } from "./in-process.ts";

// NeoPi captures HOME at load, so real sessions run in a child `bun test`
// with an isolated home, agent dir and dummy keys (no request is sent: the
// chats are only opened and inspected).
const fixtureRoot = process.env.NPI_DECK_FALLBACK_CHAIN_ROOT;

if (!fixtureRoot) {
	test("model picker fallback chains against real NeoPi sessions", () => {
		const selection = resolveBackendSelection();
		if (!selection) throw new Error("fallback chain test requires a configured NeoPi backend");
		const root = mkdtempSync(path.join(os.tmpdir(), "deck-fallback-chain-"));
		try {
			const home = path.join(root, "home");
			mkdirSync(home, { recursive: true });
			const env: Record<string, string> = {};
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined && !/(_API_KEY|_TOKEN|_SECRET)$/.test(key) && !/^(PI_|OMP_|NPI_DECK_)/.test(key)) env[key] = value;
			}
			Object.assign(env, {
				HOME: home,
				XDG_CONFIG_HOME: path.join(home, ".config"),
				XDG_DATA_HOME: path.join(home, ".local/share"),
				XDG_STATE_HOME: path.join(home, ".local/state"),
				XDG_CACHE_HOME: path.join(home, ".cache"),
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
				ANTHROPIC_API_KEY: "sk-ant-fallback-chain-dummy",
				OPENROUTER_API_KEY: "sk-or-fallback-chain-dummy",
				NPI_DECK_BACKEND: selection.path,
				NPI_DECK_FALLBACK_CHAIN_ROOT: root,
			});
			const child = spawnOwnedSync([process.execPath, "test", import.meta.path], { cwd: root, env, stdout: "pipe", stderr: "pipe" }, { replaceEnv: true });
			const output = `${child.stdout.toString()}${child.stderr.toString()}`;
			if (child.exitCode !== 0) console.error(output);
			expect(child.exitCode).toBe(0);
			expect(output).toContain("2 pass");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 180_000);
} else {
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const project = path.join(fixtureRoot, "project");
	const configYml = path.join(agentDir, "config.yml");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	await loadBackend(resolveBackendSelection()!);
	const config: Config = { defaultCwd: project, extraWorkspaces: [], host: "127.0.0.1", port: 0, devMode: true, idleTimeoutMs: 0, dbPath: path.join(fixtureRoot, "db"), uploadsRoot: path.join(fixtureRoot, "uploads") };

	const withBridge = async (run: (api: {
		bridge: InProcessAgentBridge;
		chain: (sessionId: string) => Promise<SessionFallbackChainResponse>;
		setEntries: (entries: Record<string, unknown>) => Promise<NpiConfigPatchResponse>;
	}) => Promise<void>) => {
		const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
		const chainRoutes = buildFallbackChainRouter(bridge);
		const configRoutes = buildNpiConfigRouter(bridge, config);
		try {
			await run({
				bridge,
				chain: async sessionId => {
					const response = await chainRoutes.request(`http://127.0.0.1/sessions/${sessionId}/fallback-chain`);
					expect(response.status).toBe(200);
					return await response.json() as SessionFallbackChainResponse;
				},
				setEntries: async entries => {
					const response = await configRoutes.request("http://127.0.0.1/npi-config", {
						method: "PATCH",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id: "retry.fallbackChains", entries }),
					});
					expect(response.status).toBe(200);
					return await response.json() as NpiConfigPatchResponse;
				},
			});
		} finally {
			await bridge.dispose();
		}
	};

	const opus = "anthropic/claude-opus-5-5";
	const deckFallback = "openrouter/openai/gpt-6-sol:medium";

	test("a new chat's picker chain starts at the deck default and follows config.yml edits live", async () => {
		await writeFile(configYml, "retry:\n  fallbackChains:\n    openrouter/openai/gpt-4o-mini:\n      - openrouter/openai/gpt-4o\n");
		await withBridge(async ({ bridge, chain, setEntries }) => {
			const handle = await bridge.createSession({ cwd: project, mcpServersAllowed: [] });
			expect(await chain(handle.sessionId)).toEqual({
				model: opus,
				key: opus,
				resolved: { key: `${opus}:medium`, chain: [deckFallback], deckDefault: true },
			});

			// The picker saves the model's own chain; the open chat uses it at once.
			const saved = await setEntries({ [opus]: ["openrouter/openai/gpt-4o-mini", deckFallback] });
			expect(saved.live.find(entry => entry.sessionId === handle.sessionId)?.reloadFailed).toBeUndefined();
			expect(await chain(handle.sessionId)).toEqual({
				model: opus,
				key: opus,
				resolved: { key: opus, chain: ["openrouter/openai/gpt-4o-mini", deckFallback] },
			});
			// Other configured chains survived the entry edit, on disk and in the chat.
			expect(await readFile(configYml, "utf8")).toContain("openrouter/openai/gpt-4o-mini:\n      - openrouter/openai/gpt-4o\n");
			const liveChains = saved.live.find(entry => entry.sessionId === handle.sessionId)?.effectiveValue as Record<string, string[]>;
			expect(liveChains["openrouter/openai/gpt-4o-mini"]).toEqual(["openrouter/openai/gpt-4o"]);
			expect(liveChains.default).toEqual([deckFallback]);

			// Reordering is one write of the whole entry.
			await setEntries({ [opus]: [deckFallback, "openrouter/openai/gpt-4o-mini"] });
			expect((await chain(handle.sessionId)).resolved?.chain).toEqual([deckFallback, "openrouter/openai/gpt-4o-mini"]);

			// Removing the model's chain hands it back to the deck default.
			await setEntries({ [opus]: null });
			expect((await chain(handle.sessionId)).resolved).toEqual({ key: `${opus}:medium`, chain: [deckFallback], deckDefault: true });
			expect(await readFile(configYml, "utf8")).not.toContain(`${opus}:`);
		});
	}, 120_000);

	test("a configured chain for the model beats the deck default from the start; an effort key is edited in place", async () => {
		await writeFile(configYml, `retry:\n  fallbackChains:\n    ${opus}:medium:\n      - openrouter/openai/gpt-4o\n`);
		await withBridge(async ({ bridge, chain }) => {
			const fresh = await bridge.createSession({ cwd: project, mcpServersAllowed: [] });
			expect(await chain(fresh.sessionId)).toEqual({
				model: opus,
				key: `${opus}:medium`,
				resolved: { key: `${opus}:medium`, chain: ["openrouter/openai/gpt-4o"] },
			});
			// A chat on a model without a chain of its own reports none and edits `provider/id`.
			const manual = await bridge.createSession({ cwd: project, model: { provider: "openrouter", id: "openai/gpt-4o-mini" }, mcpServersAllowed: [] });
			expect(await chain(manual.sessionId)).toEqual({ model: "openrouter/openai/gpt-4o-mini", key: "openrouter/openai/gpt-4o-mini" });
		});
	}, 120_000);
}
