import * as React from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Background, BackgroundVariant, Handle, MarkerType, Position, ReactFlow,
  getNodesBounds, getViewportForBounds, useReactFlow,
} from '@xyflow/react';
import type { Edge, Node, NodeProps, NodeTypes, Viewport } from '@xyflow/react';
import { graphFromStructure } from 'footprint-explainable-ui';
import { createDagreTraceLayout } from 'footprint-explainable-ui/flowchart';
import type { TraceGraph } from 'footprint-explainable-ui/flowchart';
import type { CriterionDefinition, CriterionResult, CriterionStatus, RunEvent, TemplateCriterion } from '../src/types.ts';
import './workspace.css';

export interface WorkspaceOptions {
  structure: unknown;
  criteria: CriterionDefinition[];
  mode: 'draft' | 'running' | 'complete' | 'interrupted';
  selectedId: string | null;
  events: RunEvent[];
  results: CriterionResult[];
  onSelect: (id: string) => void;
}

export interface WorkspaceHandle {
  update: (options: WorkspaceOptions) => void;
  unmount: () => void;
}

type TraversalState = 'configured' | 'waiting' | 'running' | 'completed' | 'interrupted' | 'unrecorded';
type StageData = Record<string, unknown> & {
  label: string;
  collectorLabel: string;
  order: number;
  traversal: TraversalState;
  finding?: CriterionStatus;
  chosen: boolean;
};
type StageNode = Node<StageData>;
const NODE_WIDTH = 214;
const NODE_HEIGHT = 126;
const COLUMN_GAP = 46;
const ROW_GAP = 50;
const MAX_STAGES = 128;
const findingLabels: Record<CriterionStatus, string> = {
  satisfied: 'Satisfied',
  not_satisfied: 'Not satisfied',
  insufficient_evidence: 'Insufficient evidence',
  not_applicable: 'Not applicable',
  evaluation_error: 'Evaluation error',
};
const traversalLabels: Record<TraversalState, string> = {
  configured: 'Configured', waiting: 'Not started', running: 'Running',
  completed: 'Completed', interrupted: 'Interrupted', unrecorded: 'Event not recorded',
};
const directedLayout = createDagreTraceLayout({ direction: 'LR', nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT, rankSep: 60, nodeSep: 42 });

function criterionType(criterion?: CriterionDefinition): string {
  if (!criterion) return 'Evaluation state';
  const template = criterion as Partial<TemplateCriterion>;
  const expert = criterion.mode === 'expert' || template.evaluation?.kind === 'expert' ||
    (template.evaluation?.kind === 'builtin' && template.evaluation.criterionId === 'governance-review');
  if (expert) return 'Expert review';
  const tool = template.collector?.toolId;
  const collector = tool === 'osv-scanner' ? 'OSV-Scanner' : tool === 'project-files' ? 'Project files' : 'Automatic check';
  return template.requiresReview ? `${collector} · review required` : collector;
}

function traversalState(id: string, options: WorkspaceOptions): TraversalState {
  if (options.mode === 'draft') return 'configured';
  let state: TraversalState = options.mode === 'complete' ? 'unrecorded' : 'waiting';
  for (const event of options.events) {
    const matches = event.stageId === id || event.criterionId === id;
    if (!matches) continue;
    if (event.type === 'stage_started' || event.type === 'criterion_started') state = 'running';
    if (event.type === 'stage_completed' || event.type === 'criterion_completed') state = 'completed';
  }
  return state === 'running' && options.mode === 'interrupted' ? 'interrupted' : state;
}

// Wrapping is only a visual placement of a verified single path. Original
// stage identifiers and directed edges always come from the builder structure.
function singlePath(graph: TraceGraph): string[] | null {
  if (!graph.nodes.length || graph.edges.length !== graph.nodes.length - 1) return null;
  const ids = new Set(graph.nodes.map(node => node.id));
  const next = new Map<string, string>();
  const incoming = new Set<string>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || next.has(edge.source) || incoming.has(edge.target) || edge.source === edge.target) return null;
    next.set(edge.source, edge.target);
    incoming.add(edge.target);
  }
  const roots = graph.nodes.filter(node => !incoming.has(node.id));
  if (roots.length !== 1) return null;
  const order: string[] = [];
  let id: string | undefined = roots[0].id;
  const visited = new Set<string>();
  while (id && !visited.has(id)) {
    visited.add(id);
    order.push(id);
    id = next.get(id);
  }
  return order.length === graph.nodes.length ? order : null;
}

