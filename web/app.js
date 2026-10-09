'use strict';

const state = {
  catalog: [], tools: [], runs: [], selected: new Set(), sessionToken: '',
  run: null, project: null, view: 'assessment', ready: false, submitting: false, inspecting: false,
  sourceKind: 'local', sourceImporting: false, projectRequest: 0, localProjectPath: '', fetchedProject: null,
  pollTimer: null, activeRunId: null, evidenceRequest: 0, reviewBusy: false,
  templates: [], builtinTemplate: null, assessmentTemplate: null, templateSelectionRequest: 0,
  templateSelectionLoading: false, editor: null, editorRequest: 0, publishing: false,
  viewRequest: 0, flow: null, flowHandle: null, flowMounting: null, flowRequest: 0, flowTimer: null, flowSelected: '_freeze-inputs',
  flowEditing: false, flowEditorIndex: null, flowMode: 'draft', flowEvents: [], flowResults: [], flowRun: null, flowValid: false,
  replayRequest: 0, replayAbort: null, replayUnmount: null, replayOpenRunId: null,
};
let replayModulePromise = null;
let replayStylesPromise = null;
const $ = (selector, root = document) => root.querySelector(selector);
const statusLabels = {
  satisfied: 'Satisfied', not_satisfied: 'Not satisfied',
  insufficient_evidence: 'Insufficient evidence', not_applicable: 'Not applicable',
  evaluation_error: 'Evaluation error', running: 'Running', awaiting_review: 'Awaiting review',
  completed: 'Completed', interrupted: 'Interrupted',
};
const viewLabels = { assessment: 'Flow workspace', templates: 'Templates', history: 'Run history', tools: 'Tools & setup', run: 'Assessment findings' };

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined && content !== null) element.textContent = String(content);
  return element;
}
function append(parent, ...children) {
  children.filter(Boolean).forEach(child => parent.append(child));
  return parent;
}
function badge(status) {
  return node('span', `badge ${status}`, statusLabels[status] || status);
}
function button(label, className, action) {
  const element = node('button', className || 'text-button', label);
  element.type = 'button';
  if (action) element.addEventListener('click', action);
  return element;
}
function formatDate(value, options) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(undefined, options || {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
function shortHash(value) { return value ? `${String(value).slice(0, 12)}…` : 'Not recorded'; }
function criterionFor(id) { return state.catalog.find(item => item.id === id); }
function toolFor(id) { return state.tools.find(item => item.id === id); }
function isOneOffPolicy(template) { return Boolean(template && (template.id === 'one-off' || template.version === 0 || template.version === '0')); }
function capturedPolicyLabel(template) {
  return isOneOffPolicy(template) ? `${template.name} · captured one-off policy` : `${template.name} · v${template.version}`;
}
function isIntrinsicExpertCriterion(criterion) {
  if (criterion.evaluation?.kind === 'expert') return true;
  if (criterion.evaluation?.kind === 'builtin') return criterionFor(criterion.evaluation.criterionId)?.mode === 'expert';
  return !criterion.evaluation && criterion.mode === 'expert';
}
function showNotice(message, error = false) {
  const element = $('#notice');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = false;
  element.setAttribute('role', error ? 'alert' : 'status');
}
function clearNotice() { $('#notice').hidden = true; }

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.method === 'POST') {
    headers.set('Content-Type', 'application/json');
    headers.set('X-Assessment-Session', state.sessionToken);
  }
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let message = `The local engine returned an error (${response.status}).`;
    try { const body = await response.json(); if (body.error) message = body.error; } catch { /* Use the HTTP error. */ }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function setView(view, focus = false) {
  state.viewRequest += 1;
  if (view !== 'run') {
    disposeReplay();
    state.replayOpenRunId = null;
    const panel = $('#recorded-replay-panel');
    if (panel) panel.open = false;
  }
  if (view === 'templates' && state.flowEditing) leaveFlowDraft(false);
  state.view = view;
  document.querySelectorAll('.view').forEach(element => { element.hidden = element.id !== `${view}-view`; });
  document.querySelectorAll('.nav-button').forEach(element => {
    const active = element.dataset.view === view;
    element.classList.toggle('active', active);
    if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current');
  });
  $('#view-label').textContent = viewLabels[view] || view;
  if (view === 'assessment') updateFlowGraph();
  if (focus) $('#main').focus({ preventScroll: true });
}

function renderCriteria() {
  const list = $('#criterion-list');
  list.replaceChildren();
  const criteria = state.assessmentTemplate?.criteria || state.catalog;
  if (!criteria.length) {
    list.append(node('p', 'empty-copy', 'No criteria are available in this framework.'));
    updateSelection();
    return;
  }
  for (const criterion of criteria) {
    const card = node('div', 'criterion-card');
    card.classList.toggle('selected', state.selected.has(criterion.id));
    const label = node('label', 'criterion-choice');
    const input = node('input');
    input.type = 'checkbox';
    input.value = criterion.id;
    input.checked = state.selected.has(criterion.id);
    input.disabled = state.submitting || Boolean(state.assessmentTemplate);
    const copy = node('span', 'criterion-copy');
    const titleRow = node('span', 'criterion-title-row');
    const title = node('span', 'criterion-title', criterion.title);
    const needsReview = criterion.requiresReview || criterion.mode === 'expert';
    const modeLabel = isIntrinsicExpertCriterion(criterion) ? 'Expert review' : needsReview ? 'Automatic + review' : 'Automatic';
    const mode = node('span', `mode-badge ${needsReview ? 'expert' : ''}`, modeLabel);
    append(titleRow, title, mode);
    append(copy, node('div', 'criterion-id', `${criterion.id} · ${criterion.dimension}`), titleRow, node('p', 'criterion-description', criterion.description));
    append(label, input, copy);
    input.addEventListener('change', () => {
      if (input.checked) state.selected.add(criterion.id); else state.selected.delete(criterion.id);
      card.classList.toggle('selected', input.checked);
      updateSelection(); scheduleFlowPreview();
    });
    const details = node('details', 'criterion-details');
    append(details, node('summary', '', 'Rule & evidence requirements'), node('p', '', criterion.rule));
    const requirements = node('ul');
    (criterion.evidenceRequirements || []).forEach(item => requirements.append(node('li', '', item)));
    if (requirements.childElementCount) details.append(requirements);
    append(card, label, details);
    list.append(card);
  }
  updateSelection();
  scheduleFlowPreview();
}

function updateSelection() {
  const count = state.selected.size;
  $('#selection-count').textContent = `${count} ${count === 1 ? 'criterion' : 'criteria'} selected`;
  $('#run-button').disabled = !state.ready || !count || state.submitting || state.inspecting || state.sourceImporting || state.templateSelectionLoading || !projectSourceReady() || state.flowEditing || state.flowMode !== 'draft' || !state.flowValid;
  $('#restore-defaults').hidden = Boolean(state.assessmentTemplate);
  $('#restore-defaults').disabled = !state.ready || state.submitting;
  renderReadiness();
  updateFlowActions();
}

function renderReadiness() {
  const container = $('#tool-readiness');
  container.replaceChildren();
  const collectorIds = state.assessmentTemplate ? new Set(state.assessmentTemplate.criteria.map(criterion => criterion.collector.toolId)) : null;
  const tools = state.tools.filter(tool => collectorIds ? collectorIds.has(tool.id) : (tool.supportedCriteria || []).some(id => state.selected.has(id)));
  if (!tools.length) {
    container.append(node('p', 'empty-copy', state.selected.size ? 'No external tools are required by the selected criteria.' : 'Select criteria to see their tools.'));
    return;
  }
  for (const tool of tools) {
    const row = node('div', 'tool-ready-row');
    const onlineOnly = tool.available && tool.network === 'required' && $('input[name="network-mode"]:checked')?.value === 'offline';
    const name = node('span', 'tool-name', tool.name);
    if (onlineOnly) name.append(node('small', '', 'Requires public network access'));
    append(row, node('span', `availability-dot ${tool.available && !onlineOnly ? '' : 'unavailable'}`), name, node('span', `availability-label ${tool.available && !onlineOnly ? '' : 'unavailable'}`, !tool.available ? 'Unavailable' : onlineOnly ? 'Online only' : 'Available'));
    container.append(row);
  }
}

function renderProject(project) {
  const preview = $('#project-preview');
  preview.replaceChildren();
  preview.hidden = !project;
  if (!project) return;
  const title = node('div', 'project-title');
  append(title, node('span', '', project.name), project.packageVersion ? node('span', 'tag muted', `v${project.packageVersion}`) : null);
  const facts = node('div', 'project-facts');
  if (project.gitCommit) facts.append(node('span', 'mono', `Commit ${project.gitCommit.slice(0, 10)}`));
  if (project.gitDirty !== null && project.gitDirty !== undefined) facts.append(node('span', '', project.gitDirty ? 'Uncommitted changes present' : 'Working tree clean'));
  facts.append(node('span', '', `${(project.detectedFiles || []).length} recognised project files`));
  append(preview, title, facts);
  if (project.source) {
    const source = project.source;
    const label = source.kind === 'github' ? 'GitHub repository' : 'npm published package';
    append(preview,
      node('p', 'field-help', `${label}: ${source.name}`),
      node('p', 'field-help mono', `Pinned ${source.kind === 'github' ? 'commit' : 'version'}: ${source.revision}`),
      node('p', 'field-help', source.kind === 'npm'
        ? 'Checks assess files in this published package archive. It may omit source files, tests, and lockfiles from its development repository.'
        : 'Checks assess the selected evidence files in this downloaded repository archive.'),
      source.selectedInputs === 'changed' ? node('p', 'field-help', 'Selected inputs changed locally after download. Findings use the captured local bytes; the pin identifies their downloaded origin.') : null,
      button('Copy pinned source', 'text-button', async () => {
        try {
          await navigator.clipboard.writeText(`${source.url}\n${source.kind === 'github' ? 'Commit' : 'Version'}: ${source.revision}\nArchive SHA-256: ${source.archiveSha256}`);
          showNotice('Pinned source details copied.');
        } catch { showNotice('Pinned source details could not be copied. Select the source and revision text above.', true); }
      }));
  }
}

function projectSourceReady() {
  const path = $('#project-path').value.trim();
  if (state.sourceKind === 'local') return Boolean(path);
  const fetched = state.fetchedProject;
  return Boolean(fetched && state.project && fetched.kind === state.sourceKind && fetched.requested === $('#remote-source').value.trim() && fetched.path === path && state.project.path === path);
}

function updateProjectControls() {
  const busy = state.submitting || state.inspecting || state.sourceImporting;
  const remote = state.sourceKind !== 'local';
  $('#project-source-kind').value = state.sourceKind;
  $('#project-source-kind').disabled = busy || !state.ready;
  $('#remote-source-form').hidden = !remote;
  $('#remote-source').disabled = busy;
  $('#fetch-project').disabled = busy || !state.ready || !$('#remote-source').value.trim();
  $('#fetch-project').textContent = state.sourceImporting ? 'Fetching…' : 'Fetch project';
  $('#project-folder-field').hidden = remote && !state.project;
  $('#project-path').disabled = busy;
  $('#project-path').readOnly = remote;
  $('#project-path-label').textContent = remote ? 'Fetched local folder' : 'Local project folder';
  $('#inspect-button').hidden = remote;
  $('#inspect-button').disabled = busy || remote || !state.ready;
  $('#remote-source-label').textContent = state.sourceKind === 'npm' ? 'npm package URL or package name' : 'GitHub repository URL';
  $('#remote-source').placeholder = state.sourceKind === 'npm' ? 'https://www.npmjs.com/package/footprintjs' : 'https://github.com/owner/repository';
  $('#remote-source-example').textContent = state.sourceKind === 'npm'
    ? 'Examples: https://www.npmjs.com/package/footprintjs · footprintjs@9.48.0 · @scope/package@1.2.3'
    : 'Example: https://github.com/owner/repository. The default branch is resolved to an exact commit.';
}

function changeProjectSource(kind) {
  if (!['local', 'github', 'npm'].includes(kind) || state.submitting || state.inspecting || state.sourceImporting) return;
  if (kind === state.sourceKind) return;
  if (state.sourceKind === 'local') state.localProjectPath = $('#project-path').value;
  state.projectRequest += 1;
  state.sourceKind = kind; state.project = null; state.fetchedProject = null;
  $('#project-path').value = kind === 'local' ? state.localProjectPath : '';
  $('#remote-source').value = '';
  renderProject(null); updateProjectControls(); updateSelection(); clearNotice();
}

async function fetchProject() {
  if (state.sourceKind === 'local' || state.sourceImporting || state.inspecting || state.submitting || !state.ready) return;
  if (!$('#remote-source-form').reportValidity()) return;
  const kind = state.sourceKind;
  const requested = $('#remote-source').value.trim();
  const request = ++state.projectRequest;
  state.sourceImporting = true; state.project = null; state.fetchedProject = null;
  $('#project-path').value = '';
  renderProject(null); updateProjectControls(); updateSelection(); clearNotice();
  try {
    const imported = await api('/api/projects/import', { method: 'POST', body: JSON.stringify({ kind, source: requested }) });
    if (request !== state.projectRequest || kind !== state.sourceKind || requested !== $('#remote-source').value.trim()) return;
    if (!imported.project || typeof imported.project.path !== 'string' || !imported.project.path || !imported.source || imported.source.kind !== kind) throw new Error('The local engine did not return a fetched project and its pinned source.');
    const project = { ...imported.project, source: imported.project.source || imported.source };
    state.project = project;
    state.fetchedProject = { kind, requested, path: project.path };
    $('#project-path').value = project.path;
    renderProject(project);
    showNotice(`Fetched ${project.source.name} at ${kind === 'github' ? 'commit' : 'version'} ${project.source.revision}. The assessment network policy is unchanged.`);
  } catch (error) {
    if (request === state.projectRequest) showNotice(`Project could not be fetched. ${error.message}`, true);
  } finally {
    if (request === state.projectRequest) { state.sourceImporting = false; updateProjectControls(); updateSelection(); }
  }
}

async function inspectProject() {
  if (state.sourceKind !== 'local' || state.inspecting || state.sourceImporting || state.submitting || !state.ready) return;
  const form = $('#project-form');
  if (!form.reportValidity()) return;
  const requested = $('#project-path').value.trim();
  const request = ++state.projectRequest;
  const inspect = $('#inspect-button');
  const original = inspect.textContent;
  state.inspecting = true;
  updateProjectControls();
  inspect.textContent = 'Inspecting…';
  updateSelection();
  clearNotice();
  try {
    const project = await api('/api/projects/inspect', { method: 'POST', body: JSON.stringify({ projectPath: requested }) });
    if (request !== state.projectRequest || state.sourceKind !== 'local') return;
    state.project = project;
    $('#project-path').value = project.path;
    state.localProjectPath = project.path;
    renderProject(project);
    updateSelection();
    showNotice(`Ready to assess ${project.name}.`);
  } catch (error) { if (request === state.projectRequest) { state.project = null; showNotice(error.message, true); renderProject(null); } }
  finally {
    if (request === state.projectRequest) { state.inspecting = false; inspect.textContent = original; updateProjectControls(); updateSelection(); }
  }
}

function renderHistory() {
  $('#history-count').textContent = String(state.runs.length);
  const container = $('#history-list');
  container.replaceChildren();
  if (!state.runs.length) {
    const empty = node('div', 'history-empty');
    append(empty, node('h3', '', 'Your first assessment starts here.'), node('p', '', 'Run an assessment to save its findings and original evidence.'), button('Start an assessment ↗', 'text-button', () => setView('assessment', true)));
    container.append(empty);
    return;
  }
  const table = node('table', 'history-table');
  const caption = node('caption', 'sr-only', 'Saved assessment runs');
  const head = node('thead');
  const row = node('tr');
  ['Project', 'Run status', 'Started', ''].forEach(text => {
    const cell = node('th', '', text); cell.scope = 'col';
    if (!text) cell.append(node('span', 'sr-only', 'Open run'));
    row.append(cell);
  });
  head.append(row);
  const body = node('tbody');
  for (const run of state.runs) {
    const tr = node('tr');
    const project = node('td');
    append(project, node('div', 'history-project', run.subject.name), node('div', 'history-path mono', run.subject.path));
    if (run.template) project.append(node('div', 'history-template', capturedPolicyLabel(run.template)));
    project.title = run.subject.path;
    const status = append(node('td'), badge(run.status));
    const date = node('td', 'history-date', formatDate(run.startedAt));
    const open = button('View findings ↗', 'text-button', () => loadRun(run.id));
    open.setAttribute('aria-label', `View findings for ${run.subject.name}, ${formatDate(run.startedAt)}`);
    append(tr, project, status, date, append(node('td'), open));
    body.append(tr);
  }
  append(table, caption, head, body);
  container.append(table);
}

function renderTools() {
  const list = $('#tools-list');
  list.replaceChildren();
  if (!state.tools.length) { list.append(node('p', 'empty-copy', 'No tool definitions are available.')); return; }
  for (const tool of state.tools) {
    const card = node('article', 'panel tool-card');
    const header = node('div', 'tool-card-header');
    append(header, node('h2', '', tool.name), node('span', `badge ${tool.available ? 'satisfied' : 'insufficient_evidence'}`, tool.available ? 'Available' : 'Unavailable'));
    const facts = node('div', 'tool-facts');
    facts.append(node('span', 'tag muted', tool.version ? `Version ${tool.version}` : 'Version unavailable'));
    const networks = { none: 'No network required', optional: 'Network optional', required: 'Network required' };
    facts.append(node('span', 'tag muted', networks[tool.network] || tool.network));
    const setup = node('div', 'setup-box');
    append(setup, node('h3', '', tool.available ? 'Setup & usage' : 'How to enable this tool'));
    const instructions = node('ol');
    (tool.setupInstructions || []).forEach(item => instructions.append(node('li', '', item)));
    if (instructions.childElementCount) setup.append(instructions); else setup.append(node('p', '', tool.available ? 'No additional setup is required.' : 'No setup instructions were supplied by the engine.'));
    const criteria = (tool.supportedCriteria || []).map(id => criterionFor(id)?.title || id);
    if (criteria.length) setup.append(node('p', 'field-help', `Used for: ${criteria.join('; ')}.`));
    append(card, header, node('p', 'description', tool.description), facts, setup);
    list.append(card);
  }
  renderReadiness();
}

async function refreshHistory() {
  state.runs = (await api('/api/runs')).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  renderHistory();
  return state.runs;
}
async function refreshTools() {
  state.tools = await api('/api/tools');
  renderTools();
}

function renderProgress(run) {
  const panel = $('#live-progress');
  panel.hidden = false;
  const status = run?.status || 'running';
  const statusNode = $('#progress-state');
  statusNode.className = `badge ${status}`;
  statusNode.textContent = statusLabels[status] || status;
  $('#progress-project').textContent = run?.subject?.name || 'Starting local assessment';
  const events = $('#progress-events');
  events.replaceChildren();
  if (!run || !run.events?.length) events.append(node('p', 'empty-copy', 'Waiting for the engine to record this run.'));
  else for (const event of run.events.slice(-7)) {
    const entry = node('div', 'event-item');
    const copy = node('div');
    append(copy, node('span', '', event.message), node('time', '', formatDate(event.timestamp, { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
    append(entry, node('span', 'event-dot'), copy);
    events.append(entry);
  }
  $('#open-live-run').hidden = !run;
}

function setConfigurationBusy(busy) {
  state.submitting = busy;
  updateProjectControls();
  document.querySelectorAll('#criterion-list input, input[name="network-mode"]').forEach(input => { input.disabled = busy || Boolean(state.assessmentTemplate); });
  $('#assessment-template').disabled = busy || state.templateSelectionLoading;
  $('#assessment-template-version').disabled = busy || state.templateSelectionLoading;
  $('#run-button').textContent = busy ? 'Assessment running…' : 'Run assessment ↗';
  updateSelection();
}

async function startRun() {
  if (state.submitting || state.inspecting || state.sourceImporting || state.templateSelectionLoading || !state.ready) return;
  if (!projectSourceReady()) { showNotice(state.sourceKind === 'local' ? 'Enter a local project folder.' : 'Fetch the selected source before running its assessment.', true); return; }
  if (!$('#project-form').reportValidity()) return;
  if (!state.selected.size) { showNotice('Select at least one criterion.', true); return; }
  if (!state.flowValid || state.flowEditing || state.flowMode !== 'draft') { showNotice('Choose a valid published flow before running.', true); return; }
  clearNotice();
  const input = state.assessmentTemplate
    ? { projectPath: $('#project-path').value.trim(), templateId: state.assessmentTemplate.id, templateVersion: state.assessmentTemplate.version }
    : { projectPath: $('#project-path').value.trim(), criterionIds: [...state.selected], networkMode: $('input[name="network-mode"]:checked').value };
  setConfigurationBusy(true);
  state.activeRunId = null;
  renderProgress(null);
  state.flowMode = 'running'; state.flowEvents = []; state.flowResults = []; state.flowRun = null;
  state.flowRequest += 1; clearTimeout(state.flowTimer);
  $('#flow-status').textContent = 'Preparing the project and capturing selected files…';
  updateFlowGraph(); renderFlowInspector(); updateFlowActions();
  try {
    const run = await streamAssessment(input);
    state.run = run; state.flowRun = run; state.activeRunId = run.id;
    state.flowEvents = run.events; state.flowResults = run.results;
    state.flowMode = run.status === 'interrupted' ? 'interrupted' : 'complete';
    updateFlowGraph(); renderFlowInspector(); renderProgress(run); renderRun(); setView('run', true);
    await refreshHistory();
    showNotice(run.status === 'awaiting_review' ? 'Automated checks are saved. The report is awaiting human review.' : 'Assessment saved. Explore the findings, evidence, and recorded flow.');
  } catch (error) {
    showNotice(error.message, true);
    state.flowMode = 'interrupted';
    if (state.activeRunId) {
      try {
        const run = await api(`/api/runs/${encodeURIComponent(state.activeRunId)}`);
        state.run = run; state.flowRun = run; state.flowEvents = run.events; state.flowResults = run.results;
        state.flowMode = run.status === 'running' ? 'running' : run.status === 'interrupted' ? 'interrupted' : 'complete';
        renderProgress(run);
      } catch { /* The run may still be continuing; preserve the recorded events. */ }
    }
    $('#flow-status').textContent = 'Live updates ended. Open the report or run history to check the saved state before starting another run.';
    updateFlowGraph(); renderFlowInspector();
  } finally { setConfigurationBusy(false); updateFlowActions(); }
}

async function loadRun(id) {
  clearNotice();
  try {
    state.run = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (state.flowRun?.id === id) { state.flowRun = state.run; state.flowEvents = state.run.events; state.flowResults = state.run.results; state.flowMode = state.run.status === 'running' ? 'running' : state.run.status === 'interrupted' ? 'interrupted' : 'complete'; updateFlowActions(); }
    renderRun();
    setView('run', true);
    if (state.run.status === 'running' && !state.submitting) showNotice('This assessment is still running. Refresh its findings to see recorded progress.');
  } catch (error) { showNotice(error.message, true); }
}

function metadata(label, value, wide = false, mono = false) {
  const item = node('div', `metadata-item ${wide ? 'wide' : ''}`);
  append(item, node('dt', '', label), node('dd', mono ? 'mono' : '', value === null || value === undefined || value === '' ? 'Not recorded' : value));
  return item;
}

function renderRun() {
  const run = state.run;
  const content = $('#run-content');
  disposeReplay();
  content.replaceChildren();
  if (!run) { content.append(node('p', 'empty-copy', 'Select a saved assessment to view its findings.')); return; }
  const back = button('← All assessments', 'text-button run-back', () => setView('history', true));
  const intro = node('header', 'page-intro run-intro');
  const title = node('div');
  const oneOffPolicy = isOneOffPolicy(run.template || run.framework);
  append(title, node('div', 'eyebrow', 'ASSESSMENT FINDINGS'), node('h1', '', run.subject.name), node('p', '', run.subject.path));
  if (run.template) title.append(node('div', 'run-template-caption', oneOffPolicy ? capturedPolicyLabel(run.template) : `${run.template.name} · published version ${run.template.version}`));
  const tags = node('div', 'intro-tags');
  append(tags, badge(run.status), node('span', 'tag', 'Self-assessment'), node('span', 'tag muted', run.networkMode === 'online' ? 'Public lookups allowed' : 'Offline run'));
  title.append(tags);
  if (run.subject.source) {
    const source = run.subject.source;
    title.append(node('p', 'run-source-scope', source.kind === 'npm'
      ? `Assessed the published npm package at version ${source.revision}. Files absent here may exist in its development repository.`
      : `Downloaded origin: GitHub ${source.name} at commit ${source.revision}. This assessment covers the captured local input files.`));
    if (source.selectedInputs === 'changed') title.append(node('p', 'run-source-edit-note', 'Selected inputs changed locally after download. Findings use the captured local files; the pin identifies their downloaded origin.'));
  }
  const actions = node('div', 'run-actions');
  append(actions, button('View recorded flow', 'button secondary small', () => showRunFlow(run)), button('Refresh', 'button secondary small', () => loadRun(run.id)), button('Export HTML', 'button secondary small', event => downloadExport('html', event.currentTarget)), button('Export JSON', 'button secondary small', event => downloadExport('json', event.currentTarget)));
  append(intro, title, actions);
  const counts = Object.fromEntries(Object.keys(statusLabels).filter(key => ['satisfied', 'not_satisfied', 'insufficient_evidence', 'not_applicable', 'evaluation_error'].includes(key)).map(key => [key, 0]));
  run.results.forEach(result => { if (result.status in counts) counts[result.status] += 1; });
  const summary = node('div', 'run-summary');
  Object.entries(counts).forEach(([status, count]) => summary.append(append(node('div', `result-counter outcome-${status}`), node('strong', '', count), node('span', '', statusLabels[status]))));
  summary.setAttribute('aria-label', 'Criterion outcome counts');
  const context = node('details', 'panel run-context');
  context.append(node('summary', '', 'Recorded scope & provenance'));
  const info = node('dl', 'metadata-grid');
  append(info,
    metadata('Started', formatDate(run.startedAt)), metadata('Finished', run.completedAt ? formatDate(run.completedAt) : 'Not yet finalised'),
    metadata('Framework', oneOffPolicy ? `${run.framework.name} · one-off policy` : `${run.framework.name} · ${run.framework.version}`), metadata('Git commit', run.subject.gitCommit, false, true),
    metadata('Working tree', run.subject.gitDirty === null ? 'Not recorded' : run.subject.gitDirty ? 'Uncommitted changes present' : 'Clean'),
    metadata('Snapshot scope', run.sourceSnapshot.scope), metadata('Source snapshot SHA-256', run.sourceSnapshot.digest, true, true),
    metadata('Policy digest', run.framework.policyDigest, true, true), metadata('Run identifier', run.id, true, true));
  context.append(info);
  if (run.template) {
    append(info, metadata(oneOffPolicy ? 'Captured one-off policy' : 'Captured template', capturedPolicyLabel(run.template)), metadata(oneOffPolicy ? 'Policy identifier' : 'Template identifier', run.template.id), metadata(oneOffPolicy ? 'Policy SHA-256' : 'Template policy SHA-256', run.template.policyDigest, true, true));
  }
  if (run.subject.source) {
    const source = run.subject.source;
    append(info,
      metadata('Imported project source', `${source.kind === 'github' ? 'GitHub repository' : 'npm published package'} · ${source.name}`, true),
      metadata('Source URL', source.url, true), metadata('Requested source', source.requested, true),
      metadata(source.kind === 'github' ? 'Pinned source commit' : 'Pinned package version', source.revision, true, true),
      metadata('Requested reference', source.reference), metadata('Fetched', formatDate(source.fetchedAt)),
      metadata('Downloaded archive SHA-256', source.archiveSha256, true, true),
      metadata('Verified advertised integrity', source.integrity, true, true),
      metadata('Imported archive contents', `${source.fileCount} files · ${source.extractedBytes} bytes`),
      metadata('Selected imported inputs', source.selectedInputs === 'changed' ? 'Changed locally after download' : source.selectedInputs === 'unchanged' ? 'Unchanged from the imported archive' : 'Not recorded'));
    if (source.selectedInputs === 'changed') append(info, metadata('Changed selected paths', (source.changedPaths || []).join(', '), true));
    context.append(node('p', 'field-help', source.kind === 'npm'
      ? 'This source is the published npm archive, which can differ from its development repository. The source snapshot covers only the evidence files named by the assessment policy.'
      : 'The imported repository was pinned before assessment. The source snapshot covers only the evidence files named by the assessment policy.'));
  }
  const workflowEvidence = run.evidence.filter(evidence => evidence.toolId === 'footprintjs');
  if (workflowEvidence.length) {
    const workflowLinks = node('div', 'workflow-evidence');
    workflowEvidence.forEach(evidence => {
      const label = workflowEvidence.length === 1 ? 'Inspect recorded assessment workflow ↗' : `Inspect workflow: ${evidence.source || evidence.id} ↗`;
      workflowLinks.append(button(label, 'button secondary small', () => openEvidence(run.id, evidence)));
    });
    context.append(workflowLinks);
  }
  const heading = node('div', 'findings-heading');
  append(heading, node('h2', '', 'Criterion findings'), node('p', '', 'Each finding applies to its recorded scope.'));
  const findings = node('div', 'findings-stack');
  if (!run.results.length) findings.append(node('p', 'empty-copy', 'The engine has not recorded any criterion results yet.'));
  for (const result of run.results) findings.append(renderFinding(run, result));
  const replay = createReplayPanel(run);
  append(content, back, intro, summary, context, replay, heading, findings);
  if (state.replayOpenRunId === run.id) {
    replay.open = true;
    loadRecordedReplay(run, replay, $('.recorded-replay-mount', replay));
  }
  if (run.status === 'running' || run.status === 'interrupted') {
    const activity = node('section', 'panel run-limitations');
    append(activity, node('h2', '', 'Recorded run activity'));
    const events = node('div', 'event-list');
    (run.events || []).forEach(event => events.append(append(node('div', 'event-item'), node('span', 'event-dot'), node('div', '', `${event.message} · ${formatDate(event.timestamp)}`))));
    activity.append(events);
    content.append(activity);
  }
  if (run.limitations?.length) {
    const limitations = node('section', 'panel run-limitations');
    append(limitations, node('h2', '', 'Assessment limitations'));
    const list = node('ul', 'finding-notes');
    run.limitations.forEach(item => list.append(node('li', '', item)));
    limitations.append(list);
    content.append(limitations);
  }
}

function disposeReplay() {
  state.replayRequest += 1;
  state.replayAbort?.abort();
  state.replayAbort = null;
  if (state.replayUnmount) { state.replayUnmount(); state.replayUnmount = null; }
}

function loadReplayStyles() {
  if (replayStylesPromise) return replayStylesPromise;
  replayStylesPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById('fp-stage-node-keyframes');
    if (existing?.sheet) { resolve(); return; }
    const link = existing || node('link');
    link.id = 'fp-stage-node-keyframes';
    link.rel = 'stylesheet';
    link.href = '/assets/replay.css';
    const timeout = setTimeout(() => fail('The local replay stylesheet did not load in time.'), 15000);
    const complete = () => { clearTimeout(timeout); resolve(); };
    const fail = message => { clearTimeout(timeout); link.remove(); replayStylesPromise = null; reject(new Error(message)); };
    link.addEventListener('load', complete, { once: true });
    link.addEventListener('error', () => fail('The local replay stylesheet could not be loaded.'), { once: true });
    if (!existing) document.head.append(link);
  });
  return replayStylesPromise;
}

function loadReplayModule() {
  if (!replayModulePromise) replayModulePromise = import('/assets/replay.js').catch(error => { replayModulePromise = null; throw error; });
  return replayModulePromise;
}

function createReplayPanel(run) {
  const panel = node('details', 'panel recorded-replay-panel');
  panel.id = 'recorded-replay-panel';
  const heading = node('summary', 'recorded-replay-heading');
  const title = node('div');
  append(title, node('h2', '', 'What happened?'), node('p', '', 'Step through the saved evaluation, its findings, and the evidence attached to each criterion.'));
  append(heading, title, node('span', 'tag muted', 'Recorded replay'));
  const body = node('div', 'recorded-replay-body');
  const mount = node('div', 'recorded-replay-mount');
  mount.append(node('p', 'empty-copy', 'Open this panel to load the recorded traversal.'));
  const source = run.evidence.find(evidence => evidence.toolId === 'footprintjs');
  const footer = node('div', 'recorded-replay-footer');
  append(footer, node('p', '', 'Replaying a traversal does not rerun checks. A completed step can have a negative or inconclusive criterion finding.'));
  if (source) footer.append(button('Inspect original workflow output ↗', 'text-button', () => openEvidence(run.id, source)));
  append(body, mount, footer); append(panel, heading, body);
  panel.addEventListener('toggle', () => {
    if (panel.open) {
      state.replayOpenRunId = run.id;
      loadRecordedReplay(run, panel, mount);
    } else if (state.replayOpenRunId === run.id) {
      state.replayOpenRunId = null;
      disposeReplay();
      panel.dataset.replayLoading = 'false'; panel.dataset.replayLoaded = 'false';
      mount.replaceChildren(node('p', 'empty-copy', 'Open this panel to load the recorded traversal.'));
    }
  });
  return panel;
}

function renderWorkflowFallback(run, workflow, container) {
  container.replaceChildren();
  const note = node('p', 'recorded-replay-note', workflow.note || 'An interactive replay is unavailable for this recording.');
  append(container, note);
  if (run.events.length) {
    const heading = node('h3', 'recorded-activity-heading', 'Recorded run activity');
    const events = node('ol', 'recorded-activity-list');
    run.events.slice(0, 200).forEach(event => {
      const entry = node('li');
      append(entry, node('span', '', event.message), node('time', '', formatDate(event.timestamp)));
      events.append(entry);
    });
    append(container, heading, events);
    if (run.events.length > 200) container.append(node('p', 'field-help', 'The first 200 events are shown. The exported run retains the complete activity record.'));
  }
  const narrative = Array.isArray(workflow.narrativeEntries) ? workflow.narrativeEntries.filter(entry => entry && typeof entry.text === 'string') : [];
  if (narrative.length) {
    const details = node('details', 'recorded-narrative-fallback');
    details.append(node('summary', '', 'Preserved workflow narration'));
    const output = node('pre', '', narrative.slice(0, 200).map(entry => entry.text).join('\n'));
    details.append(output);
    if (narrative.length > 200) details.append(node('p', 'field-help', 'The first 200 narration entries are shown. Inspect the original workflow output for the full recording.'));
    container.append(details);
  }
}

async function loadRecordedReplay(run, panel, container) {
  if (!container || panel.dataset.replayLoading === 'true' || panel.dataset.replayLoaded === 'true') return;
  const request = ++state.replayRequest;
  const controller = new AbortController();
  state.replayAbort?.abort(); state.replayAbort = controller;
  panel.dataset.replayLoading = 'true';
  const message = node('p', 'empty-copy', 'Loading the saved workflow from the local engine…'); message.setAttribute('role', 'status');
  container.replaceChildren(message);
  const stillCurrent = () => request === state.replayRequest && panel.open && container.isConnected && state.run?.id === run.id;
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(run.id)}/workflow`, { credentials: 'same-origin', signal: controller.signal });
    if (!response.ok) {
      let error = `Recorded workflow could not be loaded (${response.status}).`;
      try { const body = await response.json(); if (body.error) error = body.error; } catch { /* Preserve the HTTP error. */ }
      throw new Error(error);
    }
    const workflow = await response.json();
    if (!stillCurrent()) return;
    if (workflow.kind === 'replay') {
      const [, module] = await Promise.all([loadReplayStyles(), loadReplayModule()]);
      if (!stillCurrent()) return;
      container.replaceChildren();
      state.replayUnmount = module.mountReplay(container, { run, workflow, onEvidence: openEvidence });
    } else renderWorkflowFallback(run, workflow, container);
    panel.dataset.replayLoaded = 'true';
  } catch (error) {
    if (!stillCurrent()) return;
    const note = error.name === 'AbortError' ? 'The recorded workflow request timed out. The saved findings and original evidence remain available.' : `The recorded replay could not be loaded. ${error.message}`;
    renderWorkflowFallback(run, { note }, container);
    container.append(button('Try loading replay again', 'button secondary small', () => {
      panel.dataset.replayLoading = 'false'; panel.dataset.replayLoaded = 'false';
      loadRecordedReplay(run, panel, container);
    }));
  } finally {
    clearTimeout(timeout);
    if (request === state.replayRequest) { panel.dataset.replayLoading = 'false'; state.replayAbort = null; }
  }
}

function renderFinding(run, result) {
  const criterion = (run.criteria || state.catalog).find(item => item.id === result.criterionId) || run.template?.criteria.find(item => item.id === result.criterionId);
  const finding = node('details', 'panel finding');
  finding.dataset.status = result.status;
  finding.open = result.status === 'insufficient_evidence' || result.status === 'evaluation_error';
  const summary = node('summary');
  const copy = node('div', 'finding-summary');
  append(copy, node('div', 'criterion-id', `${result.criterionId}${criterion ? ` · ${criterion.dimension}` : ''}`), node('h3', '', criterion?.title || result.criterionId));
  append(summary, copy, badge(result.status));
  const body = node('div', 'finding-body');
  body.append(node('p', 'finding-rationale', result.rationale));
  if (result.automaticResult) {
    const provisional = node('div', 'provisional-result');
    append(provisional, node('h4', '', 'Retained automatic finding'), badge(result.automaticResult.status), node('p', '', result.automaticResult.rationale), node('small', '', 'This is the provisional rule result. The criterion’s final outcome includes its required human review.'));
    body.append(provisional);
  }
  if (criterion) {
    const rubric = node('details', 'criterion-details');
    append(rubric, node('summary', '', 'Assessment rule & evidence requirements'), node('p', '', criterion.rule));
    const requirements = node('ul');
    (criterion.evidenceRequirements || []).forEach(item => requirements.append(node('li', '', item)));
    if (requirements.childElementCount) rubric.append(requirements);
    body.append(rubric);
  }
  if (result.coverage?.length) {
    body.append(node('h4', 'finding-subheading', 'Evidence coverage'));
    const coverage = node('ul', 'finding-notes');
    result.coverage.forEach(item => coverage.append(node('li', '', item)));
    body.append(coverage);
  }
  body.append(node('h4', 'finding-subheading', 'Original evidence'));
  const evidenceList = node('div', 'evidence-list');
  for (const id of result.evidenceIds || []) {
    const evidence = run.evidence.find(item => item.id === id);
    if (!evidence) { evidenceList.append(node('span', 'field-help', `Evidence ${id} is not available in this run.`)); continue; }
    const item = button('', 'evidence-button', () => openEvidence(run.id, evidence));
    const evidenceCopy = node('span', 'evidence-button-copy');
    const toolName = toolFor(evidence.toolId)?.name || evidence.toolId;
    const displayVersion = (evidence.toolVersion || 'Version not recorded').split('\n')[0].replace(/^osv-scanner version:\s*/i, '');
    append(evidenceCopy, node('strong', 'evidence-source', evidence.source || evidence.id), node('span', 'evidence-tool', `${toolName} · ${displayVersion} · ${formatBytes(evidence.bytes)}`));
    append(item, evidenceCopy, node('span', 'evidence-arrow', '↗'));
    item.setAttribute('aria-label', `Inspect ${evidence.source || evidence.id}, collected by ${toolName}`);
    evidenceList.append(item);
  }
  if (!evidenceList.childElementCount) evidenceList.append(node('p', 'empty-copy', 'No collected evidence is attached to this criterion.'));
  body.append(evidenceList);
  if (result.limitations?.length) {
    const limitation = node('div', 'limitation');
    limitation.append(node('strong', '', 'Limitations'));
    const list = node('ul', 'finding-notes');
    result.limitations.forEach(item => list.append(node('li', '', item)));
    limitation.append(list);
    body.append(limitation);
  }
  const reviews = run.reviews.filter(review => review.criterionId === result.criterionId);
  if (reviews.length) {
    const history = node('div', 'review-history');
    history.append(node('h3', '', 'Attributed reviews'));
    reviews.forEach(review => {
      const entry = node('div', 'review-entry');
      append(entry, node('strong', '', review.reviewer), badge(review.decision), node('span', '', formatDate(review.createdAt)), node('p', '', review.rationale));
      history.append(entry);
    });
    body.append(history);
  }
  const requiresReview = criterion?.mode === 'expert' || run.template?.criteria.find(item => item.id === result.criterionId)?.requiresReview;
  if (requiresReview && run.status !== 'running' && run.status !== 'interrupted') body.append(renderReviewForm(run, criterion, reviews));
  append(finding, summary, body);
  return finding;
}

function renderReviewForm(run, criterion, reviews) {
  const form = node('form', 'review-form');
  append(form, node('h3', '', reviews.length ? 'Record a further expert review' : 'Add expert review'), node('p', '', 'Record your decision and the evidence behind it. This remains a self-assessment; original tool output is preserved.'));
  const prefix = `review-${criterion.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const fields = node('div', 'review-field-row');
  const reviewerWrap = node('div');
  const reviewer = node('input');
  reviewer.type = 'text'; reviewer.id = `${prefix}-reviewer`; reviewer.name = 'reviewer'; reviewer.required = true; reviewer.maxLength = 200; reviewer.placeholder = 'Reviewer name';
  const reviewerLabel = node('label', '', 'Reviewer'); reviewerLabel.htmlFor = reviewer.id;
  append(reviewerWrap, reviewerLabel, reviewer);
  const decisionWrap = node('div');
  const decision = node('select'); decision.id = `${prefix}-decision`; decision.name = 'decision'; decision.required = true;
  const placeholder = node('option', '', 'Choose a decision'); placeholder.value = ''; placeholder.disabled = true; placeholder.selected = true; decision.append(placeholder);
  ['satisfied', 'not_satisfied', 'insufficient_evidence'].forEach(value => { const option = node('option', '', statusLabels[value]); option.value = value; decision.append(option); });
  const decisionLabel = node('label', '', 'Criterion decision'); decisionLabel.htmlFor = decision.id;
  append(decisionWrap, decisionLabel, decision);
  append(fields, reviewerWrap, decisionWrap);
  const rationale = node('textarea'); rationale.id = `${prefix}-rationale`; rationale.name = 'rationale'; rationale.required = true; rationale.maxLength = 20000; rationale.placeholder = 'Explain how the available evidence supports your decision, including any gaps.';
  const rationaleLabel = node('label', 'rationale-label', 'Reasoning & evidence'); rationaleLabel.htmlFor = rationale.id;
  const submit = node('button', 'button primary small', 'Record review'); submit.type = 'submit';
  append(form, fields, rationaleLabel, rationale, submit);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity() || state.reviewBusy) return;
    if (!reviewer.value.trim() || !rationale.value.trim()) { showNotice('Add a reviewer name and substantive reasoning.', true); return; }
    state.reviewBusy = true;
    submit.disabled = true; submit.textContent = 'Saving review…';
    clearNotice();
    try {
      state.run = await api(`/api/runs/${encodeURIComponent(run.id)}/reviews`, { method: 'POST', body: JSON.stringify({ criterionId: criterion.id, reviewer: reviewer.value.trim(), decision: decision.value, rationale: rationale.value.trim() }) });
      renderRun();
      await refreshHistory();
      showNotice('Review recorded with reviewer attribution and rationale.');
    } catch (error) { showNotice(error.message, true); submit.disabled = false; submit.textContent = 'Record review'; }
    finally { state.reviewBusy = false; }
  });
  return form;
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number') return 'Size not recorded';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function openEvidence(runId, evidence) {
  const request = ++state.evidenceRequest;
  const dialog = $('#evidence-dialog');
  $('#evidence-title').textContent = evidence.source || toolFor(evidence.toolId)?.name || evidence.toolId;
  const details = node('dl', 'metadata-grid');
  append(details, metadata('Collector', toolFor(evidence.toolId)?.name || evidence.toolId), metadata('Tool version', evidence.toolVersion), metadata('Collected', formatDate(evidence.collectedAt)), metadata('Source', evidence.source, true), metadata('Evidence SHA-256', evidence.sha256, true, true), metadata('Artifact', evidence.rawArtifactRef, true, true), metadata('Size', formatBytes(evidence.bytes)));
  $('#evidence-metadata').replaceChildren(details);
  $('#evidence-output').textContent = '';
  $('#evidence-load-status').textContent = 'Loading preserved original output…';
  if (!dialog.open) dialog.showModal();
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(evidence.id)}`, { credentials: 'same-origin' });
    if (!response.ok) {
      let message = `Evidence could not be loaded (${response.status}).`;
      try { const body = await response.json(); if (body.error) message = body.error; } catch { /* Keep the HTTP error. */ }
      throw new Error(message);
    }
    const output = await response.text();
    if (request !== state.evidenceRequest) return;
    $('#evidence-output').textContent = output;
    $('#evidence-load-status').textContent = output ? '' : 'The preserved artifact is empty.';
  } catch (error) { if (request === state.evidenceRequest) $('#evidence-load-status').textContent = error.message; }
}

async function downloadExport(format, trigger) {
  if (!state.run) return;
  const run = state.run;
  const original = trigger.textContent;
  trigger.disabled = true; trigger.textContent = 'Preparing…';
  clearNotice();
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(run.id)}/export?format=${encodeURIComponent(format)}`, { credentials: 'same-origin' });
    if (!response.ok) {
      let message = `Export failed (${response.status}).`;
      try { const body = await response.json(); if (body.error) message = body.error; } catch { /* Keep the HTTP error. */ }
      throw new Error(message);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = node('a');
    link.href = url;
    link.download = `assessment-${run.id}.${format}`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) { showNotice(error.message, true); }
  finally { trigger.disabled = false; trigger.textContent = original; }
}

