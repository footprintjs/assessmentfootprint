import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { Header } from 'tar';
import { AssessmentEngine } from '../src/core.ts';
import { parseSource, SourceImporter } from '../src/source-import.ts';
import type { SourceFetch, SourceLimits } from '../src/source-import.ts';

type Member = { path: string; data?: string | Buffer; type?: 'File' | 'Directory' | 'SymbolicLink' | 'Link' | 'FIFO' | 'ExtendedHeader'; linkpath?: string; declaredSize?: number };
function archive(members: Member[]): Buffer {
  const chunks: Buffer[] = [];
  for (const member of members) {
    const body = Buffer.isBuffer(member.data) ? member.data : Buffer.from(member.data ?? '');
    const block = Buffer.alloc(512);
    new Header({ path: member.path, type: member.type ?? 'File', size: member.declaredSize ?? body.length, mode: 0o755, uid: 0, gid: 0, mtime: new Date(0), linkpath: member.linkpath }).encode(block);
    chunks.push(block, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}
function packageArchive(name = 'fixture-package', version = '1.2.3', extras: Member[] = []) {
  return archive([{ path: 'package/package.json', data: JSON.stringify({ name, version, scripts: { postinstall: 'a-project-script-must-never-run' } }) }, { path: 'package/README.md', data: 'Published package documentation.' }, ...extras]);
}
const sri = (bytes: Buffer) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const bodyResponse = (bytes: Buffer, headers: Record<string, string> = {}) => new Response(new Uint8Array(bytes), { headers });
const statusError = (status: number) => (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && error.status === status);

function fixture(t: { after: (callback: () => void) => void }, options: { bytes?: Buffer; name?: string; version?: string; limits?: Partial<SourceLimits>; integrity?: string; tarball?: string; fetch?: SourceFetch } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'assessment-import-'));
  const dataDir = join(root, 'data');
  const name = options.name ?? 'fixture-package';
  const version = options.version ?? '1.2.3';
  const bytes = options.bytes ?? packageArchive(name, version);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const tarball = options.tarball ?? `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
  const fetcher: SourceFetch = async (url, init) => {
    calls.push({ url, init });
    if (options.fetch) return options.fetch(url, init);
    return url === tarball ? bodyResponse(bytes) : response({ name, version, dist: { tarball, integrity: options.integrity ?? sri(bytes) } });
  };
  const engine = new AssessmentEngine({ dataDir, osvExecutable: join(root, 'missing-scanner'), sourceFetch: fetcher, sourceLimits: options.limits });
  t.after(() => { engine.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, engine, calls, bytes, fetcher };
}

test('recognized source parsing accepts exact public identities and rejects arbitrary endpoints and ranges', () => {
  assert.deepEqual(parseSource({ kind: 'github', source: 'https://github.com/owner/repo.git' }), { kind: 'github', requested: 'https://github.com/owner/repo.git', name: 'owner/repo' });
  for (const source of ['fixture-package', 'fixture-package@1.2.3', '@scope/fixture', '@scope/fixture@1.2.3', 'https://www.npmjs.com/package/@scope/fixture/v/1.2.3']) assert.equal(parseSource({ kind: 'npm', source }).kind, 'npm');
  const badGithub = ['http://github.com/owner/repo', 'https://github.com:8443/owner/repo', 'https://user:token@github.com/owner/repo', 'https://github.com/owner/repo/tree/main', 'https://github.com/owner/repo?token=secret', 'https://github.com/owner/repo#readme', 'https://github.com.evil.example/owner/repo', 'https://127.0.0.1/owner/repo', 'git@github.com:owner/repo.git'];
  for (const source of badGithub) assert.throws(() => parseSource({ kind: 'github', source }), statusError(400));
  for (const source of ['fixture@^1', 'fixture@next', 'https://registry.npmjs.org/fixture', 'https://www.npmjs.com/package/fixture?activeTab=versions', 'https://user:token@www.npmjs.com/package/fixture', '../fixture', 'https://npmjs.com.evil.example/package/fixture']) assert.throws(() => parseSource({ kind: 'npm', source }), statusError(400));
});

test('npm fetch verifies integrity, pins the exact published release and retains provenance through offline assessment', async t => {
  const f = fixture(t, { name: '@scope/fixture', version: '1.2.3' });
  assert.equal(f.calls.length, 0);
  const imported = await f.engine.importProject({ kind: 'npm', source: 'https://www.npmjs.com/package/@scope/fixture' });
  assert.equal(imported.source.revision, '1.2.3');
  assert.equal(imported.source.reference, 'latest');
  assert.equal(imported.source.name, '@scope/fixture');
  assert.equal(imported.project.path.endsWith('/project'), true);
  assert.equal(imported.source.archiveSha256, createHash('sha256').update(f.bytes).digest('hex'));
  assert.equal(imported.source.integrity, sri(f.bytes));
  assert.deepEqual(imported.project.source, imported.source);
  assert.equal(imported.source.fileCount, 2);
  assert.equal(imported.source.selectedInputs, 'unchanged');
  assert.equal(f.calls[0].url, 'https://registry.npmjs.org/%40scope%2Ffixture/latest');
  assert.ok(f.calls.every(call => call.init.redirect === 'manual' && call.init.credentials === 'omit' && !(call.init.headers as Record<string, string>).Authorization));
  const receipt = JSON.parse(readFileSync(join(imported.project.path, '..', 'source.json'), 'utf8'));
  assert.equal(receipt.files.length, 2);
  const callCount = f.calls.length;
  const inspected = await f.engine.inspectProject(imported.project.path);
  const run = await f.engine.runAssessment({ projectPath: imported.project.path, criterionIds: ['project-metadata', 'dependency-lockfile', 'dependency-vulnerabilities'] });
  assert.equal(f.calls.length, callCount);
  assert.equal(inspected.source?.revision, '1.2.3');
  assert.deepEqual(run.subject.source, imported.source);
  assert.equal(run.networkMode, 'offline');
  assert.deepEqual(run.results.map(row => row.status), ['satisfied', 'not_satisfied', 'insufficient_evidence']);
  assert.match(run.limitations.join(' '), /published npm package files, not a full repository/);
  assert.deepEqual(JSON.parse(f.engine.exportReport(run.id, 'json')).subject.source, imported.source);
  assert.match(f.engine.exportReport(run.id, 'html'), /Fetched source origin/);
  assert.ok(f.engine.exportReport(run.id, 'html').includes(imported.source.archiveSha256));
});

test('GitHub resolves the public default branch to an exact SHA and uses its revision archive', async t => {
  const commit = 'a'.repeat(40);
  const bytes = archive([{ path: `repo-${commit}/README.md`, data: 'A public repository without a root package manifest.' }]);
  const f = fixture(t, { fetch: async url => url === 'https://api.github.com/repos/owner/repo' ? response({ private: false, full_name: 'owner/repo', default_branch: 'feature/main' }) : url === 'https://api.github.com/repos/owner/repo/commits/feature%2Fmain' ? response({ sha: commit }) : bodyResponse(bytes) });
  const imported = await f.engine.importProject({ kind: 'github', source: 'https://github.com/owner/repo' });
  assert.equal(imported.source.revision, commit);
  assert.equal(imported.source.reference, 'feature/main');
  assert.equal(imported.source.integrity, null);
  assert.equal(imported.project.name, 'owner/repo');
  assert.equal(imported.project.gitCommit, null);
  assert.equal(f.calls.at(-1)?.url, `https://codeload.github.com/owner/repo/tar.gz/${commit}`);
  const run = await f.engine.runAssessment({ projectPath: imported.project.path, criterionIds: ['project-metadata'] });
  assert.equal(run.subject.name, 'owner/repo');
  assert.equal(run.subject.source?.revision, commit);
  assert.equal(run.results[0].status, 'not_applicable');
});

