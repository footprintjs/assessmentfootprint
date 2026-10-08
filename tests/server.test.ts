import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssessmentEngine } from '../src/core.ts';
import { startServer, type ServerEngine } from '../src/server.ts';
import type { AssessmentRun, ReviewInput, RunInput } from '../src/types.ts';

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
  assert.match(state.sessionToken, /^[a-f0-9]{64}$/);
  assert.equal(bootstrap.headers['access-control-allow-origin'], undefined);
  assert.match(bootstrap.headers['content-security-policy'] as string, /script-src 'self'/);
  assert.doesNotMatch(bootstrap.headers['content-security-policy'] as string, /script-src[^;]*unsafe-inline/);
  const headers = { 'Content-Type': 'application/json', 'X-Assessment-Session': state.sessionToken, Origin: app.url };
  const assessed = await http(app.url, { method: 'POST', path: '/api/runs', headers, body: JSON.stringify({ projectPath: '/example/project', criterionIds: ['documentation'], networkMode: 'offline' }) });
  assert.equal(assessed.status, 201);
  assert.equal(JSON.parse(assessed.body).id, run.id);
  assert.deepEqual(inputs, [{ projectPath: '/example/project', criterionIds: ['documentation'], networkMode: 'offline' }]);
  const reviewed = await http(app.url, { method: 'POST', path: '/api/runs/run-1/reviews', headers, body: JSON.stringify({ criterionId: 'documentation', reviewer: 'Reviewer', decision: 'satisfied', rationale: 'Reviewed the guide.' }) });
  assert.equal(reviewed.status, 200);
  assert.equal(reviews[0].runId, 'run-1');
  assert.equal((await http(app.url, { path: '/api/runs/run-1' })).status, 200);
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