function templateCriterionInput(criterion) {
  const evaluation = { ...criterion.evaluation };
  if (Array.isArray(evaluation.field)) evaluation.field = [...evaluation.field];
  if (evaluation.kind === 'json-field' && evaluation.operator === 'exists') delete evaluation.expected;
  return {
    id: criterion.id, title: criterion.title, description: criterion.description,
    dimension: criterion.dimension, evidenceRequirements: [...(criterion.evidenceRequirements || [])],
    collector: { toolId: criterion.collector.toolId, paths: [...criterion.collector.paths] },
    evaluation, requiresReview: Boolean(criterion.requiresReview),
  };
}

function templateDraftFrom(version) {
  return {
    name: version.name, description: version.description, networkMode: version.networkMode,
    criteria: version.criteria.map(templateCriterionInput),
  };
}

function renderTemplateLibrary() {
  const list = $('#template-library-list');
  list.replaceChildren();
  if (!state.templates.length) {
    list.append(node('p', 'empty-copy', 'No saved templates are available. Create one to define your assessment.'));
    return;
  }
  for (const template of state.templates) {
    const card = node('article', 'template-library-card');
    card.classList.toggle('active', state.editor?.source?.id === template.id);
    const title = node('div', 'template-library-title');
    append(title, node('h3', '', template.name), node('span', 'tag muted', template.builtIn ? 'Built-in' : 'Custom'));
    const actions = node('div', 'template-library-actions');
    append(actions,
      button('Open', 'button secondary small', () => openTemplateEditor(template.id)),
      button('Use latest ↗', 'text-button', async () => {
        if (await selectAssessmentTemplate(template.id)) setView('assessment', true);
      }));
    append(card, title, node('p', '', template.description), node('div', 'template-library-meta', `Version ${template.latestVersion} · ${template.versionCount} ${template.versionCount === 1 ? 'published version' : 'published versions'}`), actions);
    list.append(card);
  }
}

