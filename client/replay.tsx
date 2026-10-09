import * as React from 'react';
import { Component, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useReactFlow, useStore, useStoreApi } from '@xyflow/react';
import type { Node, NodeProps, NodeTypes } from '@xyflow/react';
import {
  ExplainableProvider,
  GanttTimeline,
  TimeTravelControls,
  ValueInspector,
  useExplainableRun,
} from 'footprint-explainable-ui';
import type { ExplainableRecording, StageSnapshot } from 'footprint-explainable-ui';
import { TracedFlow } from 'footprint-explainable-ui/flowchart';
import type { AssessmentRun, CriterionStatus, EvidenceRecord } from '../src/types.ts';
import '@xyflow/react/dist/style.css';
import './replay.css';
import { measuredTimelineSteps } from './replay-timing.ts';
import { AssessmentStageCard, ChartViewportControls, layoutAssessmentGraph, placeAssessmentGraph } from './assessment-chart.tsx';
import type { ChartViewportActions } from './assessment-chart.tsx';
export { mountWorkspace } from './workspace.tsx';

type ReplayWorkflow = {
  kind: 'replay';
  recording: ExplainableRecording & { scope?: string };
  evidenceId: string;
};

export interface ReplayOptions {
  run: AssessmentRun;
  workflow: ReplayWorkflow;
  onEvidence: (runId: string, evidence: EvidenceRecord) => void;
}

const labels: Record<CriterionStatus, string> = {
  satisfied: 'Satisfied',
  not_satisfied: 'Not satisfied',
  insufficient_evidence: 'Insufficient evidence',
  not_applicable: 'Not applicable',
  evaluation_error: 'Evaluation error',
};
const validStatuses = new Set(Object.keys(labels));
const MAX_REPLAY_STEPS = 512;

function stageId(snapshot?: StageSnapshot): string {
  const id = snapshot?.runtimeStageId || snapshot?.stageName || '';
  const separator = id.indexOf('#');
  return separator < 0 ? id : id.slice(0, separator);
}

function stageLabel(snapshot: StageSnapshot, run?: AssessmentRun): string {
  const id = stageId(snapshot);
  if (id === '_freeze-inputs') return 'Initialize evaluation';
  const criterion = run?.criteria.find(item => item.id === id) || run?.template?.criteria.find(item => item.id === id);
  return criterion?.title || snapshot.stageLabel || snapshot.stageName;
}

function validStatus(value: unknown): CriterionStatus | null {
  return typeof value === 'string' && validStatuses.has(value) ? value as CriterionStatus : null;
}

function StatusBadge({ status }: { status: CriterionStatus }) {
  return <span className={`af-replay-finding-badge af-result-${status}`}>{labels[status]}</span>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function presentationSteps(snapshots: StageSnapshot[], run: AssessmentRun, recording: ExplainableRecording | null): { steps: StageSnapshot[]; measured: boolean } {
  const presentation = measuredTimelineSteps(snapshots, recording);
  return { ...presentation, steps: presentation.steps.map(snapshot => ({ ...snapshot, stageLabel: stageLabel(snapshot, run) })) };
}

type AssessmentNodeData = Record<string, unknown> & {
  label?: string;
  active?: boolean;
  done?: boolean;
  error?: boolean;
  stageId?: string;
  stepNumbers?: number[];
  order?: number;
  recordedFinding?: CriterionStatus;
  isInitialization?: boolean;
};

function AssessmentStageNode({ data }: NodeProps<Node<AssessmentNodeData>>) {
  const traversal = data.error ? 'Execution error' : data.active ? 'Selected step' : data.done ? 'Visited' : 'Later in replay';
  const tone = data.error ? 'interrupted' : data.done ? 'completed' : 'future';
  return <AssessmentStageCard label={String(data.label || 'Recorded step')} order={data.order ?? 1} traversal={traversal} tone={tone} chosen={data.active} finding={data.recordedFinding} findingLabel="At step" emptyFinding={data.isInitialization ? 'No criterion finding' : 'Not yet recorded'} visits={data.stepNumbers} />;
}

const nodeTypes: NodeTypes = { stageNode: AssessmentStageNode };

function ReplayViewportBridge({ onReady }: { onReady: (actions: ChartViewportActions | null) => void }) {
  const instance = useReactFlow();
  const store = useStoreApi();
  const minZoom = useStore(state => state.minZoom);
  useEffect(() => {
    // TracedFlow 0.38 supplies a 0.1 minimum; the public store setter allows
    // the same overview range as the authored assessment workspace.
    if (minZoom !== 0.01) store.getState().setMinZoom(0.01);
    onReady({ zoomIn: () => { void instance.zoomIn({ duration: 120 }); }, zoomOut: () => { void instance.zoomOut({ duration: 120 }); }, fit: () => { void instance.fitView({ padding: 0.1, minZoom: 0.01, maxZoom: 1 }); } });
    return () => onReady(null);
  }, [instance, store, minZoom, onReady]);
  return null;
}

class ReplayBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="af-replay-error" role="status">The recorded traversal could not be displayed. You can still inspect its original workflow output and the criterion findings below.</div>;
    return this.props.children;
  }
}

