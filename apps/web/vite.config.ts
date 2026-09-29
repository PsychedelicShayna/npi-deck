import type { ClientRequest, IncomingMessage } from "node:http";
import { defineConfig, type HttpProxy } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const SERVER_PORT = process.env.NPI_DECK_PORT ?? "1701";
const SERVER_HOST = process.env.NPI_DECK_HOST ?? "127.0.0.1";
const WEB_PORT = Number(process.env.NPI_DECK_WEB_PORT ?? "5173");

const SERVER_HTTP = `http://${SERVER_HOST}:${SERVER_PORT}`;
const SERVER_WS = `ws://${SERVER_HOST}:${SERVER_PORT}`;

// The deck sees every proxied request arrive from this loopback proxy with a rewritten
// Host, so on `--host 0.0.0.0` a remote browser would pass its loopback-only checks
// (secret reveal, restart). Always overwrite, never pass through, the header the server
// reads for the real client (PROXY_PEER_HEADER in apps/server/src/request-peer.ts).
const PROXY_PEER_HEADER = "x-npi-deck-proxy-peer";

function stampProxyPeer(proxy: HttpProxy.Server): void {
	const stamp = (proxyReq: ClientRequest, req: IncomingMessage) => proxyReq.setHeader(PROXY_PEER_HEADER, req.socket.remoteAddress ?? "");
	proxy.on("proxyReq", stamp);
	proxy.on("proxyReqWs", stamp);
}

export default defineConfig({
	plugins: [react()],
	// Expose `NPI_DECK_*` env vars (in addition to Vite's default `VITE_*`) so
	// power-user opt-outs like `NPI_DECK_CANVAS_SKIP_PREVIEW=1` are visible to
	// the client via `import.meta.env` without bouncing through a localStorage
	// shim.
	envPrefix: ["VITE_", "NPI_DECK_"],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	server: {
		host: SERVER_HOST,
		port: WEB_PORT,
		// `vite preview` inherits this proxy (preview.proxy defaults to server.proxy).
		proxy: {
			"/api": { target: SERVER_HTTP, changeOrigin: true, configure: stampProxyPeer },
			"/ws": { target: SERVER_WS, ws: true, changeOrigin: true, configure: stampProxyPeer },
		},
	},
	build: {
		outDir: "dist",
		sourcemap: true,
	},
});
