/**
 * Brief, human-scannable timestamp formatter used on kanban task cards.
 *
 * Compact tiers tuned for at-a-glance reading without dominating the card:
 *   < 60s        → "just now"
 *   < 60m        → "5m"
 *   same day     → "5pm" (exact hour) or "5:30pm" (non-hour); lowercased
 *   < 365d       → "05/08" (zero-padded MM/DD)
 *   ≥ 365d       → "05/08/25" (zero-padded MM/DD/YY)
 *
 * Time tier picks deliberately drop minutes when the timestamp lands exactly
 * on an hour boundary — "5pm" reads faster than "5:00pm". Date tiers use the
 * local timezone so the value matches the user's wall clock.
 *
 * @param iso  ISO-8601 timestamp string (anything `new Date(iso)` accepts).
 * @param now  Override for "current time" — injected by tests; defaults to
 *             Date.now().
 */
export function formatBriefTime(iso: string, now: number = Date.now()): string {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return "";

	const elapsed = now - t;

	if (elapsed < 60_000) return "just now";

	if (elapsed < 60 * 60_000) {
		const m = Math.floor(elapsed / 60_000);
		return `${m}m`;
	}

	const dt = new Date(t);
	const nowDt = new Date(now);

	const sameCalendarDay =
		dt.getFullYear() === nowDt.getFullYear() &&
		dt.getMonth() === nowDt.getMonth() &&
		dt.getDate() === nowDt.getDate();

	if (sameCalendarDay) {
		const hours24 = dt.getHours();
		const minutes = dt.getMinutes();
		const period = hours24 >= 12 ? "pm" : "am";
		const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
		return minutes === 0
			? `${hours12}${period}`
			: `${hours12}:${pad2(minutes)}${period}`;
	}

	const mm = pad2(dt.getMonth() + 1);
	const dd = pad2(dt.getDate());

	// 365d threshold matches a wall calendar year. Compare absolute days so
	// daylight-saving boundaries do not flip a 364-day-old card into the
	// year-stamped tier.
	const elapsedDays = Math.floor(elapsed / 86_400_000);
	if (elapsedDays < 365) return `${mm}/${dd}`;

	const yy = pad2(dt.getFullYear() % 100);
	return `${mm}/${dd}/${yy}`;
}

/** Elapsed time since `startedIso` as "42s", "5m", "3h12m" or "2d4h". */
export function formatUptime(startedIso: string, now: number = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - Date.parse(startedIso)) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60}m`;
	const days = Math.floor(hours / 24);
	return `${days}d${hours % 24}h`;
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}