function renderAssessmentTemplateSelector() {
  const select = $('#assessment-template');
  select.replaceChildren();
  const oneOff = node('option', '', 'One-off checks'); oneOff.value = ''; select.append(oneOff);
  for (const template of state.templates) {
    const option = node('option', '', `${template.name} · latest v${template.latestVersion}`);
    option.value = template.id; select.append(option);
  }
  select.value = state.assessmentTemplate?.id || '';
  select.disabled = !state.ready || state.submitting || state.templateSelectionLoading;
}

function renderAssessmentVersionOptions(versions, selectedVersion) {
  const select = $('#assessment-template-version');
  select.replaceChildren();
  [...versions].sort((a, b) => b.version - a.version).forEach(item => {
    const option = node('option', '', `Version ${item.version}`); option.value = item.version; select.append(option);
  });
  select.value = String(selectedVersion);
}

async function refreshTemplates() {
  state.templates = await api('/api/templates');
  renderTemplateLibrary();
  renderAssessmentTemplateSelector();
  return state.templates;
}

async function selectAssessmentTemplate(id, version) {
  if (state.submitting) { showNotice('Finish the current assessment before changing its template.', true); return false; }
  const request = ++state.templateSelectionRequest;
  state.flowRequest += 1; clearTimeout(state.flowTimer); state.flowValid = false;
  state.flowMode = 'draft'; state.flowRun = null; state.flowEvents = []; state.flowResults = [];
  $('#live-progress').hidden = true;
  clearNotice();
  if (!id) {
    state.assessmentTemplate = null;
    state.templateSelectionLoading = false;
    state.selected = new Set(state.catalog.filter(criterion => criterion.defaultEnabled).map(criterion => criterion.id));
    $('input[name="network-mode"][value="offline"]').checked = true;
    $('#assessment-version-field').hidden = true;
    $('#assessment-template-info').hidden = true;
    $('#network-description').textContent = 'Public advisory lookups are optional. No account is needed.';
    document.querySelectorAll('input[name="network-mode"]').forEach(input => { input.disabled = false; });
    renderAssessmentTemplateSelector(); renderCriteria();
    return true;
  }
  state.templateSelectionLoading = true;
  $('#assessment-template').disabled = true;
  $('#assessment-template-version').disabled = true;
  updateSelection();
  try {
    const [template, versions] = await Promise.all([
      api(`/api/templates/${encodeURIComponent(id)}${version ? `?version=${encodeURIComponent(version)}` : ''}`),
      api(`/api/templates/${encodeURIComponent(id)}/versions`),
    ]);
    if (request !== state.templateSelectionRequest) return false;
    state.assessmentTemplate = template;
    if (template.builtIn) state.builtinTemplate = template;
    state.selected = new Set(template.criteria.map(criterion => criterion.id));
    renderAssessmentVersionOptions(versions, template.version);
    $('#assessment-version-field').hidden = false;
    const info = $('#assessment-template-info');
    info.replaceChildren();
    append(info, node('p', '', template.description), node('p', 'field-help', 'This published version fixes its criteria, evidence paths, rules, and network policy.'), node('code', 'selected-template-digest', `Policy SHA-256: ${shortHash(template.policyDigest)}`), button(template.builtIn ? 'View or copy template ↗' : 'Edit a new version ↗', 'text-button', () => openTemplateEditor(template.id, template.version)));
    info.hidden = false;
    const network = $(`input[name="network-mode"][value="${template.networkMode === 'online' ? 'online' : 'offline'}"]`);
    network.checked = true;
    document.querySelectorAll('input[name="network-mode"]').forEach(input => { input.disabled = true; });
    $('#network-description').textContent = `Fixed by ${template.name}, version ${template.version}. Publish a new version to change this policy.`;
    renderAssessmentTemplateSelector(); renderCriteria();
    return true;
  } catch (error) {
    if (request === state.templateSelectionRequest) {
      renderAssessmentTemplateSelector();
      showNotice(`Template could not be loaded: ${error.message}`, true);
    }
    return false;
  } finally {
    if (request === state.templateSelectionRequest) {
      state.templateSelectionLoading = false;
      $('#assessment-template').disabled = state.submitting;
      $('#assessment-template-version').disabled = state.submitting;
      updateSelection();
    }
  }
}