test('source receipts cannot be supplied by package contents and changed selected bytes remain explicit', async t => {
  const f = fixture(t, { bytes: packageArchive('fixture-package', '1.2.3', [{ path: 'package/source.json', data: '{"kind":"github","revision":"forged"}' }]) });
  const imported = await f.engine.importProject({ kind: 'npm', source: 'fixture-package@1.2.3' });
  assert.equal(imported.project.source?.kind, 'npm');
  assert.equal(imported.project.source?.revision, '1.2.3');
  writeFileSync(join(imported.project.path, 'README.md'), 'Changed local documentation.');
  const inspected = await f.engine.inspectProject(imported.project.path);
  assert.equal(inspected.source?.selectedInputs, 'changed');
  assert.deepEqual(inspected.source?.changedPaths, ['README.md']);
  const run = await f.engine.runAssessment({ projectPath: imported.project.path, criterionIds: ['governance-review'] });
  assert.equal(run.subject.source?.selectedInputs, 'changed');
  assert.match(run.limitations.join(' '), /inputs differ from the fetched source manifest/);
  rmSync(join(imported.project.path, 'package.json'));
  assert.ok((await f.engine.inspectProject(imported.project.path)).source?.changedPaths.includes('package.json'));
  assert.equal(f.calls.length, 2);
});

