import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { AssessmentEngine } from '../src/core.ts';
import { startServer } from '../src/server.ts';
import type { SourceFetch } from '../src/source-import.ts';
import type { AssessmentRun, SourceImportResult } from '../src/types.ts';

const commit = 'a'.repeat(40);
const packageName = 'source-api-fixture';
const packageVersion = '1.2.3';

function archive(root: string): Buffer {
  const blocks: Buffer[] = [];
  const files = {
    'package.json': JSON.stringify({ name: packageName, version: packageVersion, license: 'MIT', scripts: { install: 'this-must-never-be-executed' } }),
    'README.md': 'Actual package documentation retained from the downloaded archive.',
    LICENSE: 'MIT licence fixture.',
  };
  for (const [path, text] of Object.entries(files)) {
    const bytes = Buffer.from(text);
    const block = Buffer.alloc(512);
    const header = new Header({ path: `${root}/${path}`, type: 'File', mode: 0o644, size: bytes.length });
    header.encode(block);
    blocks.push(block, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function sourceService() {
  const githubArchive = archive(`repository-${commit}`);
  const npmArchive = archive('package');
  const integrity = `sha512-${createHash('sha512').update(npmArchive).digest('base64')}`;
  const calls: string[] = [];
  let unavailable: number | null = null;
  const fetch: SourceFetch = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(new Headers(options.headers).has('authorization'), false);
    if (unavailable !== null) return new Response('Public source unavailable.', { status: unavailable });
    if (url === 'https://api.github.com/repos/owner/repository') return Response.json({ private: false, full_name: 'owner/repository', default_branch: 'main' });
    if (url === 'https://api.github.com/repos/owner/repository/commits/main') return Response.json({ sha: commit });
    if (url === `https://codeload.github.com/owner/repository/tar.gz/${commit}`) return new Response(new Uint8Array(githubArchive));
    if (url === `https://registry.npmjs.org/${packageName}/${packageVersion}`) return Response.json({ name: packageName, version: packageVersion, dist: { tarball: `https://registry.npmjs.org/${packageName}/-/${packageName}-${packageVersion}.tgz`, integrity } });
    if (url === `https://registry.npmjs.org/${packageName}/-/${packageName}-${packageVersion}.tgz`) return new Response(new Uint8Array(npmArchive));
    throw new Error(`Unexpected source request: ${url}`);
  };
  return { fetch, calls, integrity, setUnavailable: (status: number | null) => { unavailable = status; } };
}

function http(url: string, options: { path?: string; method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
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

async function fixture(t: { after: (callback: () => void | Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'assessment-source-api-'));
  const projectPath = join(root, 'local-project');
  mkdirSync(projectPath);
  writeFileSync(join(projectPath, 'package.json'), '{"name":"local-project","version":"1.0.0"}');
  const service = sourceService();
  const engine = new AssessmentEngine({ dataDir: join(root, 'data'), osvExecutable: join(root, 'missing-scanner'), sourceFetch: service.fetch });
  const app = await startServer({ engine, projectPath, dataDir: engine.dataDir });
  t.after(async () => { await app.close(); engine.close(); rmSync(root, { recursive: true, force: true }); });
  const bootstrap = await http(app.url, { path: '/api/bootstrap' });
  assert.equal(bootstrap.status, 200);
  const { sessionToken } = JSON.parse(bootstrap.body);
  const headers = { 'Content-Type': 'application/json', 'X-Assessment-Session': sessionToken, Origin: app.url };
  return { root, projectPath, service, engine, app, headers };
}

for (const kind of ['github', 'npm'] as const) {
  test(`${kind} import is an explicit authenticated HTTP action and later offline assessments reuse its pinned local bytes`, async t => {
    const f = await fixture(t);
    assert.equal(f.service.calls.length, 0, 'bootstrap must not download a project');
    const source = kind === 'github' ? 'https://github.com/owner/repository' : `${packageName}@${packageVersion}`;
    const importedResponse = await http(f.app.url, { path: '/api/projects/import', method: 'POST', headers: f.headers, body: JSON.stringify({ kind, source }) });
    assert.equal(importedResponse.status, 201, importedResponse.body);
    const imported = JSON.parse(importedResponse.body) as SourceImportResult;
    assert.equal(imported.project.name, packageName);
    assert.ok(imported.project.path.startsWith(join(realpathSync(f.engine.dataDir), 'imports')));
    assert.equal(imported.source.kind, kind);
    assert.equal(imported.source.requested, source);
    assert.equal(imported.source.revision, kind === 'github' ? commit : packageVersion);
    assert.equal(imported.source.integrity, kind === 'npm' ? f.service.integrity : null);
    assert.match(imported.source.archiveSha256, /^[a-f\d]{64}$/);
    assert.equal(imported.source.selectedInputs, 'unchanged');
    assert.deepEqual(imported.project.source, imported.source);
    assert.equal(imported.source.fileCount, 3);
    assert.ok(imported.source.extractedBytes > 0);
    const acquisitionCalls = [...f.service.calls];
    assert.equal(acquisitionCalls.length, kind === 'github' ? 3 : 2);

    const refreshed = await http(f.app.url, { path: '/api/bootstrap' });
    assert.equal(refreshed.status, 200);
    const inspected = await http(f.app.url, { path: '/api/projects/inspect', method: 'POST', headers: f.headers, body: JSON.stringify({ projectPath: imported.project.path }) });
    assert.equal(inspected.status, 200, inspected.body);
    assert.deepEqual(JSON.parse(inspected.body).source, imported.source);
    const previewed = await http(f.app.url, { path: '/api/flow/preview', method: 'POST', headers: f.headers, body: JSON.stringify({ templateId: 'oss-readiness', templateVersion: 1 }) });
    assert.equal(previewed.status, 200, previewed.body);
    assert.equal(JSON.parse(previewed.body).networkMode, 'offline');
    const assessed = await http(f.app.url, { path: '/api/runs', method: 'POST', headers: f.headers, body: JSON.stringify({ projectPath: imported.project.path }) });
    assert.equal(assessed.status, 201, assessed.body);
    const run = JSON.parse(assessed.body) as AssessmentRun;
    assert.equal(run.networkMode, 'offline', 'source acquisition must not enable advisory network access');
    assert.deepEqual(run.subject.source, imported.source);
    assert.equal(run.results.find(result => result.criterionId === 'project-metadata')?.status, 'satisfied');
    assert.deepEqual(f.engine.getRun(run.id)?.subject.source, imported.source);
    const exported = await http(f.app.url, { path: `/api/runs/${run.id}/export?format=json` });
    assert.equal(exported.status, 200, exported.body);
    assert.deepEqual(JSON.parse(exported.body).subject.source, imported.source);
    assert.deepEqual(f.service.calls, acquisitionCalls, 'inspect, preview, run and export must not refetch the source');
    assert.equal(readdirSync(join(f.engine.dataDir, 'imports')).length, 1);
  });
}

test('source import rejects session, host, origin, cross-site and malformed body requests before making any remote request', async t => {
  const f = await fixture(t);
  const body = JSON.stringify({ kind: 'github', source: 'https://github.com/owner/repository' });
  const rejectedHeaders: Record<string, string>[] = [
    { 'Content-Type': 'application/json' },
    { ...f.headers, 'X-Assessment-Session': 'invalid' },
    { ...f.headers, Host: 'unrelated.example' },
    { ...f.headers, Origin: 'https://unrelated.example' },
    { ...f.headers, 'Sec-Fetch-Site': 'cross-site' },
  ];
  for (const headers of rejectedHeaders) {
    const response = await http(f.app.url, { path: '/api/projects/import', method: 'POST', headers, body });
    assert.equal(response.status, 403, response.body);
    assert.equal(typeof JSON.parse(response.body).error, 'string');
  }
  const invalidBodies = [
    '{', '[]', 'null', '{}',
    JSON.stringify({ kind: 'local', source: '/local/project' }),
    JSON.stringify({ kind: 'github', source: null }),
    JSON.stringify({ kind: 'github', source: '' }),
    JSON.stringify({ kind: 'github', source: 'https://127.0.0.1/owner/repository' }),
    JSON.stringify({ kind: 'github', source: 'https://github.com/owner/repository/tree/main' }),
    JSON.stringify({ kind: 'npm', source: 'https://unrelated.example/package/fixture' }),
    JSON.stringify({ kind: 'npm', source: `${packageName}@^1.0.0` }),
  ];
  for (const invalid of invalidBodies) {
    const response = await http(f.app.url, { path: '/api/projects/import', method: 'POST', headers: f.headers, body: invalid });
    assert.equal(response.status, 400, response.body);
  }
  assert.equal((await http(f.app.url, { path: '/api/projects/import', method: 'POST', headers: { ...f.headers, 'Content-Type': 'text/plain' }, body })).status, 415);
  const oversized = JSON.stringify({ kind: 'github', source: 'https://github.com/owner/repository', padding: 'x'.repeat(65 * 1024) });
  const boundedHeaders: Record<string, string>[] = [{ 'Content-Length': String(Buffer.byteLength(oversized)) }, { 'Transfer-Encoding': 'chunked' }];
  for (const sizeHeaders of boundedHeaders) {
    const response = await http(f.app.url, { path: '/api/projects/import', method: 'POST', headers: { ...f.headers, ...sizeHeaders }, body: oversized });
    assert.equal(response.status, 413, response.body);
  }
  assert.equal(f.service.calls.length, 0, 'rejected requests must never contact a source service');
  assert.equal(existsSync(join(f.engine.dataDir, 'imports')), false);
  assert.deepEqual(f.engine.listRuns(), []);
});

test('unavailable public sources return actionable HTTP failures without imports or runs and release the acquisition lock', async t => {
  const f = await fixture(t);
  const body = JSON.stringify({ kind: 'github', source: 'https://github.com/owner/repository' });
  for (const status of [404, 429]) {
    f.service.setUnavailable(status);
    const response = await http(f.app.url, { path: '/api/projects/import', method: 'POST', headers: f.headers, body });
    assert.equal(response.status, status === 429 ? 429 : 400, response.body);
    assert.match(JSON.parse(response.body).error, status === 429 ? /rate limit|try again later/i : /could not be downloaded|private sources are unsupported/i);
    assert.equal(existsSync(join(f.engine.dataDir, 'imports')), false);
    assert.deepEqual(f.engine.listRuns(), []);
  }
  assert.equal(f.service.calls.length, 2);
  f.service.setUnavailable(null);
  const recovered = await http(f.app.url, { path: '/api/projects/import', method: 'POST', headers: f.headers, body });
  assert.equal(recovered.status, 201, recovered.body);
  assert.equal(f.service.calls.length, 5);
  assert.equal(readdirSync(join(f.engine.dataDir, 'imports')).length, 1);
  assert.deepEqual(f.engine.listRuns(), []);
});
