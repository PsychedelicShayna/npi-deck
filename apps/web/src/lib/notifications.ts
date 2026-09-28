/**
 * Client-side notification bridge. Subscribes to the store's `notifications`
 * array; for each new (undelivered) item, fires:
 *   - Browser `Notification` (when permission has been granted)
 *   - Audio tone (when item.sound is truthy)
 *
 * In-app toast rendering is handled by `<NotificationToast />`; this module
 * is the system bridge.
 *
 * Permission state and audio-enabled preference are persisted in
 * localStorage so the user's choice survives reloads.
 */

import { useEffect, useState } from "react";

import { playNotificationTone, unlockAudio } from "./audio";
import { useStore, type NotificationItem } from "./store";

const AUDIO_PREF_KEY = "npi-deck:notifications:audio-enabled";
const BANNER_DISMISSED_KEY = "npi-deck:notifications:banner-dismissed";

/** Web Notification API permission, narrowed to the values we read. */
export type NotificationPermissionState = "default" | "granted" | "denied" | "unsupported";

function readPermission(): NotificationPermissionState {
	if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
	return window.Notification.permission as NotificationPermissionState;
}

function readAudioPref(): boolean {
	if (typeof localStorage === "undefined") return true;
	const raw = localStorage.getItem(AUDIO_PREF_KEY);
	return raw === null ? true : raw === "1";
}

function writeAudioPref(enabled: boolean): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(AUDIO_PREF_KEY, enabled ? "1" : "0");
	} catch {
		/* quota / private mode */
	}
}

/**
 * Hook for the permission UX surface. Returns the current permission state
 * and a `request` action that prompts the user. After request, the state
 * updates accordingly. Safe to call from any component; the permission
 * itself is shared across the whole document.
 */
export function useNotificationPermission(): {
	permission: NotificationPermissionState;
	requestPermission: () => Promise<void>;
	audioEnabled: boolean;
	setAudioEnabled: (enabled: boolean) => void;
	bannerDismissed: boolean;
	dismissBanner: () => void;
} {
	const [permission, setPermission] = useState<NotificationPermissionState>(readPermission);
	const [audioEnabled, setAudioEnabledLocal] = useState<boolean>(readAudioPref);
	const [bannerDismissed, setBannerDismissed] = useState<boolean>(() => {
		if (typeof localStorage === "undefined") return false;
		return localStorage.getItem(BANNER_DISMISSED_KEY) === "1";
	});

	async function requestPermission(): Promise<void> {
		if (permission !== "default") return;
		try {
			const result = await window.Notification.requestPermission();
			setPermission(result as NotificationPermissionState);
			// Browsers gate audio behind a user gesture; piggyback off the
			// permission prompt click to unlock the AudioContext for free.
			void unlockAudio();
		} catch {
			setPermission("denied");
		}
	}

	function setAudioEnabled(enabled: boolean): void {
		writeAudioPref(enabled);
		setAudioEnabledLocal(enabled);
		if (enabled) void unlockAudio();
	}

	function dismissBanner(): void {
		if (typeof localStorage !== "undefined") {
			try {
				localStorage.setItem(BANNER_DISMISSED_KEY, "1");
			} catch {
				/* quota */
			}
		}
		setBannerDismissed(true);
	}

	return { permission, requestPermission, audioEnabled, setAudioEnabled, bannerDismissed, dismissBanner };
}

/**
 * Connector hook: mounts the bridge between store.notifications and the
 * OS-level Notification API + audio. Mount this once near the App root.
 * Idempotent — multiple mounts cooperate via the `deliveredOs` flag.
 */
export function useNotificationBridge(): void {
	const markNotificationDelivered = useStore((s) => s.markNotificationDelivered);

	useEffect(() => {
		const unsubscribe = useStore.subscribe(
			(s) => s.notifications,
			(notifications) => {
				const undelivered = notifications.filter((n) => !n.deliveredOs);
				for (const item of undelivered) {
					deliverOnce(item);
					markNotificationDelivered(item.id);
				}
			},
			{ fireImmediately: false },
		);
		return () => {
			unsubscribe();
		};
	}, [markNotificationDelivered]);
}

function deliverOnce(item: NotificationItem): void {
	const audioPref = readAudioPref();
	if (item.sound && audioPref) {
		void playNotificationTone(item.level);
	}

	const permission = readPermission();
	if (permission !== "granted") return;
	if (typeof window === "undefined" || !("Notification" in window)) return;

	try {
		const options: NotificationOptions = {
			tag: item.id, // dedupe — re-creating with same tag replaces existing
			silent: true, // we do our own audio; suppress the OS default
		};
		if (item.body) options.body = item.body;
		const notif = new window.Notification(item.title, options);
		if (item.actionUrl) {
			notif.onclick = (ev) => {
				ev.preventDefault();
				if (typeof window !== "undefined" && item.actionUrl) {
					window.focus();
					// SPA hash routing: use location.assign so the router picks it up.
					window.location.assign(item.actionUrl);
				}
				notif.close();
			};
		}
	} catch {
		/* OS notif rejected — toast surface still shows it via the store */
	}
}
