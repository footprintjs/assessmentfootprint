import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

// Execute the shipping functions rather than reproducing their navigation rules.
// Top-level named functions begin and end on unindented lines in this script.
function sourceOf(name: string): string {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(app);
  assert.ok(match, `Missing UI function: ${name}`);
  const end = app.indexOf('\n}', match.index);
  assert.ok(end > match.index, `Missing UI function end: ${name}`);
  return app.slice(match.index, end + 2);
}

function run(id: string, revision = 1) {
  return {
    id, revision, status: 'completed', networkMode: 'offline',
    criteria: [{ id: `${id}-criterion` }],
    events: [{ type: 'criterion_completed', criterionId: `${id}-criterion` }],
    results: [{ criterionId: `${id}-criterion`, status: 'satisfied' }],
  };
}

function workflow(id: string) {
  return { kind: 'replay', recording: { structure: { id: `${id}-chart` } } };
}

function harness() {
  const previous = run('previous');
  const state = {
    run: previous, view: 'run', viewRequest: 0, recordedNavigationRequest: 0,
    submitting: false, flowEditing: false, flowMode: 'complete', flowRequest: 0,
    flowRun: null as ReturnType<typeof run> | null, flow: null as unknown,
    flowSelected: '_freeze-inputs', flowEvents: [] as unknown[], flowResults: [] as unknown[],
    flowTimer: null, replayOpenRunId: null, assessmentStep: 'flow', flowPane: 'chart',
  };
  const requests: Array<{ path: string; resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const rendered: string[] = [];
  const notices: string[] = [];
  const elements = new Map<string, { textContent: string; hidden: boolean; open: boolean; focus: () => void }>();
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, { textContent: '', hidden: false, open: false, focus() {} });
    return elements.get(selector)!;
  };
  const context = createContext({
    state, $: element,
    document: { body: { classList: { toggle() {} } }, querySelectorAll: () => [] },
    viewLabels: { run: 'Results', assessment: 'Assessment', history: 'History' },
    statusLabels: { completed: 'Completed', interrupted: 'Interrupted', running: 'Running' },
    api: (path: string) => new Promise<unknown>((resolve, reject) => requests.push({ path, resolve, reject })),
    renderRun: () => rendered.push(state.run.id),
    showNotice: (message: string) => notices.push(message),
    clearNotice() {}, disposeReplay() {}, renderAssessmentSteps() {},
    updateFlowGraph() {}, updateFlowActions() {}, renderFlowInspector() {}, renderProgress() {},
    leaveFlowDraft() {}, scheduleFlowPreview() {}, clearTimeout() {},
    setFlowPane: (pane: string) => { state.flowPane = pane; },
  });
  runInContext(['setView', 'loadRun', 'newestRunContext', 'syncRecordedFlow', 'resetFlowDraft', 'showRunFlow'].map(sourceOf).join('\n'), context);
  return {
    state, previous, requests, rendered, notices,
    load: (id: string) => runInContext(`loadRun(${JSON.stringify(id)})`, context) as Promise<void>,
    flow: (value: ReturnType<typeof run>) => { context.selectedRun = value; return runInContext('showRunFlow(selectedRun)', context) as Promise<void>; },
    reset: () => runInContext('resetFlowDraft()', context),
  };
}

test('the latest Results selection wins even when an older report arrives first', async () => {
  const h = harness();
  const first = h.load('first');
  const second = h.load('second');
  assert.deepEqual(h.requests.map(request => request.path), ['/api/runs/first', '/api/runs/second']);
  h.requests[0].resolve(run('first'));
  await first;
  assert.equal(h.state.run, h.previous);
  assert.deepEqual(h.rendered, [], 'a superseded report must never be displayed, even transiently');
  const selected = run('second');
  h.state.flowRun = { ...selected, results: [] };
  h.requests[1].resolve(selected);
  await second;
  assert.equal(h.state.run, selected);
  assert.equal(h.state.flowRun, selected, 'refreshing the same saved run also updates its recorded flow findings');
  assert.equal(h.state.view, 'run');
  assert.deepEqual(h.rendered, ['second']);
});

