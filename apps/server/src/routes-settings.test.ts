import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ListEnvSettingsResponse } from "@npi-deck/protocol";

import type { AgentBridge } from "./bridge/types.ts";
import type { Config } from "./config.ts";
import { MANAGED_ENV_KEYS_LOADED, readManagedEnvFile } from "./env-store.ts";
import { buildSettingsRouter } from "./routes-settings.ts";

const ENV_KEYS = ["NPI_DECK_HOME", "NPI_DECK_DEFAULT_CWD", "NPI_DECK_WORKSPACES"];

let saved: Record<string, string | undefined>;
let dataDir: string;

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	for (const k of ENV_KEYS) delete process.env[k];
	dataDir = mkdtempSync(path.join(os.tmpdir(), "npi-deck-settings-"));
	process.env.NPI_DECK_HOME = dataDir;
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		MANAGED_ENV_KEYS_LOADED.delete(k);
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

function buildApp() {
	const config = { defaultCwd: os.homedir(), extraWorkspaces: [] as string[] } as unknown as Config;
	return buildSettingsRouter({} as AgentBridge, config);
}

function patch(app: ReturnType<typeof buildApp>, updates: Record<string, string | null>) {
	return app.request("http://127.0.0.1/settings/env", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ updates }),
	});
}

async function saveTwoKeysConcurrently(app: ReturnType<typeof buildApp>) {
	const [a, b] = await Promise.all([
		patch(app, { NPI_DECK_DEFAULT_CWD: "/tmp/concurrent-cwd" }),
		patch(app, { NPI_DECK_WORKSPACES: "/tmp/ws-a,/tmp/ws-b" }),
	]);
	expect(a.status).toBe(200);
	expect(b.status).toBe(200);

	const onDisk = readManagedEnvFile().values;
	expect(onDisk.get("NPI_DECK_DEFAULT_CWD")).toBe("/tmp/concurrent-cwd");
	expect(onDisk.get("NPI_DECK_WORKSPACES")).toBe("/tmp/ws-a,/tmp/ws-b");

	const listed = (await (await app.request("http://127.0.0.1/settings/env")).json()) as ListEnvSettingsResponse;
	const byKey = new Map(listed.entries.map((entry) => [entry.key, entry]));
	expect(byKey.get("NPI_DECK_DEFAULT_CWD")).toMatchObject({ source: "env-file", masked: "/tmp/concurrent-cwd" });
	expect(byKey.get("NPI_DECK_WORKSPACES")).toMatchObject({ source: "env-file", masked: "/tmp/ws-a,/tmp/ws-b" });

	expect(readdirSync(dataDir).filter((name) => name.includes(".pending-"))).toEqual([]);
}

describe("PATCH /settings/env concurrency (#16)", () => {
	test("two concurrent saves of different keys both survive on disk and in effective settings", async () => {
		// Distinct clock readings keep this case about the lost read-modify-write update, not temp-name reuse.
		let tick = 1_700_000_000_000;
		const ticking = spyOn(Date, "now").mockImplementation(() => tick++);
		try {
			await saveTwoKeysConcurrently(buildApp());
		} finally {
			ticking.mockRestore();
		}
	});

	test("concurrent saves within one clock millisecond do not share a temp file", async () => {
		const frozen = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		try {
			await saveTwoKeysConcurrently(buildApp());
		} finally {
			frozen.mockRestore();
		}
	});
});