function newTemplateCriterion(criteria = []) {
  let suffix = 1;
  while (criteria.some(criterion => criterion.id === `CUSTOM-${String(suffix).padStart(2, '0')}`)) suffix += 1;
  return {
    id: `CUSTOM-${String(suffix).padStart(2, '0')}`, title: '', description: '', dimension: '',
    evidenceRequirements: [], collector: { toolId: 'project-files', paths: [] },
    evaluation: { kind: 'files', match: 'all', minimumBytes: 1 }, requiresReview: false,
  };
}

function createTemplateEditor(draft, origin = '') {
  state.editorRequest += 1;
  state.editor = { source: null, draft, versions: [], expectedVersion: undefined, readonly: false, dirty: true, origin };
  renderTemplateEditor(); renderTemplateLibrary(); setView('templates', true);
}

function startNewTemplate() {
  createTemplateEditor({ name: '', description: '', networkMode: 'offline', criteria: [newTemplateCriterion()] });
}

function editorMessage(message, error = false) {
  const element = $('#template-publish-message');
  element.replaceChildren(node('span', '', message));
  element.classList.toggle('error', error); element.hidden = false;
  element.setAttribute('role', error ? 'alert' : 'status');
  element.tabIndex = -1;
  if (error) element.focus(); else element.scrollIntoView({ block: 'nearest' });
}

