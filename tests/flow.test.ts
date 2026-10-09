import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { graphFromStructure } from 'footprint-explainable-ui';
import { AssessmentEngine } from '../src/core.ts';
import { startServer } from '../src/server.ts';
import type { AssessmentRun, FlowPreview, RunEvent, RunStreamPacket, TemplateDraft } from '../src/types.ts';

function fixture(t: { after: (callback: () => void | Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'assessment-flow-'));
  const projectPath = join(root, 'project');
  mkdirSync(projectPath);
  writeFileSync(join(projectPath, 'package.json'), '{"name":"flow-fixture","version":"1.0.0"}');
  writeFileSync(join(projectPath, 'README.md'), 'Actual local documentation.');
  const engine = new AssessmentEngine({ dataDir: join(root, 'data'), osvExecutable: join(root, 'missing-scanner') });
  t.after(() => { engine.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, projectPath, engine };
}

function draft(): TemplateDraft {
  return { name: 'Documentation policy', description: 'Check a selected local document.', networkMode: 'offline', criteria: [{ id: 'readme', title: 'README availability', description: 'Inspect explicit README bytes.', dimension: 'Documentation', evidenceRequirements: ['README.md'], collector: { toolId: 'project-files', paths: ['README.md'] }, evaluation: { kind: 'files', match: 'all', minimumBytes: 1 }, requiresReview: false }] };
}

function statusError(status: number) { return (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && error.status === status); }

function http(url: string, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
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

function stream(url: string, headers: Record<string, string>, body: unknown, onPacket: (packet: RunStreamPacket) => void = () => {}): Promise<{ status: number; headers: IncomingHttpHeaders; packets: RunStreamPacket[] }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request({ hostname: target.hostname, port: target.port, path: '/api/runs/stream', method: 'POST', headers }, res => {
      const packets: RunStreamPacket[] = [];
      let pending = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        pending += chunk;
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try { const packet = JSON.parse(line) as RunStreamPacket; packets.push(packet); onPacket(packet); }
          catch (error) { reject(error); }
        }
      });
      res.on('end', () => pending ? reject(new Error('The stream ended with an incomplete packet.')) : resolve({ status: res.statusCode!, headers: res.headers, packets }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function serverFixture(t: { after: (callback: () => void | Promise<void>) => void }) {
  const f = fixture(t);
  const app = await startServer({ engine: f.engine, projectPath: f.projectPath, dataDir: f.engine.dataDir });
  t.after(() => app.close());
  const bootstrap = JSON.parse((await http(app.url, { path: '/api/bootstrap' })).body);
  const headers = { 'Content-Type': 'application/json', 'X-Assessment-Session': bootstrap.sessionToken };
  return { ...f, app, headers };
}

test('the preview is a real FootprintJS chart identical to the exact selection executed later', async t => {
  const f = fixture(t);
  let toolsCalls = 0;
  const originalTools = f.engine.getTools.bind(f.engine);
  f.engine.getTools = async () => { toolsCalls++; return originalTools(); };
  const selection = { criterionIds: ['security-policy', 'project-metadata'], networkMode: 'offline' as const };
  const preview = f.engine.previewFlow(selection);
  assert.equal(toolsCalls, 0);
  assert.equal(f.engine.listRuns().length, 0);
  assert.deepEqual(preview.criteria.map(criterion => criterion.id), selection.criterionIds);
  const graph = graphFromStructure(preview.structure);
  assert.deepEqual(graph.nodes.map(node => node.id), ['_freeze-inputs', ...selection.criterionIds]);
  assert.deepEqual(graph.edges.map(edge => [edge.source, edge.target]), [['_freeze-inputs', 'security-policy'], ['security-policy', 'project-metadata']]);
  const run = await f.engine.runAssessment({ projectPath: f.projectPath, ...selection });
  const workflow = f.engine.getWorkflow(run.id);
  assert.equal(workflow.kind, 'replay');
  if (workflow.kind !== 'replay') throw new Error('Expected actual executed structure.');
  assert.deepEqual(workflow.recording.structure, preview.structure);
  assert.deepEqual(run.criteria, preview.criteria);
  assert.deepEqual(run.template, preview.template);
  assert.equal(toolsCalls, 1);
  assert.deepEqual(run.results.map(result => result.status), ['not_satisfied', 'satisfied']);
});

test('saved version previews freeze the same policy, while a normalized draft preview publishes nothing', async t => {
  const f = fixture(t);
  const first = f.engine.saveTemplate(draft());
  const firstPreview = f.engine.previewFlow({ templateId: first.id, templateVersion: 1 });
  const second = f.engine.saveTemplate({ ...draft(), id: first.id, expectedVersion: 1, name: 'More substantial documentation', criteria: [{ ...draft().criteria[0], evaluation: { kind: 'files', match: 'all', minimumBytes: 1000 } }] });
  assert.deepEqual(f.engine.previewFlow({ templateId: first.id, templateVersion: 1 }), firstPreview);
  assert.equal(f.engine.previewFlow({ templateId: first.id }).template.version, 2);
  assert.equal(f.engine.previewFlow({ templateId: first.id }).template.policyDigest, second.policyDigest);
  const before = f.engine.listTemplates();
  const preview = f.engine.previewFlow({ draft: { ...draft(), criteria: [{ ...draft().criteria[0], rule: 'Forged: automatically approved.' }] } });
  assert.equal(preview.template.version, 0);
  assert.equal(preview.template.builtIn, false);
  assert.equal(preview.criteria[0].evaluation.kind, 'files');
  assert.doesNotMatch(preview.criteria[0].rule, /Forged/);
  assert.deepEqual(f.engine.listTemplates(), before);
  assert.equal(f.engine.listRuns().length, 0);
  const run = await f.engine.runAssessment({ projectPath: f.projectPath, templateId: first.id, templateVersion: 1 });
  const workflow = f.engine.getWorkflow(run.id);
  assert.equal(workflow.kind, 'replay');
  if (workflow.kind === 'replay') assert.deepEqual(workflow.recording.structure, firstPreview.structure);
  assert.equal(run.template?.policyDigest, first.policyDigest);
  for (const input of [{ draft: draft(), criterionIds: ['project-metadata'] }, { draft: draft(), networkMode: 'offline' }, { draft: { ...draft(), criteria: [] } }, { draft: { ...draft(), criteria: [{ ...draft().criteria[0], collector: { toolId: 'project-files', paths: ['../outside'] } }] } }, { templateId: first.id, networkMode: 'online' }, { criterionIds: [] }]) assert.throws(() => f.engine.previewFlow(input as never), statusError(400));
});

test('events name actual collection, seed traversal and findings, and observers cannot rewrite or stop the record', async t => {
  const f = fixture(t);
  const observed: Array<{ event: RunEvent; id: string | null }> = [];
  let frozenAtCollection = false;
  const run = await f.engine.runAssessment({ projectPath: f.projectPath, criterionIds: ['project-metadata'], onEvent: (event, id) => {
    observed.push({ event: structuredClone(event), id });
    if (event.type === 'collection_completed') frozenAtCollection = Boolean(id && existsSync(join(f.engine.dataDir, 'runs', id, 'inputs', 'package.json')));
    event.message = 'An observer tried to rewrite the event.';
    throw new Error('An observer failed.');
  } });
  assert.deepEqual(observed.map(item => item.event.type), ['collection_started', 'run_started', 'collection_completed', 'stage_started', 'stage_completed', 'criterion_started', 'criterion_completed', 'run_completed']);
  assert.equal(observed[0].id, null);
  assert.equal(frozenAtCollection, true);
  assert.ok(observed.slice(1).every(item => item.id === run.id));
  assert.deepEqual(run.events, observed.map(item => item.event));
  assert.deepEqual(run.events.filter(event => event.type.startsWith('stage_')).map(event => event.stageId), ['_freeze-inputs', '_freeze-inputs']);
  assert.equal(run.results[0].status, 'satisfied');
  assert.equal(run.status, 'completed');
});

test('flow preview uses the session boundary and rejects project access, mixed drafts and invalid policy bodies', async t => {
  const f = await serverFixture(t);
  f.engine.inspectProject = async () => { throw new Error('Preview must never inspect a project.'); };
  f.engine.getTools = async () => { throw new Error('Preview must never probe native tools.'); };
  const preview = await http(f.app.url, { method: 'POST', path: '/api/flow/preview', headers: f.headers, body: JSON.stringify({ criterionIds: ['project-metadata'] }) });
  assert.equal(preview.status, 200, preview.body);
  assert.deepEqual((JSON.parse(preview.body) as FlowPreview).criteria.map(criterion => criterion.id), ['project-metadata']);
  const policy = await http(f.app.url, { method: 'POST', path: '/api/flow/preview', headers: f.headers, body: JSON.stringify({ draft: draft() }) });
  assert.equal(policy.status, 200, policy.body);
  assert.equal(JSON.parse(policy.body).template.version, 0);
  for (const body of [{ projectPath: f.projectPath }, { draft: draft(), criterionIds: ['project-metadata'] }, { draft: draft(), networkMode: 'offline' }, { criterionIds: 'all' }, { templateVersion: 1 }, { criterionIds: [] }, { draft: { ...draft(), criteria: [] } }]) assert.equal((await http(f.app.url, { method: 'POST', path: '/api/flow/preview', headers: f.headers, body: JSON.stringify(body) })).status, 400);
  for (const headers of [{ 'Content-Type': 'application/json' }, { ...f.headers, Origin: 'https://unrelated.example' }, { ...f.headers, 'Sec-Fetch-Site': 'cross-site' }, { ...f.headers, Host: 'unrelated.example' }]) assert.equal((await http(f.app.url, { method: 'POST', path: '/api/flow/preview', headers, body: '{}' })).status, 403);
  assert.equal((await http(f.app.url, { method: 'POST', path: '/api/flow/preview', headers: f.headers, body: JSON.stringify({ padding: 'x'.repeat(65 * 1024) }) })).status, 413);
  assert.equal(f.engine.listRuns().length, 0);
  assert.equal(f.engine.listTemplates().length, 1);
});

test('the NDJSON route delivers real events and exact run identity before finalisation, with actual finding packets', { timeout: 10000 }, async t => {
  const f = await serverFixture(t);
  let release!: () => void;
  let collectionArrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const collected = new Promise<void>(resolve => { collectionArrived = resolve; });
  f.engine.getTools = async () => { await gate; return []; };
  const received: RunStreamPacket[] = [];
  const pending = stream(f.app.url, f.headers, { projectPath: f.projectPath, criterionIds: ['project-metadata', 'security-policy'] }, packet => { received.push(packet); if (packet.type === 'event' && packet.event.type === 'collection_completed') collectionArrived(); });
  t.after(() => release());
  await collected;
  assert.equal(received.some(packet => packet.type === 'result'), false);
  const started = received.find(packet => packet.type === 'event' && packet.event.type === 'run_started');
  assert.ok(started?.type === 'event' && started.runId);
  assert.equal(f.engine.getRun(started.runId)?.status, 'running');
  release();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/x-ndjson; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'no-store');
  const final = response.packets.at(-1);
  assert.ok(final?.type === 'result');
  const events = response.packets.filter(packet => packet.type === 'event');
  assert.deepEqual(events.map(packet => packet.event), final.run.events);
  assert.equal(events[0].runId, null);
  assert.ok(events.slice(1).every(packet => packet.runId === final.run.id));
  assert.equal(final.run.id, started.runId);
  assert.deepEqual(events.filter(packet => packet.event.type === 'criterion_completed').map(packet => packet.result), final.run.results);
  assert.deepEqual(final.run.results.map(result => result.status), ['satisfied', 'not_satisfied']);
  assert.equal(final.run.status, 'completed');
  assert.equal(f.engine.listRuns().length, 1);
});

test('streaming retains preflight HTTP failures and reports execution failures after emitted events', async t => {
  const f = await serverFixture(t);
  for (const body of [{}, { projectPath: f.projectPath, criterionIds: [] }, { projectPath: f.projectPath, templateVersion: 1 }, { projectPath: f.projectPath, criterionIds: 'all' }, { projectPath: f.projectPath, networkMode: 'automatic' }, { projectPath: f.projectPath, draft: draft() }]) assert.equal((await http(f.app.url, { method: 'POST', path: '/api/runs/stream', headers: f.headers, body: JSON.stringify(body) })).status, 400);
  assert.equal((await http(f.app.url, { method: 'POST', path: '/api/runs/stream', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await http(f.app.url, { method: 'POST', path: '/api/runs/stream', headers: { ...f.headers, Origin: 'https://unrelated.example' }, body: '{}' })).status, 403);
  assert.equal((await http(f.app.url, { method: 'POST', path: '/api/runs/stream', headers: f.headers, body: JSON.stringify({ projectPath: f.projectPath, padding: 'x'.repeat(65 * 1024) }) })).status, 413);
  assert.equal(f.engine.listRuns().length, 0);
  f.engine.getTools = async () => { throw new Error('A controlled tool availability failure.'); };
  const response = await stream(f.app.url, f.headers, { projectPath: f.projectPath, criterionIds: ['project-metadata'] });
  const error = response.packets.at(-1);
  assert.ok(error?.type === 'error');
  assert.equal(error.status, 500);
  assert.match(error.error, /controlled tool availability failure/);
  assert.ok(error.runId);
  assert.equal(f.engine.getRun(error.runId)?.status, 'interrupted');
  assert.equal(response.packets.some(packet => packet.type === 'result'), false);
  assert.ok(response.packets.some(packet => packet.type === 'event' && packet.event.type === 'run_interrupted'));
});

test('disconnecting a streaming observer leaves the real assessment free to finish and persist', { timeout: 10000 }, async t => {
  const f = await serverFixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.engine.getTools = async () => { await gate; return []; };
  t.after(() => release());
  const target = new URL(f.app.url);
  let runId: string | null = null;
  await new Promise<void>((resolve, reject) => {
    const req = request({ hostname: target.hostname, port: target.port, path: '/api/runs/stream', method: 'POST', headers: f.headers }, res => {
      let pending = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        pending += chunk;
        for (const line of pending.split('\n').slice(0, -1)) {
          const packet = JSON.parse(line) as RunStreamPacket;
          if (packet.type === 'event' && packet.event.type === 'run_started') { runId = packet.runId; res.destroy(); req.destroy(); resolve(); return; }
        }
      });
      res.on('error', () => {});
    });
    req.on('error', error => runId ? undefined : reject(error));
    req.end(JSON.stringify({ projectPath: f.projectPath, criterionIds: ['project-metadata'] }));
  });
  assert.ok(runId);
  release();
  for (let attempt = 0; attempt < 100 && f.engine.getRun(runId)?.status === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const run = f.engine.getRun(runId);
  assert.equal(run?.status, 'completed');
  assert.equal(run.results[0].status, 'satisfied');
  const raw = run.evidence.find(evidence => evidence.source === 'Recorded assessment workflow');
  assert.ok(raw);
  assert.ok(readFileSync(join(f.engine.dataDir, raw.rawArtifactRef)).length > 0);
});