function ReplayGraph({ run, onInspect }: { run: AssessmentRun; onInspect: () => void }) {
  const { traceGraph, runtimeOverlay, snapshots, selectedSnapshot, selectedIndex, selectIndex } = useExplainableRun();
  const [actions, setActions] = useState<ChartViewportActions | null>(null);
  const graph = useMemo(() => {
    const order = placeAssessmentGraph(traceGraph).order;
    const findings = Array.isArray(selectedSnapshot?.memory.findings) ? selectedSnapshot.memory.findings : [];
    return { ...traceGraph, nodes: traceGraph.nodes.map(node => {
      const criterion = run.criteria.find(item => item.id === node.id) || run.template?.criteria.find(item => item.id === node.id);
      const finding = findings.find(item => item && typeof item === 'object' && (item as Record<string, unknown>).criterionId === node.id) as Record<string, unknown> | undefined;
      return { ...node, data: { ...node.data, label: node.id === '_freeze-inputs' ? 'Initialize evaluation' : criterion?.title || node.data.label, order: order.indexOf(node.id) + 1, isInitialization: node.id === '_freeze-inputs', recordedFinding: validStatus(finding?.status) ?? undefined } };
    }) };
  }, [traceGraph, run.criteria, run.template, selectedSnapshot]);
  const scrubIndex = runtimeOverlay.executionOrder.findIndex(step => step.runtimeStageId === snapshots[selectedIndex]?.runtimeStageId);
  const selectStage = (id: string) => {
    const matches = snapshots.map((snapshot, index) => ({ id: stageId(snapshot), index })).filter(item => item.id === id);
    const match = matches.find(item => item.index >= selectedIndex) || matches[matches.length - 1];
    if (match) { selectIndex(match.index); onInspect(); }
  };
  return <section className="af-replay-graph" aria-label="Recorded execution graph">
    <header className="af-replay-surface-heading"><div><h3>Recorded traversal</h3><span>Click a step to inspect it</span></div><ChartViewportControls actions={actions} /></header>
    <div className="af-replay-graph-canvas">{graph.nodes.length ? <TracedFlow graph={graph} overlay={runtimeOverlay} scrubIndex={scrubIndex < 0 ? selectedIndex : scrubIndex} nodeTypes={nodeTypes} layout={layoutAssessmentGraph} onNodeClick={selectStage} theme="light" style={{ minHeight: 0 }} colors={{ active: '#2752ad', done: '#37684d', default: '#162a40', error: '#ad4d43' }}><ReplayViewportBridge onReady={setActions} /></TracedFlow> : <p className="af-replay-empty">This recording has no saved structure, so a graph is unavailable.</p>}</div>
    <details className="af-replay-graph-help"><summary>About replay status</summary><p className="af-replay-graph-legend"><span className="af-replay-legend-dot visited" /> Visited <span className="af-replay-legend-dot current" /> Selected step <span>These colours describe traversal. At-step findings come from saved evaluation state; later reviews remain separate.</span></p></details>
  </section>;
}

function EvidenceButtons({ run, ids, onEvidence }: { run: AssessmentRun; ids: string[]; onEvidence: ReplayOptions['onEvidence'] }) {
  const evidence = ids.map(id => run.evidence.find(item => item.id === id)).filter((item): item is EvidenceRecord => Boolean(item));
  if (!evidence.length) return <p className="af-replay-muted">No collected evidence is attached to this criterion.</p>;
  return (
    <div className="af-replay-evidence-list">
      {evidence.map(item => <button key={item.id} type="button" className="af-replay-evidence-button" onClick={() => onEvidence(run.id, item)} aria-label={`Inspect original evidence: ${item.source}`}><strong>{item.source || item.id}</strong><span>{item.toolId} · original output <span aria-hidden="true">↗</span></span></button>)}
    </div>
  );
}

