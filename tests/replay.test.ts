import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { graphFromStructure, overlayFromSnapshot, toVisualizationSnapshots } from 'footprint-explainable-ui';
import type { NarrativeEntry } from 'footprint-explainable-ui';
import { AssessmentEngine } from '../src/core.ts';
import type { AssessmentRun, TemplateCriterionInput, WorkflowRecording } from '../src/types.ts';
import { measuredTimelineSteps } from '../client/replay-timing.ts';

function fixture(t: { after: (callback: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'assessment-replay-'));
  const project = join(root, 'project');
  const dataDir = join(root, 'data');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'replay-fixture', version: '1.0.0' }));
  writeFileSync(join(project, 'README.md'), 'A real input retained for the assessment.');
  writeFileSync(join(project, 'package-lock.json'), JSON.stringify({ name: 'replay-fixture', lockfileVersion: 3, packages: { '': { name: 'replay-fixture', version: '1.0.0' }, 'node_modules/example': { version: '1.0.0' } } }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function engine(options: { osvExecutable?: string } = {}) {
    const value = new AssessmentEngine({ dataDir, osvExecutable: join(root, 'unavailable-scanner'), ...options });
    t.after(() => value.close());
    return value;
  }
  return { root, project, dataDir, engine };
}

function replay(engine: AssessmentEngine, runId: string): WorkflowRecording {
  const response = engine.getWorkflow(runId);
  assert.equal(response.kind, 'replay');
  if (response.kind !== 'replay') throw new Error('Expected a complete recording.');
  return response.recording;
}

function statusError(code: number) {
  return (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && error.status === code);
}

function replaceArtifact(dataDir: string, original: AssessmentRun, payload: unknown, rawBytes?: Buffer) {
  const run = structuredClone(original);
  const evidence = run.evidence.find(item => item.source === 'Recorded assessment workflow');
  assert.ok(evidence);
  const bytes = rawBytes ?? Buffer.from(JSON.stringify(payload));
  writeFileSync(join(dataDir, evidence.rawArtifactRef), bytes);
  evidence.sha256 = createHash('sha256').update(bytes).digest('hex');
  evidence.bytes = bytes.length;
  const db = new DatabaseSync(join(dataDir, 'assessment.sqlite'));
  try { db.prepare('UPDATE runs SET payload=? WHERE id=?').run(JSON.stringify(run), run.id); }
  finally { db.close(); }
}

test('a real assessment replays the exact chart and criterion order through the installed adapters', async t => {
  const f = fixture(t);
  const engine = f.engine();
  const criteria = ['project-metadata', 'security-policy', 'dependency-lockfile'];
  const run = await engine.runAssessment({ projectPath: f.project, criterionIds: criteria });
  const recording = replay(engine, run.id);
  assert.equal(recording.schemaVersion, 1);
  assert.equal(recording.recorder, 'footprintjs');
  const installedVersion = createRequire(import.meta.url)('footprintjs/package.json').version;
  assert.equal(recording.version, installedVersion);
  assert.equal(run.evidence.find(item => item.source === 'Recorded assessment workflow')?.toolVersion, installedVersion);
  assert.equal(recording.scope, 'automated-evaluation');
  assert.equal(recording.assessmentId, run.id);
  assert.equal(recording.policyDigest, run.framework.policyDigest);
  assert.equal(recording.sourceDigest, run.sourceSnapshot.digest);
  const expected = ['_freeze-inputs', ...criteria];
  const graph = graphFromStructure(recording.structure);
  const snapshots = toVisualizationSnapshots(recording.snapshot, recording.narrativeEntries as NarrativeEntry[]);
  const overlay = overlayFromSnapshot(recording.snapshot, { narrativeEntries: recording.narrativeEntries as NarrativeEntry[] });
  assert.deepEqual(graph.nodes.map(node => node.id), expected);
  assert.deepEqual(graph.edges.map(edge => [edge.source, edge.target]), expected.slice(1).map((id, index) => [expected[index], id]));
  assert.deepEqual(snapshots.map(snapshot => snapshot.stageLabel), expected);
  assert.deepEqual(overlay.executionOrder.map(step => step.stageId), expected);
  assert.equal(new Set(overlay.executionOrder.map(step => step.runtimeStageId)).size, expected.length);
  assert.deepEqual(snapshots.map(snapshot => snapshot.runtimeStageId), overlay.executionOrder.map(step => step.runtimeStageId));
  assert.deepEqual(snapshots[0].memory.findings, []);
  assert.equal(snapshots[0].memory.subjectDigest, run.sourceSnapshot.digest);
  for (let index = 1; index < snapshots.length; index++) {
    const expectedFindings = run.results.slice(0, index).map(row => ({ criterionId: row.criterionId, status: row.status, evidenceIds: row.evidenceIds }));
    assert.deepEqual(snapshots[index].memory.findings, expectedFindings);
    assert.equal(snapshots[index].memory.activeCriterion, criteria[index - 1]);
    assert.deepEqual(snapshots[index - 1].memory.findings, expectedFindings.slice(0, -1));
  }
  assert.deepEqual(snapshots.at(-1)?.memory, recording.snapshot.sharedState);
  assert.ok(recording.narrativeEntries.length > 0);
  assert.ok(snapshots.every(snapshot => snapshot.narrative.length > 0));
  assert.equal(overlay.running, false);
  assert.equal(overlay.errors.size, 0);
  assert.ok(overlay.executionOrder.every(step => step.timestampMs === 0));
  // Execution completion and assessment satisfaction are separate facts.
  assert.equal(run.status, 'completed');
  assert.equal(run.results.find(row => row.criterionId === 'security-policy')?.status, 'not_satisfied');
  assert.ok(snapshots.every(snapshot => snapshot.status === 'done'));
});

test('measured asynchronous scanner duration survives recording and replay without rerunning the tool', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const callsPath = join(f.root, 'scanner-calls.txt');
  const executable = join(f.root, 'known-replay-scanner.mjs');
  const output = { results: [{ packages: [{ package: { name: 'example', version: '1.0.0', ecosystem: 'npm' }, vulnerabilities: [] }] }] };
  writeFileSync(executable, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nif(process.argv.includes('--version')){console.log('osv-scanner version: 2.6.0');process.exit(0);}\nappendFileSync(${JSON.stringify(callsPath)},'scan\\n');\nawait new Promise(resolve=>setTimeout(resolve,60));\nconsole.log(${JSON.stringify(JSON.stringify(output))});\n`);
  chmodSync(executable, 0o700);
  const engine = f.engine({ osvExecutable: executable });
  const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['dependency-vulnerabilities'] });
  const recording = replay(engine, run.id);
  const snapshots = toVisualizationSnapshots(recording.snapshot, recording.narrativeEntries as NarrativeEntry[]);
  const metricRecorder = recording.snapshot.recorders?.find(recorder => recorder.name === 'Metrics');
  assert.ok(metricRecorder, 'The metrics recorder must have been attached before traversal.');
  const metricData = metricRecorder.data as { steps: Record<string, { duration: number }> };
  assert.deepEqual(Object.keys(metricData.steps), snapshots.map(snapshot => snapshot.runtimeStageId));
  for (const snapshot of snapshots) {
    const duration = metricData.steps[snapshot.runtimeStageId!]?.duration;
    assert.ok(Number.isFinite(duration) && duration >= 0);
    assert.equal(snapshot.durationMs, duration > 0 ? Math.round(duration) : 0);
  }
  assert.ok(snapshots[1].durationMs >= 40, 'The observed scanner wait belongs to the recorded criterion stage.');
  assert.equal(snapshots[1].startMs, snapshots[0].durationMs);
  const withoutMetrics = structuredClone(recording.snapshot);
  withoutMetrics.recorders = withoutMetrics.recorders?.filter(recorder => recorder.name !== 'Metrics');
  assert.ok(toVisualizationSnapshots(withoutMetrics, recording.narrativeEntries as NarrativeEntry[]).every(snapshot => snapshot.durationMs === 0));
  writeFileSync(join(f.project, 'package-lock.json'), 'The project has since changed.');
  assert.deepEqual(engine.getWorkflow(run.id), engine.getWorkflow(run.id));
  assert.equal(readFileSync(callsPath, 'utf8'), 'scan\n');
  const workflowEvidence = run.evidence.find(item => item.source === 'Recorded assessment workflow');
  assert.ok(workflowEvidence);
  writeFileSync(join(f.dataDir, workflowEvidence.rawArtifactRef), '{"tampered":true}');
  assert.throws(() => engine.getWorkflow(run.id), statusError(409));
  assert.equal(readFileSync(callsPath, 'utf8'), 'scan\n');
});

test('human judgment changes the current finding while retaining the original automation replay byte for byte', async t => {
  const f = fixture(t);
  const engine = f.engine();
  const criterion: TemplateCriterionInput = { id: 'readme-review', title: 'Readme review', description: 'Presence followed by a separate quality judgment.', dimension: 'Documentation', evidenceRequirements: ['Useful project guidance'], collector: { toolId: 'project-files', paths: ['README.md'] }, evaluation: { kind: 'files', match: 'all', minimumBytes: 1 }, requiresReview: true };
  const template = engine.saveTemplate({ name: 'Reviewed documentation', description: 'A replay regression policy.', networkMode: 'offline', criteria: [criterion] });
  const run = await engine.runAssessment({ projectPath: f.project, templateId: template.id });
  const recording = replay(engine, run.id);
  const evidence = run.evidence.find(item => item.source === 'Recorded assessment workflow');
  assert.ok(evidence);
  const originalBytes = engine.readEvidence(run.id, evidence.id);
  assert.equal(run.results[0].automaticResult?.status, 'satisfied');
  const reviewed = engine.submitReview({ runId: run.id, criterionId: criterion.id, reviewer: 'Local reviewer', decision: 'not_satisfied', rationale: 'The document is present, but its explanation does not meet the stated requirement.' });
  assert.equal(reviewed.results[0].status, 'not_satisfied');
  assert.equal(reviewed.results[0].automaticResult?.status, 'satisfied');
  assert.equal(reviewed.revision, run.revision + 1);
  assert.deepEqual(engine.readEvidence(run.id, evidence.id), originalBytes);
  assert.deepEqual(replay(engine, run.id), recording);
  const snapshots = toVisualizationSnapshots(recording.snapshot, recording.narrativeEntries as NarrativeEntry[]);
  assert.deepEqual(snapshots.at(-1)?.memory.findings, [{ criterionId: criterion.id, status: 'insufficient_evidence', evidenceIds: run.results[0].evidenceIds }]);
});

test('earlier flat artifacts and absent recordings receive honest fallbacks without invented chart data', async t => {
  const f = fixture(t);
  const engine = f.engine();
  const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['project-metadata'] });
  const recording = replay(engine, run.id);
  const snapshot = recording.snapshot;
  replaceArtifact(f.dataDir, run, { recorder: 'footprintjs', version: '9.44.1', runId: snapshot.runId, sharedState: snapshot.sharedState, commitLog: snapshot.commitLog, commitValues: snapshot.commitValues, writeProvenance: snapshot.writeProvenance, narrative: recording.narrativeEntries });
  const legacy = engine.getWorkflow(run.id);
  assert.equal(legacy.kind, 'legacy');
  if (legacy.kind !== 'legacy') throw new Error('Expected an earlier-format fallback.');
  assert.match(legacy.note, /did not record.*execution tree.*chart structure.*timings/);
  assert.deepEqual(legacy.narrativeEntries, recording.narrativeEntries);
  assert.equal(Object.hasOwn(legacy, 'recording'), false);
  const missing = structuredClone(run);
  missing.evidence = missing.evidence.filter(item => item.source !== 'Recorded assessment workflow');
  const db = new DatabaseSync(join(f.dataDir, 'assessment.sqlite'));
  try { db.prepare('UPDATE runs SET payload=? WHERE id=?').run(JSON.stringify(missing), run.id); }
  finally { db.close(); }
  const unavailable = engine.getWorkflow(run.id);
  assert.equal(unavailable.kind, 'unavailable');
  assert.equal(Object.hasOwn(unavailable, 'recording'), false);
  assert.equal(engine.listRuns().length, 1);
  assert.throws(() => engine.getWorkflow('not-a-run'), statusError(404));
});

test('a hash-consistent artifact still cannot replay against a different assessment, policy or input set', async t => {
  const f = fixture(t);
  const engine = f.engine();
  const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['project-metadata'] });
  const recording = replay(engine, run.id);
  for (const key of ['assessmentId', 'policyDigest', 'sourceDigest'] as const) {
    const corrupted = structuredClone(recording);
    corrupted[key] = 'unrelated-recording';
    replaceArtifact(f.dataDir, run, corrupted);
    assert.throws(() => engine.getWorkflow(run.id), statusError(409));
  }
  for (const incomplete of [ { ...recording, schemaVersion: 2 }, { ...recording, structure: undefined }, { ...recording, snapshot: { ...recording.snapshot, executionTree: undefined } }, { ...recording, narrativeEntries: null } ]) {
    replaceArtifact(f.dataDir, run, incomplete);
    assert.throws(() => engine.getWorkflow(run.id), statusError(409));
  }
  replaceArtifact(f.dataDir, run, recording);
  assert.deepEqual(replay(engine, run.id), recording);
});

test('hash-checked replay rejects malformed JSON and oversized recordings without changing the run', async t => {
  const f = fixture(t);
  const engine = f.engine();
  const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['project-metadata'] });
  const recording = replay(engine, run.id);
  replaceArtifact(f.dataDir, run, null, Buffer.from('{"unfinished":'));
  assert.throws(() => engine.getWorkflow(run.id), statusError(409));
  replaceArtifact(f.dataDir, run, { ...recording, padding: 'x'.repeat(8 * 1024 * 1024) });
  assert.throws(() => engine.getWorkflow(run.id), statusError(409));
  assert.equal(engine.getRun(run.id)?.revision, run.revision);
  assert.deepEqual(engine.getRun(run.id)?.results, run.results);
  assert.equal(engine.listRuns().length, 1);
  replaceArtifact(f.dataDir, run, recording);
  assert.deepEqual(replay(engine, run.id), recording);
});

test('replay checks actual sparse-file size before reading despite stale small evidence metadata', async t => {
  const f = fixture(t);
  const engine = f.engine();
  const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['project-metadata'] });
  const evidence = run.evidence.find(item => item.source === 'Recorded assessment workflow');
  assert.ok(evidence && evidence.bytes < 8 * 1024 * 1024);
  const path = join(f.dataDir, evidence.rawArtifactRef);
  const handle = openSync(path, 'r+');
  try { ftruncateSync(handle, 8 * 1024 * 1024 + 1); }
  finally { closeSync(handle); }
  assert.equal(statSync(path).size, 8 * 1024 * 1024 + 1);
  assert.equal(engine.getRun(run.id)?.evidence.find(item => item.id === evidence.id)?.bytes, evidence.bytes);
  // A hash failure would mean it reached content reading; the size failure must take precedence.
  assert.throws(() => engine.getWorkflow(run.id), (error: unknown) => statusError(409)(error) && error instanceof Error && /8 MiB replay size/.test(error.message));
  assert.equal(engine.getRun(run.id)?.revision, run.revision);
});

function controlledMetrics(recording: WorkflowRecording, durations: unknown[]) {
  const copy = structuredClone(recording);
  const snapshots = toVisualizationSnapshots(copy.snapshot, copy.narrativeEntries as NarrativeEntry[]);
  const metrics = copy.snapshot.recorders?.find(recorder => recorder.name === 'Metrics');
  assert.ok(metrics);
  const data = metrics.data as { steps: Record<string, Record<string, unknown>> };
  assert.equal(durations.length, snapshots.length);
  for (const [index, snapshot] of snapshots.entries()) {
    assert.ok(snapshot.runtimeStageId && Object.hasOwn(data.steps, snapshot.runtimeStageId));
    data.steps[snapshot.runtimeStageId] = { ...data.steps[snapshot.runtimeStageId], duration: durations[index] };
  }
  return copy;
}

test('timeline presentation retains actual metrics and positive fractional durations beyond the adapter rounding', async t => {
  const f = fixture(t);
  const engine = f.engine();
  const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['project-metadata', 'security-policy', 'dependency-lockfile'] });
  const recording = replay(engine, run.id);
  const snapshots = toVisualizationSnapshots(recording.snapshot, recording.narrativeEntries as NarrativeEntry[]);
  const originalRecording = structuredClone(recording);
  const originalSnapshots = structuredClone(snapshots);
  const actual = measuredTimelineSteps(snapshots, { snapshot: recording.snapshot });
  assert.equal(actual.measured, true);
  const data = recording.snapshot.recorders!.find(recorder => recorder.name === 'Metrics')!.data as { steps: Record<string, { duration: number }> };
  let offset = 0;
  for (const step of actual.steps) {
    const duration = Number(data.steps[step.runtimeStageId!].duration.toPrecision(4));
    assert.equal(step.durationMs, duration);
    assert.equal(step.startMs, offset);
    offset += duration;
  }
  assert.deepEqual(recording, originalRecording);
  assert.deepEqual(snapshots, originalSnapshots);
  // A controlled timing fixture keeps this real engine recording's tree, commits and state.
  const fractional = controlledMetrics(recording, [0.123456, 0.007654321, 0.00019876, 0.3333333]);
  const fractionalSnapshots = toVisualizationSnapshots(fractional.snapshot, fractional.narrativeEntries as NarrativeEntry[]);
  assert.ok(fractionalSnapshots.every(step => step.durationMs === 0), 'The installed state adapter rounds these measurements to zero.');
  const frozenFractional = structuredClone(fractional);
  const frozenSnapshots = structuredClone(fractionalSnapshots);
  const presented = measuredTimelineSteps(fractionalSnapshots, { snapshot: fractional.snapshot });
  assert.equal(presented.measured, true);
  const expected = [0.1235, 0.007654, 0.0001988, 0.3333];
  assert.deepEqual(presented.steps.map(step => step.durationMs), expected);
  offset = 0;
  for (const [index, step] of presented.steps.entries()) {
    assert.equal(step.startMs, offset);
    assert.ok(step.durationMs > 0 && step.durationMs < 1);
    assert.deepEqual(step.memory, fractionalSnapshots[index].memory);
    assert.equal(step.runtimeStageId, fractionalSnapshots[index].runtimeStageId);
    assert.notEqual(step, fractionalSnapshots[index]);
    offset += expected[index];
  }
  assert.deepEqual(fractional, frozenFractional);
  assert.deepEqual(fractionalSnapshots, frozenSnapshots);
  assert.deepEqual(replay(engine, run.id), originalRecording);
});

test('a recorded zero duration remains measured rather than being mistaken for missing timing', async t => {
  const f = fixture(t);
  const engine = f.engine();
  const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['project-metadata', 'dependency-lockfile'] });
  const recording = replay(engine, run.id);
  const zeros = controlledMetrics(recording, [0, 0, 0]);
  const snapshots = toVisualizationSnapshots(zeros.snapshot, zeros.narrativeEntries as NarrativeEntry[]);
  const allZero = measuredTimelineSteps(snapshots, { snapshot: zeros.snapshot });
  assert.equal(allZero.measured, true);
  assert.deepEqual(allZero.steps.map(step => [step.startMs, step.durationMs]), [[0, 0], [0, 0], [0, 0]]);
  const mixed = controlledMetrics(recording, [0, 0.0123456, 0]);
  const mixedSnapshots = toVisualizationSnapshots(mixed.snapshot, mixed.narrativeEntries as NarrativeEntry[]);
  const presented = measuredTimelineSteps(mixedSnapshots, { snapshot: mixed.snapshot });
  assert.equal(presented.measured, true);
  assert.deepEqual(presented.steps.map(step => [step.startMs, step.durationMs]), [[0, 0], [0, 0.01235], [0.01235, 0]]);
  assert.deepEqual(allZero.steps.map(step => step.memory), snapshots.map(step => step.memory));
});

test('missing, partial and invalid metrics use untimed order placeholders without changing replay state', async t => {
  const f = fixture(t);
  const engine = f.engine();
  const run = await engine.runAssessment({ projectPath: f.project, criterionIds: ['project-metadata', 'dependency-lockfile'] });
  const recording = replay(engine, run.id);
  const snapshots = toVisualizationSnapshots(recording.snapshot, recording.narrativeEntries as NarrativeEntry[]);
  const frozenSnapshots = structuredClone(snapshots);
  const missing = structuredClone(recording);
  missing.snapshot.recorders = missing.snapshot.recorders?.filter(recorder => recorder.name !== 'Metrics');
  const partial = structuredClone(recording);
  const partialData = partial.snapshot.recorders!.find(recorder => recorder.name === 'Metrics')!.data as { steps: Record<string, unknown> };
  delete partialData.steps[snapshots[1].runtimeStageId!];
  const invalid = [-1, NaN, Infinity, '0.5', null, undefined, {}].map(duration => controlledMetrics(recording, [0.25, duration, 0.25]));
  for (const candidate of [null, missing, partial, ...invalid]) {
    const before = structuredClone(candidate);
    const presented = measuredTimelineSteps(snapshots, candidate ? { snapshot: candidate.snapshot } : null);
    assert.equal(presented.measured, false);
    assert.deepEqual(presented.steps.map(step => [step.startMs, step.durationMs]), snapshots.map(() => [0, 0]));
    assert.deepEqual(presented.steps.map(step => step.runtimeStageId), snapshots.map(step => step.runtimeStageId));
    assert.deepEqual(presented.steps.map(step => step.memory), snapshots.map(step => step.memory));
    assert.deepEqual(candidate, before);
    assert.deepEqual(snapshots, frozenSnapshots);
  }
  assert.equal(measuredTimelineSteps([], { snapshot: recording.snapshot }).measured, false);
});