function placedGraph(graph: TraceGraph): { graph: TraceGraph; order: string[]; wrapped: boolean } {
  const order = singlePath(graph);
  if (!order) return { graph: directedLayout(graph), order: graph.nodes.map(node => node.id), wrapped: false };
  const indices = new Map(order.map((id, index) => [id, index]));
  const columns = Math.min(3, order.length);
  const nodes = graph.nodes.map(node => {
    const index = indices.get(node.id)!;
    const row = Math.floor(index / columns);
    const column = row % 2 === 0 ? index % columns : columns - 1 - index % columns;
    return { ...node, position: { x: column * (NODE_WIDTH + COLUMN_GAP), y: row * (NODE_HEIGHT + ROW_GAP) } };
  });
  const positions = new Map(nodes.map(node => [node.id, node.position]));
  const edges = graph.edges.map(edge => {
    const source = positions.get(edge.source)!;
    const target = positions.get(edge.target)!;
    const down = target.y > source.y;
    return { ...edge, sourceHandle: down ? 'out-bottom' : target.x > source.x ? 'out-right' : 'out-left', targetHandle: down ? 'in-top' : target.x > source.x ? 'in-left' : 'in-right' };
  });
  return { graph: { nodes, edges }, order, wrapped: order.length > columns };
}

function AssessmentNode({ data }: NodeProps<StageNode>) {
  return (
    <div className={`af-workspace-node traversal-${data.traversal}${data.chosen ? ' is-chosen' : ''}`} title={data.label}>
      {[['left', Position.Left], ['right', Position.Right], ['top', Position.Top], ['bottom', Position.Bottom]].map(([side, position]) => (
        <React.Fragment key={side}>
          <Handle id={`in-${side}`} type="target" position={position as Position} isConnectable={false} />
          <Handle id={`out-${side}`} type="source" position={position as Position} isConnectable={false} />
        </React.Fragment>
      ))}
      <div className="af-workspace-node-top"><span className="af-workspace-node-order">{data.order}</span><span className="af-workspace-traversal"><span aria-hidden="true" />{traversalLabels[data.traversal]}</span></div>
      <div className="af-workspace-node-title">{data.label}</div>
      <div className="af-workspace-node-tool">{data.collectorLabel}</div>
      <div className="af-workspace-node-finding">{data.finding ? <><span className="af-workspace-finding-label">Current finding</span><span className={`af-workspace-finding finding-${data.finding}`}>{findingLabels[data.finding]}</span></> : <span className="af-workspace-no-finding">{data.traversal === 'configured' ? 'Select to configure' : 'No finding recorded'}</span>}</div>
    </div>
  );
}
const nodeTypes: NodeTypes = { assessmentStage: AssessmentNode };

function ViewportControls({ onFit }: { onFit: () => void }) {
  const { zoomIn, zoomOut } = useReactFlow();
  return <div className="af-workspace-canvas-controls nodrag nopan"><button type="button" onClick={() => { void zoomOut({ duration: 120 }); }} aria-label="Zoom out">−</button><button type="button" onClick={() => { void zoomIn({ duration: 120 }); }} aria-label="Zoom in">+</button><button type="button" className="af-workspace-fit" onClick={onFit}>Fit chart</button></div>;
}

function WorkspaceCanvas({ nodes, edges, topologyKey, onSelect }: { nodes: StageNode[]; edges: Edge[]; topologyKey: string; onSelect: WorkspaceOptions['onSelect'] }) {
  const canvas = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  // These cards have a fixed authored footprint, independent of live content
  // or React Flow's optional measured fields. Only topology changes the bounds.
  const bounds = useMemo(() => getNodesBounds(nodes.map(node => ({ ...node, measured: undefined, width: NODE_WIDTH, height: NODE_HEIGHT }))), [topologyKey]);
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fit = useCallback(() => {
    if (size.width > 0 && size.height > 0) setViewport(getViewportForBounds(bounds, size.width, size.height, 0.08, 1, 0.10));
  }, [bounds, size.width, size.height]);
  useEffect(fit, [fit]);
  return <div className="af-workspace-canvas" ref={canvas}>
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      viewport={viewport} onViewportChange={setViewport}
      onNodeClick={(_event, node) => onSelect(node.id)}
      nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false}
      deleteKeyCode={null} selectionOnDrag={false} selectNodesOnDrag={false}
      minZoom={0.08} maxZoom={1.75} panOnScroll zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
      ariaLabelConfig={{ 'node.a11yDescription.default': 'Select a stage to inspect or configure it. Use the stage selector above as a keyboard alternative.', 'controls.ariaLabel': 'Chart view controls' }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#cdd5d8" />
      <ViewportControls onFit={fit} />
    </ReactFlow>
  </div>;
}

