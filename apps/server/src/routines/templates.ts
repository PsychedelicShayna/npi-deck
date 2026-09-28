/**
 * Routine templates. Each `.yaml` file under `apps/server/src/templates/` is a
 * pre-authored V1 routine spec the user can install via:
 *
 *   GET  /api/routines/templates           — list available templates
 *   POST /api/routines/templates/:slug      — install + return the routine row
 *
 * Installation is plain `createV1Routine` with the parsed spec. Templates ship
 * with `enabled: false` by default so a fresh install doesn't fire unscheduled
 * agent runs against the user's BYOK keys.
 *
 * V1 ships one template (`daily-briefing`); the visual builder's marketplace
 * (Phase 3 / V2) surfaces them in a curated catalog with screenshots + tags.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import type { RoutineSpec } from "@npi-deck/protocol";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(here, "..", "templates");

export interface TemplateSummary {
	slug: string;
	name: string;
	description?: string;
	tags?: string[];
	steps: number;
	triggers: number;
}

/** List every .yaml under the templates directory with a summary. */
export function listTemplates(): TemplateSummary[] {
	if (!fs.existsSync(TEMPLATES_DIR)) return [];
	const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".yaml"));
	const out: TemplateSummary[] = [];
	for (const f of files) {
		const slug = f.replace(/\.yaml$/, "");
		try {
			const raw = fs.readFileSync(path.join(TEMPLATES_DIR, f), "utf-8");
			const spec = parseYaml(raw) as RoutineSpec;
			const summary: TemplateSummary = {
				slug,
				name: spec.name ?? slug,
				steps: spec.steps?.length ?? 0,
				triggers: spec.trigger?.length ?? 0,
			};
			if (spec.description) summary.description = spec.description;
			if (spec.tags) summary.tags = spec.tags;
			out.push(summary);
		} catch {
			// Skip malformed templates; surface in logs if needed.
		}
	}
	return out;
}

/** Read + parse a template by slug. Returns the spec + raw YAML. */
export function loadTemplate(slug: string): { spec: RoutineSpec; specYaml: string } | null {
	if (!/^[a-z][a-z0-9-]*$/.test(slug)) return null;
	const target = path.join(TEMPLATES_DIR, `${slug}.yaml`);
	if (!fs.existsSync(target)) return null;
	const raw = fs.readFileSync(target, "utf-8");
	try {
		const spec = parseYaml(raw) as RoutineSpec;
		return { spec, specYaml: raw };
	} catch {
		return null;
	}
}
