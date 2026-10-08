import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseArguments, runExitCode } from '../src/cli.ts';
import type { AssessmentRun, CriterionStatus } from '../src/types.ts';

const executable = fileURLToPath(new URL('../bin/assessment.mjs', import.meta.url));

test('CLI parses documented options and rejects ambiguous or unknown input', () => {
  assert.deepEqual(parseArguments(['run', '/project', '--criteria', 'licence,documentation', '--online', '--json']).positional, ['/project']);
  assert.deepEqual(parseArguments(['studio', '--port', '0', '--no-open']).options, { '--port': '0', '--no-open': true });
  assert.deepEqual(parseArguments(['run', '--', '-project']).positional, ['-project']);
  for (const args of [ ['unknown'], ['run', '--unknown'], ['run', '--data-dir'], ['run', 'first', 'second'], ['tools', '/project'], ['studio', '--port', '-1'], ['studio', '--port', '65536'], ['studio', '--port', 'abc'], ['run', '--criteria', 'licence,'], ['run', '--json', '--json'], ['report', 'run-1'], ['report', 'run-1', '--format', 'pdf'] ]) {
    assert.throws(() => parseArguments(args));
  }
});

test('CLI result exit codes distinguish negative, incomplete and erroneous assessments', () => {
  const makeRun = (status: AssessmentRun['status'], results: CriterionStatus[]): AssessmentRun => ({ status, results: results.map(criterionStatus => ({ status: criterionStatus })) } as AssessmentRun);
  assert.equal(runExitCode(makeRun('completed', ['satisfied', 'not_applicable'])), 0);
  assert.equal(runExitCode(makeRun('completed', ['not_satisfied'])), 1);
  assert.equal(runExitCode(makeRun('completed', ['insufficient_evidence'])), 2);
  assert.equal(runExitCode(makeRun('awaiting_review', ['satisfied'])), 2);
  assert.equal(runExitCode(makeRun('interrupted', [])), 2);
  assert.equal(runExitCode(makeRun('completed', ['not_satisfied', 'evaluation_error'])), 3);
});

test('CLI executable runs an offline project assessment and exports the stored report', t => {
  const root = mkdtempSync(join(tmpdir(), 'assessment-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectPath = join(root, 'project with spaces');
  const dataDir = join(root, 'store');
  mkdirSync(projectPath);
  writeFileSync(join(projectPath, 'package.json'), JSON.stringify({ name: 'assessment-fixture', version: '1.0.0', license: 'MIT' }));
  writeFileSync(join(projectPath, 'README.md'), '# Assessment fixture\n\nInstall and use this package with Node.js.\n');
  const assessed = spawnSync(process.execPath, [executable, 'run', projectPath, '--json', '--data-dir', dataDir], { cwd: root, encoding: 'utf8' });
  assert.ok([0, 1, 2].includes(assessed.status!), `Unexpected exit code ${assessed.status}: ${assessed.stderr}`);
  const run = JSON.parse(assessed.stdout) as AssessmentRun;
  assert.equal(run.subject.path, realpathSync(projectPath));
  assert.equal(run.networkMode, 'offline');
  assert.equal(assessed.status, runExitCode(run));
  const reportPath = join(root, 'reports', 'assessment.html');
  const report = spawnSync(process.execPath, [executable, 'report', run.id, '--format', 'html', '--output', reportPath, '--data-dir', dataDir], { cwd: root, encoding: 'utf8' });
  assert.equal(report.status, 0, report.stderr);
  assert.match(readFileSync(reportPath, 'utf8'), /<html[\s>]/i);
  const unknown = spawnSync(process.execPath, [executable, 'run', projectPath, '--unrecognised'], { cwd: root, encoding: 'utf8' });
  assert.equal(unknown.status, 3);
  assert.match(unknown.stderr, /Unknown option/);
});

test('studio executable advertises a local URL and shuts down on SIGTERM', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'assessment-studio-'));
  const child = spawn(process.execPath, [executable, 'studio', root, '--no-open', '--port', '0', '--data-dir', join(root, 'store')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); });
  let output = '';
  let errors = '';
  child.stderr.on('data', chunk => { errors += String(chunk); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout.on('data', chunk => {
      output += String(chunk);
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) resolve(match[0]);
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Studio exited before startup (${code}): ${errors}`)));
  });
  const response = await fetch(`${url}/api/bootstrap`);
  assert.equal(response.status, 200);
  const bootstrap = await response.json() as { projectPath: string; sessionToken: string };
  assert.equal(bootstrap.projectPath, root);
  assert.ok(bootstrap.sessionToken);
  child.kill('SIGTERM');
  assert.deepEqual(await exit, { code: 0, signal: null });
});
