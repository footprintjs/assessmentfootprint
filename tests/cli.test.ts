import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseArguments, runExitCode } from '../src/cli.ts';
import type { AssessmentRun, CriterionStatus, TemplateDraft, TemplateVersion } from '../src/types.ts';

const executable = fileURLToPath(new URL('../bin/assessment.mjs', import.meta.url));

test('CLI parses documented options and rejects ambiguous or unknown input', () => {
  assert.deepEqual(parseArguments(['run', '/project', '--criteria', 'licence,documentation', '--online', '--json']).positional, ['/project']);
  assert.deepEqual(parseArguments(['studio', '--port', '0', '--no-open']).options, { '--port': '0', '--no-open': true });
  assert.deepEqual(parseArguments(['run', '--', '-project']).positional, ['-project']);
  assert.deepEqual(parseArguments(['templates', 'show', 'readme', '--version', '2', '--json']).subcommand, 'show');
  assert.equal(parseArguments(['run', '--template', 'readme', '--template-version', '1']).options['--template-version'], '1');
  assert.equal(parseArguments(['templates', 'import', 'policy.json', '--expected-version', '2']).options['--expected-version'], '2');
  for (const args of [ ['unknown'], ['run', '--unknown'], ['run', '--data-dir'], ['run', 'first', 'second'], ['tools', '/project'], ['studio', '--port', '-1'], ['studio', '--port', '65536'], ['studio', '--port', 'abc'], ['run', '--criteria', 'licence,'], ['run', '--json', '--json'], ['report', 'run-1'], ['report', 'run-1', '--format', 'pdf'] ]) {
    assert.throws(() => parseArguments(args));
  }
  for (const args of [ ['templates'], ['templates', 'delete'], ['templates', 'list', 'extra'], ['templates', 'show'], ['templates', 'show', 'readme', '--version', '0'], ['templates', 'export', 'readme', '--json'], ['templates', 'import', 'file.json', '--version', '1'], ['templates', 'import', 'file.json', '--expected-version', '0'], ['templates', 'import', 'file.json', '--expected-version', '1.5'], ['templates', 'import', 'file.json', '--expected-version', '9007199254740992'], ['run', '--template-version', '1'], ['run', '--template', 'readme', '--criteria', 'project-metadata'], ['run', '--template', 'readme', '--template-version', '1.5'], ['run', '--template', 'readme', '--template-version', '9007199254740992'] ]) assert.throws(() => parseArguments(args));
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

test('CLI imports and exports template versions and pins policy across separate invocations', t => {
  const root = mkdtempSync(join(tmpdir(), 'assessment-template-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectPath = join(root, 'project with spaces');
  const dataDir = join(root, 'store');
  const importPath = join(root, 'template.json');
  mkdirSync(projectPath);
  writeFileSync(join(projectPath, 'README.md'), '# Useful documentation\n');
  const draft: TemplateDraft = { id: 'cli-readme', name: 'README availability', description: 'Collect a useful README.', networkMode: 'offline', criteria: [{ id: 'readme', title: 'README availability', description: 'Collect selected README bytes.', dimension: 'Documentation', evidenceRequirements: ['README.md'], collector: { toolId: 'project-files', paths: ['README.md'] }, evaluation: { kind: 'files', match: 'all', minimumBytes: 5 }, requiresReview: false }] };
  writeFileSync(importPath, JSON.stringify(draft));
  const invoke = (args: string[]) => spawnSync(process.execPath, [executable, ...args, '--data-dir', dataDir], { cwd: root, encoding: 'utf8' });
  const imported = invoke(['templates', 'import', importPath, '--json']);
  assert.equal(imported.status, 0, imported.stderr);
  const first = JSON.parse(imported.stdout) as TemplateVersion;
  assert.equal(first.version, 1);
  const assessed = invoke(['run', projectPath, '--template', first.id, '--template-version', '1', '--json']);
  assert.equal(assessed.status, 0, assessed.stderr);
  const firstRun = JSON.parse(assessed.stdout) as AssessmentRun;
  assert.equal(firstRun.template?.policyDigest, first.policyDigest);
  const revised = { ...first, name: 'Substantial README', criteria: [{ ...first.criteria[0], evaluation: { kind: 'files', match: 'all', minimumBytes: 1000 } }] };
  writeFileSync(importPath, JSON.stringify(revised));
  const unguarded = invoke(['templates', 'import', importPath, '--json']);
  assert.equal(unguarded.status, 3);
  assert.match(unguarded.stderr, /version|changed|conflict/i);
  const reimported = invoke(['templates', 'import', importPath, '--expected-version', '1', '--json']);
  assert.equal(reimported.status, 0, reimported.stderr);
  const second = JSON.parse(reimported.stdout) as TemplateVersion;
  assert.equal(second.id, first.id);
  assert.equal(second.version, 2);
  assert.notEqual(second.policyDigest, first.policyDigest);
  const stale = invoke(['templates', 'import', importPath, '--expected-version', '1', '--json']);
  assert.equal(stale.status, 3);
  assert.match(stale.stderr, /version|changed|conflict/i);
  const sourceVersionsUnchanged = JSON.parse(readFileSync(importPath, 'utf8')) as TemplateVersion;
  assert.equal(sourceVersionsUnchanged.version, 1);
  assert.equal('expectedVersion' in sourceVersionsUnchanged, false);
  const pinned = invoke(['run', projectPath, '--template', first.id, '--template-version', '1', '--json']);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(JSON.parse(pinned.stdout).template.policyDigest, first.policyDigest);
  const latest = invoke(['run', projectPath, '--template', first.id, '--json']);
  assert.equal(latest.status, 1, latest.stderr);
  assert.equal(JSON.parse(latest.stdout).template.version, 2);
  const shown = invoke(['templates', 'show', first.id, '--version', '1', '--json']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout), first);
  const listed = invoke(['templates', 'list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).find((template: { id: string }) => template.id === first.id).latestVersion, 2);
  const exportPath = join(root, 'exports', 'template-v1.json');
  const exported = invoke(['templates', 'export', first.id, '--version', '1', '--output', exportPath]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.deepEqual(JSON.parse(readFileSync(exportPath, 'utf8')), first);
  const report = invoke(['report', firstRun.id, '--format', 'json']);
  assert.equal(report.status, 0, report.stderr);
  assert.equal(JSON.parse(report.stdout).template.policyDigest, first.policyDigest);
  const mismatch = invoke(['run', projectPath, '--template', first.id, '--online', '--json']);
  assert.equal(mismatch.status, 3);
  assert.match(mismatch.stderr, /network|profile|online/i);
});

test('CLI template import accepts bounded regular JSON files without executing content', t => {
  const root = mkdtempSync(join(tmpdir(), 'assessment-template-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'store');
  const input = join(root, 'input.json');
  const invoke = (file: string) => spawnSync(process.execPath, [executable, 'templates', 'import', file, '--data-dir', dataDir], { cwd: root, encoding: 'utf8' });
  writeFileSync(input, 'x'.repeat(65 * 1024));
  const oversized = invoke(input);
  assert.equal(oversized.status, 3);
  assert.match(oversized.stderr, /64 KB/);
  writeFileSync(input, 'export default function() { throw new Error("must not execute"); }');
  const code = invoke(input);
  assert.equal(code.status, 3);
  assert.match(code.stderr, /valid JSON/);
  const directory = invoke(root);
  assert.equal(directory.status, 3);
  assert.match(directory.stderr, /regular JSON file/);
});