test('starting a new assessment prevents pending Results or recorded Flow responses from reopening the old assessment', async () => {
  for (const response of ['report', 'replay', 'legacy'] as const) {
    const h = harness();
    const pending = response === 'report' ? h.load('older') : h.flow(run('older'));
    h.reset();
    assert.equal(h.state.view, 'assessment');
    assert.equal(h.state.assessmentStep, 'project');
    h.requests[0].resolve(response === 'report' ? run('older') : response === 'replay' ? workflow('older') : { kind: 'legacy', note: 'No recorded chart.' });
    await pending;
    assert.equal(h.state.view, 'assessment', response);
    assert.equal(h.state.assessmentStep, 'project', response);
    assert.equal(h.state.flowRun, null, response);
    assert.equal(h.state.run, h.previous, response);
    assert.deepEqual(h.rendered, [], response);
    assert.deepEqual(h.notices, [], response);
  }
});

test('a recorded Flow request supersedes a pending Results load before either response changes the view', async () => {
  const h = harness();
  const report = h.load('other-report');
  const selected = run('selected-flow');
  const flow = h.flow(selected);
  h.requests[0].resolve(run('other-report'));
  await report;
  assert.equal(h.state.run, h.previous);
  assert.deepEqual(h.rendered, []);
  h.requests[1].resolve(workflow(selected.id));
  await flow;
  assert.equal(h.state.view, 'assessment');
  assert.equal(h.state.assessmentStep, 'flow');
  assert.equal(h.state.flowRun, selected);
  assert.deepEqual(h.state.flowEvents, selected.events);
  assert.deepEqual(h.state.flowResults, selected.results);
  assert.deepEqual(h.rendered, [], 'opening Flow must not briefly show the superseded report');
});

test('a newer Results load supersedes a pending recorded Flow without replacing its selected run or showing stale errors', async () => {
  for (const rejected of [false, true]) {
    const h = harness();
    const flow = h.flow(run('older-flow'));
    const report = h.load('newer-report');
    if (rejected) h.requests[0].reject(new Error('Delayed old workflow failure.'));
    else h.requests[0].resolve(workflow('older-flow'));
    await flow;
    assert.equal(h.state.flowRun, null);
    assert.equal(h.state.view, 'run');
    assert.deepEqual(h.notices, [], 'a superseded workflow error must not appear over the newer selection');
    const selected = run('newer-report');
    h.requests[1].resolve(selected);
    await report;
    assert.equal(h.state.run, selected);
    assert.equal(h.state.flowRun, null);
    assert.equal(h.state.view, 'run');
    assert.deepEqual(h.rendered, ['newer-report']);
  }
});

test('a delayed refresh cannot regress the same assessment after a newer review revision reaches Results or Flow', async () => {
  for (const updatedContext of ['results', 'flow']) {
    const h = harness();
    const older = run('same-assessment', 1);
    const reviewed = { ...run('same-assessment', 2), results: [{ criterionId: 'same-assessment-criterion', status: 'not_satisfied' }] };
    h.state.run = older;
    h.state.flowRun = older;
    const refresh = h.load(older.id);
    if (updatedContext === 'results') h.state.run = reviewed;
    else h.state.flowRun = reviewed;
    h.requests[0].resolve(older);
    await refresh;
    assert.equal(h.state.run, reviewed, updatedContext);
    assert.equal(h.state.flowRun, reviewed, updatedContext);
    assert.equal(h.state.flowResults, reviewed.results, updatedContext);
    assert.deepEqual(h.rendered, [older.id]);
  }
});

test('a pending Flow pairs the original automation structure with the newest same-run reviewed findings', async () => {
  const h = harness();
  const older = run('same-assessment', 1);
  const reviewed = { ...run('same-assessment', 2), results: [{ criterionId: 'same-assessment-criterion', status: 'not_satisfied' }] };
  h.state.run = older;
  h.state.flowRun = older;
  h.state.flowSelected = 'same-assessment-criterion';
  const pending = h.flow(older);
  h.state.run = reviewed;
  const original = workflow(older.id);
  h.requests[0].resolve(original);
  await pending;
  assert.equal(h.state.flowRun, reviewed);
  assert.equal(h.state.flowResults, reviewed.results);
  assert.equal(h.state.run, reviewed);
  assert.equal((h.state.flow as { structure: unknown }).structure, original.recording.structure);
  assert.equal(h.state.flowSelected, 'same-assessment-criterion');
  assert.equal(h.state.view, 'assessment');
  assert.equal(h.state.assessmentStep, 'flow');
});
