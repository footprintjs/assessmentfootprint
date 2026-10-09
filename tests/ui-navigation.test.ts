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

function testElement() {
  return {
    textContent: '', hidden: false, open: false, isConnected: true,
    dataset: {} as Record<string, string>, attributes: {} as Record<string, string>,
    children: [] as unknown[], value: '', id: '',
    listeners: new Map<string, (event: { preventDefault(): void }) => Promise<void>>(),
    focus() {}, setAttribute(name: string, value: string) { this.attributes[name] = value; },
    replaceChildren(...children: unknown[]) { this.children = children; },
    append(...children: unknown[]) { this.children.push(...children); },
    reportValidity() { return true; },
    addEventListener(name: string, listener: (event: { preventDefault(): void }) => Promise<void>) { this.listeners.set(name, listener); },
  };
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
  const elements = new Map<string, ReturnType<typeof testElement>>();
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, testElement());
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
  runInContext(['setView', 'loadRun', 'newestRunContext', 'syncRecordedFlow', 'resetFlowDraft', 'showRunFlow', 'setResultsPane'].map(sourceOf).join('\n'), context);
  return {
    state, previous, requests, rendered, notices,
    load: (id: string) => runInContext(`loadRun(${JSON.stringify(id)})`, context) as Promise<void>,
    flow: (value: ReturnType<typeof run>) => { context.selectedRun = value; return runInContext('showRunFlow(selectedRun)', context) as Promise<void>; },
    reset: () => runInContext('resetFlowDraft()', context),
    findings: () => runInContext("setResultsPane('findings')", context),
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

test('an explicit Results pane selection supersedes a pending recorded Flow', async () => {
  const h = harness();
  const pending = h.flow(h.previous);
  h.findings();
  h.requests[0].resolve(workflow(h.previous.id));
  await pending;
  assert.equal(h.state.view, 'run');
  assert.equal(h.state.flowRun, null);
  assert.equal(h.state.run, h.previous);
  assert.deepEqual(h.rendered, []);
  assert.deepEqual(h.notices, []);
});

test('leaving Replay aborts and invalidates a deferred workflow; reopening mounts only a fresh response', async () => {
  const selected = run('assessment');
  const state = {
    run: selected, view: 'run', recordedNavigationRequest: 0,
    replayRequest: 0, replayAbort: null as AbortController | null,
    replayUnmount: null as (() => void) | null, replayOpenRunId: null as string | null,
  };
  const panel = testElement(); panel.hidden = true;
  const report = testElement();
  const container = testElement();
  const content = testElement();
  const controls = ['findings', 'replay'].map(pane => {
    const control = testElement(); control.dataset.resultsPane = pane; return control;
  });
  const requests: Array<{ path: string; signal: AbortSignal; resolve: (value: unknown) => void }> = [];
  const pending: Promise<void>[] = [];
  const mounted: unknown[] = [];
  const fallbacks: unknown[] = [];
  let unmounted = 0;
  const elements = new Map([
    ['#recorded-replay-panel', panel], ['#results-findings', report],
    ['.recorded-replay-mount', container], ['#run-content', content],
    ['#results-findings-tab', controls[0]], ['#results-replay-tab', controls[1]],
  ]);
  const context = createContext({
    state, AbortController, setTimeout, clearTimeout, pending,
    $: (selector: string) => { const element = elements.get(selector); assert.ok(element, selector); return element; },
    document: { querySelectorAll: () => controls },
    node: () => testElement(),
    fetch: (path: string, options: { signal: AbortSignal }) => new Promise(resolve => requests.push({ path, signal: options.signal, resolve })),
    loadReplayStyles: async () => {},
    loadReplayModule: async () => ({ mountReplay(_container: unknown, options: { workflow: unknown }) { mounted.push(options.workflow); return () => { unmounted += 1; }; } }),
    renderWorkflowFallback: (_run: unknown, value: unknown) => fallbacks.push(value),
    openEvidence() {},
  });
  runInContext(['setResultsPane', 'loadRecordedReplay', 'disposeReplay'].map(sourceOf).join('\n'), context);
  runInContext('const shippingLoader = loadRecordedReplay; loadRecordedReplay = (...args) => { const load = shippingLoader(...args); pending.push(load); return load; };', context);
  runInContext("setResultsPane('replay')", context);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/runs/assessment/workflow');
  assert.equal(requests[0].signal.aborted, false);
  runInContext("setResultsPane('findings')", context);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(panel.hidden, true);
  assert.equal(report.hidden, false);
  assert.equal(state.replayOpenRunId, null);
  assert.deepEqual(container.children, []);
  // Deliberately deliver a response despite cancellation to exercise the
  // request/pane guards, not only the browser's AbortSignal behavior.
  requests[0].resolve({ ok: true, json: async () => workflow('stale') });
  await pending[0];
  assert.deepEqual(mounted, []);
  assert.deepEqual(fallbacks, []);
  runInContext("setResultsPane('replay')", context);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[1].signal, requests[0].signal);
  assert.equal(requests[1].signal.aborted, false);
  const fresh = workflow('fresh');
  requests[1].resolve({ ok: true, json: async () => fresh });
  await pending[1];
  assert.deepEqual(mounted, [fresh]);
  assert.equal(panel.dataset.replayLoaded, 'true');
  assert.equal(state.replayAbort, null);
  runInContext("setResultsPane('findings')", context);
  assert.equal(unmounted, 1);
  assert.equal(state.replayUnmount, null);
  assert.equal(panel.dataset.replayLoaded, 'false');
  assert.equal(panel.dataset.replayLoading, 'false');
});

