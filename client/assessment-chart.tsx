import * as React from 'react';
import { Handle, Position } from '@xyflow/react';
import { createDagreTraceLayout } from 'footprint-explainable-ui/flowchart';
import type { TraceGraph } from 'footprint-explainable-ui/flowchart';
import type { CriterionStatus } from '../src/types.ts';
import './workspace.css';

export const NODE_WIDTH = 320;
export const NODE_HEIGHT = 64;
export const ROW_GAP = 18;
export const findingLabels: Record<CriterionStatus, string> = {
  satisfied: 'Satisfied', not_satisfied: 'Not satisfied',
  insufficient_evidence: 'Insufficient evidence', not_applicable: 'Not applicable',
  evaluation_error: 'Evaluation error',
};
const directedLayout = createDagreTraceLayout({ direction: 'TB', nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT, rankSep: 28, nodeSep: 42 });

function singlePath(graph: TraceGraph): string[] | null {
  if (!graph.nodes.length || graph.edges.length !== graph.nodes.length - 1) return null;
  const ids = new Set(graph.nodes.map(node => node.id));
  const next = new Map<string, string>();
  const incoming = new Set<string>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || next.has(edge.source) || incoming.has(edge.target) || edge.source === edge.target) return null;
    next.set(edge.source, edge.target); incoming.add(edge.target);
  }
  const roots = graph.nodes.filter(node => !incoming.has(node.id));
  if (roots.length !== 1) return null;
  const order: string[] = [];
  const visited = new Set<string>();
  let id: string | undefined = roots[0].id;
  while (id && !visited.has(id)) { visited.add(id); order.push(id); id = next.get(id); }
  return order.length === graph.nodes.length ? order : null;
}

// Presentation changes positions and authored dimensions only. Identifiers and
// directed edges continue to come from the builder or saved trace structure.
export function placeAssessmentGraph(graph: TraceGraph): { graph: TraceGraph; order: string[] } {
  const path = singlePath(graph);
  const indices = new Map((path ?? graph.nodes.map(node => node.id)).map((id, index) => [id, index]));
  const authored = { ...graph, nodes: graph.nodes.map(node => ({ ...node, width: NODE_WIDTH, height: NODE_HEIGHT, style: { ...node.style, width: NODE_WIDTH, height: NODE_HEIGHT } })) };
  const positioned = path
    ? { ...authored, nodes: authored.nodes.map(node => ({ ...node, position: { x: 0, y: indices.get(node.id)! * (NODE_HEIGHT + ROW_GAP) } })) }
    : directedLayout(authored);
  return {
    order: path ?? graph.nodes.map(node => node.id),
    graph: { ...positioned, edges: positioned.edges.map(edge => ({ ...edge, sourceHandle: edge.sourceHandle ?? 'out-bottom', targetHandle: edge.targetHandle ?? 'in-top' })) },
  };
}

export function layoutAssessmentGraph(graph: TraceGraph): TraceGraph { return placeAssessmentGraph(graph).graph; }

export interface AssessmentStageCardProps {
  label: string;
  order: number;
  traversal: string;
  tone: string;
  chosen?: boolean;
  finding?: CriterionStatus;
  findingLabel?: string;
  emptyFinding?: string;
  visits?: number[];
}

export function AssessmentStageCard({ label, order, traversal, tone, chosen, finding, findingLabel = 'Finding', emptyFinding = 'No finding recorded', visits }: AssessmentStageCardProps) {
  return <div className={`af-workspace-node traversal-${tone}${chosen ? ' is-chosen' : ''}`} title={label}>
    {[['top', Position.Top], ['bottom', Position.Bottom]].map(([side, position]) => <React.Fragment key={side}>
      <Handle id={`in-${side}`} type="target" position={position as Position} isConnectable={false} />
      <Handle id={`out-${side}`} type="source" position={position as Position} isConnectable={false} />
    </React.Fragment>)}
    <div className="af-workspace-node-head"><span className="af-workspace-node-order">{String(order).padStart(2, '0')}</span><div className="af-workspace-node-title">{label}</div></div>
    <div className="af-workspace-node-bottom"><span className="af-workspace-traversal" title={visits?.length ? `Recorded visits: ${visits.join(', ')}` : undefined}><span aria-hidden="true" />{traversal}</span><span className="af-workspace-node-finding">{finding ? <><span className="af-workspace-finding-label">{findingLabel}</span><span className={`af-workspace-finding finding-${finding}`}>{findingLabels[finding]}</span></> : <span className="af-workspace-no-finding">{emptyFinding}</span>}</span></div>
  </div>;
}

export interface ChartViewportActions { zoomIn: () => void; zoomOut: () => void; fit: () => void }
export function ChartViewportControls({ actions }: { actions: ChartViewportActions | null }) {
  return <div className="af-workspace-canvas-controls nodrag nopan"><button type="button" disabled={!actions} onClick={() => actions?.zoomOut()} aria-label="Zoom out">−</button><button type="button" disabled={!actions} onClick={() => actions?.zoomIn()} aria-label="Zoom in">+</button><button type="button" disabled={!actions} className="af-workspace-fit" onClick={() => actions?.fit()}>Fit chart</button></div>;
}
