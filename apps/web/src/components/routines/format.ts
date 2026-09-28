import type { Routine } from "@npi-deck/protocol";

/** Human-readable cron expression — "07:00 daily", "every minute", etc. */
export function describeCron(expr: string): string {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return expr;
	const [m, h, dom, mon, dow] = parts;
	const everyMin = m === "*" && h === "*" && dom === "*" && mon === "*" && dow === "*";
	if (everyMin) return "every minute";
	const fixedTime = /^\d+$/.test(m ?? "") && /^\d+$/.test(h ?? "");
	const timeStr = fixedTime ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` : "";
	if (timeStr && dom === "*" && mon === "*" && dow === "*") return `${timeStr} daily`;
	if (timeStr && dom === "*" && mon === "*" && dow === "1-5") return `${timeStr} weekdays`;
	if (timeStr && dom === "*" && mon === "*" && /^\d$/.test(dow ?? "")) {
		const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
		return `${timeStr} ${days[Number(dow)]}`;
	}
	if (m === "0" && h === "*" && dom === "*" && mon === "*" && dow === "*") return "hourly";
	return expr;
}

export function countdown(toIso: string | undefined, from: Date = new Date()): string {
	if (!toIso) return "";
	const t = new Date(toIso).getTime();
	if (Number.isNaN(t)) return "";
	const ms = t - from.getTime();
	if (ms <= 0) return "now";
	const min = Math.floor(ms / 60_000);
	if (min < 1) return "<1m";
	const h = Math.floor(min / 60);
	if (h < 1) return `${min}m`;
	const d = Math.floor(h / 24);
	if (d < 1) return `${h}h ${min % 60}m`;
	return `${d}d ${h % 24}h`;
}

export function routineSubtitle(r: Routine): string {
	const bits: string[] = [];
	if (r.cron) bits.push(describeCron(r.cron));
	if (r.timezone) bits.push(r.timezone);
	return bits.join(" · ");
}
