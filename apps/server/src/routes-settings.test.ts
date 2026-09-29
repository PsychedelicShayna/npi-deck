import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ListEnvSettingsResponse, NotificationSettingsResponse, RestartServerResponse, WorkspaceSettingsResponse } from "@npi-deck/protocol";

import type { AgentBridge } from "./bridge/types.ts";
import type { Config } from "./config.ts";
import { MANAGED_ENV_KEYS_LOADED, readManagedEnvFile } from "./env-store.ts";
import { NotificationService } from "./notifications/service.ts";
import type { NotificationEnvelope } from "./notifications/types.ts";
import { buildSettingsRouter } from "./routes-settings.ts";
import { PROXY_PEER_HEADER } from "./request-peer.ts";

const ENV_KEYS = ["NPI_DECK_HOME", "NPI_DECK_DEFAULT_CWD", "NPI_DECK_WORKSPACES", "NPI_DECK_NOTIFICATIONS_DISABLED"];

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

function buildApp(
	config = { defaultCwd: os.homedir(), extraWorkspaces: [] as string[] } as unknown as Config,
	restartServer?: () => RestartServerResponse,
) {
	return buildSettingsRouter({} as AgentBridge, config, { restartServer });
}

function put(app: ReturnType<typeof buildApp>, url: string, body: unknown) {
	return app.request(`http://127.0.0.1${url}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function patch(app: ReturnType<typeof buildApp>, updates: Record<string, string | null>) {
	return app.request("http://127.0.0.1/settings/env", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ updates }),
	});
}

async function saveTwoKeysConcurrently(app: ReturnType<typeof buildApp>) {
	const wsA = path.join(dataDir, "ws-a");
	const wsB = path.join(dataDir, "ws-b");
	mkdirSync(wsA);
	mkdirSync(wsB);
	const [a, b] = await Promise.all([
		patch(app, { NPI_DECK_DEFAULT_CWD: "/tmp/concurrent-cwd" }),
		patch(app, { NPI_DECK_WORKSPACES: `${wsA},${wsB}` }),
	]);
	expect(a.status).toBe(200);
	expect(b.status).toBe(200);

	const onDisk = readManagedEnvFile().values;
	expect(onDisk.get("NPI_DECK_DEFAULT_CWD")).toBe("/tmp/concurrent-cwd");
	expect(onDisk.get("NPI_DECK_WORKSPACES")).toBe(`${wsA},${wsB}`);

	const listed = (await (await app.request("http://127.0.0.1/settings/env")).json()) as ListEnvSettingsResponse;
	const byKey = new Map(listed.entries.map((entry) => [entry.key, entry]));
	expect(byKey.get("NPI_DECK_DEFAULT_CWD")).toMatchObject({ source: "env-file", masked: "/tmp/concurrent-cwd" });
	expect(byKey.get("NPI_DECK_WORKSPACES")).toMatchObject({ source: "env-file", masked: `${wsA},${wsB}` });

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

describe("privileged routes authorize by socket peer, not Host (#79)", () => {
	const SECRET = "sk-test-secret-value";
	const REVEAL = "http://127.0.0.1/settings/env/NPI_DECK_WORKSPACES?reveal=1";
	const RESTART = "http://127.0.0.1/server/restart";

	function setup() {
		process.env.NPI_DECK_WORKSPACES = SECRET;
		let restarts = 0;
		const app = buildApp(undefined, () => {
			restarts++;
			return { ok: true, message: "restarting" };
		});
		return { app, restarts: () => restarts };
	}

	test("a remote peer sending Host: 127.0.0.1 cannot reveal a value or restart", async () => {
		const { app, restarts } = setup();
		for (const peerAddress of ["192.168.1.50", "100.64.0.7", "::ffff:10.0.0.2", "fe80::1"]) {
			const reveal = await app.request(REVEAL, {}, { peerAddress });
			expect(reveal.status).toBe(403);
			expect(await reveal.text()).not.toContain(SECRET);
			const restart = await app.request(RESTART, { method: "POST" }, { peerAddress });
			expect(restart.status).toBe(403);
		}
		expect(restarts()).toBe(0);
	});

	test("a request whose socket peer is unknown is refused", async () => {
		const { app, restarts } = setup();
		expect((await app.request(REVEAL)).status).toBe(403);
		expect((await app.request(RESTART, { method: "POST" })).status).toBe(403);
		expect(restarts()).toBe(0);
	});

	test("a loopback peer with a loopback Host reveals and restarts", async () => {
		const { app, restarts } = setup();
		for (const peerAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.8.9.10"]) {
			const reveal = await app.request(REVEAL, {}, { peerAddress });
			expect(reveal.status).toBe(200);
			expect(((await reveal.json()) as { value: string }).value).toBe(SECRET);
		}
		const restart = await app.request(RESTART, { method: "POST" }, { peerAddress: "127.0.0.1" });
		expect(restart.status).toBe(200);
		expect(restarts()).toBe(1);
	});

	test("a loopback peer with a foreign Host (DNS rebinding) is refused", async () => {
		const { app, restarts } = setup();
		const reveal = await app.request("http://attacker.example/settings/env/NPI_DECK_WORKSPACES?reveal=1", {}, { peerAddress: "127.0.0.1" });
		expect(reveal.status).toBe(403);
		const restart = await app.request("http://attacker.example/server/restart", { method: "POST" }, { peerAddress: "127.0.0.1" });
		expect(restart.status).toBe(403);
		expect(restarts()).toBe(0);
	});

	test("a remote client relayed by the loopback dev proxy is refused", async () => {
		const { app, restarts } = setup();
		for (const relayed of ["192.168.1.50", "::ffff:100.64.0.7", ""]) {
			const headers = { [PROXY_PEER_HEADER]: relayed };
			const reveal = await app.request(REVEAL, { headers }, { peerAddress: "127.0.0.1" });
			expect(reveal.status).toBe(403);
			expect(await reveal.text()).not.toContain(SECRET);
			const restart = await app.request(RESTART, { method: "POST", headers }, { peerAddress: "127.0.0.1" });
			expect(restart.status).toBe(403);
		}
		expect(restarts()).toBe(0);
	});

	test("a local client relayed by the loopback dev proxy reveals and restarts", async () => {
		const { app, restarts } = setup();
		for (const relayed of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
			const reveal = await app.request(REVEAL, { headers: { [PROXY_PEER_HEADER]: relayed } }, { peerAddress: "127.0.0.1" });
			expect(reveal.status).toBe(200);
		}
		const restart = await app.request(RESTART, { method: "POST", headers: { [PROXY_PEER_HEADER]: "127.0.0.1" } }, { peerAddress: "127.0.0.1" });
		expect(restart.status).toBe(200);
		expect(restarts()).toBe(1);
	});

	test("a remote peer cannot claim a loopback client through the proxy header", async () => {
		const { app, restarts } = setup();
		const headers = { [PROXY_PEER_HEADER]: "127.0.0.1" };
		expect((await app.request(REVEAL, { headers }, { peerAddress: "192.168.1.50" })).status).toBe(403);
		expect((await app.request(RESTART, { method: "POST", headers }, { peerAddress: "192.168.1.50" })).status).toBe(403);
		expect(restarts()).toBe(0);
	});
});

describe("PATCH /settings/env with NPI_DECK_WORKSPACES (#98 review)", () => {
	test("the generic env editor applies the same workspace validation as Settings → Workspaces", async () => {
		const good = path.join(dataDir, "good");
		mkdirSync(good);
		const config = { defaultCwd: os.homedir(), extraWorkspaces: [] as string[] } as unknown as Config;
		const app = buildApp(config);
		for (const bad of [`${good},${path.join(dataDir, "missing")}`, "relative/dir"]) {
			expect((await patch(app, { NPI_DECK_WORKSPACES: bad })).status).toBe(400);
		}
		expect(readManagedEnvFile().values.has("NPI_DECK_WORKSPACES")).toBe(false);
		expect(config.extraWorkspaces).toEqual([]);

		// Saved in the same normalized form the Workspaces panel writes.
		expect((await patch(app, { NPI_DECK_WORKSPACES: ` ${good}/ , ${good} ` })).status).toBe(200);
		expect(readManagedEnvFile().values.get("NPI_DECK_WORKSPACES")).toBe(good);
		expect(config.extraWorkspaces).toEqual([good]);
	});
});

describe("Settings → Workspaces (#98)", () => {
	test("saving pinned roots persists them and updates the live picker list without a restart", async () => {
		const a = path.join(dataDir, "ws-a");
		const b = path.join(dataDir, "ws-b");
		mkdirSync(a);
		mkdirSync(b);
		const config = { defaultCwd: os.homedir(), extraWorkspaces: [] as string[] } as unknown as Config;
		const app = buildApp(config);

		const res = await put(app, "/settings/workspaces", { pinned: [a, `${b}/`, a] });
		expect(res.status).toBe(200);
		const body = (await res.json()) as WorkspaceSettingsResponse;
		expect(body.pinned).toEqual([
			{ cwd: a, label: "ws-a", exists: true },
			{ cwd: b, label: "ws-b", exists: true },
		]);
		expect(config.extraWorkspaces).toEqual([a, b]);
		expect(readManagedEnvFile().values.get("NPI_DECK_WORKSPACES")).toBe(`${a},${b}`);

		// Removing one is the same save with a shorter list.
		const removed = (await (await put(app, "/settings/workspaces", { pinned: [b] })).json()) as WorkspaceSettingsResponse;
		expect(removed.pinned.map((p) => p.cwd)).toEqual([b]);
		expect(config.extraWorkspaces).toEqual([b]);
	});

	test("a root that is not an existing absolute directory is refused and nothing changes", async () => {
		const file = path.join(dataDir, "not-a-dir");
		await Bun.write(file, "x");
		const config = { defaultCwd: os.homedir(), extraWorkspaces: [] as string[] } as unknown as Config;
		const app = buildApp(config);
		for (const bad of [path.join(dataDir, "missing"), file, "relative/dir", path.join(dataDir, "a,b")]) {
			const res = await put(app, "/settings/workspaces", { pinned: [bad] });
			expect(res.status).toBe(400);
		}
		expect(config.extraWorkspaces).toEqual([]);
		expect(readManagedEnvFile().values.has("NPI_DECK_WORKSPACES")).toBe(false);
	});

	test("a pinned root deleted from disk is listed as missing", async () => {
		const gone = path.join(dataDir, "gone");
		mkdirSync(gone);
		const app = buildApp();
		expect((await put(app, "/settings/workspaces", { pinned: [gone] })).status).toBe(200);
		rmSync(gone, { recursive: true });
		const body = (await (await app.request("http://127.0.0.1/settings/workspaces")).json()) as WorkspaceSettingsResponse;
		expect(body.pinned).toEqual([{ cwd: gone, label: "gone", exists: false }]);
		expect(body.setting).toEqual({ key: "NPI_DECK_WORKSPACES", source: "env-file", editable: true });
	});

	test("roots exported by the launching shell are read-only: saving would not take effect", async () => {
		process.env.NPI_DECK_WORKSPACES = dataDir;
		// loadConfig() read the exported value at launch.
		const config = { defaultCwd: os.homedir(), extraWorkspaces: [dataDir] } as unknown as Config;
		const app = buildApp(config);
		const body = (await (await app.request("http://127.0.0.1/settings/workspaces")).json()) as WorkspaceSettingsResponse;
		expect(body.setting).toEqual({ key: "NPI_DECK_WORKSPACES", source: "process-env", editable: false });
		expect(body.pinned.map((p) => p.cwd)).toEqual([dataDir]);
		expect((await put(app, "/settings/workspaces", { pinned: [] })).status).toBe(409);
		expect(readManagedEnvFile().values.has("NPI_DECK_WORKSPACES")).toBe(false);
		expect(config.extraWorkspaces).toEqual([dataDir]);
	});
});

describe("Settings → Notifications (#98)", () => {
	async function deliveredKinds(): Promise<string[]> {
		const received: NotificationEnvelope[] = [];
		const svc = new NotificationService();
		svc.register({ id: "rec", deliver: (e) => void received.push(e) });
		await svc.notify({ kind: "routine_failed", level: "error", title: "r" });
		await svc.notify({ kind: "task_shipped", level: "info", title: "t" });
		await svc.notify({ kind: "auth_fallback", level: "warn", title: "a" });
		return received.map((e) => e.kind);
	}

	test("every source is listed with its trigger and is on by default", async () => {
		const body = (await (await buildApp().request("http://127.0.0.1/settings/notifications")).json()) as NotificationSettingsResponse;
		expect(body.sources.map((s) => [s.kind, s.enabled])).toEqual([
			["routine_failed", true],
			["task_shipped", true],
			["auth_fallback", true],
		]);
		for (const source of body.sources) expect(source.trigger.length).toBeGreaterThan(20);
		expect(await deliveredKinds()).toEqual(["routine_failed", "task_shipped", "auth_fallback"]);
	});

	test("switching a source off stops the server emitting it, live; switching it back on restores it", async () => {
		const app = buildApp();
		const res = await put(app, "/settings/notifications", { disabled: ["task_shipped"] });
		expect(res.status).toBe(200);
		const body = (await res.json()) as NotificationSettingsResponse;
		expect(body.sources.find((s) => s.kind === "task_shipped")?.enabled).toBe(false);
		expect(await deliveredKinds()).toEqual(["routine_failed", "auth_fallback"]);

		expect((await put(app, "/settings/notifications", { disabled: [] })).status).toBe(200);
		expect(await deliveredKinds()).toEqual(["routine_failed", "task_shipped", "auth_fallback"]);
	});

	test("an unknown source is refused", async () => {
		expect((await put(buildApp(), "/settings/notifications", { disabled: ["bogus"] })).status).toBe(400);
		expect(readManagedEnvFile().values.has("NPI_DECK_NOTIFICATIONS_DISABLED")).toBe(false);
	});

	test("a shell-exported switch is read-only", async () => {
		process.env.NPI_DECK_NOTIFICATIONS_DISABLED = "auth_fallback";
		const app = buildApp();
		const body = (await (await app.request("http://127.0.0.1/settings/notifications")).json()) as NotificationSettingsResponse;
		expect(body.setting.editable).toBe(false);
		expect(body.sources.find((s) => s.kind === "auth_fallback")?.enabled).toBe(false);
		expect((await put(app, "/settings/notifications", { disabled: [] })).status).toBe(409);
	});
});