async function openTemplateEditor(id, version) {
  if (state.publishing) { showNotice('Wait for publishing to finish before loading another template.', true); return; }
  const request = ++state.editorRequest;
  setView('templates', true); clearNotice();
  try {
    const [template, versions] = await Promise.all([
      api(`/api/templates/${encodeURIComponent(id)}${version ? `?version=${encodeURIComponent(version)}` : ''}`),
      api(`/api/templates/${encodeURIComponent(id)}/versions`),
    ]);
    if (request !== state.editorRequest) return;
    if (template.builtIn) state.builtinTemplate = template;
    const latestVersion = Math.max(template.version, ...versions.map(item => item.version));
    state.editor = {
      source: template, draft: templateDraftFrom(template), versions,
      expectedVersion: template.version, readonly: template.builtIn, dirty: false, origin: '',
    };
    renderTemplateEditor(); renderTemplateLibrary();
  } catch (error) { if (request === state.editorRequest) showNotice(`Template could not be loaded: ${error.message}`, true); }
}

function markEditorDirty() {
  if (!state.editor || state.editor.readonly) return;
  state.editor.dirty = true;
  if (state.flowEditing) scheduleFlowPreview();
  $('#template-publish-message').hidden = true;
  updateEditorActions();
}

function updateEditorActions() {
  const editor = state.editor;
  if (!editor) return;
  const { source, readonly, dirty } = editor;
  const nextVersion = source ? editor.expectedVersion + 1 : 1;
  $('#template-editor-title').textContent = source ? source.name : 'New template';
  $('#template-editor-badge').textContent = readonly ? 'Built-in · read-only' : dirty ? 'Unpublished draft' : `Published v${source?.version || 1}`;
  $('#template-version-note').textContent = source
    ? `Viewing version ${source.version}, published ${formatDate(source.createdAt)}.`
    : editor.origin || 'Define a reusable assessment for your local projects.';
  $('#publish-version-note').textContent = readonly
    ? 'This built-in template is fixed. Make an editable copy to create your own version.'
    : source ? `Publishing creates version ${nextVersion}. Existing versions and their runs stay unchanged.` : 'Publishing saves an immutable first version.';
  $('#publish-template').hidden = readonly;
  $('#publish-template').disabled = state.publishing || !editor.draft.criteria.length || Boolean(source && !dirty);
  $('#publish-template').textContent = state.publishing ? 'Publishing…' : `Publish version ${nextVersion}`;
  $('#copy-template').hidden = !source;
  $('#copy-template').textContent = readonly ? 'Make an editable copy ↗' : 'Copy as a new template ↗';
  $('#copy-template').disabled = state.publishing;
  $('#use-editor-template').hidden = !source || dirty;
  $('#use-editor-template').disabled = state.submitting || state.publishing;
  $('#add-template-criterion').hidden = readonly;
  $('#add-template-criterion').disabled = state.publishing;
  $('#template-form').querySelectorAll('input, textarea, select').forEach(input => {
    input.disabled = state.publishing || input.dataset.fixed === 'true' || (readonly && input.id !== 'editor-template-version');
  });
  $('#template-form').querySelectorAll('.criterion-editor-order button').forEach(control => { control.disabled = state.publishing || control.dataset.boundary === 'true'; });
  if (state.flowEditing) filterFlowEditor();
  $('#export-template').disabled = !source || state.publishing;
  $('#new-template').disabled = state.publishing;
  $('#import-template').disabled = state.publishing;
}

function renderTemplateEditor() {
  const editor = state.editor;
  $('#template-builder-empty').hidden = Boolean(editor);
  $('#template-form').hidden = !editor;
  if (!editor) return;
  $('#template-publish-message').hidden = true;
  $('#template-name').value = editor.draft.name;
  $('#template-description').value = editor.draft.description;
  $('#template-network').value = editor.draft.networkMode;
  const versions = $('#editor-template-version');
  versions.replaceChildren();
  [...editor.versions].sort((a, b) => b.version - a.version).forEach(item => {
    const option = node('option', '', `Version ${item.version} · ${formatDate(item.createdAt)}`); option.value = item.version; versions.append(option);
  });
  if (editor.source) versions.value = String(editor.source.version);
  $('#template-version-controls').hidden = !editor.source;
  renderEditorCriteria();
  updateEditorActions();
}

function editorField(label, control, help) {
  const wrapper = node('div', 'editor-field');
  const labelNode = node('label', 'field-label', label); labelNode.htmlFor = control.id;
  append(wrapper, labelNode, control, help ? node('p', 'field-help', help) : null);
  return wrapper;
}

function textEditorControl(id, value, onChange, options = {}) {
  const control = node(options.multiline ? 'textarea' : 'input');
  if (!options.multiline) control.type = 'text'; else control.rows = options.rows || 3;
  control.id = id; control.value = value === undefined || value === null ? '' : value;
  control.required = options.required !== false;
  if (options.placeholder) control.placeholder = options.placeholder;
  if (options.maxLength) control.maxLength = options.maxLength;
  control.addEventListener('input', () => { onChange(control.value); markEditorDirty(); });
  return control;
}

function selectEditorControl(id, value, choices, onChange) {
  const control = node('select'); control.id = id;
  choices.forEach(([optionValue, label]) => { const option = node('option', '', label); option.value = optionValue; control.append(option); });
  control.value = value;
  control.addEventListener('change', () => { onChange(control.value); markEditorDirty(); });
  return control;
}

function numericEditorControl(id, value, onChange, maximum) {
  const control = node('input'); control.type = 'number'; control.id = id;
  control.min = '0'; control.step = '1'; control.required = true; control.value = String(value);
  if (maximum !== undefined) control.max = String(maximum);
  control.addEventListener('input', () => { onChange(control.value === '' ? NaN : Number(control.value)); markEditorDirty(); });
  return control;
}

function splitLines(text) { return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }

function applyBuiltinCriterion(index, builtinId) {
  const original = state.builtinTemplate?.criteria.find(criterion => criterion.id === builtinId);
  if (!original) { editorMessage('The built-in criterion definition is unavailable. Reload the templates.', true); return; }
  state.editor.draft.criteria[index] = templateCriterionInput(original);
  state.editor.draft.criteria[index].evaluation = { kind: 'builtin', criterionId: original.evaluation?.criterionId || original.id };
  markEditorDirty(); renderEditorCriteria(); updateEditorActions();
}

function changeEvaluationKind(index, kind) {
  const criterion = state.editor.draft.criteria[index];
  if (kind === 'builtin') {
    const original = state.builtinTemplate?.criteria.find(item => item.evaluation?.kind === 'builtin');
    if (!original) { editorMessage('No built-in deterministic rules are available.', true); return; }
    applyBuiltinCriterion(index, original.id); return;
  }
  if (kind === 'files') criterion.evaluation = { kind, match: 'all', minimumBytes: 1 };
  else if (kind === 'json-field') criterion.evaluation = { kind, field: [], operator: 'exists' };
  else if (kind === 'vulnerabilities') criterion.evaluation = { kind, maxFindings: 0 };
  else criterion.evaluation = { kind: 'expert' };
  criterion.collector.toolId = kind === 'vulnerabilities' ? 'osv-scanner' : 'project-files';
  if (kind === 'expert') criterion.requiresReview = true;
  delete criterion._expectedText;
  markEditorDirty(); renderEditorCriteria(); updateEditorActions();
}

