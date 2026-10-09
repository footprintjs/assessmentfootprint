import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AssessmentEngine } from '../src/core.ts';

function fixture(t: { after: (callback: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'assessment-core-'));
  const project = join(root, 'project');
  const dataDir = join(root, 'data');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'real-file-fixture', version: '1.0.0', license: 'MIT', dependencies: { example: '1.0.0' } }));
  writeFileSync(join(project, 'package-lock.json'), JSON.stringify({ name: 'real-file-fixture', lockfileVersion: 3, packages: { '': { name: 'real-file-fixture', version: '1.0.0' }, 'node_modules/example': { version: '1.0.0' } } }));
  writeFileSync(join(project, 'LICENSE'), 'MIT License\nPermission is hereby granted.');
  writeFileSync(join(project, 'SECURITY.md'), '# Reporting a vulnerability\nContact the maintainer privately.');
  writeFileSync(join(project, 'GOVERNANCE.md'), '# Governance\nMaintainers decide through documented proposals.');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, dataDir };
}

function scanner(root: string, output: unknown, code = 0, version = '2.3.2') {
  const executable = join(root, `test-scanner-${Math.random().toString(16).slice(2)}.mjs`);
  const argsFile = `${executable}.args.json`;
  writeFileSync(executable, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nif(process.argv.includes('--version')){console.log('Version: ${version}');process.exit(0);}\nwriteFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(JSON.stringify(output))});\nprocess.exit(${code});\n`);
  chmodSync(executable, 0o700);
  return { executable, argsFile };
}

test('actual input files are frozen, shared evidence is reused, and FootprintJS records each assessment stage', async t => {
  const f = fixture(t);
  const engine = new AssessmentEngine({ dataDir: f.dataDir, osvExecutable: join(f.root, 'not-installed') });
  t.after(() => engine.close());
  const run = await engine.runAssessment({ projectPath: f.project });
  assert.equal(run.results.length, 6);
  for (const id of ['project-metadata', 'license-evidence', 'security-policy', 'dependency-lockfile']) assert.equal(run.results.find(r => r.criterionId === id)?.status, 'satisfied');
  assert.equal(run.results.find(r => r.criterionId === 'dependency-vulnerabilities')?.status, 'insufficient_evidence');
  assert.equal(run.status, 'awaiting_review');
  assert.equal(run.completedAt, null);
  assert.ok(run.automationCompletedAt);
  assert.equal(run.criteria.length, 6);
  assert.equal(run.evidence.filter(e => e.source === 'package.json').length, 1);
  const manifestEvidence = run.evidence.find(e => e.source === 'package.json')!;
  const original = engine.readEvidence(run.id, manifestEvidence.id).toString();
  writeFileSync(join(f.project, 'package.json'), '{}');
  assert.equal(engine.readEvidence(run.id, manifestEvidence.id).toString(), original);
  const traceRecord = run.evidence.find(e => e.toolId === 'footprintjs')!;
  const trace = JSON.parse(engine.readEvidence(run.id, traceRecord.id).toString());
  assert.equal(trace.snapshot.sharedState.findings.length, 6);
  assert.ok(trace.snapshot.commitLog.length > 0);
  assert.equal(run.events.filter(e => e.type === 'criterion_completed').length, 6);
  assert.match(engine.exportReport(run.id, 'html'), /Self-assessment/);
});

test('missing documents and malformed lockfiles do not become passing assessments', async t => {
  const f = fixture(t);
  rmSync(join(f.project, 'LICENSE'));
  writeFileSync(join(f.project, 'package-lock.json'), 'not json');
  const engine = new AssessmentEngine({ dataDir: f.dataDir, osvExecutable: join(f.root, 'missing') });
  t.after(() => engine.close());
  const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['license-evidence', 'dependency-lockfile', 'dependency-vulnerabilities'] });
  assert.deepEqual(run.results.map(r => r.status), ['not_satisfied', 'not_satisfied', 'insufficient_evidence']);
  await assert.rejects(engine.runAssessment({ projectPath: f.project, criterionIds: ['unknown'] }), /Unknown criterion/);
  await assert.rejects(engine.runAssessment({ projectPath: f.project, criterionIds: [] }), /at least one/);
});

test('human review remains attributable, preserves history, and cannot silently replace automatic evidence', async t => {
  const f = fixture(t);
  const engine = new AssessmentEngine({ dataDir: f.dataDir, osvExecutable: join(f.root, 'missing') });
  const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['project-metadata', 'governance-review'] });
  assert.throws(() => engine.submitReview({ runId: run.id, criterionId: 'project-metadata', reviewer: 'Assessor', decision: 'satisfied', rationale: 'This automatic result should not be overridden.' }), /expert criterion/);
  let reviewed = engine.submitReview({ runId: run.id, criterionId: 'governance-review', reviewer: 'Local assessor', decision: 'satisfied', rationale: 'The governance document identifies maintainers and their proposal process.' });
  assert.equal(reviewed.status, 'completed');
  assert.ok(reviewed.completedAt);
  assert.equal(reviewed.revision, 2);
  reviewed = engine.submitReview({ runId: run.id, criterionId: 'governance-review', reviewer: 'Second assessor', decision: 'not_satisfied', rationale: 'The document does not establish how disagreements can be appealed.' });
  assert.equal(reviewed.reviews.length, 2);
  assert.equal(reviewed.results[0].status, 'satisfied');
  assert.deepEqual(reviewed.evidence, run.evidence);
  engine.close();
  const reopened = new AssessmentEngine({ dataDir: f.dataDir });
  t.after(() => reopened.close());
  assert.equal(reopened.getRun(run.id)?.reviews.length, 2);
  assert.equal(reopened.listRuns()[0].counts.not_satisfied, 1);
});

test('OSV adapter uses frozen lockfiles, disables Go call analysis, and preserves a negative scanner finding', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const fake = scanner(f.root, { results: [{ packages: [{ package: { name: 'example', version: '1.0.0', ecosystem: 'npm' }, vulnerabilities: [{ id: 'TEST-ADVISORY' }] }] }] }, 1);
  const engine = new AssessmentEngine({ dataDir: f.dataDir, osvExecutable: fake.executable });
  t.after(() => engine.close());
  const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['dependency-vulnerabilities'] });
  assert.equal(run.results[0].status, 'not_satisfied');
  const args = JSON.parse(readFileSync(fake.argsFile, 'utf8')) as string[];
  assert.ok(args.includes('--offline'));
  assert.ok(args.includes('--no-call-analysis=go'));
  const lockArg = args.find(a => a.startsWith('--lockfile='))!;
  assert.ok(lockArg.includes('/runs/'));
  assert.ok(!lockArg.includes('/project/'));
  assert.equal(run.evidence.filter(e => e.toolId === 'osv-scanner').length, 2);
});

test('scanner errors, invalid schemas and empty coverage stay insufficient; clean identified packages can satisfy the scoped check', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  for (const [index, output, code, expected] of [
    [0, { error: 'database missing' }, 128, 'insufficient_evidence'],
    [1, { unexpected: true }, 0, 'insufficient_evidence'],
    [2, { results: [] }, 0, 'insufficient_evidence'],
    [3, { results: [{ packages: [{ package: { name: 'example', version: '1.0.0', ecosystem: 'npm' } }] }] }, 0, 'satisfied'],
  ] as const) {
    const fake = scanner(f.root, output, code);
    const engine = new AssessmentEngine({ dataDir: join(f.dataDir, String(index)), osvExecutable: fake.executable });
    try {
      const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['dependency-vulnerabilities'] });
      assert.equal(run.results[0].status, expected);
    } finally { engine.close(); }
  }
});

test('outside-project symlinks are rejected and changed stored evidence fails its integrity check', async t => {
  const f = fixture(t);
  const outside = join(f.root, 'private.txt');
  writeFileSync(outside, 'out-of-project contents');
  rmSync(join(f.project, 'LICENSE'));
  symlinkSync(outside, join(f.project, 'LICENSE'));
  const engine = new AssessmentEngine({ dataDir: f.dataDir, osvExecutable: join(f.root, 'missing') });
  t.after(() => engine.close());
  await assert.rejects(engine.runAssessment({ projectPath: f.project }), /outside the selected project/);
  rmSync(join(f.project, 'LICENSE'));
  const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['project-metadata'] });
  const evidence = run.evidence[0];
  writeFileSync(join(f.dataDir, evidence.rawArtifactRef), 'changed');
  assert.throws(() => engine.readEvidence(run.id, evidence.id), /integrity check failed/);
  assert.throws(() => engine.exportReport(run.id, 'html'), /integrity check failed/);
});

test('malformed packages, malformed vulnerabilities, contradictory exit codes and unsupported majors never pass', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const identity = { name: 'example', version: '1.0.0', ecosystem: 'npm' };
  const cases: Array<{ output: unknown; code: number; version?: string }> = [
    { output: { results: [{ packages: [{}] }] }, code: 0 },
    { output: { results: [{ packages: [{ package: identity, vulnerabilities: 'bad' }] }] }, code: 0 },
    { output: { results: [{ packages: [{ package: identity }] }] }, code: 1 },
    { output: { results: [{ packages: [{ package: identity, vulnerabilities: [{ id: 'ADVISORY' }] }] }] }, code: 0 },
    { output: { results: [{ packages: [{ package: identity }] }] }, code: 0, version: '1.2.3' },
    { output: { results: [{ packages: [{ package: identity }] }] }, code: 0, version: '3.2.3' },
  ];
  for (const [index, scenario] of cases.entries()) {
    const fake = scanner(f.root, scenario.output, scenario.code, scenario.version);
    const engine = new AssessmentEngine({ dataDir: join(f.dataDir, `invalid-${index}`), osvExecutable: fake.executable });
    try {
      const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['dependency-vulnerabilities'] });
      assert.equal(run.results[0].status, 'insufficient_evidence');
    } finally { engine.close(); }
  }
});

test('Git metadata inspection disables a project-configured filesystem monitor', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  execFileSync('git', ['init', f.project], { stdio: 'ignore' });
  execFileSync('git', ['-C', f.project, 'add', 'package.json']);
  execFileSync('git', ['-C', f.project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture'], { stdio: 'ignore' });
  const marker = join(f.root, 'executed');
  const hook = join(f.root, 'monitor.sh');
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(hook, 0o700);
  execFileSync('git', ['-C', f.project, 'config', 'core.fsmonitor', hook]);
  const engine = new AssessmentEngine({ dataDir: f.dataDir });
  t.after(() => engine.close());
  const project = await engine.inspectProject(f.project);
  assert.ok(project.gitCommit);
  assert.equal(existsSync(marker), false);
});

test('passive metadata collection never invokes Git clean filters for changed project files', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  execFileSync('git', ['init', f.project], { stdio: 'ignore' });
  writeFileSync(join(f.project, '.gitattributes'), 'package.json filter=probe\n');
  execFileSync('git', ['-C', f.project, 'add', 'package.json', '.gitattributes']);
  execFileSync('git', ['-C', f.project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture'], { stdio: 'ignore' });
  const marker = join(f.root, 'filter-executed');
  const filter = join(f.root, 'filter.sh');
  writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
  chmodSync(filter, 0o700);
  execFileSync('git', ['-C', f.project, 'config', 'filter.probe.clean', filter]);
  const original = readFileSync(join(f.project, 'package.json'), 'utf8');
  writeFileSync(join(f.project, 'package.json'), original.replace('1.0.0', '1.0.1'));
  const engine = new AssessmentEngine({ dataDir: f.dataDir });
  t.after(() => engine.close());
  const project = await engine.inspectProject(f.project);
  assert.equal(project.gitDirty, null);
  assert.equal(project.packageVersion, '1.0.1');
  assert.equal(existsSync(marker), false);
});

test('report integrity includes the frozen scanner inputs and saved criterion definitions', async t => {
  const f = fixture(t);
  const engine = new AssessmentEngine({ dataDir: f.dataDir });
  t.after(() => engine.close());
  const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['project-metadata'] });
  const db = new DatabaseSync(join(f.dataDir, 'assessment.sqlite'));
  const original = JSON.stringify(run);
  run.criteria[0].title = 'Forged policy title';
  db.prepare('UPDATE runs SET payload=? WHERE id=?').run(JSON.stringify(run), run.id);
  assert.throws(() => engine.exportReport(run.id, 'html'), /policy integrity check failed/);
  db.prepare('UPDATE runs SET payload=? WHERE id=?').run(original, run.id);
  db.close();
  assert.match(engine.exportReport(run.id, 'html'), /Package identity/);
  writeFileSync(join(f.dataDir, 'runs', run.id, 'inputs', 'package.json'), '{}');
  assert.throws(() => engine.exportReport(run.id, 'json'), /Frozen input integrity check failed/);
});

test('startup recovers dead-owner runs without interrupting runs owned by another live engine', async t => {
  const f = fixture(t);
  const first = new AssessmentEngine({ dataDir: f.dataDir });
  const run = await first.runAssessment({ projectPath: f.project, criterionIds: ['project-metadata'] });
  first.close();
  const db = new DatabaseSync(join(f.dataDir, 'assessment.sqlite'));
  const write = (ownerPid: number) => { run.status = 'running'; run.execution.ownerPid = ownerPid; db.prepare('UPDATE runs SET payload=? WHERE id=?').run(JSON.stringify(run), run.id); };
  write(process.pid);
  let reopened = new AssessmentEngine({ dataDir: f.dataDir });
  assert.equal(reopened.getRun(run.id)?.status, 'running');
  reopened.close();
  write(2147483647);
  reopened = new AssessmentEngine({ dataDir: f.dataDir });
  assert.equal(reopened.getRun(run.id)?.status, 'interrupted');
  assert.equal(reopened.getRun(run.id)?.events.at(-1)?.type, 'run_interrupted');
  reopened.close();
  db.close();
});

test('exported reports escape source metadata and review text', async t => {
  const f = fixture(t);
  writeFileSync(join(f.project, 'package.json'), JSON.stringify({ name: '<script>alert(1)</script>', version: '1.0.0', license: 'MIT' }));
  const engine = new AssessmentEngine({ dataDir: f.dataDir, osvExecutable: join(f.root, 'missing') });
  t.after(() => engine.close());
  const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['project-metadata', 'governance-review'] });
  engine.submitReview({ runId: run.id, criterionId: 'governance-review', reviewer: '<img src=x onerror=alert(1)>', decision: 'satisfied', rationale: '<script>alert(2)</script> is untrusted review content.' });
  const html = engine.exportReport(run.id, 'html');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;script&gt;/);
});
