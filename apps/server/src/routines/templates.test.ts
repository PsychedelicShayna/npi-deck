/**
 * Smoke tests for routine templates. Every `.yaml` file under
 * `apps/server/src/templates/` is parsed + validated against the V1 routine
 * spec schema. Adding a new template here is the cheap way to catch typos
 * (unknown step type, missing required field, regex-failing id) before they
 * 500 the install endpoint at runtime.
 *
 * The test is dynamic: it iterates whatever templates are present on disk
 * rather than hardcoding a slug list. That way local-only templates (e.g.
 * user-specific paper-trading sleeves gitignored away from the public repo)
 * still get validated in dev, but CI doesn't fail when they're absent.
 */

import { describe, expect, test } from "bun:test";

import { validateRoutineSpec } from "@npi-deck/protocol";

import { listTemplates, loadTemplate } from "./templates.ts";

/** Templates that MUST ship in the public repo. Anything else is best-effort. */
const REQUIRED_SHIPPED = ["daily-briefing"] as const;

describe("routine templates", () => {
	test("every required shipped template is in the listing", () => {
		const slugs = new Set(listTemplates().map((t) => t.slug));
		for (const required of REQUIRED_SHIPPED) {
			expect(slugs.has(required)).toBe(true);
		}
	});

	const templates = listTemplates();
	for (const summary of templates) {
		test(`${summary.slug}: loads + passes schema validation`, () => {
			const loaded = loadTemplate(summary.slug);
			expect(loaded).not.toBeNull();
			if (!loaded) return;
			const result = validateRoutineSpec(loaded.spec);
			if (!result.valid) {
				const reasons = (result.errors ?? []).map((e) => `  ${e.path}: ${e.message}`).join("\n");
				throw new Error(`${summary.slug} failed validation:\n${reasons}`);
			}
		});
	}
});