function renderEditorCriteria() {
  const editor = state.editor;
  const list = $('#template-criteria-editor'); list.replaceChildren();
  if (!editor) return;
  if (!editor.draft.criteria.length) { list.append(node('p', 'empty-copy', 'Add at least one criterion before publishing.')); return; }
  editor.draft.criteria.forEach((criterion, index) => {
    const prefix = `template-criterion-${index}`;
    const card = node('details', 'criterion-editor'); card.open = true; card.dataset.criterionIndex = String(index);
    const summary = node('summary');
    const summaryCopy = node('span', 'criterion-editor-summary');
    const summaryNumber = node('span', 'step-number', String(index + 1).padStart(2, '0'));
    const summaryTitle = node('span', '', criterion.title || 'Untitled criterion');
    append(summaryCopy, summaryNumber, summaryTitle);
    append(summary, summaryCopy, node('span', 'mode-badge', criterion.id || 'Set an identifier'));
    card.append(summary);
    const body = node('div', 'criterion-editor-body');
    if (!editor.readonly) {
      const order = node('div', 'criterion-editor-order');
      const up = button('↑ Move up', 'text-button', () => {
        if (state.flowEditing) state.flowEditorIndex = index - 1;
        const items = editor.draft.criteria; [items[index - 1], items[index]] = [items[index], items[index - 1]];
        markEditorDirty(); renderEditorCriteria(); updateEditorActions();
      });
      up.disabled = index === 0; up.dataset.boundary = String(index === 0); up.setAttribute('aria-label', `Move criterion ${index + 1} up`);
      const down = button('↓ Move down', 'text-button', () => {
        if (state.flowEditing) state.flowEditorIndex = index + 1;
        const items = editor.draft.criteria; [items[index + 1], items[index]] = [items[index], items[index + 1]];
        markEditorDirty(); renderEditorCriteria(); updateEditorActions();
      });
      down.disabled = index === editor.draft.criteria.length - 1; down.dataset.boundary = String(index === editor.draft.criteria.length - 1); down.setAttribute('aria-label', `Move criterion ${index + 1} down`);
      const remove = button('Remove criterion', 'text-button remove-criterion', () => { editor.draft.criteria.splice(index, 1); markEditorDirty(); renderEditorCriteria(); updateEditorActions(); });
      remove.setAttribute('aria-label', `Remove criterion ${index + 1}`);
      append(order, up, down, remove); body.append(order);
    }
    const basics = node('div', 'editor-field-grid');
    append(basics,
      editorField('Criterion identifier', textEditorControl(`${prefix}-id`, criterion.id, value => { criterion.id = value; summary.lastElementChild.textContent = value || 'Set an identifier'; }, { maxLength: 128, placeholder: 'DOC-01' })),
      editorField('Dimension', textEditorControl(`${prefix}-dimension`, criterion.dimension, value => { criterion.dimension = value; }, { maxLength: 160, placeholder: 'Documentation' })),
      editorField('Criterion title', textEditorControl(`${prefix}-title`, criterion.title, value => { criterion.title = value; summaryTitle.textContent = value || 'Untitled criterion'; }, { maxLength: 160, placeholder: 'What does this criterion establish?' })),
      editorField('Criterion description', textEditorControl(`${prefix}-description`, criterion.description, value => { criterion.description = value; }, { multiline: true, required: false, maxLength: 2000, placeholder: 'Describe the claim and its scope.' })));
    body.append(basics);
    body.append(editorField('Evidence requirements', textEditorControl(`${prefix}-requirements`, criterion.evidenceRequirements.join('\n'), value => { criterion.evidenceRequirements = splitLines(value); }, { multiline: true, required: false, maxLength: 20000, placeholder: 'One requirement per line' }), 'Use up to 20 custom descriptions. The generated reviewer-decision requirement does not count toward this limit. If left blank, the engine uses the configured evidence paths.'));
    const ruleKinds = [['files', 'File presence & size'], ['json-field', 'JSON field'], ['vulnerabilities', 'Known vulnerability count'], ['expert', 'Human judgment']];
    if (state.builtinTemplate?.criteria.some(item => item.evaluation?.kind === 'builtin')) ruleKinds.unshift(['builtin', 'Built-in criterion rule']);
    const ruleSelect = selectEditorControl(`${prefix}-rule-kind`, criterion.evaluation.kind, ruleKinds, kind => changeEvaluationKind(index, kind));
    body.append(editorField('Evaluation rule', ruleSelect));
    if (criterion.evaluation.kind === 'builtin') {
      const choices = (state.builtinTemplate?.criteria || []).filter(item => item.evaluation?.kind === 'builtin').map(item => [item.id, `${item.id} · ${item.title}`]);
      const builtinId = state.builtinTemplate?.criteria.find(item => item.evaluation?.criterionId === criterion.evaluation.criterionId)?.id || criterion.evaluation.criterionId;
      body.append(editorField('Built-in criterion', selectEditorControl(`${prefix}-builtin`, builtinId, choices, value => applyBuiltinCriterion(index, value)), 'Selecting a built-in criterion copies its default definition and fixed collector inputs.'));
    }
    const collector = selectEditorControl(`${prefix}-collector`, criterion.collector.toolId, [['project-files', 'Project files · preserve selected bytes'], ['osv-scanner', 'OSV-Scanner · supported lockfiles']], value => {
      criterion.collector.toolId = value;
      if (value === 'osv-scanner' && criterion.evaluation.kind !== 'vulnerabilities') changeEvaluationKind(index, 'vulnerabilities');
      else if (value === 'project-files' && criterion.evaluation.kind === 'vulnerabilities') changeEvaluationKind(index, 'files');
    });
    body.append(editorField('Evidence collector', collector));
    const paths = textEditorControl(`${prefix}-paths`, criterion.collector.paths.join('\n'), value => { criterion.collector.paths = splitLines(value); }, { multiline: true, maxLength: 20000, placeholder: criterion.collector.toolId === 'osv-scanner' ? 'package-lock.json\ngo.sum' : 'README.md\ndocs/governance.md' });
    body.append(editorField('Project-relative evidence paths', paths, criterion.evaluation.kind === 'json-field' ? 'Use exactly one relative path to a JSON file. Inputs stay within the selected project.' : criterion.collector.toolId === 'osv-scanner' ? 'One supported root lockfile per line. The engine validates which lockfile formats are supported.' : 'One relative file path per line. The engine captures these selected inputs, rather than the whole repository.'));
    if (criterion.evaluation.kind === 'builtin') {
      collector.disabled = true; collector.dataset.fixed = 'true'; paths.readOnly = true; paths.dataset.fixed = 'true';
      paths.required = false;
    }
    if (criterion.evaluation.kind === 'files') {
      const config = node('div', 'editor-field-grid');
      append(config,
        editorField('Required file coverage', selectEditorControl(`${prefix}-match`, criterion.evaluation.match, [['all', 'All configured files'], ['any', 'At least one configured file']], value => { criterion.evaluation.match = value; })),
        editorField('Minimum size in bytes', numericEditorControl(`${prefix}-minimum-bytes`, criterion.evaluation.minimumBytes, value => { criterion.evaluation.minimumBytes = value; }, 8 * 1024 * 1024), 'This establishes file presence and size, not the accuracy of its contents.'));
      body.append(config);
    } else if (criterion.evaluation.kind === 'json-field') {
      body.append(editorField('JSON property path', textEditorControl(`${prefix}-json-field`, criterion.evaluation.field.join('\n'), value => { criterion.evaluation.field = splitLines(value); }, { multiline: true, rows: 2, placeholder: 'metadata\nlicense' }), 'One property name per line, from outermost to innermost. Dots inside a name remain literal.'));
      body.append(editorField('JSON comparison', selectEditorControl(`${prefix}-operator`, criterion.evaluation.operator, [['exists', 'Property exists'], ['equals', 'Equals a JSON scalar']], value => {
        criterion.evaluation.operator = value;
        if (value === 'exists') { delete criterion.evaluation.expected; delete criterion._expectedText; }
        else if (!('expected' in criterion.evaluation)) criterion.evaluation.expected = null;
        renderEditorCriteria(); updateEditorActions();
      })));
      if (criterion.evaluation.operator === 'equals') {
        body.append(editorField('Expected JSON scalar', textEditorControl(`${prefix}-expected`, criterion._expectedText ?? JSON.stringify(criterion.evaluation.expected ?? null), value => { criterion._expectedText = value; }, { placeholder: '"MIT"' }), 'Use JSON syntax: a quoted string, number, true, false, or null. Arrays and objects are not supported.'));
      }
    } else if (criterion.evaluation.kind === 'vulnerabilities') {
      body.append(editorField('Maximum known findings allowed', numericEditorControl(`${prefix}-max-findings`, criterion.evaluation.maxFindings, value => { criterion.evaluation.maxFindings = value; }, 100000), 'This rule applies to scanner findings within the recorded lockfile coverage; it does not establish overall security.'));
    } else if (isIntrinsicExpertCriterion(criterion)) {
      body.append(node('p', 'expert-rule-note', 'Collected files inform an attributed reviewer decision. This criterion has no automatic passing rule.'));
    }
    const reviewLabel = node('label', 'review-requirement');
    const review = node('input'); review.type = 'checkbox'; review.checked = criterion.requiresReview || criterion.evaluation.kind === 'expert';
    review.id = `${prefix}-requires-review`;
    const fixedExpertRule = criterion.evaluation.kind === 'builtin' && state.builtinTemplate?.criteria.find(item => item.evaluation?.criterionId === criterion.evaluation.criterionId)?.requiresReview;
    if (criterion.evaluation.kind === 'expert' || fixedExpertRule) { criterion.requiresReview = true; review.checked = true; review.dataset.fixed = 'true'; review.disabled = true; }
    review.addEventListener('change', () => { criterion.requiresReview = review.checked; markEditorDirty(); });
    append(reviewLabel, review, node('span', '', 'Require an attributed human review before finalising this criterion'));
    body.append(reviewLabel);
    append(card, body); list.append(card);
  });
  updateEditorActions();
}

function prepareTemplateDraft() {
  const editor = state.editor;
  const draft = { ...editor.draft, criteria: editor.draft.criteria.map(criterion => {
    const input = templateCriterionInput(criterion);
    const customRequirements = input.evidenceRequirements.filter(requirement => !(input.requiresReview && requirement === 'Attributed reviewer decision and rationale'));
    if (customRequirements.length > 20) throw new Error(`${criterion.id}: use at most 20 custom evidence requirements. The generated attributed-review requirement is counted separately.`);
    if (input.evaluation.kind === 'json-field' && input.evaluation.operator === 'equals') {
      let value;
      try { value = JSON.parse(criterion._expectedText ?? JSON.stringify(input.evaluation.expected)); } catch { throw new Error(`${criterion.id}: the expected value must be a valid JSON scalar.`); }
      if ((value !== null && !['string', 'number', 'boolean'].includes(typeof value)) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`${criterion.id}: the expected value must be a finite number, string, boolean, or null.`);
      input.evaluation.expected = value;
    }
    return input;
  }) };
  if (editor.source && !editor.readonly) { draft.id = editor.source.id; draft.expectedVersion = editor.expectedVersion; }
  return draft;
}

async function publishTemplate() {
  if (!state.editor || state.editor.readonly || state.publishing) return;
  const form = $('#template-form');
  form.querySelectorAll('input, select, textarea').forEach(control => {
    if (!control.disabled && !control.checkValidity()) {
      const detail = control.closest('details'); if (detail) detail.open = true;
    }
  });
  if (state.flowEditing) revealInvalidFlowField(form);
  if (!form.reportValidity()) return;
  let draft;
  try { draft = prepareTemplateDraft(); } catch (error) { editorMessage(error.message, true); return; }
  state.publishing = true; updateEditorActions(); clearNotice();
  try {
    const published = await api('/api/templates', { method: 'POST', body: JSON.stringify(draft) });
    const versions = [...(state.editor.versions || []).filter(item => item.version !== published.version), { version: published.version, createdAt: published.createdAt, policyDigest: published.policyDigest }];
    state.editor = { source: published, draft: templateDraftFrom(published), versions, expectedVersion: published.version, readonly: published.builtIn, dirty: false, origin: '' };
    const summary = { id: published.id, name: published.name, description: published.description, latestVersion: published.version, versionCount: versions.length, updatedAt: published.createdAt, policyDigest: published.policyDigest, builtIn: published.builtIn };
    state.templates = [summary, ...state.templates.filter(item => item.id !== published.id)];
    renderTemplateLibrary(); renderAssessmentTemplateSelector();
    renderTemplateEditor();
    editorMessage(`${published.name}, version ${published.version}, is published. This fixed version can now be used in the browser and CLI.`);
    const refreshes = await Promise.allSettled([
      api(`/api/templates/${encodeURIComponent(published.id)}/versions`), api('/api/templates'),
    ]);
    if (refreshes[0].status === 'fulfilled') state.editor.versions = refreshes[0].value;
    if (refreshes[1].status === 'fulfilled') state.templates = refreshes[1].value;
    renderTemplateLibrary(); renderAssessmentTemplateSelector();
    if (refreshes.some(result => result.status === 'rejected')) editorMessage(`${published.name}, version ${published.version}, is published. The template list could not be fully refreshed; use Refresh to try again.`);
    if (state.flowEditing) {
      leaveFlowDraft(false);
      const selected = await selectAssessmentTemplate(published.id, published.version);
      if (selected) showNotice(`${published.name}, version ${published.version}, is ready to run.`);
      else showNotice(`${published.name}, version ${published.version}, was published, but could not be loaded. Choose it again in the assessment template selector.`, true);
    } else if (state.assessmentTemplate?.id === published.id) {
      renderAssessmentVersionOptions(state.editor.versions, state.assessmentTemplate.version);
      showNotice(`Version ${published.version} was published. The assessment selection stays pinned to version ${state.assessmentTemplate.version} until you choose another version.`);
    }
  } catch (error) {
    if (error.status === 409 && state.editor.source) {
      editorMessage(`A newer version was published while you were editing. Your draft is retained. ${error.message}`, true);
      const recover = button('Load latest published version', 'text-button', () => openTemplateEditor(state.editor.source.id));
      const note = node('p', 'field-help', 'Loading the latest version replaces the draft shown here. Copy the draft into a new template to keep your changes separately.');
      append($('#template-publish-message'), note, recover);
    } else editorMessage(`Template was not published. ${error.message}`, true);
  } finally { state.publishing = false; updateEditorActions(); }
}

