import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, preview, type InlineConfig } from "vite";

import { PROXY_PEER_HEADER, isLoopbackRequest } from "../server/src/request-peer.ts";

// A non-loopback address of this machine: connecting to it from here makes the proxy
// see a non-loopback client, as a remote browser on `--host 0.0.0.0` would.
const remoteAddress = Object.values(os.networkInterfaces())
	.flat()
	.find((iface) => iface && iface.family === "IPv4" && !iface.internal)?.address;

let upstream: ReturnType<typeof Bun.serve>;
let outDir: string;
const savedEnv = { NPI_DECK_PORT: process.env.NPI_DECK_PORT, NPI_DECK_HOST: process.env.NPI_DECK_HOST };

beforeAll(() => {
	// Stands in for the deck: applies the server's loopback gate to whatever the proxy relays.
	upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			const allowed = isLoopbackRequest(req, { peerAddress: srv.requestIP(req)?.address });
			return Response.json({ relayed: req.headers.get(PROXY_PEER_HEADER) }, { status: allowed ? 200 : 403 });
		},
	});
	outDir = mkdtempSync(path.join(os.tmpdir(), "npi-deck-vite-preview-"));
});

afterAll(() => {
	upstream.stop(true);
	rmSync(outDir, { recursive: true, force: true });
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function inlineConfig(): InlineConfig {
	process.env.NPI_DECK_PORT = String(upstream.port);
	delete process.env.NPI_DECK_HOST;
	return {
		configFile: path.join(import.meta.dir, "vite.config.ts"),
		root: import.meta.dir,
		logLevel: "silent",
		server: { host: "0.0.0.0", port: 0, hmr: false, watch: null },
		preview: { host: "0.0.0.0", port: 0 },
		build: { outDir },
		optimizeDeps: { disabled: true },
	};
}

const modes = {
	dev: async () => {
		const server = await createServer(inlineConfig());
		await server.listen();
		return { port: (server.httpServer!.address() as AddressInfo).port, close: () => server.close() };
	},
	preview: async () => {
		const server = await preview(inlineConfig());
		return { port: (server.httpServer.address() as AddressInfo).port, close: () => server.close() };
	},
};

describe.skipIf(!remoteAddress)("web proxy relays the real client to the loopback gate (#79)", () => {
	for (const [mode, start] of Object.entries(modes)) {
		test(`vite ${mode}: a remote client is refused even when it forges the header, a local one passes`, async () => {
			const proxy = await start();
			try {
				const forged = { [PROXY_PEER_HEADER]: "127.0.0.1", host: "127.0.0.1" };
				const remote = await fetch(`http://${remoteAddress}:${proxy.port}/api/server/restart`, { method: "POST", headers: forged });
				expect(remote.status).toBe(403);
				expect(await remote.json()).toEqual({ relayed: remoteAddress });

				const local = await fetch(`http://127.0.0.1:${proxy.port}/api/server/restart`, { method: "POST" });
				expect(local.status).toBe(200);
			} finally {
				await proxy.close();
			}
		});
	}
});
