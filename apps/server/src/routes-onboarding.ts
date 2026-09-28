/**
 * Onboarding routes — drive the first-run wizard's state machine.
 *
 * GET  /api/onboarding/state          → OnboardingState (composite)
 * POST /api/onboarding/complete       → mark done (skipped flag distinguishes
 *                                       walked-through vs X-ed out)
 * POST /api/onboarding/seed-kb-system → create the kb root and its starter
 *                                       README; idempotent (won't overwrite
 *                                       an existing README)
 *
 * Provider auth, kb init, and env updates reuse their existing routes
 * (`/api/auth/oauth/*`, `/api/kb/init`, `/api/env/*`). The wizard just
 * sequences them.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { Hono } from "hono";

import type {
	CompleteOnboardingRequest,
	OnboardingState,
	SeedKbSystemRequest,
	SeedKbSystemResponse,
} from "@npi-deck/protocol";

import { resolveKbRoot } from "./kb-service.ts";
import { logger } from "./log.ts";
import { getOnboardingState, markOnboardingComplete } from "./onboarding-state.ts";

const log = logger("routes:onboarding");

/**
 * Top-level README written at the kb root by `seed-kb-system`. Same
 * intent as the one rendered by `kb-service.initialize()` — drop a
 * starter file so the first-time visitor sees what a kb article looks
 * like (frontmatter shape + wikilink convention) and where to point new
 * content. Inlined here so the wizard can scaffold at any path the user
 * chooses, not just the server's resolved `NPI_DECK_KB_ROOT`.
 */
const KB_README_BODY = [
	"---",
	"type: knowledge",
	"tags: [meta, readme]",
	"---",
	"",
	"# Welcome to your KB",
	"",
	"This is a fresh knowledge base scaffolded by npi-deck onboarding. The deck",
	"reads this folder as a Karpathy-style llm-wiki — hand-tended markdown with",
	"YAML frontmatter and `[[wikilinks]]` between articles.",
	"",
	"## How it works",
	"",
	"- Each file is markdown with YAML frontmatter (`type`, `created`,",
	"  `updated`, `tags` are parsed automatically).",
	"- `[[some-file]]` resolves by filename stem. `[[dir/path]]` for explicit",
	"  paths. `[[target|label]]` to rename the rendered text.",
	"- The deck's KB view browses, searches, and edits these files.",
	"",
	"## What this is NOT",
	"",
	"omp's session memory (rolling summaries, vector store) is separate. This kb",
	"is your long-term, hand-tended layer. They complement each other.",
	"",
	"Happy authoring.",
	"",
].join("\n");

export function buildOnboardingRouter(): Hono {
	const app = new Hono();

	app.get("/state", async (c) => {
		const state: OnboardingState = await getOnboardingState();
		return c.json(state);
	});

	app.post("/complete", async (c) => {
		let body: CompleteOnboardingRequest = { skipped: false };
		try {
			body = (await c.req.json()) as CompleteOnboardingRequest;
		} catch {
			// Empty body is fine — assume non-skipped completion.
		}
		markOnboardingComplete(Boolean(body.skipped));
		const state = await getOnboardingState();
		return c.json(state);
	});

	app.post("/seed-kb-system", async (c) => {
		let body: SeedKbSystemRequest = {};
		try {
			body = (await c.req.json()) as SeedKbSystemRequest;
		} catch {
			/* empty body uses defaults */
		}
		const kbRoot = body.kbRoot?.trim() || resolveKbRoot();
		try {
			mkdirSync(kbRoot, { recursive: true });
		} catch (err) {
			log.error(`mkdir failed at ${kbRoot}`, err);
			return c.json({ error: String(err) }, 500);
		}
		const result: SeedKbSystemResponse = { created: [], skipped: [] };
		// Top-level README — same intent as kb-service.initialize() but writes
		// to whatever path the caller passes, not the server's resolved root.
		// (Lets the wizard scaffold at a user-chosen location without first
		// restarting the server to repoint NPI_DECK_KB_ROOT.)
		const readmePath = path.join(kbRoot, "README.md");
		if (!existsSync(readmePath)) {
			try {
				writeFileSync(readmePath, KB_README_BODY, "utf8");
				result.created.push("README.md");
			} catch (err) {
				log.warn(`failed to write ${readmePath}`, err);
				result.skipped.push("README.md");
			}
		} else {
			result.skipped.push("README.md");
		}
		return c.json(result);
	});

	return app;
}
