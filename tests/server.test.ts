import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AssessmentEngine } from '../src/core.ts';
import { startServer, type ServerEngine } from '../src/server.ts';
import type { AssessmentRun, ReviewInput, RunInput, TemplateDraft, TemplateVersion, WorkflowResponse } from '../src/types.ts';

function fixture() {
  const inputs: RunInput[] = [];
  const reviews: ReviewInput[] = [];
  const run: AssessmentRun = {
    id: 'run-1', status: 'awaiting_review', startedAt: '2026-10-08T10:00:00Z', completedAt: null, automationCompletedAt: '2026-10-08T10:00:00Z', revision: 1,
    subject: { path: '/example/project', name: 'project', packageVersion: '1.0.0', gitCommit: null, gitDirty: null, detectedFiles: ['README.md'] },
    framework: { id: 'test', name: 'Test', version: '1', policyDigest: 'digest' },
    criteria: [], execution: { ownerPid: process.pid },
    sourceSnapshot: { scope: 'test', digest: 'digest', files: [] }, results: [],
    evidence: [{ id: 'evidence-1', toolId: 'test', toolVersion: '1', collectedAt: '2026-10-08T10:00:00Z', source: 'README.md', sha256: 'digest', bytes: 21, rawArtifactRef: 'evidence-1.txt', value: '<script>bad()</script>' }],
    reviews: [], events: [], assessmentType: 'self-assessment', networkMode: 'offline', limitations: [],
  };
  const engine: ServerEngine = {
    getCatalog: () => [], getTools: async () => [], inspectProject: async projectPath => ({ ...run.subject, path: projectPath }),
    runAssessment: async input => { inputs.push(input); return run; }, listRuns: () => [], getRun: id => id === run.id ? run : null,
    submitReview: input => { reviews.push(input); return run; }, readEvidence: () => Buffer.from('<script>bad()</script>'),
    exportReport: (_id, format) => format === 'json' ? JSON.stringify(run) : '<!doctype html><html><body>Report</body></html>',
    listTemplates: () => [], getTemplate: () => null, listTemplateVersions: () => [],
    saveTemplate: () => { throw new Error('No fixture template has been defined.'); }, importTemplate: () => { throw new Error('No fixture template has been defined.'); },
    getWorkflow: () => ({ kind: 'unavailable', note: 'This fixture does not include a recorded workflow.' }),
  };
  return { engine, run, inputs, reviews };
}

