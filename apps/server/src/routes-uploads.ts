/**
 * Image upload surface for task bodies (and any other markdown body the deck
 * renders). The contract is intentionally narrow:
 *
 * - Single endpoint: `POST /api/uploads/image` with either a `multipart/form-data`
 *   payload (field name `file`) OR a raw binary body whose `content-type` starts
 *   with `image/`.
 * - Server validates content-type against a whitelist (png / jpeg / gif / webp),
 *   enforces a max size, hashes the bytes (sha256), and writes them to
 *   `<dataDir>/uploads/<yyyy>/<mm>/<hash>.<ext>`. Content-addressed paths mean
 *   re-pasting the same image is a no-op disk-wise. SVG is refused: opened as
 *   a document it runs script with the deck origin's authority.
 * - Response: `{ url, name, size, mimeType }`. `url` is rooted at `/uploads/...`
 *   so it works for both browser-side <img src> and agent-written markdown.
 *
 * Files are served back by `serveUpload` (mounted at `/uploads/*` in
 * `index.ts`) under a sandboxing CSP, so even a stored active document —
 * e.g. an SVG uploaded before SVG was refused — cannot script the deck origin.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { Hono } from "hono";

import { logger } from "./log.ts";

const log = logger("routes:uploads");

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB hard cap — way more than a screenshot

/**
 * MIME → file extension. The keys are the only types we accept. We deliberately
 * exclude `image/heic` and friends (browsers don't render them inline),
 * `image/avif` (uneven decoder support across embedded webviews), and
 * `image/svg+xml` (an active document, not just pixels).
 */
const ACCEPTED_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/**
 * Headers on every served upload. `sandbox` puts a directly opened file in an
 * opaque origin with scripts disabled, and `default-src 'none'` stops it from
 * fetching anything; `nosniff` keeps the browser from reinterpreting bytes as
 * HTML. None of these affect rendering through `<img>`.
 */
export const UPLOAD_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
	"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
	"x-content-type-options": "nosniff",
};

export interface UploadsConfig {
	/** Absolute filesystem root for stored uploads, typically `<dataDir>/uploads`. */
	uploadsRoot: string;
}

/**
 * Best-effort filename sanitizer for the response `name` field. We never use
 * the client-supplied name on disk — the hash-based filename is the only thing
 * that hits the filesystem — but a clean display name helps when an agent
 * inspects the upload response.
 */
function sanitizeDisplayName(raw: string | undefined, fallbackExt: string): string {
	if (!raw) return `image.${fallbackExt}`;
	// Strip path separators and control characters; clamp length.
	const cleaned = raw
		.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_")
		.replace(/^\.+/, "")
		.slice(0, 120);
	return cleaned || `image.${fallbackExt}`;
}

/**
 * Two-deep date sharding (`yyyy/mm`) keeps any single directory bounded for
 * `ls`/file managers. Production deployments that grow past tens of thousands
 * of files can swap this for a deeper scheme without touching the URL contract.
 */
function dateShard(now: Date): { yyyy: string; mm: string } {
	const yyyy = String(now.getUTCFullYear());
	const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
	return { yyyy, mm };
}

export interface SavedUpload {
	url: string;
	name: string;
	size: number;
	mimeType: string;
}

/**
 * Internal: persist a single in-memory image to disk under the content-addressed
 * path. Exported for the unit tests; the HTTP layer wraps it with validation.
 */
