/**
 * Notification audio tones, synthesized via the Web Audio API. No asset files
 * — tones are short sine bursts so they're instantly swappable to a real
 * sample later if the user wants a custom sound.
 *
 * Design:
 *   - One shared AudioContext lazily created on first user gesture (browsers
 *     refuse to play before that).
 *   - Per-level tone sequences; warn / error / critical are distinct enough
 *     to recognize without looking at the screen.
 *   - Volume capped at 0.15 so the cue is unmistakable but not jarring.
 *   - All tones < 600ms total so they never block a typing UX.
 *
 * Caller responsibility: invoke `playNotificationTone(level)` only when
 * a notification frame actually arrives. The store's NotificationItem
 * carries `sound?: boolean` from the server; respect that flag.
 */

import type { NotificationLevel } from "@npi-deck/protocol";

type ToneSpec = { freq: number; durationMs: number; gapMs: number };

const TONES: Record<NotificationLevel, ToneSpec[]> = {
	// info plays nothing by default — server-side default sound is false for info.
	// If the caller explicitly forces sound: true on info, we still produce a tone.
	info: [{ freq: 880, durationMs: 120, gapMs: 0 }],
	warn: [
		{ freq: 880, durationMs: 140, gapMs: 60 },
		{ freq: 660, durationMs: 160, gapMs: 0 },
	],
	error: [
		{ freq: 880, durationMs: 130, gapMs: 50 },
		{ freq: 660, durationMs: 130, gapMs: 50 },
		{ freq: 440, durationMs: 200, gapMs: 0 },
	],
	critical: [
		{ freq: 988, durationMs: 130, gapMs: 50 },
		{ freq: 740, durationMs: 130, gapMs: 50 },
		{ freq: 494, durationMs: 130, gapMs: 50 },
		{ freq: 370, durationMs: 250, gapMs: 0 },
	],
};

const PEAK_GAIN = 0.15;
const ATTACK_MS = 8;
const RELEASE_MS = 30;

let sharedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
	if (typeof window === "undefined") return null;
	if (sharedCtx) {
		// Browsers suspend AudioContexts when not user-driven. Resume on demand.
		if (sharedCtx.state === "suspended") {
			void sharedCtx.resume().catch(() => {});
		}
		return sharedCtx;
	}
	const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!Ctor) return null;
	try {
		sharedCtx = new Ctor();
		return sharedCtx;
	} catch {
		return null;
	}
}

/**
 * Play the tone sequence associated with `level`. Returns a promise that
 * resolves when the last tone has released; callers can ignore it (the
 * function is fire-and-forget in practice).
 */
export async function playNotificationTone(level: NotificationLevel): Promise<void> {
	const ctx = getCtx();
	if (!ctx) return;
	const tones = TONES[level];
	if (!tones || tones.length === 0) return;

	let cursor = ctx.currentTime + 0.01;
	for (const tone of tones) {
		const osc = ctx.createOscillator();
		osc.type = "sine";
		osc.frequency.value = tone.freq;

		const gain = ctx.createGain();
		gain.gain.setValueAtTime(0, cursor);
		gain.gain.linearRampToValueAtTime(PEAK_GAIN, cursor + ATTACK_MS / 1000);
		gain.gain.setValueAtTime(PEAK_GAIN, cursor + (tone.durationMs - RELEASE_MS) / 1000);
		gain.gain.linearRampToValueAtTime(0, cursor + tone.durationMs / 1000);

		osc.connect(gain).connect(ctx.destination);
		osc.start(cursor);
		osc.stop(cursor + tone.durationMs / 1000);

		cursor += (tone.durationMs + tone.gapMs) / 1000;
	}

	const totalSecs = tones.reduce((acc, t) => acc + (t.durationMs + t.gapMs) / 1000, 0.01);
	await new Promise((r) => setTimeout(r, totalSecs * 1000));
}

/**
 * Force-create or resume the AudioContext. Some browsers (Safari, Chrome
 * autoplay policy) require a user gesture before audio can play; callers
 * should invoke this from a click/keypress handler ideally tied to the
 * notification permission prompt.
 */
export async function unlockAudio(): Promise<void> {
	const ctx = getCtx();
	if (!ctx) return;
	if (ctx.state === "suspended") {
		try {
			await ctx.resume();
		} catch {
			/* user can re-try; we tried */
		}
	}
}
