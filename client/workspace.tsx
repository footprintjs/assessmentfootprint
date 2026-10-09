import * as React from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Background, BackgroundVariant, MarkerType, ReactFlow, ReactFlowProvider,
  getNodesBounds, getViewportForBounds, useReactFlow,
} from '@xyflow/react';
import type { Edge, Node, NodeProps, NodeTypes, Viewport } from '@xyflow/react';
import { graphFromStructure } from 'footprint-explainable-ui';
import type { CriterionDefinition, CriterionResult, CriterionStatus, RunEvent } from '../src/types.ts';
import './workspace.css';
import { AssessmentStageCard, ChartViewportControls, findingLabels, NODE_WIDTH, NODE_HEIGHT, placeAssessmentGraph } from './assessment-chart.tsx';

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
  order: number;
  traversal: TraversalState;
  finding?: CriterionStatus;
  chosen: boolean;
};
type StageNode = Node<StageData>;
const MAX_STAGES = 128;
const traversalLabels: Record<TraversalState, string> = {
  configured: 'Configured', waiting: 'Not started', running: 'Running',
  completed: 'Completed', interrupted: 'Interrupted', unrecorded: 'Event not recorded',
};

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

function AssessmentNode({ data }: NodeProps<StageNode>) {
  return <AssessmentStageCard label={data.label} order={data.order} traversal={traversalLabels[data.traversal]} tone={data.traversal} chosen={data.chosen} finding={data.finding} emptyFinding={data.traversal === 'configured' ? 'Select to configure' : 'No finding recorded'} />;
}

const nodeTypes: NodeTypes = { assessmentStage: AssessmentNode };

function ViewportControls({ onFit }: { onFit: () => void }) {
  const { zoomIn, zoomOut } = useReactFlow();
  return <ChartViewportControls actions={{ zoomIn: () => { void zoomIn({ duration: 120 }); }, zoomOut: () => { void zoomOut({ duration: 120 }); }, fit: onFit }} />;
}

function WorkspaceHelp() {
  return <details className="af-workspace-help"><summary>About this flow</summary><div className="af-workspace-legend"><span><i className="legend-running" />Running</span><span><i className="legend-completed" />Stage completed</span><span><i className="legend-selected" />Selected for inspection</span><span className="af-workspace-legend-note">Completion describes traversal. Current findings are separate.</span></div><p className="af-workspace-scope">Arrows come from the assessment builder. Project input capture happens before this evaluation; attributed human review is separate.</p></details>;
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
      // A focused view can temporarily hide this mounted chart. Keep its last
      // visible size so returning to it does not reset a user's inspection zoom.
      if (width <= 0 || height <= 0) return;
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fit = useCallback(() => {
    if (size.width > 0 && size.height > 0) setViewport(getViewportForBounds(bounds, size.width, size.height, 0.01, 1, 0.10));
  }, [bounds, size.width, size.height]);
  // Fit the authored topology to the bounded canvas. Selection, findings and
  // live events do not change these bounds, so a user's pan or zoom is retained.
  useEffect(() => {
    fit();
  }, [fit]);
  return <div className="af-workspace-canvas-group"><ReactFlowProvider><div className="af-workspace-chart-controls"><ViewportControls onFit={fit} /><WorkspaceHelp /></div><div className="af-workspace-canvas" ref={canvas}>
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      viewport={viewport} onViewportChange={setViewport}
      onNodeClick={(_event, node) => onSelect(node.id)}
      nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false}
      deleteKeyCode={null} selectionOnDrag={false} selectNodesOnDrag={false}
      minZoom={0.01} maxZoom={1.75} panOnScroll={false} zoomOnScroll={false} preventScrolling={false} zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
      ariaLabelConfig={{ 'node.a11yDescription.default': 'Select a stage to inspect or configure it. Use the stage selector above as a keyboard alternative.', 'controls.ariaLabel': 'Chart view controls' }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#d4d0c6" />
    </ReactFlow>
  </div></ReactFlowProvider></div>;
}

function Workspace(options: WorkspaceOptions) {
  const pickerId = useId();
  const built = useMemo(() => {
    try {
      const graph = graphFromStructure(options.structure);
      if (!graph.nodes.length) return { error: 'The builder returned no assessment stages.' };
      if (graph.nodes.length > MAX_STAGES) return { error: `This chart exceeds the ${MAX_STAGES}-stage interactive limit.` };
      return { ...placeAssessmentGraph(graph), error: undefined };
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
      ariaLabel: `${node.id === '_freeze-inputs' ? 'Initialize evaluation' : criterion?.title || node.data.label}. Traversal: ${traversalLabels[traversal]}.${options.mode !== 'draft' && results.get(node.id) ? ` Current finding: ${findingLabels[results.get(node.id)!.status]}.` : ''} Select to inspect.`,
      data: {
        ...node.data, label: node.id === '_freeze-inputs' ? 'Initialize evaluation' : criterion?.title || node.data.label,
        order: (indices.get(node.id) ?? 0) + 1,
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
    const color = completed ? '#357567' : '#162a40';
    return {
      ...edge, type: 'smoothstep', sourceHandle: edge.sourceHandle || 'out-bottom', targetHandle: edge.targetHandle || 'in-top',
      animated: false, interactionWidth: 14,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 22, height: 22 },
      style: { ...edge.style, stroke: color, strokeWidth: 2.6 },
    };
  });
  const topologyKey = JSON.stringify([nodes.map(node => [node.id, node.position.x, node.position.y]), edges.map(edge => [edge.id, edge.source, edge.target, edge.sourceHandle, edge.targetHandle])]);
  const modeLabel = options.mode === 'draft' ? 'Configuration' : options.mode === 'running' ? 'Live evaluation' : options.mode === 'interrupted' ? 'Interrupted evaluation' : 'Recorded evaluation';
  return (
    <section className="af-workspace" aria-label="Assessment flowchart">
      <div className="af-workspace-toolbar"><div><strong>{modeLabel}</strong><span>{nodes.length} stages · top to bottom</span></div><label htmlFor={pickerId}>Select stage<select id={pickerId} value={options.selectedId || ''} onChange={event => { if (event.currentTarget.value) options.onSelect(event.currentTarget.value); }}><option value="">Choose a stage</option>{built.order.map(id => <option key={id} value={id}>{(indices.get(id) ?? 0) + 1}. {nodeById.get(id)?.data.label}</option>)}</select></label></div>
      <WorkspaceCanvas nodes={nodes} edges={edges} topologyKey={topologyKey} onSelect={options.onSelect} />
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