function StepContext({ run, onEvidence }: { run: AssessmentRun; onEvidence: ReplayOptions['onEvidence'] }) {
  const { selectedSnapshot, selectedIndex, snapshots } = useExplainableRun();
  if (!selectedSnapshot) return null;
  const id = stageId(selectedSnapshot);
  const criterion = run.criteria.find(item => item.id === id) || run.template?.criteria.find(item => item.id === id);
  const finding = run.results.find(item => item.criterionId === id);
  const stageFindings = Array.isArray(selectedSnapshot.memory.findings) ? selectedSnapshot.memory.findings : [];
  const recordedFinding = stageFindings.find(item => item && typeof item === 'object' && (item as Record<string, unknown>).criterionId === id) as Record<string, unknown> | undefined;
  const recordedStatus = validStatus(recordedFinding?.status);
  const completedEvent = run.events.find(event => event.type === 'criterion_completed' && event.criterionId === id);
  const recordedRationale = typeof recordedFinding?.rationale === 'string' ? recordedFinding.rationale : completedEvent?.message;
  const recordedEvidenceIds = Array.isArray(recordedFinding?.evidenceIds) && recordedFinding.evidenceIds.every(value => typeof value === 'string')
    ? recordedFinding.evidenceIds as string[] : finding?.evidenceIds || [];
  const latestReview = run.reviews.filter(review => review.criterionId === id).at(-1);
  return (
    <aside className="af-replay-step-context" aria-label="Selected recorded step">
      <div className="af-replay-step-position">RECORDED STEP {selectedIndex + 1} OF {snapshots.length}</div>
      <h3>{criterion?.title || stageLabel(selectedSnapshot)}</h3>
      {criterion ? <div className="af-replay-criterion-id">{criterion.id} · {criterion.dimension}</div> : null}
      <div className="af-replay-traversal-state">Traversal: {selectedSnapshot.status === 'error' ? 'execution error recorded' : 'step recorded'}</div>
      {!criterion ? <p className="af-replay-context-copy">This step initialized evaluation state for the recorded assessment. The selected project files were captured before this traversal began.</p> : (
        <>
          <section className="af-replay-finding-section"><h4>Finding at this step</h4>{recordedStatus ? <StatusBadge status={recordedStatus} /> : <p className="af-replay-muted">No criterion status was stored in this step.</p>}{recordedRationale ? <p>{recordedRationale}</p> : null}</section>
          {finding?.automaticResult ? <section className="af-replay-automatic-result"><h4>Retained automatic rule result</h4><StatusBadge status={finding.automaticResult.status} /><p>{finding.automaticResult.rationale}</p><small>The criterion also requires an attributed human decision.</small></section> : null}
          <details className="af-replay-rule"><summary>Criterion rule &amp; evidence requirements</summary><p>{criterion.rule}</p><ul>{criterion.evidenceRequirements.map((requirement, index) => <li key={index}>{requirement}</li>)}</ul></details>
          <section className="af-replay-finding-section"><h4>Evidence attached to this criterion</h4><EvidenceButtons run={run} ids={recordedEvidenceIds} onEvidence={onEvidence} /><p className="af-replay-evidence-note">These links identify the criterion’s evidence. The execution trace does not establish a file-to-decision causal explanation.</p></section>
          {finding?.coverage.length || finding?.limitations.length ? <details className="af-replay-rule"><summary>Evidence coverage &amp; limitations</summary>{finding.coverage.length ? <ul>{finding.coverage.map((entry, index) => <li key={`coverage-${index}`}>{entry}</li>)}</ul> : null}{finding.limitations.length ? <ul>{finding.limitations.map((entry, index) => <li key={`limit-${index}`}>{entry}</li>)}</ul> : null}</details> : null}
          {latestReview ? <section className="af-replay-later-review"><h4>Later human review</h4><StatusBadge status={latestReview.decision} /><p className="af-replay-review-attribution">{latestReview.reviewer} · {formatDate(latestReview.createdAt)}</p><p>{latestReview.rationale}</p><small>This attributed review is separate from the automated traversal. It has not changed the recorded step.</small></section> : finding && (run.template?.criteria.find(item => item.id === id)?.requiresReview || criterion.mode === 'expert') ? <section className="af-replay-later-review"><h4>Human review</h4><p>No attributed review has been recorded for this criterion. Add your review in its finding below.</p></section> : null}
        </>
      )}
      <RecordedDetails run={run} />
    </aside>
  );
}

