import {
	Background,
	BackgroundVariant,
	Controls,
	MiniMap,
	ReactFlow,
	type Edge,
	type Node,
	type ReactFlowProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

/**
 * Canvas chrome shared by the routine and mixture editors: background,
 * viewport controls and minimap. Callers own node/edge types, connections,
 * validation and execution semantics; wrap it in `.routine-canvas` or
 * `.graph-canvas` for the deck theme.
 */
export function GraphCanvasSurface<N extends Node = Node, E extends Edge = Edge>({
	children,
	minZoom = 0.25,
	maxZoom = 2,
	proOptions = { hideAttribution: true },
	...props
}: ReactFlowProps<N, E>): JSX.Element {
	return (
		<ReactFlow<N, E> minZoom={minZoom} maxZoom={maxZoom} proOptions={proOptions} {...props}>
			<Background variant={BackgroundVariant.Dots} gap={20} size={1} className="!bg-paper" />
			<Controls position="bottom-right" showInteractive={false} className="!border !border-line !bg-paper-2 !shadow-sm" />
			<MiniMap
				position="bottom-left"
				nodeStrokeWidth={2}
				maskColor="rgb(var(--paper) / 0.7)"
				className="!border !border-line !bg-paper-2"
				pannable
				zoomable
			/>
			{children}
		</ReactFlow>
	);
}
