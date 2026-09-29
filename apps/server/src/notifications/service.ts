/**
 * Deck notification service. Routes notification payloads to every
 * registered channel concurrently; isolates failures so one bad channel
 * never starves siblings.
 *
 * Public surface intentionally narrow: register() / notify(). The runtime
 * supports adding more channels later (telegram, email, push) without
 * touching call sites — `register` is the seam.
 *
 * A payload whose `kind` is listed in `NPI_DECK_NOTIFICATIONS_DISABLED`
 * (Settings → Notifications) is dropped before any channel sees it. The
 * variable is read on every notify, so a Settings save applies at once.
 *
 * Channel handlers MUST be idempotent w.r.t. notification id: a transport
 * could deliver twice on reconnect; the channel decides how to dedupe (the
 * browser channel doesn't bother — clients ignore duplicate ids via the
 * `id` field on the wire frame).
 */

import { logger } from "../log.ts";
import { NOTIFICATIONS_DISABLED_ENV, parseDisabledKinds } from "./kinds.ts";
import type {
	NotificationChannel,
	NotificationEnvelope,
	NotificationPayload,
} from "./types.ts";

const log = logger("notifications");

export class NotificationService {
	private readonly channels = new Map<string, NotificationChannel>();

	/**
	 * Add a channel. If a channel with the same id is already registered, it
	 * is replaced — keeps test setup simple and lets later channels override
	 * earlier ones if needed.
	 */
	register(channel: NotificationChannel): void {
		if (this.channels.has(channel.id)) {
			log.warn(`replacing existing notification channel ${channel.id}`);
		}
		this.channels.set(channel.id, channel);
	}

	/** Unregister a channel by id. Returns true if it was present. */
	unregister(channelId: string): boolean {
		return this.channels.delete(channelId);
	}

	/** Channels currently registered. Stable iteration order = insertion order. */
	listChannels(): readonly string[] {
		return Array.from(this.channels.keys());
	}

	/**
	 * Fire a notification across every channel. Resolves once all channels
	 * have either delivered or thrown, with the envelope they received, or
	 * null when the payload's kind is switched off. Caller is expected to
	 * fire-and-forget unless they specifically need to await delivery (e.g.
	 * test code).
	 */
	async notify(payload: NotificationPayload): Promise<NotificationEnvelope | null> {
		if (parseDisabledKinds(process.env[NOTIFICATIONS_DISABLED_ENV]).has(payload.kind)) {
			log.debug(`notify (${payload.kind} disabled): ${payload.level} ${payload.title}`);
			return null;
		}

		// Default sound: true for warn and above. Explicit false respected.
		const sound =
			payload.sound !== undefined
				? payload.sound
				: payload.level === "warn" || payload.level === "error" || payload.level === "critical";

		const envelope: NotificationEnvelope = {
			...payload,
			sound,
			id: crypto.randomUUID(),
			timestamp: new Date().toISOString(),
		};

		if (this.channels.size === 0) {
			log.debug(`notify (no channels): ${envelope.level} ${envelope.title}`);
			return envelope;
		}

		await Promise.all(
			Array.from(this.channels.values()).map(async (channel) => {
				try {
					await channel.deliver(envelope);
				} catch (err) {
					log.warn(`notification channel ${channel.id} threw`, err);
				}
			}),
		);

		return envelope;
	}
}

/** Module-level singleton. Producers import this and call notify(). */
export const notificationService = new NotificationService();
