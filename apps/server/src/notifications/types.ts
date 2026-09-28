/**
 * Internal types for the deck's notification service. The wire-level shape
 * (`NotificationPayload`, `NotificationLevel`) is re-exported from
 * `@npi-deck/protocol` so producers don't import server-internal modules.
 */

import type { NotificationLevel, NotificationPayload } from "@npi-deck/protocol";

export type { NotificationLevel, NotificationPayload };

/**
 * A pluggable delivery target. Each channel must accept a payload and route
 * it however it likes (WS frame, HTTP POST to Telegram, SMTP send, etc).
 *
 * Channels MUST NOT throw. Errors are caught by the service and logged; one
 * broken channel must never block siblings.
 */
export interface NotificationChannel {
	readonly id: string;
	deliver(envelope: NotificationEnvelope): Promise<void> | void;
}

/**
 * Channel-facing payload: the user-supplied fields plus identifiers the
 * service assigns at notify time. Channels see the same struct regardless of
 * who produced the notification.
 */
export interface NotificationEnvelope extends NotificationPayload {
	/** Unique notification id, stable across channels. UUID v4 by default. */
	id: string;
	/** Wall-clock timestamp the notification was emitted, ISO 8601. */
	timestamp: string;
}
