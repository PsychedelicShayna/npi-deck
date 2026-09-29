/**
 * Hono bindings the deck's Bun listener passes into `router.fetch`. `peerAddress` is the
 * TCP peer Bun accepted the connection from (`server.requestIP(req)`), never anything the
 * client sent in a header. It is absent when the request did not arrive on a socket.
 */
export interface RequestPeerBindings {
	peerAddress?: string;
}

export type RequestPeerEnv = { Bindings: RequestPeerBindings };

/**
 * Loopback gate for privileged routes (secret reveal, restart).
 *
 * Authorization rests on the socket peer: a remote client on a non-loopback bind can put
 * `Host: 127.0.0.1` in its request, but it cannot make its TCP connection come from
 * 127.0.0.0/8 or ::1. The Host check is an extra requirement, not a grant: it stops a
 * DNS-rebound page in a local browser (loopback peer, foreign Host) from reaching these
 * routes. A request with no known peer is refused.
 */
export function isLoopbackRequest(req: Request, bindings: RequestPeerBindings | undefined): boolean {
	return isLoopbackAddress(bindings?.peerAddress) && isLoopbackHostname(new URL(req.url).hostname);
}

function isLoopbackAddress(address: string | undefined): boolean {
	if (!address) return false;
	const ip = address.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
	if (ip === "::1") return true;
	const octets = ip.split(".");
	return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
