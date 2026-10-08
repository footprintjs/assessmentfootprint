'use strict';

const state = {
  catalog: [], tools: [], runs: [], selected: new Set(), sessionToken: '',
  run: null, project: null, view: 'assessment', ready: false, submitting: false, inspecting: false,
  pollTimer: null, activeRunId: null, evidenceRequest: 0, reviewBusy: false,
};
const $ = (selector, root = document) => root.querySelector(selector);
const statusLabels = {
  satisfied: 'Satisfied', not_satisfied: 'Not satisfied',
  insufficient_evidence: 'Insufficient evidence', not_applicable: 'Not applicable',
  evaluation_error: 'Evaluation error', running: 'Running', awaiting_review: 'Awaiting review',
  completed: 'Completed', interrupted: 'Interrupted',
};
const viewLabels = { assessment: 'New assessment', history: 'Run history', tools: 'Tools & setup', run: 'Assessment findings' };

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
    throw new Error(message);
  }
  return response.json();
}

function setView(view, focus = false) {
  state.view = view;
  document.querySelectorAll('.view').forEach(element => { element.hidden = element.id !== `${view}-view`; });
  document.querySelectorAll('.nav-button').forEach(element => {
    const active = element.dataset.view === view;
    element.classList.toggle('active', active);
    if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current');
  });
  $('#view-label').textContent = viewLabels[view] || view;
  if (focus) $('#main').focus({ preventScroll: true });
}

