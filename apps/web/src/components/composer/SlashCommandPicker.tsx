import { useEffect, useRef } from "react";
import type { SlashCommand, SlashCommandScope } from "@npi-deck/protocol";
import { cn } from "@/lib/utils";

const SCOPE_STYLE: Record<SlashCommandScope, { className: string; label: string; title: string }> = {
	deck: {
		className: "bg-accent/15 text-accent",
		label: "deck",
		title: "Deck-native command — operates on the kanban/inbox without a model round-trip",
	},
	builtin: {
		className: "bg-ink/10 text-ink-2",
		label: "builtin",
		title: "Built-in omp slash command",
	},
	project: {
		className: "bg-accent-soft text-accent",
		label: "project",
		title: "Project-local override",
	},
	user: {
		className: "bg-paper-3 text-ink-3",
		label: "user",
		title: "User-global command",
	},
};

interface Props {
	commands: SlashCommand[];
	selectedIndex: number;
	onPick: (cmd: SlashCommand) => void;
	onSelectionChange: (index: number) => void;
}

/**
 * Autocomplete dropdown anchored above the composer textarea when the draft
 * starts with `/`. Filtering happens *outside* the component — `commands` is
 * already the filtered list, and `selectedIndex` is owned by `Composer` so the
 * textarea's keydown handler can drive it (Arrow / Enter / Tab / Esc).
 *
 * Renders nothing when `commands` is empty so the composer doesn't have to
 * gate the JSX too — it can drop this in unconditionally and let it disappear.
 */
export function SlashCommandPicker({
	commands,
	selectedIndex,
	onPick,
	onSelectionChange,
}: Props) {
	const listRef = useRef<HTMLDivElement>(null);

	// Keep the active row visible when keyboard nav moves it offscreen.
	useEffect(() => {
		const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
		el?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	if (commands.length === 0) return null;

	return (
		<div
			role="listbox"
			aria-label="Slash commands"
			className={cn(
				"absolute bottom-full left-0 right-0 mb-1 max-h-[280px] overflow-y-auto",
				"rounded-md border border-line bg-paper-2 shadow-[0_8px_24px_-8px_rgba(26,24,20,0.25)]",
				"font-mono text-[13px]",
			)}
		>
			<div ref={listRef}>
				{commands.map((cmd, i) => {
					const active = i === selectedIndex;
					return (
						<button
							key={`${cmd.scope}:${cmd.name}`}
							type="button"
							role="option"
							aria-selected={active}
							onClick={() => onPick(cmd)}
							onMouseEnter={() => onSelectionChange(i)}
							// Prevent the textarea blur that would dismiss the picker
							// before onClick fires.
							onMouseDown={(e) => e.preventDefault()}
							className={cn(
								"flex w-full items-start gap-2 px-3 py-2 text-left",
								active ? "bg-accent-soft/60" : "hover:bg-paper-3/60",
							)}
						>
							<div className="min-w-0 flex-1">
								<div className="flex items-baseline gap-1.5">
									<span className={cn("font-medium", active ? "text-accent" : "text-ink")}>
										/{cmd.name}
									</span>
									{cmd.argumentHint ? (
										<span className="font-mono text-2xs text-ink-3">
											{cmd.argumentHint}
										</span>
									) : null}
								</div>
								{cmd.description ? (
									<div className="mt-0.5 truncate font-sans text-xs text-ink-3">
										{cmd.description}
									</div>
								) : null}
							</div>
							<span
								className={cn(
									"shrink-0 self-center rounded px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta",
									SCOPE_STYLE[cmd.scope].className,
								)}
								title={SCOPE_STYLE[cmd.scope].title}
							>
								{SCOPE_STYLE[cmd.scope].label}
							</span>
						</button>
					);
				})}
			</div>
			<div className="border-t border-line bg-paper px-3 py-1 font-mono text-2xs text-ink-3">
				↑↓ navigate · enter pick · esc dismiss
			</div>
		</div>
	);
}
