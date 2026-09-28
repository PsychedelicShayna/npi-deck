/**
 * Tests the `persistImage` core path used by the upload route. The HTTP layer
 * itself is exercised end-to-end via the running deck; here we pin the
 * validation, content-addressing, and idempotency contracts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { buildUploadsRouter, persistImage, serveUpload } from "./routes-uploads.ts";

let workdir: string | null = null;

afterEach(async () => {
	if (workdir) {
		try {
			await fs.rm(workdir, { recursive: true, force: true });
		} catch {
			// leaking a temp dir is fine, failing the suite is not
		}
		workdir = null;
	}
});

async function boot(): Promise<string> {
	workdir = await fs.mkdtemp(path.join(os.tmpdir(), "npi-deck-uploads-"));
	return workdir;
}

// A 1x1 transparent PNG, hand-rolled so the test has no external dependency.
const TINY_PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

describe("persistImage", () => {
	test("writes the bytes under <root>/<yyyy>/<mm>/<hash>.<ext>", async () => {
		const root = await boot();
		const fixedNow = new Date("2026-05-23T12:34:56.000Z");
		const saved = await persistImage(root, TINY_PNG, "image/png", "screenshot.png", fixedNow);

		expect(saved.mimeType).toBe("image/png");
		expect(saved.size).toBe(TINY_PNG.byteLength);
		expect(saved.name).toBe("screenshot.png");
		expect(saved.url).toMatch(/^\/uploads\/2026\/05\/[0-9a-f]{32}\.png$/);

		// File should exist on disk at the resolved path.
		const onDisk = path.join(root, saved.url.replace(/^\/uploads\//, "").replace(/\//g, path.sep));
		const stat = await fs.stat(onDisk);
		expect(stat.size).toBe(TINY_PNG.byteLength);
	});

	test("content-addressed: same bytes yield same url", async () => {
		const root = await boot();
		const a = await persistImage(root, TINY_PNG, "image/png", "a.png");
		const b = await persistImage(root, TINY_PNG, "image/png", "b.png");
		expect(b.url).toBe(a.url);
	});

	test("rejects unsupported mime type", async () => {
		const root = await boot();
		await expect(persistImage(root, TINY_PNG, "image/heic", "x")).rejects.toThrow(
			/unsupported image type/,
		);
		// Nothing written under the date shard.
		const entries = await fs.readdir(root).catch(() => []);
		expect(entries.length).toBe(0);
	});

	test("rejects empty upload", async () => {
		const root = await boot();
		await expect(persistImage(root, new Uint8Array(), "image/png", "empty")).rejects.toThrow(
			/empty upload/,
		);
	});

	test("rejects oversized upload", async () => {
		const root = await boot();
		const big = new Uint8Array(11 * 1024 * 1024); // 11 MB > 10 MB cap
		await expect(persistImage(root, big, "image/png", "huge")).rejects.toThrow(/exceeds/);
	});

	test("sanitizes path separators out of the display name", async () => {
		const root = await boot();
		const saved = await persistImage(root, TINY_PNG, "image/png", "../../etc/passwd");
		// Display name is cosmetic — disk path uses the content hash — but path
		// separators must still get scrubbed so the name displays sanely.
		expect(saved.name).not.toContain("/");
		expect(saved.name).not.toContain("\\");
		expect(saved.name.startsWith(".")).toBe(false);
	});
});

const ACTIVE_SVG = new TextEncoder().encode(
	`<svg xmlns="http://www.w3.org/2000/svg" onload="fetch('/api/sessions',{method:'POST'})"><script>fetch('/api/tasks')</script></svg>`,
);

describe("SVG uploads", () => {
	test("the upload route refuses image/svg+xml", async () => {
		const root = await boot();
		const app = buildUploadsRouter({ uploadsRoot: root });
		const res = await app.request("/uploads/image", {
			method: "POST",
			headers: { "content-type": "image/svg+xml" },
			body: ACTIVE_SVG,
		});
		expect(res.status).toBe(415);
		expect(await fs.readdir(root)).toEqual([]);
	});

	test("a stored SVG is served sandboxed, so opening it cannot script the deck origin", async () => {
		const root = await boot();
		await fs.mkdir(path.join(root, "2026", "05"), { recursive: true });
		await fs.writeFile(path.join(root, "2026", "05", "old.svg"), ACTIVE_SVG);
		const res = await serveUpload(new Request("http://127.0.0.1:1701/uploads/2026/05/old.svg"), root);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toStartWith("image/svg+xml");
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp.split(";").map((d) => d.trim())).toEqual(expect.arrayContaining(["sandbox", "default-src 'none'"]));
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	});

	test("raster uploads keep their image type and caching", async () => {
		const root = await boot();
		const saved = await persistImage(root, TINY_PNG, "image/png", "a.png");
		const res = await serveUpload(new Request(`http://127.0.0.1:1701${saved.url}`), root);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("cache-control")).toContain("immutable");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(TINY_PNG);
	});
});