function Workspace(options: WorkspaceOptions) {
  const pickerId = useId();
  const built = useMemo(() => {
    try {
      const graph = graphFromStructure(options.structure);
      if (!graph.nodes.length) return { error: 'The builder returned no assessment stages.' };
      if (graph.nodes.length > MAX_STAGES) return { error: `This chart exceeds the ${MAX_STAGES}-stage interactive limit.` };
      return { ...placedGraph(graph), error: undefined };
    } catch {
      return { error: 'This assessment structure could not be displayed. The stage details remain available.' };
    }
  }, [options.structure]);
  if (!('graph' in built)) return <div className="af-workspace-unavailable" role="status">{built.error}</div>;
  const definitions = new Map(options.criteria.map(criterion => [criterion.id, criterion]));
  const results = new Map(options.results.map(result => [result.criterionId, result]));
  const indices = new Map(built.order.map((id, index) => [id, index]));
  const nodes: StageNode[] = built.graph.nodes.map(node => {
    const criterion = definitions.get(node.id);
    const traversal = traversalState(node.id, options);
    return {
      ...node, type: 'assessmentStage', width: NODE_WIDTH, height: NODE_HEIGHT,
      style: { ...node.style, width: NODE_WIDTH, height: NODE_HEIGHT },
      selected: node.id === options.selectedId, draggable: false, connectable: false,
      ariaLabel: `${node.id === '_freeze-inputs' ? 'Initialize evaluation' : criterion?.title || node.data.label}. ${traversalLabels[traversal]}. Select to inspect.`,
      data: {
        ...node.data, label: node.id === '_freeze-inputs' ? 'Initialize evaluation' : criterion?.title || node.data.label,
        collectorLabel: criterionType(criterion), order: (indices.get(node.id) ?? 0) + 1,
        traversal, chosen: node.id === options.selectedId,
        finding: options.mode === 'draft' ? undefined : results.get(node.id)?.status,
      },
    };
  });
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const edges: Edge[] = built.graph.edges.map(edge => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const completed = source?.data.traversal === 'completed' && target?.data.traversal === 'completed';
    const color = completed ? '#357567' : '#374d61';
    return {
      ...edge, type: 'smoothstep', sourceHandle: edge.sourceHandle || 'out-right', targetHandle: edge.targetHandle || 'in-left',
      animated: false, interactionWidth: 14,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 22, height: 22 },
      style: { ...edge.style, stroke: color, strokeWidth: 2.6 },
    };
  });
  const topologyKey = JSON.stringify([nodes.map(node => [node.id, node.position.x, node.position.y]), edges.map(edge => [edge.id, edge.source, edge.target, edge.sourceHandle, edge.targetHandle])]);
  const modeLabel = options.mode === 'draft' ? 'Configuration' : options.mode === 'running' ? 'Live evaluation' : options.mode === 'interrupted' ? 'Interrupted evaluation' : 'Recorded evaluation';
  return (
    <section className="af-workspace" aria-label="Assessment flowchart">
      <div className="af-workspace-toolbar"><div><strong>{modeLabel}</strong><span>{nodes.length} connected stages · {built.wrapped ? 'continues on the next row' : 'follow the arrows'}</span></div><label htmlFor={pickerId}>Select stage<select id={pickerId} value={options.selectedId || ''} onChange={event => { if (event.currentTarget.value) options.onSelect(event.currentTarget.value); }}><option value="">Choose a stage</option>{built.order.map(id => <option key={id} value={id}>{(indices.get(id) ?? 0) + 1}. {nodeById.get(id)?.data.label}</option>)}</select></label></div>
      <WorkspaceCanvas nodes={nodes} edges={edges} topologyKey={topologyKey} onSelect={options.onSelect} />
      <div className="af-workspace-legend"><span><i className="legend-running" />Running</span><span><i className="legend-completed" />Stage completed</span><span><i className="legend-selected" />Selected for inspection</span><span className="af-workspace-legend-note">Completion describes traversal. Current findings are separate.</span></div>
      <p className="af-workspace-scope">Arrows come from the assessment builder. Project input capture happens before this evaluation; attributed human review is separate.</p>
    </section>
  );
}

export function mountWorkspace(container: HTMLElement, options: WorkspaceOptions): WorkspaceHandle {
  const root = createRoot(container);
  let mounted = true;
  root.render(<Workspace {...options} />);
  return {
    update(nextOptions) { if (mounted) root.render(<Workspace {...nextOptions} />); },
    unmount() { if (mounted) { mounted = false; root.unmount(); } },
  };
}