export async function persistImage(
	root: string,
	bytes: Uint8Array,
	mimeType: string,
	displayName: string | undefined,
	now: Date = new Date(),
): Promise<SavedUpload> {
	const ext = ACCEPTED_MIME[mimeType];
	if (!ext) throw new Error(`unsupported image type: ${mimeType}`);
	if (bytes.byteLength === 0) throw new Error("empty upload");
	if (bytes.byteLength > MAX_BYTES) {
		throw new Error(`upload exceeds ${MAX_BYTES} bytes (got ${bytes.byteLength})`);
	}

	const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
	const { yyyy, mm } = dateShard(now);
	const dir = path.join(root, yyyy, mm);
	await fs.mkdir(dir, { recursive: true });
	const filename = `${hash}.${ext}`;
	const full = path.join(dir, filename);

	// Idempotent: if the same bytes were already uploaded, skip the write so
	// re-pasting a screenshot doesn't churn the disk.
	try {
		const stat = await fs.stat(full);
		if (stat.size === bytes.byteLength) {
			return {
				url: `/uploads/${yyyy}/${mm}/${filename}`,
				name: sanitizeDisplayName(displayName, ext),
				size: bytes.byteLength,
				mimeType,
			};
		}
	} catch {
		// not present yet; fall through to write
	}

	await fs.writeFile(full, bytes);
	return {
		url: `/uploads/${yyyy}/${mm}/${filename}`,
		name: sanitizeDisplayName(displayName, ext),
		size: bytes.byteLength,
		mimeType,
	};
}

export function buildUploadsRouter(config: UploadsConfig): Hono {
	const app = new Hono();

	app.post("/uploads/image", async (c) => {
		const contentType = c.req.header("content-type") ?? "";

		try {
			let bytes: Uint8Array;
			let mimeType: string;
			let displayName: string | undefined;

			if (contentType.toLowerCase().startsWith("multipart/form-data")) {
				const form = await c.req.formData();
				const file = form.get("file");
				if (!(file instanceof File)) {
					return c.json({ error: "multipart upload requires 'file' field" }, 400);
				}
				bytes = new Uint8Array(await file.arrayBuffer());
				mimeType = (file.type || "").toLowerCase();
				displayName = file.name;
			} else if (contentType.toLowerCase().startsWith("image/")) {
				bytes = new Uint8Array(await c.req.arrayBuffer());
				mimeType = contentType.split(";", 1)[0]!.trim().toLowerCase();
				displayName = c.req.header("x-upload-name") ?? undefined;
			} else {
				return c.json(
					{
						error:
							"send either multipart/form-data with a 'file' field, or a raw body with content-type: image/*",
					},
					400,
				);
			}

			if (!ACCEPTED_MIME[mimeType]) {
				return c.json({ error: `unsupported image type: ${mimeType}` }, 415);
			}

			const saved = await persistImage(config.uploadsRoot, bytes, mimeType, displayName);
			return c.json(saved, 201);
		} catch (err) {
			const msg = String(err instanceof Error ? err.message : err);
			// Size and unsupported-type failures are user errors; everything else is 500.
			const status =
				/exceeds|empty upload|unsupported image type/.test(msg) ? 400 : 500;
			if (status === 500) log.error(`upload failed`, err);
			return c.json({ error: msg }, status);
		}
	});

	return app;
}

/**
 * Serve a file from the uploads root. URL prefix `/uploads/` strips before
 * resolving, so `/uploads/2026/05/abc.png` maps to `<uploadsRoot>/2026/05/abc.png`.
 * No SPA fallback — a 404 here means the URL is bad.
 *
 * Path-traversal protection: any `..` in the relative path is rejected
 * outright, and the resolved absolute path must remain inside `root`.
 */
export async function serveUpload(req: Request, root: string): Promise<Response> {
	const url = new URL(req.url);
	const rel = decodeURIComponent(url.pathname.replace(/^\/+uploads\/+/, ""));
	if (!rel || rel.includes("..")) return new Response("forbidden", { status: 403 });

	const resolved = path.resolve(path.join(root, rel));
	const rootResolved = path.resolve(root);
	if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
		return new Response("forbidden", { status: 403 });
	}

	const file = Bun.file(resolved);
	if (await file.exists()) {
		// Long-lived caching is safe because the on-disk filename is content-
		// addressed (sha256 prefix). If the bytes change, the URL changes.
		return new Response(file, {
			headers: { ...UPLOAD_RESPONSE_HEADERS, "cache-control": "public, max-age=31536000, immutable" },
		});
	}
	return new Response("not found", { status: 404, headers: UPLOAD_RESPONSE_HEADERS });
}