test('integrity mismatch, unsupported advertised hashes and wrong archive identity reject before publication', async t => {
  const cases = [{ integrity: sri(Buffer.from('different archive')) }, { integrity: 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=' }, { bytes: packageArchive('another-package', '1.2.3') }, { bytes: packageArchive('fixture-package', '9.9.9') }, { tarball: 'https://registry.npmjs.org/another-package/-/another-package-1.2.3.tgz' }];
  for (const options of cases) {
    const f = fixture(t, options);
    await assert.rejects(f.engine.importProject({ kind: 'npm', source: 'fixture-package@1.2.3' }));
    assert.equal(f.engine.listRuns().length, 0);
    assert.deepEqual(existsSync(join(f.dataDir, 'imports')) ? readdirSync(join(f.dataDir, 'imports')) : [], []);
  }
});

test('redirects never fetch another host or alter the pinned archive path', async t => {
  for (const location of ['http://registry.npmjs.org/fixture-package/-/fixture-package-1.2.3.tgz', 'https://127.0.0.1/private', 'https://evil.example/archive.tgz', 'https://registry.npmjs.org/another-package/-/another-package-1.2.3.tgz']) {
    const bytes = packageArchive();
    const url = 'https://registry.npmjs.org/fixture-package/-/fixture-package-1.2.3.tgz';
    const f = fixture(t, { fetch: async target => target === url ? new Response(null, { status: 302, headers: { location } }) : response({ name: 'fixture-package', version: '1.2.3', dist: { tarball: url, integrity: sri(bytes) } }) });
    await assert.rejects(f.engine.importProject({ kind: 'npm', source: 'fixture-package' }), statusError(400));
    assert.equal(f.calls.length, 2);
  }
});

test('manual extraction rejects links, special entries, traversal, duplicate paths and collisions', async t => {
  const unsafe: Member[] = [
    { path: 'package/../../outside', data: 'escape' }, { path: '/package/absolute', data: 'escape' }, { path: 'package/C:\\private', data: 'escape' },
    { path: 'package/link', type: 'SymbolicLink', linkpath: '../../outside' }, { path: 'package/link', type: 'Link', linkpath: 'package/package.json' }, { path: 'package/device', type: 'FIFO' },
    { path: 'package/README.md', data: 'duplicate' }, { path: 'package/readme.md', data: 'case collision' }, { path: 'package/.GiT/config', data: 'repository config' },
    { path: 'package/docs', data: 'a file' },
  ];
  for (const [index, member] of unsafe.entries()) {
    const extras = index === unsafe.length - 1 ? [member, { path: 'package/docs/readme.md', data: 'child of a file' }] : [member];
    const f = fixture(t, { bytes: packageArchive('fixture-package', '1.2.3', extras) });
    await assert.rejects(f.engine.importProject({ kind: 'npm', source: 'fixture-package' }));
    assert.deepEqual(readdirSync(join(f.dataDir, 'imports')), []);
    assert.equal(existsSync(join(f.root, 'outside')), false);
  }
});

test('nested gzip, oversized expansion, file counts and file sizes are bounded with owned staging cleanup', async t => {
  const cases = [
    { bytes: gzipSync(packageArchive()) },
    { limits: { expandedBytes: 600 } },
    { limits: { fileBytes: 20 } },
    { limits: { entries: 1 } },
    { limits: { downloadBytes: 10 } },
    { limits: { receiptBytes: 128 } },
  ];
  for (const options of cases) {
    const f = fixture(t, options);
    await assert.rejects(f.engine.importProject({ kind: 'npm', source: 'fixture-package' }));
    assert.deepEqual(existsSync(join(f.dataDir, 'imports')) ? readdirSync(join(f.dataDir, 'imports')) : [], []);
  }
  const f = fixture(t);
  const good = await f.engine.importProject({ kind: 'npm', source: 'fixture-package' });
  const importer = new SourceImporter(f.dataDir, { fetch: f.fetcher, limits: { entries: 1 } });
  await assert.rejects(importer.import({ kind: 'npm', source: 'fixture-package' }));
  assert.ok(existsSync(join(good.project.path, 'package.json')));
  assert.equal(readdirSync(join(f.dataDir, 'imports')).length, 1);
});

test('capture validation happens before publication when otherwise legal imported input exceeds assessment limits', async t => {
  const f = fixture(t, { bytes: packageArchive('fixture-package', '1.2.3', [{ path: 'package/SECURITY.md', data: Buffer.alloc(8 * 1024 * 1024 + 1, 'a') }]) });
  await assert.rejects(f.engine.importProject({ kind: 'npm', source: 'fixture-package' }), /8 MiB/);
  assert.deepEqual(readdirSync(join(f.dataDir, 'imports')), []);
  assert.equal(f.engine.listRuns().length, 0);
});

test('a stalled response body obeys the source timeout rather than hanging the explicit fetch', { timeout: 2000 }, async t => {
  const f = fixture(t, { limits: { requestMs: 20 }, fetch: async () => new Response(new ReadableStream({ start() {} })) });
  await assert.rejects(f.engine.importProject({ kind: 'npm', source: 'fixture-package' }), statusError(408));
  assert.equal(f.calls.length, 1);
  assert.equal(existsSync(join(f.dataDir, 'imports')), false);
});