function http(url: string, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request({ hostname: target.hostname, port: target.port, path: options.path ?? '/', method: options.method ?? 'GET', headers: options.headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

test('local API exposes bootstrap, runs, evidence and downloadable reports', async t => {
  const { engine, run, inputs, reviews } = fixture();
  const app = await startServer({ engine, projectPath: '/example/project', dataDir: '/example/data' });
  t.after(() => app.close());
  assert.equal((app.server.address() as import('node:net').AddressInfo).address, '127.0.0.1');
  const bootstrap = await http(app.url, { path: '/api/bootstrap' });
  assert.equal(bootstrap.status, 200);
  const state = JSON.parse(bootstrap.body);
  assert.equal(state.projectPath, '/example/project');
  assert.deepEqual(state.templates, []);
  assert.match(state.sessionToken, /^[a-f0-9]{64}$/);
  assert.equal(bootstrap.headers['access-control-allow-origin'], undefined);
  assert.match(bootstrap.headers['content-security-policy'] as string, /script-src 'self'/);
  assert.doesNotMatch(bootstrap.headers['content-security-policy'] as string, /script-src[^;]*unsafe-inline/);
  assert.match(bootstrap.headers['content-security-policy'] as string, /style-src 'self'(?:;|$)/);
  assert.match(bootstrap.headers['content-security-policy'] as string, /style-src-attr 'unsafe-inline'/);
  const headers = { 'Content-Type': 'application/json', 'X-Assessment-Session': state.sessionToken, Origin: app.url };
  const assessed = await http(app.url, { method: 'POST', path: '/api/runs', headers, body: JSON.stringify({ projectPath: '/example/project', criterionIds: ['documentation'], networkMode: 'offline' }) });
  assert.equal(assessed.status, 201);
  assert.equal(JSON.parse(assessed.body).id, run.id);
  assert.deepEqual(inputs, [{ projectPath: '/example/project', criterionIds: ['documentation'], networkMode: 'offline' }]);
  const reviewed = await http(app.url, { method: 'POST', path: '/api/runs/run-1/reviews', headers, body: JSON.stringify({ criterionId: 'documentation', reviewer: 'Reviewer', decision: 'satisfied', rationale: 'Reviewed the guide.' }) });
  assert.equal(reviewed.status, 200);
  assert.equal(reviews[0].runId, 'run-1');
  assert.equal((await http(app.url, { path: '/api/runs/run-1' })).status, 200);
  assert.deepEqual(JSON.parse((await http(app.url, { path: '/api/runs/run-1/workflow' })).body), { kind: 'unavailable', note: 'This fixture does not include a recorded workflow.' });
  const evidence = await http(app.url, { path: '/api/runs/run-1/evidence/evidence-1' });
  assert.equal(evidence.status, 200);
  assert.equal(evidence.body, '<script>bad()</script>');
  assert.equal(evidence.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(evidence.headers['x-content-type-options'], 'nosniff');
  const report = await http(app.url, { path: '/api/runs/run-1/export?format=html' });
  assert.equal(report.status, 200);
  assert.match(report.headers['content-disposition'] as string, /attachment; filename="assessment-run-1.html"/);
  assert.match(report.headers['content-security-policy'] as string, /sandbox/);
});

test('server rejects remote host, cross-origin, cross-site and unauthenticated requests', async t => {
  const app = await startServer({ engine: fixture().engine, projectPath: '/example/project', dataDir: '/example/data' });
  t.after(() => app.close());
  const bootstrap = JSON.parse((await http(app.url, { path: '/api/bootstrap' })).body);
  const rejectedHeaders: Record<string, string>[] = [ { Host: 'attacker.example' }, { Origin: 'https://attacker.example' }, { 'Sec-Fetch-Site': 'cross-site' } ];
  for (const headers of rejectedHeaders) {
    const response = await http(app.url, { path: '/api/bootstrap', headers });
    assert.equal(response.status, 403);
    assert.equal(typeof JSON.parse(response.body).error, 'string');
  }
  for (const token of [undefined, 'invalid', 'x'.repeat(64), 'é'.repeat(64)]) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['X-Assessment-Session'] = token;
    assert.equal((await http(app.url, { method: 'POST', path: '/api/runs', headers, body: '{"projectPath":"/example/project"}' })).status, 403);
  }
  assert.equal((await http(app.url, { method: 'POST', path: '/api/runs', headers: { 'Content-Type': 'application/json', 'X-Assessment-Session': bootstrap.sessionToken, Origin: 'https://attacker.example' }, body: '{}' })).status, 403);
  assert.equal((await http(app.url, { method: 'OPTIONS', path: '/api/runs' })).status, 405);
});

test('server bounds JSON bodies and validates assessment and review inputs', async t => {
  const { engine, inputs } = fixture();
  const app = await startServer({ engine, projectPath: '/example/project', dataDir: '/example/data' });
  t.after(() => app.close());
  const { sessionToken } = JSON.parse((await http(app.url, { path: '/api/bootstrap' })).body);
  const headers = { 'Content-Type': 'application/json', 'X-Assessment-Session': sessionToken };
  for (const body of ['bad json', '[]', 'null', '{}', '{"projectPath":"/project","criterionIds":"all"}', '{"projectPath":"/project","networkMode":"automatic"}']) {
    assert.equal((await http(app.url, { method: 'POST', path: '/api/runs', headers, body })).status, 400);
  }
  const oversized = JSON.stringify({ projectPath: '/project', padding: 'x'.repeat(65 * 1024) });
  assert.equal((await http(app.url, { method: 'POST', path: '/api/runs', headers, body: oversized })).status, 413);
  assert.equal((await http(app.url, { method: 'POST', path: '/api/runs', headers: { ...headers, 'Transfer-Encoding': 'chunked' }, body: oversized })).status, 413);
  assert.equal((await http(app.url, { method: 'POST', path: '/api/runs', headers: { ...headers, 'Content-Length': String(Buffer.byteLength(oversized)) }, body: oversized })).status, 413);
  assert.equal((await http(app.url, { method: 'POST', path: '/api/runs', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await http(app.url, { method: 'POST', path: '/api/runs/run-1/reviews', headers, body: '{"criterionId":"documentation","reviewer":"Reviewer","decision":"approved","rationale":"Reviewed"}' })).status, 400);
  assert.equal(inputs.length, 0);
});

test('server does not expose arbitrary files or missing evidence', async t => {
  const app = await startServer({ engine: fixture().engine, projectPath: '/example/project', dataDir: '/example/data' });
  t.after(() => app.close());
  for (const path of ['/src/types.ts', '/package.json', '/..%2f..%2fetc/passwd', '/api/runs/missing', '/api/runs/run-1/evidence/missing']) {
    assert.equal((await http(app.url, { path })).status, 404);
  }
  assert.equal((await http(app.url, { path: '/api/runs/run-1/export?format=pdf' })).status, 400);
});

test('engine domain failures retain their status while unexpected failures return 500', async t => {
  const { engine } = fixture();
  engine.runAssessment = async input => {
    if (input.criterionIds?.includes('unexpected')) throw new Error('Unexpected storage failure.');
    throw Object.assign(new Error('Unknown criterion.'), { status: 400 });
  };
  engine.submitReview = () => { throw Object.assign(new Error('Assessment is not ready for review.'), { status: 409 }); };
  const app = await startServer({ engine, projectPath: '/example/project', dataDir: '/example/data' });
  t.after(() => app.close());
  const { sessionToken } = JSON.parse((await http(app.url, { path: '/api/bootstrap' })).body);
  const headers = { 'Content-Type': 'application/json', 'X-Assessment-Session': sessionToken };
  assert.equal((await http(app.url, { method: 'POST', path: '/api/runs', headers, body: '{"projectPath":"/example/project","criterionIds":["unknown"]}' })).status, 400);
  assert.equal((await http(app.url, { method: 'POST', path: '/api/runs', headers, body: '{"projectPath":"/example/project","criterionIds":["unexpected"]}' })).status, 500);
  assert.equal((await http(app.url, { method: 'POST', path: '/api/runs/run-1/reviews', headers, body: '{"criterionId":"governance-review","reviewer":"Reviewer","decision":"satisfied","rationale":"Reviewed the documentation."}' })).status, 409);
});

test('real engine input and active-run conflicts return actionable HTTP errors', async t => {
  const root = mkdtempSync(join(tmpdir(), 'assessment-api-'));
  const projectPath = join(root, 'project');
  mkdirSync(projectPath);
  writeFileSync(join(projectPath, 'package.json'), '{"name":"api-fixture","version":"1.0.0"}');
  const engine = new AssessmentEngine({ dataDir: join(root, 'data'), osvExecutable: join(root, 'missing-scanner') });
  const app = await startServer({ engine, projectPath, dataDir: engine.dataDir });
  let release: (() => void) | undefined;
  let pending: Promise<AssessmentRun> | undefined;
  t.after(async () => {
    release?.();
    await pending;
    await app.close();
    engine.close();
    rmSync(root, { recursive: true, force: true });
  });
  const { sessionToken } = JSON.parse((await http(app.url, { path: '/api/bootstrap' })).body);
  const headers = { 'Content-Type': 'application/json', 'X-Assessment-Session': sessionToken };
  for (const criterionIds of [[], ['unknown']]) {
    assert.equal((await http(app.url, { method: 'POST', path: '/api/runs', headers, body: JSON.stringify({ projectPath, criterionIds }) })).status, 400);
  }
  const assessed = await http(app.url, { method: 'POST', path: '/api/runs', headers, body: JSON.stringify({ projectPath, criterionIds: ['project-metadata'] }) });
  assert.equal(assessed.status, 201);
  const run = JSON.parse(assessed.body) as AssessmentRun;
  const reviewBody = JSON.stringify({ criterionId: 'project-metadata', reviewer: 'Reviewer', decision: 'satisfied', rationale: 'Reviewed the metadata evidence.' });
  assert.equal((await http(app.url, { method: 'POST', path: `/api/runs/${run.id}/reviews`, headers, body: reviewBody })).status, 400);
  const gate = new Promise<void>(resolve => { release = resolve; });
  engine.getTools = async () => { await gate; return []; };
  let started!: () => void;
  const runStarted = new Promise<void>(resolve => { started = resolve; });
  pending = engine.runAssessment({ projectPath, criterionIds: ['project-metadata'], onEvent: event => { if (event.type === 'run_started') started(); } });
  await runStarted;
  const activeRun = engine.listRuns().find(summary => summary.status === 'running')!;
  assert.equal((await http(app.url, { method: 'POST', path: '/api/runs', headers, body: JSON.stringify({ projectPath, criterionIds: ['project-metadata'] }) })).status, 409);
  assert.equal((await http(app.url, { method: 'POST', path: `/api/runs/${activeRun.id}/reviews`, headers, body: reviewBody })).status, 409);
  release!();
  await pending;
});

function readmeTemplate(): TemplateDraft {
  return {
    id: 'api-readme', name: 'README availability', description: 'Check selected documentation bytes.', networkMode: 'offline',
    criteria: [{ id: 'readme', title: 'README availability', description: 'Collect the README document.', dimension: 'Documentation', evidenceRequirements: ['README.md'], collector: { toolId: 'project-files', paths: ['README.md'] }, evaluation: { kind: 'files', match: 'all', minimumBytes: 5 }, requiresReview: false }],
  };
}

test('template API saves immutable versions and assessment runs retain their pinned policy', async t => {
  const root = mkdtempSync(join(tmpdir(), 'assessment-template-api-'));
  const projectPath = join(root, 'project');
  mkdirSync(projectPath);
  writeFileSync(join(projectPath, 'README.md'), '# Useful documentation\n');
  const engine = new AssessmentEngine({ dataDir: join(root, 'data'), osvExecutable: join(root, 'missing-scanner') });
  const app = await startServer({ engine, projectPath, dataDir: engine.dataDir });
  t.after(async () => { await app.close(); engine.close(); rmSync(root, { recursive: true, force: true }); });
  const state = JSON.parse((await http(app.url, { path: '/api/bootstrap' })).body);
  assert.ok(Array.isArray(state.templates));
  const headers = { 'Content-Type': 'application/json', 'X-Assessment-Session': state.sessionToken };
  const draft = readmeTemplate();
  const saved = await http(app.url, { method: 'POST', path: '/api/templates', headers, body: JSON.stringify(draft) });
  assert.equal(saved.status, 201, saved.body);
  const first = JSON.parse(saved.body) as TemplateVersion;
  assert.equal(first.version, 1);
  const assessed = await http(app.url, { method: 'POST', path: '/api/runs', headers, body: JSON.stringify({ projectPath, templateId: first.id, templateVersion: 1 }) });
  assert.equal(assessed.status, 201, assessed.body);
  const run = JSON.parse(assessed.body) as AssessmentRun;
  assert.equal(run.results[0].status, 'satisfied');
  assert.equal(run.template?.version, 1);
  const revised = { ...draft, id: first.id, expectedVersion: 1, name: 'More substantial README', criteria: [{ ...draft.criteria[0], evaluation: { kind: 'files', match: 'all', minimumBytes: 1000 } }] };
  const updated = await http(app.url, { method: 'POST', path: '/api/templates', headers, body: JSON.stringify(revised) });
  assert.equal(updated.status, 201, updated.body);
  const second = JSON.parse(updated.body) as TemplateVersion;
  assert.equal(second.version, 2);
  assert.notEqual(second.policyDigest, first.policyDigest);
  assert.equal((await http(app.url, { method: 'POST', path: '/api/templates', headers, body: JSON.stringify(revised) })).status, 409);
  const id = encodeURIComponent(first.id);
  assert.deepEqual(JSON.parse((await http(app.url, { path: `/api/templates/${id}?version=1` })).body), first);
  assert.equal(JSON.parse((await http(app.url, { path: `/api/templates/${id}` })).body).version, 2);
  assert.equal(JSON.parse((await http(app.url, { path: `/api/templates/${id}/versions` })).body).length, 2);
  const summary = JSON.parse((await http(app.url, { path: '/api/templates' })).body).find((template: { id: string }) => template.id === first.id);
  assert.equal(summary.latestVersion, 2);
  const retained = JSON.parse((await http(app.url, { path: `/api/runs/${run.id}` })).body) as AssessmentRun;
  assert.equal(retained.template?.policyDigest, first.policyDigest);
  assert.equal(retained.template?.criteria[0].evaluation.kind, 'files');
  assert.deepEqual(retained.template, first);
  const exported = await http(app.url, { path: `/api/templates/${id}/export?version=1` });
  assert.equal(exported.status, 200);
  assert.match(exported.headers['content-disposition'] as string, /attachment; filename="template-.*-v1\.json"/);
  assert.deepEqual(JSON.parse(exported.body), first);
  const latestRun = await http(app.url, { method: 'POST', path: '/api/runs', headers, body: JSON.stringify({ projectPath, templateId: first.id }) });
  assert.equal(latestRun.status, 201, latestRun.body);
  assert.equal(JSON.parse(latestRun.body).results[0].status, 'not_satisfied');
});

test('template routes retain session, body, version and supported-collector boundaries', async t => {
  const root = mkdtempSync(join(tmpdir(), 'assessment-template-boundaries-'));
  const engine = new AssessmentEngine({ dataDir: join(root, 'data'), osvExecutable: join(root, 'missing-scanner') });
  const app = await startServer({ engine, projectPath: root, dataDir: engine.dataDir });
  t.after(async () => { await app.close(); engine.close(); rmSync(root, { recursive: true, force: true }); });
  const state = JSON.parse((await http(app.url, { path: '/api/bootstrap' })).body);
  const headers = { 'Content-Type': 'application/json', 'X-Assessment-Session': state.sessionToken };
  const draft = readmeTemplate();
  assert.equal((await http(app.url, { method: 'POST', path: '/api/templates', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) })).status, 403);
  assert.equal((await http(app.url, { method: 'POST', path: '/api/templates', headers: { ...headers, Origin: 'https://unrelated.example' }, body: JSON.stringify(draft) })).status, 403);
  assert.equal(engine.listTemplates().some(template => template.id === draft.id), false);
  const template = engine.saveTemplate(draft);
  for (const version of ['0', '-1', '1.5', 'word', '9007199254740992', '1&version=2']) {
    assert.equal((await http(app.url, { path: `/api/templates/${template.id}?version=${version}` })).status, 400);
  }
  assert.equal((await http(app.url, { path: '/api/templates/%2Fprivate/export' })).status, 400);
  assert.equal((await http(app.url, { path: '/api/templates/missing/versions' })).status, 404);
  assert.equal((await http(app.url, { path: `/api/templates/${template.id}?version=99` })).status, 404);
  for (const input of [ { templateId: template.id, criterionIds: ['project-metadata'] }, { templateVersion: 1 }, { templateId: template.id, templateVersion: 0 }, { templateId: template.id, templateVersion: '1' }, { templateId: template.id, networkMode: 'online' } ]) {
    assert.equal((await http(app.url, { method: 'POST', path: '/api/runs', headers, body: JSON.stringify({ projectPath: root, ...input }) })).status, 400);
  }
  const unsafe = { ...draft, id: 'unsafe-template', criteria: [{ ...draft.criteria[0], collector: { toolId: 'shell', paths: ['README.md'], command: 'run-project-script' } }] };
  assert.equal((await http(app.url, { method: 'POST', path: '/api/templates', headers, body: JSON.stringify(unsafe) })).status, 400);
  assert.equal((await http(app.url, { method: 'POST', path: '/api/templates', headers, body: JSON.stringify({ ...draft, description: 'x'.repeat(65 * 1024) }) })).status, 413);
});

test('large valid template API exports remain within the bounded JSON import size', async t => {
  const root = mkdtempSync(join(tmpdir(), 'assessment-template-export-'));
  const engine = new AssessmentEngine({ dataDir: join(root, 'data'), osvExecutable: join(root, 'missing-scanner') });
  const criteria = Array.from({ length: 32 }, (_, index): TemplateDraft['criteria'][number] => ({
    id: `criterion-${index}`, title: `Criterion ${index}`, description: 'x'.repeat(1400), dimension: 'Documentation', evidenceRequirements: ['Selected document bytes'],
    collector: { toolId: 'project-files', paths: ['docs/review.md'] }, evaluation: { kind: 'files', match: 'all', minimumBytes: 1 }, requiresReview: false,
  }));
  const saved = engine.saveTemplate({ name: 'Local documentation policy', description: 'A declared policy for selected input files.', networkMode: 'offline', criteria });
  assert.ok(Buffer.byteLength(JSON.stringify(saved, null, 2)) > 64 * 1024, 'Fixture must exercise pretty-print expansion beyond the import limit.');
  const app = await startServer({ engine, projectPath: root, dataDir: engine.dataDir });
  t.after(async () => { await app.close(); engine.close(); rmSync(root, { recursive: true, force: true }); });
  const exported = await http(app.url, { path: `/api/templates/${encodeURIComponent(saved.id)}/export?version=1` });
  assert.equal(exported.status, 200);
  assert.ok(Buffer.byteLength(exported.body) <= 64 * 1024);
  const imported = engine.importTemplate({ ...JSON.parse(exported.body), expectedVersion: 1 });
  assert.equal(imported.version, 2);
  assert.equal(imported.policyDigest, saved.policyDigest);
  assert.deepEqual(engine.getTemplate(saved.id, 1), saved);
});

test('workflow API serves recorded replay, preserves legacy gaps, and rejects damaged evidence', async t => {
  const root = mkdtempSync(join(tmpdir(), 'assessment-workflow-api-'));
  const projectPath = join(root, 'project');
  const dataDir = join(root, 'data');
  mkdirSync(projectPath);
  writeFileSync(join(projectPath, 'package.json'), '{"name":"workflow-fixture","version":"1.0.0"}');
  const engine = new AssessmentEngine({ dataDir, osvExecutable: join(root, 'missing-scanner') });
  const current = await engine.runAssessment({ projectPath, criterionIds: ['project-metadata'] });
  const earlier = await engine.runAssessment({ projectPath, criterionIds: ['project-metadata'] });
  const app = await startServer({ engine, projectPath, dataDir });
  t.after(async () => { await app.close(); engine.close(); rmSync(root, { recursive: true, force: true }); });

  const response = await http(app.url, { path: `/api/runs/${current.id}/workflow` });
  assert.equal(response.status, 200, response.body);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'no-store');
  const replay = JSON.parse(response.body) as WorkflowResponse;
  assert.equal(replay.kind, 'replay');
  if (replay.kind !== 'replay') throw new Error('Expected a full replay.');
  assert.equal(replay.recording.schemaVersion, 1);
  assert.equal(replay.recording.scope, 'automated-evaluation');
  assert.equal(replay.recording.assessmentId, current.id);
  assert.equal(replay.recording.policyDigest, current.framework.policyDigest);
  assert.ok(replay.recording.snapshot.executionTree);
  assert.ok(replay.recording.structure);
  assert.ok(replay.recording.snapshot.commitLog.length);
  assert.ok(replay.recording.snapshot.recorders?.some(recorder => recorder.name === 'Metrics'));

  const legacy = {
    recorder: 'footprintjs', version: '9.44.1', runId: replay.recording.snapshot.runId,
    sharedState: { findings: [] }, commitLog: [], commitValues: 'full', writeProvenance: {},
    narrative: [{ type: 'stage', text: 'Package identity executed.', depth: 0, stageId: 'project-metadata' }],
  };
  const earlierEvidence = earlier.evidence.find(evidence => evidence.toolId === 'footprintjs')!;
  const legacyBytes = Buffer.from(JSON.stringify(legacy));
  writeFileSync(join(dataDir, earlierEvidence.rawArtifactRef), legacyBytes);
  earlierEvidence.sha256 = createHash('sha256').update(legacyBytes).digest('hex');
  earlierEvidence.bytes = legacyBytes.length;
  const db = new DatabaseSync(join(dataDir, 'assessment.sqlite'));
  try { db.prepare('UPDATE runs SET payload=? WHERE id=?').run(JSON.stringify(earlier), earlier.id); }
  finally { db.close(); }
  const legacyResponse = await http(app.url, { path: `/api/runs/${earlier.id}/workflow` });
  assert.equal(legacyResponse.status, 200, legacyResponse.body);
  const legacyView = JSON.parse(legacyResponse.body) as WorkflowResponse;
  assert.equal(legacyView.kind, 'legacy');
  if (legacyView.kind !== 'legacy') throw new Error('Expected honest legacy recording details.');
  assert.match(legacyView.note, /earlier|execution tree|record/i);
  assert.deepEqual(legacyView.narrativeEntries, legacy.narrative);
  assert.equal('recording' in legacyView, false);

  const currentEvidence = current.evidence.find(evidence => evidence.id === replay.evidenceId)!;
  writeFileSync(join(dataDir, currentEvidence.rawArtifactRef), '{"tampered":true}');
  const damaged = await http(app.url, { path: `/api/runs/${current.id}/workflow` });
  assert.equal(damaged.status, 409);
  assert.match(JSON.parse(damaged.body).error, /integrity/i);
  assert.equal(JSON.parse(damaged.body).kind, undefined);
});

test('workflow reads retain local-origin protections and do not invent missing runs', async t => {
  const app = await startServer({ engine: fixture().engine, projectPath: '/example/project', dataDir: '/example/data' });
  t.after(() => app.close());
  const rejectedHeaders: Record<string, string>[] = [{ Host: 'unrelated.example' }, { Origin: 'https://unrelated.example' }, { 'Sec-Fetch-Site': 'cross-site' }];
  for (const headers of rejectedHeaders) {
    const response = await http(app.url, { path: '/api/runs/run-1/workflow', headers });
    assert.equal(response.status, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await http(app.url, { path: '/api/runs/missing/workflow' })).status, 404);
  assert.equal((await http(app.url, { path: '/api/runs/%GG/workflow' })).status, 400);
  assert.equal((await http(app.url, { method: 'POST', path: '/api/runs/run-1/workflow', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
});

test('replay assets have an exact local allowlist, correct MIME types and narrow CSP', async t => {
  const app = await startServer({ engine: fixture().engine, projectPath: '/example/project', dataDir: '/example/data' });
  t.after(() => app.close());
  for (const [path, type] of [['/assets/replay.js', 'text/javascript; charset=utf-8'], ['/assets/replay.css', 'text/css; charset=utf-8']]) {
    const response = await http(app.url, { path });
    assert.equal(response.status, 200, `Expected the built local replay asset ${path}.`);
    assert.equal(response.headers['content-type'], type);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
    assert.ok(response.body.length > 0);
    const policy = response.headers['content-security-policy'] as string;
    assert.match(policy, /script-src 'self'(?:;|$)/);
    assert.match(policy, /style-src 'self'(?:;|$)/);
    assert.match(policy, /style-src-attr 'unsafe-inline'/);
    assert.doesNotMatch(policy, /script-src[^;]*(?:unsafe-inline|unsafe-eval|https?:|\*)/);
    assert.doesNotMatch(policy, /style-src (?!'self';)/);
  }
  for (const path of ['/assets/replay.js.map', '/assets/other.js', '/assets/%2e%2e/src/core.ts', '/assets/replay.js%00']) {
    assert.equal((await http(app.url, { path })).status, 404);
  }
  assert.equal((await http(app.url, { path: '/assets/replay.js', headers: { Origin: 'https://unrelated.example' } })).status, 403);
});
