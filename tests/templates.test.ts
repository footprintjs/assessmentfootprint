import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AssessmentEngine } from '../src/core.ts';
import type { TemplateCriterionInput, TemplateDraft, TemplateVersion } from '../src/types.ts';

function fixture(t: { after: (callback: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'assessment-templates-'));
  const dataDir = join(root, 'data');
  const projects = [join(root, 'first-project'), join(root, 'second-project')];
  for (const project of projects) {
    mkdirSync(project);
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'template-fixture', version: '1.0.0', license: 'MIT' }));
    writeFileSync(join(project, 'package-lock.json'), JSON.stringify({ name: 'template-fixture', lockfileVersion: 3, packages: { '': { name: 'template-fixture', version: '1.0.0' }, 'node_modules/example': { version: '1.0.0' } } }));
    mkdirSync(join(project, 'docs'));
  }
  const engines: AssessmentEngine[] = [];
  t.after(() => { for (const engine of engines) engine.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = (options: { dataDir?: string; osvExecutable?: string } = {}) => {
    const instance = new AssessmentEngine({ dataDir: options.dataDir ?? dataDir, osvExecutable: options.osvExecutable ?? join(root, 'scanner-not-installed') });
    engines.push(instance);
    return instance;
  };
  return { root, dataDir, first: projects[0], second: projects[1], engine };
}

function filesCriterion(overrides: Partial<TemplateCriterionInput> = {}): TemplateCriterionInput {
  return { id: 'documentation', title: 'Assessment documentation', description: 'Check selected project documents.', dimension: 'Documentation', evidenceRequirements: ['Selected document bytes'], collector: { toolId: 'project-files', paths: ['docs/review.md'] }, evaluation: { kind: 'files', match: 'all', minimumBytes: 1 }, requiresReview: false, ...overrides };
}

function draft(criteria: TemplateCriterionInput[] = [filesCriterion()]): TemplateDraft {
  return { name: 'Local documentation policy', description: 'A declared policy for selected input files.', networkMode: 'offline', criteria };
}

function draftFrom(version: TemplateVersion): TemplateDraft {
  return { name: version.name, description: version.description, networkMode: version.networkMode, criteria: version.criteria.map(c => ({ id: c.id, title: c.title, description: c.description, dimension: c.dimension, evidenceRequirements: c.evidenceRequirements, collector: c.collector, evaluation: c.evaluation, requiresReview: c.requiresReview })) };
}

function statusError(status: number) {
  return (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && error.status === status);
}

test('the built-in template is read-only and can be cloned into an independently saved local policy', t => {
  const f = fixture(t);
  const engine = f.engine();
  const builtIn = engine.getTemplate('oss-readiness');
  assert.ok(builtIn);
  assert.equal(builtIn.builtIn, true);
  assert.equal(builtIn.criteria.length, 6);
  const original = structuredClone(builtIn);
  assert.throws(() => engine.saveTemplate({ ...draftFrom(builtIn), id: builtIn.id, expectedVersion: builtIn.version }), statusError(409));
  builtIn.name = 'Changed returned object';
  builtIn.criteria[0].title = 'Changed returned criterion';
  assert.deepEqual(engine.getTemplate(original.id), original);
  const saved = engine.saveTemplate({ ...draftFrom(original), name: 'My local readiness policy' });
  assert.notEqual(saved.id, original.id);
  assert.match(saved.id, /^template-[0-9a-f-]{36}$/i);
  assert.equal(saved.builtIn, false);
  assert.equal(saved.version, 1);
  assert.equal(saved.criteria.length, 6);
  assert.match(saved.policyDigest, /^[a-f0-9]{64}$/);
  assert.ok(saved.criteria.every(c => c.rule.trim().length > 0));
  assert.equal(engine.listTemplates().find(row => row.id === saved.id)?.latestVersion, 1);
});

test('one saved policy evaluates two real folders, and later versions cannot change earlier templates or runs', async t => {
  const f = fixture(t);
  const engine = f.engine();
  writeFileSync(join(f.first, 'docs/review.md'), 'Review evidence.');
  const v1 = engine.saveTemplate(draft());
  const first = await engine.runAssessment({ projectPath: f.first, templateId: v1.id });
  const second = await engine.runAssessment({ projectPath: f.second, templateId: v1.id });
  assert.equal(first.results[0].status, 'satisfied');
  assert.equal(second.results[0].status, 'not_satisfied');
  assert.equal(first.template?.version, 1);
  assert.equal(first.template?.policyDigest, v1.policyDigest);
  assert.ok(first.sourceSnapshot.files.some(file => file.path === 'docs/review.md'));
  assert.ok(first.results[0].evidenceIds.length);
  const frozenRun = structuredClone(first);
  const v2 = engine.saveTemplate({ ...draft([filesCriterion({ evaluation: { kind: 'files', match: 'all', minimumBytes: 100 } })]), id: v1.id, expectedVersion: 1 });
  assert.equal(v2.version, 2);
  assert.notEqual(v2.policyDigest, v1.policyDigest);
  assert.deepEqual(engine.getTemplate(v1.id, 1), v1);
  assert.deepEqual(engine.getRun(first.id), frozenRun);
  const latest = await engine.runAssessment({ projectPath: f.first, templateId: v1.id });
  assert.equal(latest.template?.version, 2);
  assert.equal(latest.results[0].status, 'not_satisfied');
  const pinned = await engine.runAssessment({ projectPath: f.first, templateId: v1.id, templateVersion: 1 });
  assert.equal(pinned.results[0].status, 'satisfied');
  assert.equal(pinned.template?.version, 1);
  writeFileSync(join(f.first, 'docs/review.md'), 'Source changed after assessment.');
  const evidence = first.evidence.find(row => row.source === 'docs/review.md');
  assert.ok(evidence);
  assert.equal(engine.readEvidence(first.id, evidence.id).toString(), 'Review evidence.');
  assert.deepEqual(engine.getRun(first.id), frozenRun);
  assert.match(engine.exportReport(first.id, 'html'), /Local documentation policy/);
});

test('a valid criterion named freeze-inputs cannot collide with the internal workflow seed stage', async t => {
  const f = fixture(t);
  const engine = f.engine();
  writeFileSync(join(f.first, 'docs/review.md'), 'Evidence for a user-named criterion.');
  const policy = engine.saveTemplate(draft([filesCriterion({ id: 'freeze-inputs' })]));
  const run = await engine.runAssessment({ projectPath: f.first, templateId: policy.id });
  assert.equal(run.status, 'completed');
  assert.equal(run.results[0].criterionId, 'freeze-inputs');
  assert.equal(run.results[0].status, 'satisfied');
  const trace = run.evidence.find(record => record.toolId === 'footprintjs');
  assert.ok(trace);
  const recorded = JSON.parse(engine.readEvidence(run.id, trace.id).toString());
  assert.equal(recorded.sharedState.findings.length, 1);
});

test('publishing requires the latest expected version and stale writers cannot replace a policy', t => {
  const f = fixture(t);
  const first = f.engine();
  const second = f.engine();
  const initial = first.saveTemplate(draft());
  const staleCopy = second.getTemplate(initial.id);
  assert.ok(staleCopy);
  first.saveTemplate({ ...draftFrom(initial), id: initial.id, expectedVersion: 1, description: 'The current second version.' });
  assert.throws(() => second.saveTemplate({ ...draftFrom(staleCopy), id: staleCopy.id, expectedVersion: 1, description: 'A stale attempted overwrite.' }), statusError(409));
  assert.equal(second.getTemplate(initial.id)?.description, 'The current second version.');
  assert.equal(first.listTemplateVersions(initial.id).length, 2);
  assert.throws(() => second.saveTemplate({ ...draftFrom(staleCopy), id: staleCopy.id }), statusError(409));
  assert.equal(first.listTemplateVersions(initial.id).length, 2);
});

test('published rule descriptions are derived from validated configuration rather than trusting caller prose', t => {
  const f = fixture(t);
  const engine = f.engine();
  const policy = engine.saveTemplate({ ...draft(), criteria: [{ ...filesCriterion(), rule: 'Fabricated: this criterion always passes.', mode: 'expert', defaultEnabled: false }] });
  assert.equal(policy.criteria[0].mode, 'automatic');
  assert.equal(policy.criteria[0].defaultEnabled, true);
  assert.ok(!policy.criteria[0].rule.includes('Fabricated'));
  assert.match(policy.criteria[0].rule, /configured file|configured files/i);
});

test('generated evidence requirements remain valid through save, read, edit and manifest round-trip', t => {
  const f = fixture(t);
  const source = f.engine();
  const scenarios = [
    filesCriterion({ evidenceRequirements: [], collector: { toolId: 'project-files', paths: Array.from({ length: 32 }, (_, index) => `docs/input-${index}.md`) } }),
    filesCriterion({ evidenceRequirements: Array.from({ length: 20 }, (_, index) => `Authored evidence requirement ${index}`), requiresReview: true }),
  ];
  for (const [index, criterion] of scenarios.entries()) {
    const first = source.saveTemplate(draft([criterion]));
    assert.deepEqual(source.getTemplate(first.id, 1), first);
    assert.equal(first.criteria[0].evidenceRequirements.length, index === 0 ? 1 : 21);
    const second = source.saveTemplate({ ...draftFrom(first), id: first.id, expectedVersion: 1, description: 'An edited version with retained generated requirements.' });
    assert.deepEqual(source.getTemplate(first.id, 2), second);
    assert.deepEqual(second.criteria[0].evidenceRequirements, first.criteria[0].evidenceRequirements);
    const destination = f.engine({ dataDir: join(f.root, `requirements-import-${index}`) });
    const imported = destination.importTemplate(JSON.parse(JSON.stringify(second)));
    assert.deepEqual(destination.getTemplate(imported.id), imported);
    assert.equal(imported.policyDigest, second.policyDigest);
    assert.deepEqual(imported.criteria, second.criteria);
    assert.deepEqual(source.getTemplate(first.id, 1), first);
  }
});

test('invalid paths, duplicate criteria, executable collectors and incompatible rules are rejected before publishing', t => {
  const f = fixture(t);
  const engine = f.engine();
  const invalidDrafts: unknown[] = [
    draft([]),
    draft([filesCriterion(), filesCriterion()]),
    ...['../outside.md', '/etc/passwd', 'C:\\private\\file.txt', 'docs/../../outside.md', 'https://example.invalid/input', '.git/config', '.GiT/config'].map(path => draft([filesCriterion({ collector: { toolId: 'project-files', paths: [path] } })])),
    draft([filesCriterion({ collector: { toolId: 'project-files', paths: [] } })]),
    draft([filesCriterion({ collector: { toolId: 'project-files', paths: ['docs/review.md', 'docs/review.md'] } })]),
    draft([filesCriterion({ collector: { toolId: 'osv-scanner', paths: ['package-lock.json'] } })]),
    draft([filesCriterion({ evaluation: { kind: 'vulnerabilities', maxFindings: 0 } })]),
    draft([filesCriterion({ evaluation: { kind: 'json-field', field: [], operator: 'exists' } })]),
    draft([filesCriterion({ evaluation: { kind: 'json-field', field: ['name'], operator: 'equals', expected: { arbitrary: 'object' } } as never })]),
    draft([filesCriterion({ collector: { toolId: 'shell' as never, paths: ['package.json'] } })]),
    draft([filesCriterion({ id: '__proto__' })]),
    draft([filesCriterion({ evaluation: { kind: 'builtin', criterionId: 'invented-rule' } })]),
  ];
  const before = engine.listTemplates().length;
  for (const input of invalidDrafts) assert.throws(() => engine.saveTemplate(input), statusError(400));
  assert.equal(engine.listTemplates().length, before);
});

test('file all/any and JSON scalar rules use the configured nested inputs rather than unrelated documents', async t => {
  const f = fixture(t);
  const engine = f.engine();
  writeFileSync(join(f.first, 'docs/review.md'), 'A real reviewed document.');
  writeFileSync(join(f.first, 'docs/config.json'), JSON.stringify({ approvals: { enabled: true }, threshold: 3 }));
  writeFileSync(join(f.second, 'docs/review.md'), 'x');
  writeFileSync(join(f.second, 'docs/config.json'), JSON.stringify({ approvals: { enabled: false }, threshold: 5 }));
  const policy = engine.saveTemplate(draft([
    filesCriterion({ id: 'all-documents', collector: { toolId: 'project-files', paths: ['docs/review.md', 'docs/other.md'] }, evaluation: { kind: 'files', match: 'all', minimumBytes: 10 } }),
    filesCriterion({ id: 'any-document', collector: { toolId: 'project-files', paths: ['docs/review.md', 'docs/other.md'] }, evaluation: { kind: 'files', match: 'any', minimumBytes: 10 } }),
    filesCriterion({ id: 'approval-enabled', collector: { toolId: 'project-files', paths: ['docs/config.json'] }, evaluation: { kind: 'json-field', field: ['approvals', 'enabled'], operator: 'equals', expected: true } }),
    filesCriterion({ id: 'has-threshold', collector: { toolId: 'project-files', paths: ['docs/config.json'] }, evaluation: { kind: 'json-field', field: ['threshold'], operator: 'exists' } }),
  ]));
  const first = await engine.runAssessment({ projectPath: f.first, templateId: policy.id });
  const second = await engine.runAssessment({ projectPath: f.second, templateId: policy.id });
  assert.deepEqual(first.results.map(row => row.status), ['not_satisfied', 'satisfied', 'satisfied', 'satisfied']);
  assert.deepEqual(second.results.map(row => row.status), ['not_satisfied', 'not_satisfied', 'not_satisfied', 'satisfied']);
  assert.ok(first.sourceSnapshot.requestedPaths?.includes('docs/config.json'));
  assert.ok(first.sourceSnapshot.requestedPaths?.includes('docs/other.md'));
});

test('required human review keeps the automatic outcome as evidence when a reviewer disagrees', async t => {
  const f = fixture(t);
  const engine = f.engine();
  writeFileSync(join(f.first, 'docs/review.md'), 'The document exists but can still be judged inadequate.');
  const policy = engine.saveTemplate(draft([filesCriterion({ requiresReview: true })]));
  const run = await engine.runAssessment({ projectPath: f.first, templateId: policy.id });
  assert.equal(run.status, 'awaiting_review');
  assert.equal(run.completedAt, null);
  assert.ok(run.automationCompletedAt);
  assert.equal(run.results[0].status, 'insufficient_evidence');
  assert.equal(run.results[0].automaticResult?.status, 'satisfied');
  const automaticResult = structuredClone(run.results[0].automaticResult);
  const reviewed = engine.submitReview({ runId: run.id, criterionId: 'documentation', reviewer: 'Local policy reviewer', decision: 'not_satisfied', rationale: 'The file exists, but does not explain the required review process.' });
  assert.equal(reviewed.status, 'completed');
  assert.equal(reviewed.results[0].status, 'not_satisfied');
  assert.deepEqual(reviewed.results[0].automaticResult, automaticResult);
  assert.deepEqual(reviewed.evidence, run.evidence);
  assert.equal(reviewed.reviews.length, 1);
  assert.equal(reviewed.revision, 2);
  assert.match(engine.exportReport(run.id, 'json'), /automaticResult/);
  const html = engine.exportReport(run.id, 'html');
  assert.match(html, /Retained automatic finding/);
  assert.match(html, /Selected document bytes/);
  assert.match(html, /Captured template/);
  assert.ok(html.includes(policy.policyDigest));
});

test('JSON field traversal never reads inherited prototype fields and legitimate own keys do not pollute objects', async t => {
  const f = fixture(t);
  const engine = f.engine();
  writeFileSync(join(f.first, 'docs/config.json'), '{"nested":{},"__proto__":{"assessmentPolluted":true},"constructor":{"own":true}}');
  const jsonCriterion = (id: string, field: string[]) => filesCriterion({ id, collector: { toolId: 'project-files', paths: ['docs/config.json'] }, evaluation: { kind: 'json-field', field, operator: 'exists' } });
  const policy = engine.saveTemplate(draft([
    jsonCriterion('inherited-method', ['nested', 'toString']),
    jsonCriterion('inherited-constructor', ['nested', 'constructor', 'name']),
    jsonCriterion('own-special-key', ['__proto__', 'assessmentPolluted']),
    jsonCriterion('own-constructor', ['constructor', 'own']),
  ]));
  const run = await engine.runAssessment({ projectPath: f.first, templateId: policy.id });
  assert.deepEqual(run.results.map(row => row.status), ['not_satisfied', 'not_satisfied', 'satisfied', 'satisfied']);
  assert.equal(Object.hasOwn(Object.prototype, 'assessmentPolluted'), false);
});

test('JSON equality preserves scalar types and distinguishes a present null from a missing field', async t => {
  const f = fixture(t);
  const engine = f.engine();
  writeFileSync(join(f.first, 'docs/config.json'), JSON.stringify({ enabled: false, count: 0, answer: null }));
  const equals = (id: string, field: string, expected: string | number | boolean | null) => filesCriterion({ id, collector: { toolId: 'project-files', paths: ['docs/config.json'] }, evaluation: { kind: 'json-field', field: [field], operator: 'equals', expected } });
  const policy = engine.saveTemplate(draft([
    equals('false-is-false', 'enabled', false),
    equals('zero-is-zero', 'count', 0),
    equals('null-is-null', 'answer', null),
    equals('missing-is-not-null', 'missing', null),
    equals('no-number-coercion', 'count', '0'),
  ]));
  const run = await engine.runAssessment({ projectPath: f.first, templateId: policy.id });
  assert.deepEqual(run.results.map(row => row.status), ['satisfied', 'satisfied', 'satisfied', 'not_satisfied', 'not_satisfied']);
});

test('template and ad-hoc criteria/network settings cannot be mixed into an ambiguous run', async t => {
  const f = fixture(t);
  const engine = f.engine();
  const policy = engine.saveTemplate(draft());
  await assert.rejects(engine.runAssessment({ projectPath: f.first, templateId: policy.id, criterionIds: ['project-metadata'] }), statusError(400));
  await assert.rejects(engine.runAssessment({ projectPath: f.first, templateId: policy.id, networkMode: 'online' }), statusError(400));
  await assert.rejects(engine.runAssessment({ projectPath: f.first, templateId: policy.id, templateVersion: 999 }), statusError(404));
  assert.equal(engine.listRuns().length, 0);
});

test('imported template manifests are republished locally without changing old runs or trusting external version labels', t => {
  const f = fixture(t);
  const source = f.engine();
  const v1 = source.saveTemplate(draft());
  const v2 = source.saveTemplate({ ...draftFrom(v1), id: v1.id, expectedVersion: 1, name: 'Imported policy version two' });
  const destination = f.engine({ dataDir: join(f.root, 'imported-data') });
  const imported = destination.importTemplate(JSON.parse(JSON.stringify(v2)));
  assert.equal(imported.version, 1);
  assert.equal(imported.builtIn, false);
  assert.equal(imported.name, v2.name);
  assert.equal(imported.policyDigest, v2.policyDigest);
  assert.deepEqual(imported.criteria, v2.criteria);
  assert.equal(destination.listTemplateVersions(imported.id).length, 1);
  assert.deepEqual(source.getTemplate(v1.id, 1), v1);
});

test('a valid large published template round-trips through the CLI export and bounded import', t => {
  const f = fixture(t);
  const source = f.engine();
  const criteria = Array.from({ length: 32 }, (_, index) => filesCriterion({ id: `criterion-${index}`, title: `Criterion ${index}`, description: 'x'.repeat(1400) }));
  const saved = source.saveTemplate(draft(criteria));
  const exported = join(f.root, 'portable-template.json');
  const destination = join(f.root, 'roundtrip-data');
  const executable = fileURLToPath(new URL('../bin/assessment.mjs', import.meta.url));
  execFileSync(process.execPath, [executable, 'templates', 'export', saved.id, '--data-dir', f.dataDir, '--output', exported], { encoding: 'utf8' });
  const imported = JSON.parse(execFileSync(process.execPath, [executable, 'templates', 'import', exported, '--data-dir', destination, '--json'], { encoding: 'utf8' })) as TemplateVersion;
  assert.equal(imported.version, 1);
  assert.equal(imported.criteria.length, 32);
  assert.equal(imported.policyDigest, saved.policyDigest);
});

test('import concurrency uses an explicit destination version, never the exported source version', t => {
  const f = fixture(t);
  const source = f.engine();
  const destination = f.engine({ dataDir: join(f.root, 'guarded-import-data') });
  const first = source.saveTemplate(draft());
  const local = destination.importTemplate(first);
  assert.equal(local.version, 1);
  const second = source.saveTemplate({ ...draftFrom(first), id: first.id, expectedVersion: 1, description: 'Source policy version two.' });
  assert.throws(() => destination.importTemplate(second), statusError(409));
  assert.equal(destination.getTemplate(first.id)?.version, 1);
  const imported = destination.importTemplate({ ...second, expectedVersion: 1 });
  assert.equal(imported.version, 2);
  assert.equal(imported.policyDigest, second.policyDigest);
  // Matching source/destination counters still do not authorise an unguarded overwrite.
  assert.throws(() => destination.importTemplate(second), statusError(409));
  assert.throws(() => destination.importTemplate({ ...second, expectedVersion: 1 }), statusError(409));
  assert.equal(destination.listTemplateVersions(first.id).length, 2);
  assert.throws(() => destination.importTemplate({ ...draft(), id: 'not-yet-published', expectedVersion: 1 }), statusError(409));
  assert.equal(destination.getTemplate('not-yet-published'), null);
});

test('configured files are bounded and project-owned scripts do not run during collection', async t => {
  const f = fixture(t);
  const engine = f.engine();
  const marker = join(f.root, 'script-ran');
  writeFileSync(join(f.first, 'package.json'), JSON.stringify({ name: 'passive-project', version: '1.0.0', scripts: { postinstall: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')"` } }));
  writeFileSync(join(f.first, 'docs/review.md'), 'Local bytes only.');
  const policy = engine.saveTemplate(draft());
  const run = await engine.runAssessment({ projectPath: f.first, templateId: policy.id });
  assert.equal(run.results[0].status, 'satisfied');
  assert.equal(existsSync(marker), false);
  writeFileSync(join(f.first, 'docs/review.md'), Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(engine.runAssessment({ projectPath: f.first, templateId: policy.id }), /8 MiB|limit/);
  assert.equal(existsSync(marker), false);
});

test('configured nested symlinks cannot read outside the assessed project', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const engine = f.engine();
  const outside = join(f.root, 'outside.txt');
  writeFileSync(outside, 'Outside the selected project.');
  symlinkSync(outside, join(f.first, 'docs/review.md'));
  const policy = engine.saveTemplate(draft());
  await assert.rejects(engine.runAssessment({ projectPath: f.first, templateId: policy.id }), /outside the selected project/);
});

test('input-path limits count unique configured paths, with package identity retained separately', async t => {
  const f = fixture(t);
  const engine = f.engine();
  const groups = Array.from({ length: 4 }, (_, group) => filesCriterion({ id: `group-${group}`, collector: { toolId: 'project-files', paths: Array.from({ length: 32 }, (_, index) => `docs/file-${group * 32 + index}.md`) } }));
  const accepted = engine.saveTemplate(draft(groups));
  const run = await engine.runAssessment({ projectPath: f.first, templateId: accepted.id });
  assert.equal(run.sourceSnapshot.requestedPaths?.length, 129);
  assert.ok(run.sourceSnapshot.requestedPaths?.includes('package.json'));
  assert.throws(() => engine.saveTemplate(draft([...groups, filesCriterion({ id: 'too-many-paths', collector: { toolId: 'project-files', paths: ['docs/file-128.md'] } })])), statusError(400));
  const reused = Array.from({ length: 5 }, (_, index) => filesCriterion({ id: `reused-${index}`, collector: { toolId: 'project-files', paths: groups[0].collector.paths } }));
  assert.equal(engine.saveTemplate(draft(reused)).criteria.length, 5);
});

test('the total snapshot accepts exactly 32 MiB and rejects one extra byte across individually valid files', async t => {
  const f = fixture(t);
  const engine = f.engine();
  const unit = 8 * 1024 * 1024;
  const manifestSize = readFileSync(join(f.first, 'package.json')).length;
  const paths = Array.from({ length: 4 }, (_, index) => `docs/large-${index}.dat`);
  for (const [index, path] of paths.entries()) writeFileSync(join(f.first, path), Buffer.alloc(index === 3 ? unit - manifestSize : unit, 'a'));
  const policy = engine.saveTemplate(draft([filesCriterion({ collector: { toolId: 'project-files', paths } })]));
  const valid = await engine.runAssessment({ projectPath: f.first, templateId: policy.id });
  assert.equal(valid.sourceSnapshot.files.reduce((sum, file) => sum + file.bytes, 0), 32 * 1024 * 1024);
  assert.equal(valid.results[0].status, 'satisfied');
  appendFileSync(join(f.first, paths[3]), 'b');
  await assert.rejects(engine.runAssessment({ projectPath: f.first, templateId: policy.id }), /32 MiB total snapshot limit/);
  assert.equal(engine.listRuns().length, 1);
});

test('published policy rows are immutable and corruption of derived rule metadata fails the read integrity check', t => {
  const f = fixture(t);
  const engine = f.engine();
  const saved = engine.saveTemplate(draft());
  const db = new DatabaseSync(join(f.dataDir, 'assessment.sqlite'));
  try {
    assert.throws(() => db.prepare('UPDATE template_versions SET payload=? WHERE template_id=? AND version=1').run('{}', saved.id), /immutable/i);
    assert.throws(() => db.prepare('DELETE FROM template_versions WHERE template_id=?').run(saved.id), /immutable/i);
    assert.deepEqual(engine.getTemplate(saved.id), saved);
    // Only this isolated test removes the normal write barrier to simulate damaged storage.
    db.exec('DROP TRIGGER immutable_template_update');
    const changed = structuredClone(saved);
    changed.criteria[0].rule = 'Forged: always satisfied.';
    changed.criteria[0].mode = 'expert';
    db.prepare('UPDATE template_versions SET payload=? WHERE template_id=? AND version=1').run(JSON.stringify(changed), saved.id);
    assert.throws(() => engine.getTemplate(saved.id), statusError(409));
  } finally { db.close(); }
});

test('report export rejects changed retained policies, criteria, profile or framework identity', async t => {
  const f = fixture(t);
  const engine = f.engine();
  writeFileSync(join(f.first, 'docs/review.md'), 'Evidence for a report integrity test.');
  const policy = engine.saveTemplate(draft());
  const run = await engine.runAssessment({ projectPath: f.first, templateId: policy.id });
  const changes = [
    (changed: typeof run) => { changed.template!.name = 'Forged policy identity'; },
    (changed: typeof run) => { changed.criteria[0].rule = 'Forged report rule'; },
    (changed: typeof run) => { changed.framework.version = '999'; },
    (changed: typeof run) => { changed.networkMode = 'online'; },
  ];
  const db = new DatabaseSync(join(f.dataDir, 'assessment.sqlite'));
  try {
    for (const change of changes) {
      const changed = structuredClone(run);
      change(changed);
      db.prepare('UPDATE runs SET payload=? WHERE id=?').run(JSON.stringify(changed), run.id);
      assert.throws(() => engine.exportReport(run.id, 'json'), statusError(409));
      assert.throws(() => engine.exportReport(run.id, 'html'), statusError(409));
    }
    db.prepare('UPDATE runs SET payload=? WHERE id=?').run(JSON.stringify(run), run.id);
    assert.equal(JSON.parse(engine.exportReport(run.id, 'json')).template.policyDigest, policy.policyDigest);
  } finally { db.close(); }
});

test('custom vulnerability thresholds apply to real retained scanner output rather than rewriting its findings', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const executable = join(f.root, 'known-test-scanner.mjs');
  const argsFile = join(f.root, 'scanner-args.json');
  const output = { results: [{ packages: [{ package: { name: 'example', version: '1.0.0', ecosystem: 'npm' }, vulnerabilities: [{ id: 'LOCAL-TEST-ADVISORY' }] }] }] };
  writeFileSync(executable, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nif(process.argv.includes('--version')){console.log('osv-scanner version: 2.6.0');process.exit(0);}\nwriteFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(JSON.stringify(output))});\nprocess.exit(1);\n`);
  chmodSync(executable, 0o700);
  const engine = f.engine({ osvExecutable: executable });
  const criterion = (maxFindings: number): TemplateCriterionInput => filesCriterion({ id: 'vulnerability-policy', collector: { toolId: 'osv-scanner', paths: ['package-lock.json'] }, evaluation: { kind: 'vulnerabilities', maxFindings } });
  const strict = engine.saveTemplate(draft([criterion(0)]));
  const tolerant = engine.saveTemplate(draft([criterion(1)]));
  const strictRun = await engine.runAssessment({ projectPath: f.first, templateId: strict.id });
  const tolerantRun = await engine.runAssessment({ projectPath: f.first, templateId: tolerant.id });
  assert.equal(strictRun.results[0].status, 'not_satisfied');
  assert.equal(tolerantRun.results[0].status, 'satisfied');
  const raw = tolerantRun.evidence.find(record => record.source === 'OSV JSON output');
  assert.ok(raw);
  assert.deepEqual(JSON.parse(engine.readEvidence(tolerantRun.id, raw.id).toString()), output);
  const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
  assert.ok(args.includes('--offline'));
  assert.ok(args.includes('--no-call-analysis=go'));
  assert.ok(args.find(arg => arg.startsWith('--lockfile='))?.includes('/runs/'));
});