function copyEditorTemplate() {
  if (!state.editor || state.publishing) return;
  const editor = state.editor;
  const copied = { ...editor.draft, name: `${editor.draft.name} copy`, criteria: editor.draft.criteria.map(criterion => ({ ...templateCriterionInput(criterion), ...(criterion._expectedText !== undefined ? { _expectedText: criterion._expectedText } : {}) })) };
  const origin = editor.source ? `Copied from ${editor.source.name}, version ${editor.source.version}.` : editor.origin;
  createTemplateEditor(copied, origin);
}

async function downloadTemplateVersion() {
  const source = state.editor?.source;
  if (!source) return;
  const trigger = $('#export-template'); const original = trigger.textContent;
  trigger.disabled = true; trigger.textContent = 'Preparing…';
  try {
    const response = await fetch(`/api/templates/${encodeURIComponent(source.id)}/export?version=${source.version}`, { credentials: 'same-origin' });
    if (!response.ok) {
      let message = `Template export failed (${response.status}).`;
      try { const body = await response.json(); if (body.error) message = body.error; } catch { /* Use the HTTP error. */ }
      throw new Error(message);
    }
    const url = URL.createObjectURL(await response.blob());
    const link = node('a'); link.href = url; link.download = `template-${source.id}-v${source.version}.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) { editorMessage(error.message, true); }
  finally { trigger.textContent = original; trigger.disabled = state.publishing; }
}

async function importTemplateFile(file) {
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!imported || typeof imported !== 'object' || Array.isArray(imported) || typeof imported.name !== 'string' || typeof imported.description !== 'string' || !Array.isArray(imported.criteria)) throw new Error('Choose a template JSON export containing a name, description, and criteria.');
    if (!['offline', 'online'].includes(imported.networkMode)) throw new Error('The template must declare an offline or online network policy.');
    for (const criterion of imported.criteria) {
      if (!criterion || typeof criterion !== 'object' || !['id', 'title', 'description', 'dimension'].every(key => typeof criterion[key] === 'string') || !Array.isArray(criterion.evidenceRequirements) || !criterion.evidenceRequirements.every(item => typeof item === 'string') || !criterion.collector || !Array.isArray(criterion.collector.paths) || !criterion.collector.paths.every(item => typeof item === 'string') || !['project-files', 'osv-scanner'].includes(criterion.collector.toolId) || !criterion.evaluation || !['builtin', 'files', 'json-field', 'vulnerabilities', 'expert'].includes(criterion.evaluation.kind)) throw new Error('A criterion has an unsupported or incomplete definition.');
      if (criterion.evaluation.kind === 'json-field' && !Array.isArray(criterion.evaluation.field)) throw new Error(`${criterion.id}: JSON property paths must be an array of property names.`);
    }
    const draft = templateDraftFrom(imported);
    draft.name = `${draft.name} (imported)`;
    createTemplateEditor(draft, `Imported from ${file.name}. Publishing creates a new local template, with its own version history.`);
    editorMessage('Imported as an unpublished copy. Review its evidence paths, rules, and network policy before publishing.');
  } catch (error) { showNotice(`Template could not be imported: ${error.message}`, true); }
  finally { $('#template-import-file').value = ''; }
}

function updateFlowActions() {
  if (!$('#flow-edit')) return;
  const recorded = state.flowMode !== 'draft';
  $('#flow-mode').textContent = state.flowEditing ? 'Unpublished draft' : recorded ? state.flowMode === 'running' ? 'Running' : 'Recorded flow' : 'Configure';
  $('#flow-title').textContent = state.flowRun ? `${state.flowRun.subject.name} · evaluation` : state.flowEditing ? `${state.editor?.draft.name || 'Untitled flow'} · draft` : state.assessmentTemplate?.name || 'One-off evaluation';
  $('#flow-edit').hidden = recorded || state.flowEditing;
  document.querySelectorAll('#flow-stage-details button[data-configure]').forEach(control => { control.disabled = !state.flowValid || state.templateSelectionLoading || state.submitting; });
  $('#flow-edit').disabled = !state.flowValid || state.submitting || state.templateSelectionLoading || !state.selected.size;
  $('#flow-leave-draft').hidden = !state.flowEditing;
  $('#flow-leave-draft').disabled = state.publishing;
  $('#flow-new-draft').hidden = !recorded || state.submitting || state.flowMode === 'running';
  $('#flow-report').hidden = !state.flowRun;
  $('#run-button').hidden = recorded;
  $('#flow-setup').hidden = recorded || state.flowEditing;
  $('.flow-readiness').hidden = recorded || state.flowEditing;
}

function flowSelection() {
  return state.assessmentTemplate
    ? { templateId: state.assessmentTemplate.id, templateVersion: state.assessmentTemplate.version }
    : { criterionIds: [...state.selected], networkMode: $('input[name="network-mode"]:checked').value };
}

function scheduleFlowPreview() {
  if (!state.ready || state.submitting || state.flowMode !== 'draft') return;
  clearTimeout(state.flowTimer);
  state.flowRequest += 1;
  state.flowValid = false;
  $('#flow-status').textContent = state.flowEditing ? 'Draft changed. Validating the chart…' : 'Building the selected chart…';
  updateSelection();
  state.flowTimer = setTimeout(refreshFlowPreview, 200);
}

async function refreshFlowPreview() {
  if (!state.ready || state.submitting || state.flowMode !== 'draft') return;
  const request = ++state.flowRequest;
  try {
    const selection = state.flowEditing ? { draft: prepareTemplateDraft() } : flowSelection();
    const flow = await api('/api/flow/preview', { method: 'POST', body: JSON.stringify(selection) });
    if (request !== state.flowRequest) return;
    state.flow = flow; state.flowValid = true;
    if (state.flowEditing && state.flowEditorIndex !== null) state.flowSelected = flow.criteria[state.flowEditorIndex]?.id || '_freeze-inputs';
    if (state.flowSelected !== '_freeze-inputs' && !flow.criteria.some(c => c.id === state.flowSelected)) state.flowSelected = '_freeze-inputs';
    $('#flow-status').textContent = state.flowEditing ? 'Validated draft · publish this version before running.' : `${flow.criteria.length} checks · ${flow.networkMode === 'offline' ? 'offline' : 'public lookups allowed'} · click a node to inspect or configure.`;
    updateFlowGraph();
    if (!state.flowEditing) renderFlowInspector();
  } catch (error) {
    if (request !== state.flowRequest) return;
    state.flowValid = false;
    $('#flow-status').textContent = `Chart needs valid configuration. ${error.message}${state.flow ? ' The previous valid chart remains visible.' : ''}`;
    if (!state.flow) $('#flow-graph').replaceChildren(node('p', 'empty-copy', 'Select at least one valid check to build the flow.'));
  } finally { if (request === state.flowRequest) updateSelection(); }
}

async function updateFlowGraph() {
  if (!state.flow || state.view !== 'assessment') return;
  const options = () => ({ structure: state.flow.structure, criteria: state.flow.criteria, mode: state.flowMode, selectedId: state.flowSelected, events: state.flowEvents, results: state.flowResults, onSelect: selectFlowStage });
  try {
    if (state.flowHandle) { state.flowHandle.update(options()); return; }
    if (state.flowMounting) return;
    state.flowMounting = Promise.all([loadReplayModule(), loadReplayStyles()]);
    const [module] = await state.flowMounting;
    if (state.view !== 'assessment' || !state.flow) return;
    state.flowHandle = module.mountWorkspace($('#flow-graph'), options());
  } catch (error) {
    $('#flow-graph').replaceChildren(node('p', 'empty-copy', `The chart could not be displayed. ${error.message}`), button('Try loading the chart again', 'button secondary', () => updateFlowGraph()));
  } finally { state.flowMounting = null; }
}

function selectFlowStage(id) {
  if (state.publishing) return;
  state.flowSelected = id;
  if (state.flowEditing) {
    state.flowEditorIndex = id === '_freeze-inputs' ? null : state.editor.draft.criteria.findIndex(c => c.id === id);
    if (state.flowEditorIndex < 0) state.flowEditorIndex = null;
    filterFlowEditor();
  } else renderFlowInspector();
  updateFlowGraph();
  if (window.matchMedia('(max-width: 900px)').matches) $('#flow-inspector').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function flowConfigureButton(label) {
  const control = button(label, 'button secondary', beginFlowEdit);
  control.dataset.configure = 'true';
  control.disabled = !state.flowValid || state.templateSelectionLoading || state.submitting;
  return control;
}

function renderFlowInspector() {
  const host = $('#flow-stage-details'); host.replaceChildren(); host.hidden = state.flowEditing;
  $('#flow-stage-editor').hidden = !state.flowEditing;
  if (state.flowEditing || !state.flow) return;
  const id = state.flowSelected;
  const criterion = state.flow.criteria.find(item => item.id === id);
  append(host, node('div', 'eyebrow', state.flowMode === 'draft' ? 'SELECTED STAGE' : 'RECORDED STAGE'), node('h2', '', criterion?.title || 'Initialize evaluation'));
  if (!criterion) {
    host.append(node('p', 'flow-inspector-copy', 'FootprintJS initializes the evaluation state before visiting the checks. The engine captures selected files before this chart begins.'));
    if (state.flowMode === 'draft') host.append(flowConfigureButton('Configure this flow'));
    return;
  }
  host.append(node('p', 'flow-criterion-meta', `${criterion.id} · ${criterion.dimension}`));
  const result = state.flowResults.find(item => item.criterionId === id);
  if (result) {
    append(host, node('h3', '', 'Current finding'), badge(result.status), node('p', 'flow-inspector-copy', result.rationale));
    if (state.flowRun?.reviews.some(review => review.criterionId === id)) host.append(node('p', 'flow-review-note', 'This finding includes later human review. Open the recorded replay to inspect the original automated step.'));
    if (result.automaticResult) append(host, node('h3', '', 'Automatic result before review'), badge(result.automaticResult.status));
  }
  append(host, node('h3', '', 'Rule'), node('p', 'flow-inspector-copy', criterion.rule));
  const tool = toolFor(criterion.collector?.toolId);
  append(host, node('h3', '', 'Evidence & tool'), node('p', 'flow-inspector-copy', tool ? `${state.flowMode === 'draft' ? '' : 'Installed now: '}${tool.name} · ${tool.available ? 'available' : 'unavailable'}` : 'Tool availability is not recorded.'));
  const paths = node('ul', 'flow-paths');
  (criterion.collector?.paths || criterion.evidenceRequirements || []).forEach(path => paths.append(node('li', '', path)));
  host.append(paths);
  if (criterion.requiresReview || criterion.mode === 'expert') host.append(node('p', 'flow-review-note', 'An attributed human decision is required in the report.'));
  if (state.flowMode === 'draft') host.append(flowConfigureButton('Configure stage'));
  else if (state.flowRun && result) {
    const evidence = state.flowRun.evidence.filter(item => result.evidenceIds.includes(item.id));
    evidence.forEach(item => host.append(button(`Inspect ${item.source}`, 'text-button', () => openEvidence(state.flowRun.id, item))));
    host.append(button('Open report & replay', 'button secondary', () => openFlowReport(true)));
  }
}

async function beginFlowEdit() {
  if (state.submitting || state.flowMode !== 'draft' || !state.flow || state.publishing || !state.flowValid || state.templateSelectionLoading) return;
  const selected = state.flowSelected;
  const source = state.assessmentTemplate;
  const flow = state.flow;
  const generation = state.flowRequest;
  const viewGeneration = state.viewRequest;
  let versions = [];
  try { if (source && !source.builtIn) versions = await api(`/api/templates/${encodeURIComponent(source.id)}/versions`); }
  catch (error) { showNotice(`The current template versions could not be loaded. ${error.message}`, true); return; }
  if (state.submitting || state.view !== 'assessment' || state.flow !== flow || state.flowRequest !== generation || state.viewRequest !== viewGeneration || state.assessmentTemplate !== source) return;
  const draft = templateDraftFrom(flow.template);
  if (!source || source.builtIn) draft.name = `${source?.name || 'Local assessment'} copy`;
  state.editorRequest += 1;
  state.editor = { source: source && !source.builtIn ? source : null, draft, versions, expectedVersion: source && !source.builtIn ? source.version : undefined, readonly: false, dirty: true, origin: source ? `Copied from ${source.name}, version ${source.version}.` : 'Based on the selected one-off checks.' };
  state.flowEditing = true;
  state.flowEditorIndex = selected === '_freeze-inputs' ? null : draft.criteria.findIndex(c => c.id === selected);
  if (state.flowEditorIndex < 0) state.flowEditorIndex = null;
  $('#flow-stage-editor').append($('#template-form'));
  renderTemplateEditor(); renderTemplateLibrary(); renderFlowInspector(); updateFlowActions(); scheduleFlowPreview();
}

function filterFlowEditor() {
  if (!state.flowEditing) return;
  const form = $('#template-form');
  const settings = state.flowEditorIndex === null;
  form.classList.toggle('flow-show-settings', settings);
  for (const card of $('#template-criteria-editor').children) card.hidden = Number(card.dataset.criterionIndex) !== state.flowEditorIndex;
  if (state.flowEditorIndex !== null && !state.editor.draft.criteria[state.flowEditorIndex]) {
    state.flowEditorIndex = null; filterFlowEditor(); return;
  }
  $('#template-editor-title').textContent = settings ? 'Flow settings' : state.editor.draft.criteria[state.flowEditorIndex].title || 'New stage';
  $('#use-editor-template').hidden = true;
  $('#copy-template').hidden = true;
  $('#template-version-controls').hidden = true;
  $('#publish-template').textContent = state.publishing ? 'Publishing…' : `Publish flow · v${state.editor.source ? state.editor.expectedVersion + 1 : 1}`;
  $('#publish-template').disabled = state.publishing || !state.editor.draft.criteria.length;
}

function revealInvalidFlowField(form) {
  const invalid = [...form.querySelectorAll('input,select,textarea')].find(control => !control.disabled && !control.checkValidity());
  if (!invalid) return;
  const card = invalid.closest('.criterion-editor');
  state.flowEditorIndex = card ? Number(card.dataset.criterionIndex) : null;
  filterFlowEditor();
}

function leaveFlowDraft(refresh = true) {
  if (!state.flowEditing || (state.publishing && refresh)) return;
  state.flowEditing = false;
  state.flowValid = false; state.flowRequest += 1; clearTimeout(state.flowTimer);
  $('#templates-view .template-builder').append($('#template-form'));
  $('#template-form').classList.remove('flow-show-settings');
  $('#template-criteria-editor').querySelectorAll('.criterion-editor').forEach(card => { card.hidden = false; });
  renderTemplateEditor(); renderFlowInspector(); updateFlowActions();
  scheduleFlowPreview();
  if (refresh) { showNotice('Your unpublished draft remains in Templates. The workspace uses the selected published version.'); }
}

function resetFlowDraft() {
  if (state.submitting || state.flowMode === 'running') return;
  state.flowMode = 'draft'; state.flowRun = null; state.flowEvents = []; state.flowResults = []; state.flowSelected = '_freeze-inputs';
  $('#live-progress').hidden = true;
  updateFlowActions(); scheduleFlowPreview(); setView('assessment', true);
}

async function streamAssessment(input) {
  const response = await fetch('/api/runs/stream', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Assessment-Session': state.sessionToken }, body: JSON.stringify(input) });
  if (!response.ok) { let body; try { body = await response.json(); } catch { /* Keep HTTP status. */ } throw new Error(body?.error || `The local engine returned an error (${response.status}).`); }
  if (!response.body) throw new Error('This browser did not provide a live response. Check Run history for the assessment.');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = ''; let result = null; let streamError = null;
  const receive = line => {
    if (!line.trim()) return;
    const packet = JSON.parse(line);
    if (packet.runId) state.activeRunId = packet.runId;
    if (packet.type === 'result') { result = packet.run; return; }
    if (packet.type === 'error') { streamError = new Error(packet.error); return; }
    if (packet.type !== 'event') return;
    state.flowEvents.push(packet.event);
    if (packet.result) { state.flowResults = [...state.flowResults.filter(row => row.criterionId !== packet.result.criterionId), packet.result]; }
    $('#flow-status').textContent = packet.event.message;
    renderProgress({ status: 'running', subject: { name: state.project?.name || input.projectPath }, events: state.flowEvents });
    $('#open-live-run').hidden = true;
    updateFlowGraph(); renderFlowInspector();
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) { receive(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
      if (pending.length > 32 * 1024 * 1024) throw new Error('The live response exceeded the display limit. Check Run history for the saved assessment.');
      if (done) break;
    }
    receive(pending);
  } finally { reader.releaseLock(); }
  if (streamError) throw streamError;
  if (!result) throw new Error('The connection ended before a final result arrived. The local assessment may still be running. Check Run history.');
  return result;
}

async function showRunFlow(run) {
  if (state.submitting) { showNotice('The active assessment is still running.'); return; }
  const request = ++state.flowRequest;
  const viewGeneration = state.viewRequest;
  try {
    const workflow = await api(`/api/runs/${encodeURIComponent(run.id)}/workflow`);
    if (state.submitting || request !== state.flowRequest || state.viewRequest !== viewGeneration) return;
    if (workflow.kind !== 'replay') { state.run = run; state.replayOpenRunId = run.id; renderRun(); setView('run', true); showNotice(workflow.note || 'This older run has no recorded chart. Its original findings remain available.'); return; }
    leaveFlowDraft(false);
    state.flowRequest += 1; clearTimeout(state.flowTimer);
    state.flow = { structure: workflow.recording.structure, criteria: run.template?.criteria || run.criteria, template: run.template, networkMode: run.networkMode };
    state.flowRun = run; state.flowEvents = run.events; state.flowResults = run.results;
    state.flowMode = run.status === 'interrupted' ? 'interrupted' : run.status === 'running' ? 'running' : 'complete';
    state.flowSelected = '_freeze-inputs';
    $('#flow-status').textContent = `Recorded chart · ${run.status === 'awaiting_review' ? 'automation complete; human review pending' : statusLabels[run.status]} · read-only`;
    setView('assessment', true); updateFlowActions(); renderFlowInspector(); renderProgress(run);
  } catch (error) { showNotice(`The recorded chart could not be opened. ${error.message}`, true); }
}

function openFlowReport(replay = false) {
  if (!state.flowRun) return;
  state.run = state.flowRun;
  if (replay) state.replayOpenRunId = state.run.id;
  renderRun(); setView('run', true);
}

$('#flow-edit').addEventListener('click', beginFlowEdit);
$('#flow-leave-draft').addEventListener('click', () => leaveFlowDraft());
$('#flow-new-draft').addEventListener('click', resetFlowDraft);
$('#flow-report').addEventListener('click', () => openFlowReport());
$('#back-to-flow').addEventListener('click', () => $('#flow-graph').scrollIntoView({ block: 'start', behavior: 'smooth' }));

document.querySelectorAll('[data-view]').forEach(element => element.addEventListener('click', async () => {
  const view = element.dataset.view;
  if (view === 'assessment' && state.flowMode !== 'draft' && !state.submitting) resetFlowDraft();
  setView(view, true);
  try { if (view === 'history') await refreshHistory(); else if (view === 'tools') await refreshTools(); else if (view === 'templates') await refreshTemplates(); }
  catch (error) { showNotice(error.message, true); }
}));
$('#project-form').addEventListener('submit', event => { event.preventDefault(); inspectProject(); });
$('#project-source-kind').addEventListener('change', event => changeProjectSource(event.currentTarget.value));
$('#remote-source-form').addEventListener('submit', event => { event.preventDefault(); fetchProject(); });
$('#remote-source').addEventListener('input', () => {
  if (state.sourceImporting || state.submitting || state.inspecting) return;
  state.projectRequest += 1; state.project = null; state.fetchedProject = null; $('#project-path').value = '';
  renderProject(null); updateProjectControls(); updateSelection();
});
$('#project-path').addEventListener('input', () => {
  if (state.sourceKind !== 'local' || state.submitting || state.inspecting || state.sourceImporting) return;
  state.projectRequest += 1; state.localProjectPath = $('#project-path').value; state.project = null;
  renderProject(null); updateSelection();
});
document.querySelectorAll('input[name="network-mode"]').forEach(input => input.addEventListener('change', () => { renderReadiness(); scheduleFlowPreview(); }));
$('#assessment-template').addEventListener('change', event => selectAssessmentTemplate(event.currentTarget.value));
$('#assessment-template-version').addEventListener('change', event => { if (state.assessmentTemplate) selectAssessmentTemplate(state.assessmentTemplate.id, Number(event.currentTarget.value)); });
$('#new-template').addEventListener('click', startNewTemplate);
$('#builder-start').addEventListener('click', startNewTemplate);
$('#refresh-templates').addEventListener('click', async event => {
  const trigger = event.currentTarget; trigger.disabled = true;
  try { await refreshTemplates(); } catch (error) { showNotice(error.message, true); } finally { trigger.disabled = false; }
});
$('#template-name').addEventListener('input', event => { if (state.editor) { state.editor.draft.name = event.currentTarget.value; markEditorDirty(); } });
$('#template-description').addEventListener('input', event => { if (state.editor) { state.editor.draft.description = event.currentTarget.value; markEditorDirty(); } });
$('#template-network').addEventListener('change', event => { if (state.editor) { state.editor.draft.networkMode = event.currentTarget.value; markEditorDirty(); } });
$('#add-template-criterion').addEventListener('click', () => {
  if (!state.editor || state.editor.readonly || state.publishing) return;
  state.editor.draft.criteria.push(newTemplateCriterion(state.editor.draft.criteria));
  if (state.flowEditing) state.flowEditorIndex = state.editor.draft.criteria.length - 1;
  markEditorDirty(); renderEditorCriteria();
  $('#template-criteria-editor').lastElementChild?.querySelector('input')?.focus();
});
$('#template-form').addEventListener('submit', event => { event.preventDefault(); publishTemplate(); });
$('#editor-template-version').addEventListener('change', event => { if (state.editor?.source) openTemplateEditor(state.editor.source.id, Number(event.currentTarget.value)); });
$('#copy-template').addEventListener('click', copyEditorTemplate);
$('#export-template').addEventListener('click', downloadTemplateVersion);
$('#use-editor-template').addEventListener('click', async () => {
  const source = state.editor?.source;
  if (source && await selectAssessmentTemplate(source.id, source.version)) setView('assessment', true);
});
$('#import-template').addEventListener('click', () => $('#template-import-file').click());
$('#template-import-file').addEventListener('change', event => importTemplateFile(event.currentTarget.files[0]));
$('#restore-defaults').addEventListener('click', () => { state.selected = new Set(state.catalog.filter(item => item.defaultEnabled).map(item => item.id)); renderCriteria(); });
$('#run-button').addEventListener('click', startRun);
$('#open-live-run').addEventListener('click', () => { if (state.run) { renderRun(); setView('run', true); } });
$('#refresh-history').addEventListener('click', async event => {
  const trigger = event.currentTarget; trigger.disabled = true;
  try { await refreshHistory(); } catch (error) { showNotice(error.message, true); } finally { trigger.disabled = false; }
});
$('#refresh-tools').addEventListener('click', async event => {
  const trigger = event.currentTarget; trigger.disabled = true; trigger.textContent = 'Checking…';
  try { await refreshTools(); showNotice('Tool availability refreshed.'); } catch (error) { showNotice(error.message, true); } finally { trigger.disabled = false; trigger.textContent = 'Check again'; }
});
$('#storage-toggle').addEventListener('click', () => {
  const path = $('#storage-path'); path.hidden = !path.hidden;
  $('#storage-toggle').setAttribute('aria-expanded', String(!path.hidden));
});
$('#close-evidence').addEventListener('click', () => { state.evidenceRequest += 1; $('#evidence-dialog').close(); });
$('#evidence-dialog').addEventListener('close', () => { state.evidenceRequest += 1; });

(async function bootstrap() {
  try {
    const data = await api('/api/bootstrap');
    state.catalog = data.catalog || []; state.tools = data.tools || []; state.runs = data.runs || []; state.templates = data.templates || [];
    state.sessionToken = data.sessionToken || '';
    state.selected = new Set(state.catalog.filter(item => item.defaultEnabled).map(item => item.id));
    $('#project-path').value = data.projectPath || '';
    state.localProjectPath = $('#project-path').value;
    $('#storage-path').textContent = data.dataDir || 'Location not supplied by the engine.';
    state.ready = true;
    updateProjectControls();
    $('#engine-status').replaceChildren(node('span', 'status-dot'), document.createTextNode('Local engine connected'));
    renderCriteria(); renderHistory(); renderTools(); renderTemplateLibrary(); renderAssessmentTemplateSelector();
    const builtin = state.templates.find(template => template.id === 'oss-readiness');
    if (builtin) await selectAssessmentTemplate(builtin.id, 1);
  } catch (error) {
    $('#engine-status').classList.add('failed');
    $('#engine-status').replaceChildren(node('span', 'status-dot'), document.createTextNode('Engine unavailable'));
    $('#criterion-list').replaceChildren(node('p', 'empty-copy', 'The framework could not be loaded.'));
    $('#tool-readiness').replaceChildren(node('p', 'empty-copy', 'Tool readiness is unavailable.'));
    showNotice(`${error.message} Start the local assessment engine, then reload this page.`, true);
  }
})();
