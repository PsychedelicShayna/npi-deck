/**
 * Every notification the server emits, with the plain-language trigger the
 * Settings page shows. A producer passes one of these kinds to `notify()`;
 * a kind listed in `NPI_DECK_NOTIFICATIONS_DISABLED` is dropped before any
 * channel sees it.
 */

import type { NotificationKind, NotificationLevel } from "@npi-deck/protocol";

export const NOTIFICATIONS_DISABLED_ENV = "NPI_DECK_NOTIFICATIONS_DISABLED";

export const NOTIFICATION_SOURCES: ReadonlyArray<{
	kind: NotificationKind;
	label: string;
	trigger: string;
	level: NotificationLevel;
}> = [
	{
		kind: "routine_failed",
		label: "Routine failures",
		trigger:
			"A routine run ends failed, cancelled or timed out (error), or stops at its budget cap (warning). Successful runs stay silent.",
		level: "error",
	},
	{
		kind: "task_shipped",
		label: "Agent shipped a task",
		trigger:
			"A routine step moves a kanban task into Done. Moving a task yourself, by drag or slash command, does not notify.",
		level: "info",
	},
	{
		kind: "auth_fallback",
		label: "Subscription login available",
		trigger:
			"A model call fails authentication while you are signed in to a subscription provider that serves the same model, so switching models in the picker would work.",
		level: "warn",
	},
];

const KINDS = new Set<string>(NOTIFICATION_SOURCES.map((s) => s.kind));

export function isNotificationKind(value: string): value is NotificationKind {
	return KINDS.has(value);
}

/** Kinds switched off by a comma-separated `NPI_DECK_NOTIFICATIONS_DISABLED` value; unknown names are ignored. */
export function parseDisabledKinds(raw: string | undefined): Set<NotificationKind> {
	const out = new Set<NotificationKind>();
	for (const part of (raw ?? "").split(",")) {
		const name = part.trim();
		if (isNotificationKind(name)) out.add(name);
	}
	return out;
}
