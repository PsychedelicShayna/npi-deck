import { useState } from "react";
import { Plus } from "lucide-react";

import type { RoutineDeckAction, RoutineStep } from "@npi-deck/protocol";

import { STEP_TYPE_DESCRIPTIONS } from "./spec-yaml";

interface Props {
	onAdd: (type: RoutineStep["type"], presetAction?: RoutineDeckAction) => void;
}

export function AddStepPicker({ onAdd }: Props) {
	const [open, setOpen] = useState(false);
	return (
		<div className="relative">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="btn-ghost h-7 w-full justify-center border-dashed text-2xs text-ink-3 hover:text-ink"
			>
				<Plus className="h-3.5 w-3.5" />
				Add step
			</button>
			{open ? (
				<div className="absolute z-10 mt-1 w-full overflow-hidden rounded border border-line bg-paper shadow-xl">
					{STEP_TYPE_DESCRIPTIONS.map((t) => (
						<button
							key={t.key}
							type="button"
							onClick={() => {
								onAdd(t.value, t.presetAction);
								setOpen(false);
							}}
							className="flex w-full items-baseline gap-2 px-2 py-1.5 text-left hover:bg-paper-3"
						>
							<span className="font-mono text-2xs uppercase tracking-meta text-accent">{t.label}</span>
							<span className="text-2xs text-ink-2">{t.help}</span>
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