test('a saved review remains successful when the auxiliary history refresh fails', async () => {
  const selected = { ...run('assessment'), subject: { name: 'Assessed project' } };
  const reviewed = { ...selected, revision: 2 };
  const state = { run: selected, flowRun: null, view: 'run', reviewBusy: false };
  const elements: ReturnType<typeof testElement>[] = [];
  const notices: string[] = [];
  const rendered: string[] = [];
  let historyRequests = 0;
  const context = createContext({
    state, selected, criterion: { id: 'assessment-criterion' },
    node: (_tag: string, _className: string, text?: string) => { const element = testElement(); element.textContent = text || ''; elements.push(element); return element; },
    append: (parent: ReturnType<typeof testElement>, ...children: unknown[]) => { parent.append(...children); return parent; },
    statusLabels: { satisfied: 'Satisfied', not_satisfied: 'Not satisfied', insufficient_evidence: 'Insufficient evidence' },
    api: async () => reviewed,
    refreshHistory: async () => { historyRequests += 1; throw new Error('History unavailable.'); },
    renderRun: () => rendered.push(state.run.id),
    clearNotice() {}, showNotice: (message: string) => notices.push(message),
  });
  runInContext(['renderReviewForm', 'newestRunContext', 'syncRecordedFlow'].map(sourceOf).join('\n'), context);
  const form = runInContext('renderReviewForm(selected, criterion, [])', context) as ReturnType<typeof testElement>;
  for (const [suffix, value] of [['reviewer', 'Local reviewer'], ['decision', 'satisfied'], ['rationale', 'The captured evidence supports this decision.']]) {
    const element = elements.find(item => item.id === `review-assessment-criterion-${suffix}`);
    assert.ok(element, suffix); element.value = value;
  }
  const submit = form.listeners.get('submit'); assert.ok(submit);
  await submit({ preventDefault() {} });
  assert.equal(state.run, reviewed);
  assert.equal(state.reviewBusy, false);
  assert.equal(historyRequests, 1);
  assert.deepEqual(rendered, ['assessment']);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^Review saved\. Run history could not refresh:/);
  assert.doesNotMatch(notices[0], /was not saved/);
});