function renderCriteria() {
  const list = $('#criterion-list');
  list.replaceChildren();
  if (!state.catalog.length) {
    list.append(node('p', 'empty-copy', 'No criteria are available in this framework.'));
    updateSelection();
    return;
  }
  for (const criterion of state.catalog) {
    const card = node('div', 'criterion-card');
    card.classList.toggle('selected', state.selected.has(criterion.id));
    const label = node('label', 'criterion-choice');
    const input = node('input');
    input.type = 'checkbox';
    input.value = criterion.id;
    input.checked = state.selected.has(criterion.id);
    input.disabled = state.submitting;
    const copy = node('span', 'criterion-copy');
    const titleRow = node('span', 'criterion-title-row');
    const title = node('span', 'criterion-title', criterion.title);
    const mode = node('span', `mode-badge ${criterion.mode === 'expert' ? 'expert' : ''}`, criterion.mode === 'expert' ? 'Expert review' : 'Automatic');
    append(titleRow, title, mode);
    append(copy, node('div', 'criterion-id', `${criterion.id} · ${criterion.dimension}`), titleRow, node('p', 'criterion-description', criterion.description));
    append(label, input, copy);
    input.addEventListener('change', () => {
      if (input.checked) state.selected.add(criterion.id); else state.selected.delete(criterion.id);
      card.classList.toggle('selected', input.checked);
      updateSelection();
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
}

function updateSelection() {
  const count = state.selected.size;
  $('#selection-count').textContent = `${count} ${count === 1 ? 'criterion' : 'criteria'} selected`;
  $('#run-button').disabled = !state.ready || !count || state.submitting || state.inspecting || !$('#project-path').value.trim();
  $('#restore-defaults').disabled = !state.ready || state.submitting;
  renderReadiness();
}

function renderReadiness() {
  const container = $('#tool-readiness');
  container.replaceChildren();
  const tools = state.tools.filter(tool => (tool.supportedCriteria || []).some(id => state.selected.has(id)));
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
}

async function inspectProject() {
  const form = $('#project-form');
  if (!form.reportValidity()) return;
  const inspect = $('#inspect-button');
  const original = inspect.textContent;
  state.inspecting = true;
  $('#project-path').disabled = true;
  inspect.disabled = true;
  inspect.textContent = 'Inspecting…';
  updateSelection();
  clearNotice();
  try {
    const project = await api('/api/projects/inspect', { method: 'POST', body: JSON.stringify({ projectPath: $('#project-path').value.trim() }) });
    state.project = project;
    $('#project-path').value = project.path;
    renderProject(project);
    updateSelection();
    showNotice(`Ready to assess ${project.name}.`);
  } catch (error) { showNotice(error.message, true); renderProject(null); }
  finally {
    state.inspecting = false;
    $('#project-path').disabled = state.submitting;
    inspect.disabled = state.submitting;
    inspect.textContent = original;
    updateSelection();
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
  $('#project-path').disabled = busy;
  $('#inspect-button').disabled = busy;
  document.querySelectorAll('#criterion-list input, input[name="network-mode"]').forEach(input => { input.disabled = busy; });
  $('#run-button').textContent = busy ? 'Assessment running…' : 'Run assessment ↗';
  updateSelection();
}

async function startRun() {
  if (state.submitting || state.inspecting || !state.ready) return;
  if (!$('#project-form').reportValidity()) return;
  if (!state.selected.size) { showNotice('Select at least one criterion.', true); return; }
  clearNotice();
  const input = {
    projectPath: $('#project-path').value.trim(), criterionIds: [...state.selected],
    networkMode: $('input[name="network-mode"]:checked').value,
  };
  setConfigurationBusy(true);
  state.activeRunId = null;
  renderProgress(null);
  const baseline = new Set(state.runs.map(run => run.id));
  let collecting = true;
  const normalisePath = path => String(path).replace(/\/+$/, '');
  const poll = async () => {
    if (!state.submitting || !collecting) return;
    try {
      const summaries = await refreshHistory();
      if (!state.activeRunId) {
        const candidates = summaries.filter(run => !baseline.has(run.id) && normalisePath(run.subject.path) === normalisePath(input.projectPath));
        if (candidates.length === 1) state.activeRunId = candidates[0].id;
      }
      if (state.activeRunId) {
        const run = await api(`/api/runs/${encodeURIComponent(state.activeRunId)}`);
        if (state.submitting && collecting) {
          state.run = run;
          renderProgress(run);
          if (state.view === 'run') renderRun();
        }
      }
    } catch { /* The final response remains authoritative; polling can recover next time. */ }
    if (state.submitting && collecting) state.pollTimer = setTimeout(poll, 1200);
  };
  state.pollTimer = setTimeout(poll, 500);
  try {
    const run = await api('/api/runs', { method: 'POST', body: JSON.stringify(input) });
    collecting = false;
    state.run = run;
    state.activeRunId = run.id;
    renderProgress(run);
    renderRun();
    setView('run', true);
    await refreshHistory();
    if (run.status === 'awaiting_review') showNotice('Evidence collection is complete. The expert criteria need your review.');
    else if (run.status === 'interrupted') showNotice('This run was interrupted. Review the recorded activity and limitations.', true);
    else showNotice('Assessment saved. Review each finding and its original evidence.');
  } catch (error) {
    collecting = false;
    showNotice(error.message, true);
    if (state.activeRunId) {
      try {
        state.run = await api(`/api/runs/${encodeURIComponent(state.activeRunId)}`);
        renderProgress(state.run);
      } catch { /* Keep any evidence already displayed. */ }
    } else $('#live-progress').hidden = true;
  } finally {
    collecting = false;
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
    setConfigurationBusy(false);
  }
}

async function loadRun(id) {
  clearNotice();
  try {
    state.run = await api(`/api/runs/${encodeURIComponent(id)}`);
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
  content.replaceChildren();
  if (!run) { content.append(node('p', 'empty-copy', 'Select a saved assessment to view its findings.')); return; }
  const back = button('← All assessments', 'text-button run-back', () => setView('history', true));
  const intro = node('header', 'page-intro run-intro');
  const title = node('div');
  append(title, node('div', 'eyebrow', 'ASSESSMENT FINDINGS'), node('h1', '', run.subject.name), node('p', '', run.subject.path));
  const tags = node('div', 'intro-tags');
  append(tags, badge(run.status), node('span', 'tag', 'Self-assessment'), node('span', 'tag muted', run.networkMode === 'online' ? 'Public lookups allowed' : 'Offline run'));
  title.append(tags);
  const actions = node('div', 'run-actions');
  append(actions, button('Refresh', 'button secondary small', () => loadRun(run.id)), button('Export HTML', 'button secondary small', event => downloadExport('html', event.currentTarget)), button('Export JSON', 'button secondary small', event => downloadExport('json', event.currentTarget)));
  append(intro, title, actions);
  const counts = Object.fromEntries(Object.keys(statusLabels).filter(key => ['satisfied', 'not_satisfied', 'insufficient_evidence', 'not_applicable', 'evaluation_error'].includes(key)).map(key => [key, 0]));
  run.results.forEach(result => { if (result.status in counts) counts[result.status] += 1; });
  const summary = node('div', 'run-summary');
  Object.entries(counts).forEach(([status, count]) => summary.append(append(node('div', 'result-counter'), node('strong', '', count), node('span', '', statusLabels[status]))));
  summary.setAttribute('aria-label', 'Criterion outcome counts');
  const context = node('details', 'panel run-context');
  context.append(node('summary', '', 'Recorded scope & provenance'));
  const info = node('dl', 'metadata-grid');
  append(info,
    metadata('Started', formatDate(run.startedAt)), metadata('Finished', run.completedAt ? formatDate(run.completedAt) : 'Not yet finalised'),
    metadata('Framework', `${run.framework.name} · ${run.framework.version}`), metadata('Git commit', run.subject.gitCommit, false, true),
    metadata('Working tree', run.subject.gitDirty === null ? 'Not recorded' : run.subject.gitDirty ? 'Uncommitted changes present' : 'Clean'),
    metadata('Snapshot scope', run.sourceSnapshot.scope), metadata('Source snapshot SHA-256', run.sourceSnapshot.digest, true, true),
    metadata('Policy digest', run.framework.policyDigest, true, true), metadata('Run identifier', run.id, true, true));
  context.append(info);
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
  append(content, back, intro, summary, context, heading, findings);
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

function renderFinding(run, result) {
  const criterion = criterionFor(result.criterionId);
  const finding = node('details', 'panel finding');
  finding.open = result.status === 'insufficient_evidence' || result.status === 'evaluation_error';
  const summary = node('summary');
  const copy = node('div', 'finding-summary');
  append(copy, node('div', 'criterion-id', `${result.criterionId}${criterion ? ` · ${criterion.dimension}` : ''}`), node('h3', '', criterion?.title || result.criterionId));
  append(summary, copy, badge(result.status));
  const body = node('div', 'finding-body');
  body.append(node('p', 'finding-rationale', result.rationale));
  if (criterion) {
    const rubric = node('details', 'criterion-details');
    append(rubric, node('summary', '', 'Assessment rule'), node('p', '', criterion.rule));
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
    append(evidenceCopy, node('strong', 'evidence-source', evidence.source || evidence.id), node('span', 'evidence-tool', `${toolName} · ${evidence.toolVersion || 'Version not recorded'} · ${formatBytes(evidence.bytes)}`));
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
  if (criterion?.mode === 'expert' && run.status !== 'running' && run.status !== 'interrupted') body.append(renderReviewForm(run, criterion, reviews));
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

document.querySelectorAll('[data-view]').forEach(element => element.addEventListener('click', async () => {
  const view = element.dataset.view;
  setView(view, true);
  try { if (view === 'history') await refreshHistory(); else if (view === 'tools') await refreshTools(); }
  catch (error) { showNotice(error.message, true); }
}));
$('#project-form').addEventListener('submit', event => { event.preventDefault(); inspectProject(); });
$('#project-path').addEventListener('input', () => { state.project = null; renderProject(null); updateSelection(); });
document.querySelectorAll('input[name="network-mode"]').forEach(input => input.addEventListener('change', renderReadiness));
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
    state.catalog = data.catalog || []; state.tools = data.tools || []; state.runs = data.runs || [];
    state.sessionToken = data.sessionToken || '';
    state.selected = new Set(state.catalog.filter(item => item.defaultEnabled).map(item => item.id));
    $('#project-path').value = data.projectPath || '';
    $('#storage-path').textContent = data.dataDir || 'Location not supplied by the engine.';
    state.ready = true;
    $('#engine-status').replaceChildren(node('span', 'status-dot'), document.createTextNode('Local engine connected'));
    renderCriteria(); renderHistory(); renderTools();
  } catch (error) {
    $('#engine-status').classList.add('failed');
    $('#engine-status').replaceChildren(node('span', 'status-dot'), document.createTextNode('Engine unavailable'));
    $('#criterion-list').replaceChildren(node('p', 'empty-copy', 'The framework could not be loaded.'));
    $('#tool-readiness').replaceChildren(node('p', 'empty-copy', 'Tool readiness is unavailable.'));
    showNotice(`${error.message} Start the local assessment engine, then reload this page.`, true);
  }
})();