function RecordedDetails({ run }: { run: AssessmentRun }) {
  const { snapshots, selectedIndex, selectIndex, recording } = useExplainableRun();
  const presentation = useMemo(() => presentationSteps(snapshots, run, recording), [snapshots, run, recording]);
  const displaySnapshots = presentation.steps;
  const allMeasuredZero = presentation.measured && displaySnapshots.every(snapshot => snapshot.durationMs === 0);
  return <details className="af-replay-recorded-details"><summary>Timing &amp; recorded state</summary>      <section className="af-replay-timeline" aria-label="Recorded execution timing"><header className="af-replay-surface-heading"><h3>Execution timeline</h3><span>Click a row to select its step</span></header>{allMeasuredZero ? <div className="af-replay-measured-zero"><p>The recorder measured every step as 0 ms at its available precision. The rows show execution order.</p><ol>{displaySnapshots.map((snapshot, index) => <li key={`${snapshot.runtimeStageId}-${index}`}><button type="button" onClick={() => selectIndex(index)} aria-pressed={index === selectedIndex}><span>{snapshot.stageLabel}</span><span>0 ms · measured</span></button></li>)}</ol></div> : <GanttTimeline snapshots={displaySnapshots} selectedIndex={selectedIndex} onSelect={selectIndex} theme="light" size="default" className="af-replay-gantt" maxVisibleRows={6} />}<p className="af-replay-timing-note">{presentation.measured ? 'Durations come from the saved Metrics recorder, shown to four significant digits. Offsets sum these stage durations for this sequential evaluation.' : 'When durations are unavailable, the timeline shows execution order.'} File capture and later human review are outside this timeline.</p></section>
      <details className="af-replay-technical-state"><summary>Inspect recorded state and changes</summary><p>This is the saved evaluation state at the selected step. Human reviews are stored separately.</p><div className="af-replay-state-inspector"><ValueInspector title="Recorded state & changes" size="compact" /></div></details></details>;
}

function ReplaySurfaces({ run, onEvidence }: { run: AssessmentRun; onEvidence: ReplayOptions['onEvidence'] }) {
  const { snapshots, selectedIndex, selectIndex, error, traceGraph, recording } = useExplainableRun();
  const presentation = useMemo(() => presentationSteps(snapshots, run, recording), [snapshots, run, recording]);
  const displaySnapshots = presentation.steps;
  const [pane, setPane] = useState<'chart' | 'details'>('chart');
  const inspect = () => { if (window.matchMedia('(max-width: 900px)').matches) setPane('details'); };
  if (error || !snapshots.length) return <div className="af-replay-error" role="status">{error || 'This recording has no executed steps to replay.'} Original workflow output and criterion findings remain available.</div>;
  if (snapshots.length > MAX_REPLAY_STEPS || traceGraph.nodes.length > MAX_REPLAY_STEPS) return <div className="af-replay-error" role="status">This recording exceeds the interactive viewer’s {MAX_REPLAY_STEPS}-step limit. Inspect its original workflow output instead.</div>;
  return (
    <div className="af-replay" data-pane={pane}>
      <div className="af-replay-header"><strong>Recorded replay</strong><span>Checks are not rerun.</span></div>
      <div className="af-replay-controls"><TimeTravelControls snapshots={displaySnapshots} selectedIndex={selectedIndex} onIndexChange={selectIndex} unstyled size="compact" /><label className="af-replay-jump">Jump to step<select value={selectedIndex} onChange={event => selectIndex(Number(event.currentTarget.value))}>{displaySnapshots.map((snapshot, index) => <option key={`${snapshot.runtimeStageId || snapshot.stageName}-${index}`} value={index}>{index + 1}. {snapshot.stageLabel}</option>)}</select></label></div>
      <div className="af-replay-pane-tabs"><button type="button" aria-pressed={pane === 'chart'} onClick={() => setPane('chart')}>Chart</button><button type="button" aria-pressed={pane === 'details'} onClick={() => setPane('details')}>Selected step</button></div>
      <div className="af-replay-main"><ReplayGraph run={run} onInspect={inspect} /><StepContext run={run} onEvidence={onEvidence} /></div>

    </div>
  );
}

export function mountReplay(container: HTMLElement, { run, workflow, onEvidence }: ReplayOptions): () => void {
  const root = createRoot(container);
  let mounted = true;
  root.render(
    <ReplayBoundary>
      <ExplainableProvider recording={workflow.recording} theme={{ mode: 'light' }} defaultSelectedIndex={0}>
        <ReplaySurfaces run={run} onEvidence={onEvidence} />
      </ExplainableProvider>
    </ReplayBoundary>,
  );
  return () => { if (mounted) { mounted = false; root.unmount(); } };
}
