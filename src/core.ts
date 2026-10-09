import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, realpathSync, lstatSync, statSync, existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, basename, sep } from 'node:path';
import { FlowChartExecutor } from 'footprintjs';
import { metrics } from 'footprintjs/recorders';
import type { AssessmentRun, CriterionDefinition, CriterionResult, CriterionStatus, EvidenceRecord, ProjectInfo, ReviewInput, RunEvent, RunInput, RunSummary, ToolDefinition, TemplateDraft, TemplateVersion, TemplateSummary, TemplateCriterion, WorkflowRecording, WorkflowResponse, FlowSelection, FlowPreviewInput, FlowPreview, SourceImportInput, SourceImportResult } from './types.ts';
import { AssessmentError } from './errors.ts';
export { AssessmentError } from './errors.ts';
import { builtInTemplate, DEFAULT_TEMPLATE_ID, generatedTemplateId, normalizeTemplateDraft, policyDigest, templateIdentifier, templateInputPaths } from './templates.ts';
import { buildAssessmentChart, INITIALIZE_STAGE_ID } from './chart.ts';
import { SourceImporter } from './source-import.ts';
import type { SourceFetch, SourceLimits } from './source-import.ts';

const execFileAsync = promisify(execFile);
const VERSION = '0.3.0';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_REPLAY_BYTES = 8 * 1024 * 1024;
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];
const INPUT_FILES = ['package.json', ...LOCKFILES, 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'SECURITY.md', '.github/SECURITY.md', 'GOVERNANCE.md', '.github/GOVERNANCE.md', 'CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'README.md'];
const CATALOG: CriterionDefinition[] = [
  { id: 'project-metadata', title: 'Package identity', dimension: 'Project identity', mode: 'automatic', defaultEnabled: true, description: 'A readable package manifest identifies the assessed Node.js package.', rule: 'A valid package.json declares a non-empty name and version. This is an identity check, not a maturity assessment.', evidenceRequirements: ['package.json'] },
  { id: 'license-evidence', title: 'Licence documentation', dimension: 'Licence & legal evidence', mode: 'automatic', defaultEnabled: true, description: 'The project makes its licence declaration and licence document available.', rule: 'A non-empty licence declaration and a non-empty root licence document are both present. Compatibility and legal validity require separate review.', evidenceRequirements: ['package.json licence declaration', 'Root licence document'] },
  { id: 'security-policy', title: 'Security policy availability', dimension: 'Security practices', mode: 'automatic', defaultEnabled: true, description: 'A security policy is available for a reviewer to inspect.', rule: 'A non-empty SECURITY.md is present at the root or under .github. Its presence does not establish an effective reporting process.', evidenceRequirements: ['SECURITY.md or .github/SECURITY.md'] },
  { id: 'dependency-lockfile', title: 'Dependency inventory input', dimension: 'Supply-chain evidence', mode: 'automatic', defaultEnabled: true, description: 'A supported root lockfile is available for dependency assessment.', rule: 'At least one readable, non-empty supported root lockfile exists. JSON lockfiles must parse successfully. This does not establish a reproducible build.', evidenceRequirements: LOCKFILES },
  { id: 'dependency-vulnerabilities', title: 'Known dependency vulnerabilities', dimension: 'Dependency security', mode: 'automatic', defaultEnabled: true, description: 'OSV checks the frozen root lockfile against available advisory data.', rule: 'A successful OSV v2 scan reporting known vulnerabilities is not satisfied; a successful scan of identified packages reporting none is satisfied within its documented scope. Unavailable tools or data remain insufficient evidence.', evidenceRequirements: ['Supported root lockfile', 'OSV-Scanner v2', 'Advisory data'] },
  { id: 'governance-review', title: 'Governance transparency review', dimension: 'Governance & stewardship', mode: 'expert', defaultEnabled: true, description: 'A human assesses how project decisions and contribution processes are documented.', rule: 'Review available governance and contribution documents, identify who makes decisions and how contributors participate, and provide a rationale. Document availability alone never satisfies this criterion.', evidenceRequirements: ['Governance or contribution documentation', 'Attributed reviewer decision and rationale'] },
];
type CapturedFile = { path: string; bytes: Buffer; sha256: string };

function sha(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function stamp(): string { return new Date().toISOString(); }
function plainError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function escapeHtml(value: unknown): string { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
function counts(run: AssessmentRun): Record<CriterionStatus, number> {
  const result: Record<CriterionStatus, number> = { satisfied: 0, not_satisfied: 0, insufficient_evidence: 0, not_applicable: 0, evaluation_error: 0 };
  for (const row of run.results) result[row.status]++;
  return result;
}
function parseManifest(file?: CapturedFile): Record<string, unknown> | null {
  if (!file) return null;
  try { const value = JSON.parse(file.bytes.toString('utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
}
function labelManifest(manifest: Record<string, unknown> | null, field: string): string | null {
  const value = manifest?.[field]; return typeof value === 'string' && value.trim() ? value.trim() : null;
}


function processExists(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || !pid || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function validOsvPackages(payload: unknown): Array<{ package: { name: string; version: string; ecosystem: string }; vulnerabilities?: Array<{ id: string }> }> | null {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { results?: unknown }).results)) return null;
  const packages: Array<{ package: { name: string; version: string; ecosystem: string }; vulnerabilities?: Array<{ id: string }> }> = [];
  for (const result of (payload as { results: unknown[] }).results) {
    if (!result || typeof result !== 'object' || !Array.isArray((result as { packages?: unknown }).packages)) return null;
    for (const candidate of (result as { packages: unknown[] }).packages) {
      if (!candidate || typeof candidate !== 'object') return null;
      const record = candidate as { package?: Record<string, unknown>; vulnerabilities?: unknown };
      const identity = record.package;
      if (!identity || ['name', 'version', 'ecosystem'].some(key => typeof identity[key] !== 'string' || !(identity[key] as string).trim())) return null;
      if (record.vulnerabilities !== undefined && (!Array.isArray(record.vulnerabilities) || record.vulnerabilities.some(v => !v || typeof v !== 'object' || typeof v.id !== 'string' || !v.id.trim()))) return null;
      packages.push(candidate as typeof packages[number]);
    }
  }
  return packages;
}

export class AssessmentEngine {
  readonly dataDir: string;
  private db: DatabaseSync;
  private active = false;
  private osvExecutable: string;
  private readonly sourceImporter: SourceImporter;
  private importing = false;

  constructor(options: { dataDir: string; osvExecutable?: string; sourceFetch?: SourceFetch; sourceLimits?: Partial<SourceLimits> }) {
    this.dataDir = resolve(options.dataDir);
    this.osvExecutable = options.osvExecutable ?? 'osv-scanner';
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.dataDir, 'runs'), { recursive: true, mode: 0o700 });
    this.sourceImporter = new SourceImporter(this.dataDir, { fetch: options.sourceFetch, limits: options.sourceLimits, validateProject: async path => { await this.capture(await realpath(path)); } });
    this.db = new DatabaseSync(join(this.dataDir, 'assessment.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, payload TEXT NOT NULL);');
    this.db.exec(`CREATE TABLE IF NOT EXISTS template_versions (template_id TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, policy_digest TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(template_id, version));
      CREATE TRIGGER IF NOT EXISTS immutable_template_update BEFORE UPDATE ON template_versions BEGIN SELECT RAISE(ABORT, 'Published template versions are immutable.'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_template_delete BEFORE DELETE ON template_versions BEGIN SELECT RAISE(ABORT, 'Published template versions are immutable.'); END;`);
    const initialTemplate = builtInTemplate(CATALOG);
    this.db.prepare('INSERT OR IGNORE INTO template_versions VALUES(?,?,?,?,?)').run(initialTemplate.id, initialTemplate.version, initialTemplate.createdAt, initialTemplate.policyDigest, JSON.stringify(initialTemplate));
    for (const row of this.db.prepare('SELECT payload FROM runs').all() as Array<{ payload: string }>) {
      const previous = JSON.parse(row.payload) as AssessmentRun;
      if (previous.status === 'running' && !processExists(previous.execution?.ownerPid)) {
        previous.status = 'interrupted';
        previous.completedAt = stamp();
        previous.limitations.push('The process that owned this run exited before finalisation. Start a new assessment; completed evidence has been retained.');
        previous.events.push({ type: 'run_interrupted', message: 'Recovered an interrupted assessment after its owning process exited.', timestamp: stamp() });
        this.save(previous);
      }
    }
  }

  getCatalog(): CriterionDefinition[] { return structuredClone(CATALOG); }

  listTemplates(): TemplateSummary[] {
    const rows = this.db.prepare('SELECT template_id, MAX(version) AS latest, COUNT(*) AS count FROM template_versions GROUP BY template_id ORDER BY template_id').all() as Array<{ template_id: string; latest: number; count: number }>;
    return rows.map(row => {
      const value = this.getTemplate(row.template_id, row.latest)!;
      return { id: value.id, name: value.name, description: value.description, latestVersion: value.version, versionCount: row.count, updatedAt: value.createdAt, policyDigest: value.policyDigest, builtIn: value.builtIn };
    });
  }

  getTemplate(id: string, version?: number): TemplateVersion | null {
    templateIdentifier(id);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new AssessmentError(400, 'Template version must be a positive integer.');
    const row = (version === undefined ? this.db.prepare('SELECT version,policy_digest,payload FROM template_versions WHERE template_id=? ORDER BY version DESC LIMIT 1').get(id) : this.db.prepare('SELECT version,policy_digest,payload FROM template_versions WHERE template_id=? AND version=?').get(id, version)) as { version: number; policy_digest: string; payload: string } | undefined;
    if (!row) return null;
    try {
      const template = JSON.parse(row.payload) as TemplateVersion;
      const normalized = normalizeTemplateDraft(template, CATALOG);
      if (template.id !== id || template.version !== row.version || template.policyDigest !== row.policy_digest || policyDigest(normalized) !== row.policy_digest || policyDigest(template) !== row.policy_digest) throw new Error('Policy digest mismatch.');
      if (template.builtIn !== (id === DEFAULT_TEMPLATE_ID)) throw new Error('Template origin mismatch.');
      return structuredClone(template);
    } catch { throw new AssessmentError(409, 'The saved template failed its policy integrity check.'); }
  }

  listTemplateVersions(id: string): Array<{ version: number; createdAt: string; policyDigest: string }> {
    templateIdentifier(id);
    const rows = this.db.prepare('SELECT version FROM template_versions WHERE template_id=? ORDER BY version DESC').all(id) as Array<{ version: number }>;
    return rows.map(row => { const version = this.getTemplate(id, row.version)!; return { version: version.version, createdAt: version.createdAt, policyDigest: version.policyDigest }; });
  }

  saveTemplate(input: unknown): TemplateVersion {
    const draft = normalizeTemplateDraft(input, CATALOG);
    if (draft.id === DEFAULT_TEMPLATE_ID) throw new AssessmentError(409, 'The built-in template is read-only. Make a copy to publish your own template.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const id = draft.id ?? generatedTemplateId();
      const previous = this.getTemplate(id);
      if (previous && draft.expectedVersion !== previous.version) throw new AssessmentError(409, 'This template has changed. Load its latest version before publishing an edit.');
      if (!previous && draft.expectedVersion !== undefined) throw new AssessmentError(409, 'A new template must not claim an existing version.');
      const template: TemplateVersion = { id, name: draft.name, description: draft.description, networkMode: draft.networkMode, criteria: draft.criteria, version: previous ? previous.version + 1 : 1, createdAt: stamp(), policyDigest: policyDigest(draft), builtIn: false };
      this.db.prepare('INSERT INTO template_versions VALUES(?,?,?,?,?)').run(id, template.version, template.createdAt, template.policyDigest, JSON.stringify(template));
      this.db.exec('COMMIT');
      return structuredClone(template);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  importTemplate(document: unknown): TemplateVersion {
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new AssessmentError(400, 'Import a template JSON object.');
    const source = document as Record<string, unknown>;
    const id = source.id === DEFAULT_TEMPLATE_ID ? undefined : source.id;
    return this.saveTemplate({ id, name: source.name, description: source.description, networkMode: source.networkMode, criteria: source.criteria, ...(source.expectedVersion !== undefined ? { expectedVersion: source.expectedVersion } : {}) });
  }

  private resolveRunTemplate(input: FlowSelection): TemplateVersion {
    if (input.templateVersion !== undefined && input.templateId === undefined) throw new AssessmentError(400, 'A template version requires a template identifier.');
    if (input.templateId !== undefined) {
      if (input.criterionIds !== undefined) throw new AssessmentError(400, 'A saved template cannot be combined with one-off criterion selection. Publish a new version instead.');
      const template = this.getTemplate(input.templateId, input.templateVersion);
      if (!template) throw new AssessmentError(404, 'Template version not found.');
      if (input.networkMode !== undefined && input.networkMode !== template.networkMode) throw new AssessmentError(400, 'The saved template controls network access. Publish a new version to change it.');
      return template;
    }
    const defaultTemplate = this.getTemplate(DEFAULT_TEMPLATE_ID)!;
    const requested = input.criterionIds ?? defaultTemplate.criteria.map(c => c.id);
    if (!Array.isArray(requested) || requested.length === 0 || requested.some(id => typeof id !== 'string')) throw new AssessmentError(400, 'Select at least one criterion.');
    const selected = [...new Set(requested)];
    for (const id of selected) if (!defaultTemplate.criteria.some(c => c.id === id)) throw new AssessmentError(400, `Unknown criterion: ${id}`);
    if (input.criterionIds === undefined && (input.networkMode === undefined || input.networkMode === defaultTemplate.networkMode)) return defaultTemplate;
    const oneOff = { ...defaultTemplate, id: 'one-off', name: 'One-off open-source assessment', version: 0, builtIn: false, networkMode: input.networkMode ?? 'offline', criteria: selected.map(id => defaultTemplate.criteria.find(c => c.id === id)!) };
    return { ...oneOff, policyDigest: policyDigest(oneOff) };
  }

  previewFlow(input: FlowPreviewInput = {}): FlowPreview {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AssessmentError(400, 'Provide an assessment selection or template draft.');
    let template: TemplateVersion;
    if (input.draft !== undefined) {
      if (input.templateId !== undefined || input.templateVersion !== undefined || input.criterionIds !== undefined || input.networkMode !== undefined) throw new AssessmentError(400, 'Preview a draft or a saved selection, not both.');
      const normalized = normalizeTemplateDraft(input.draft, CATALOG);
      template = { id: normalized.id ?? 'draft-preview', name: normalized.name, description: normalized.description, version: 0, createdAt: stamp(), policyDigest: policyDigest(normalized), networkMode: normalized.networkMode, criteria: normalized.criteria, builtIn: false };
    } else {
      if (input.networkMode !== undefined && input.networkMode !== 'offline' && input.networkMode !== 'online') throw new AssessmentError(400, 'Network mode must be offline or online.');
      template = this.resolveRunTemplate(input);
    }
    const chart = buildAssessmentChart(template.criteria);
    return structuredClone({ structure: chart.buildTimeStructure, criteria: template.criteria, template, networkMode: template.networkMode });
  }

  async getTools(): Promise<ToolDefinition[]> {
    let osvVersion: string | null = null;
    try { const output = await execFileAsync(this.osvExecutable, ['--version'], { timeout: 10_000, maxBuffer: 64 * 1024 }); osvVersion = output.stdout.trim() || output.stderr.trim(); } catch { /* Missing tools are exposed as unavailable. */ }
    return [
      { id: 'project-files', name: 'Local project inspection', description: 'Reads and hashes selected project documents and lockfiles without installing or executing the project.', available: true, version: VERSION, network: 'none', setupInstructions: [], supportedCriteria: CATALOG.filter(c => c.id !== 'dependency-vulnerabilities').map(c => c.id) },
      { id: 'osv-scanner', name: 'OSV-Scanner', description: 'Checks frozen root lockfiles. Offline mode requires a previously downloaded advisory database.', available: osvVersion !== null, version: osvVersion, network: 'optional', setupInstructions: ['Install OSV-Scanner v2 from https://google.github.io/osv-scanner/installation/', 'macOS: brew install osv-scanner', 'Windows: winget install Google.OSVScanner', 'Prepare offline advisory data using OSV’s documented offline database download, then run assessments in offline mode.'], supportedCriteria: ['dependency-vulnerabilities'] },
    ];
  }

  async inspectProject(projectPath: string): Promise<ProjectInfo> {
    const root = await this.projectRoot(projectPath);
    const files = await this.capture(root);
    return this.describeProject(root, files, INPUT_FILES);
  }

  async importProject(input: SourceImportInput): Promise<SourceImportResult> {
    if (this.active || this.importing) throw new AssessmentError(409, 'Wait for the current assessment or source fetch to finish.');
    this.importing = true;
    try {
      const imported = await this.sourceImporter.import(input);
      const project = await this.inspectProject(imported.projectPath);
      return { project, source: project.source ?? imported.source };
    } finally { this.importing = false; }
  }

  private async describeProject(root: string, files: CapturedFile[], requestedPaths: string[]): Promise<ProjectInfo> {
    const manifest = parseManifest(files.find(f => f.path === 'package.json'));
    let gitCommit: string | null = null;
    let gitDirty: boolean | null = null;
    try {
      const gitArgs = ['-c', 'core.fsmonitor=false', '-C', root];
      const result = await execFileAsync('git', [...gitArgs, 'rev-parse', '--show-toplevel'], { timeout: 3000, maxBuffer: 65536 });
      if (await realpath(result.stdout.trim()) === root) {
        gitCommit = (await execFileAsync('git', [...gitArgs, 'rev-parse', 'HEAD'], { timeout: 3000 })).stdout.trim();
        // git status can execute repository-defined clean/process filters. Preserve passive inspection.
        gitDirty = null;
      }
    } catch { /* A local folder does not have to be a Git repository. */ }
    const source = this.sourceImporter.originFor(root, requestedPaths, files);
    return { path: root, name: labelManifest(manifest, 'name') ?? source?.name ?? basename(root), packageVersion: labelManifest(manifest, 'version'), gitCommit, gitDirty, detectedFiles: files.map(f => f.path), ...(source ? { source } : {}) };
  }

  async runAssessment(input: RunInput): Promise<AssessmentRun> {
    if (this.active || this.importing) throw new AssessmentError(409, 'An assessment or source fetch is already running. Wait for it to finish.');
    if (!input || typeof input.projectPath !== 'string') throw new AssessmentError(400, 'A project path is required.');
    if (input.networkMode && !['offline', 'online'].includes(input.networkMode)) throw new AssessmentError(400, 'Network mode must be offline or online.');
    const template = this.resolveRunTemplate(input);
    const selected = template.criteria.map(c => c.id);
    this.active = true;
    let run: AssessmentRun | undefined;
    const preparationEvents: RunEvent[] = [];
    const emit = (event: RunEvent): void => {
      if (run) { run.events.push(event); this.save(run); }
      else preparationEvents.push(event);
      try { input.onEvent?.(structuredClone(event), run?.id ?? null); } catch { /* Observers cannot change or interrupt the assessment record. */ }
    };
    try {
      const root = await this.projectRoot(input.projectPath);
      const requestedPaths = templateInputPaths(template);
      emit({ type: 'collection_started', message: 'Capturing the selected policy’s configured local inputs.', timestamp: stamp() });
      const captured = await this.capture(root, requestedPaths);
      const subject = await this.describeProject(root, captured, requestedPaths);
      const manifest = parseManifest(captured.find(f => f.path === 'package.json'));
      subject.name = labelManifest(manifest, 'name') ?? subject.name;
      subject.packageVersion = labelManifest(manifest, 'version');
      subject.detectedFiles = captured.map(f => f.path);
      const snapshotFiles = captured.map(f => ({ path: f.path, sha256: f.sha256, bytes: f.bytes.length }));
      run = { id: randomUUID(), status: 'running', startedAt: stamp(), completedAt: null, automationCompletedAt: null, revision: 1, subject, framework: { id: template.id, name: template.name, version: String(template.version), policyDigest: template.policyDigest }, criteria: structuredClone(template.criteria), template: structuredClone(template), sourceSnapshot: { scope: 'Evidence files configured by this template, plus root package identity when present. Other project files, installed dependencies, and hosting configuration are not assessed.', digest: sha(JSON.stringify({ requestedPaths, files: snapshotFiles })), requestedPaths, files: snapshotFiles }, results: [], evidence: [], reviews: [], events: [], assessmentType: 'self-assessment', execution: { ownerPid: process.pid }, networkMode: template.networkMode, limitations: ['This is a self-assessment, not certification or an independent review.', 'Built-in checks cover root Node.js metadata; custom checks cover only their explicitly configured files and rules.', 'File presence checks do not establish security effectiveness, licence compatibility, or governance quality.', 'The source digest covers the listed assessment inputs, not every file in the repository.', 'A Git commit is contextual metadata; working-tree changes are not checked and the captured inputs may differ from that commit.'] };
      run.events.push(...preparationEvents);
      if (subject.source?.kind === 'npm') run.limitations.push('The imported subject contains published npm package files, not a full repository. Lockfiles, governance documents, development sources and other repository files may be absent; their coverage is not inferred.');
      if (subject.source?.kind === 'github') run.limitations.push('The imported subject is an archive pinned to a GitHub commit; Git history, submodule contents and Git LFS object availability are not established.');
      if (subject.source?.selectedInputs === 'changed') run.limitations.push('Selected assessment inputs differ from the fetched source manifest. The recorded revision identifies fetched origin; the frozen input hashes identify what was actually assessed.');
      const assessment = run;
      const artifactRoot = join(this.dataDir, 'runs', assessment.id);
      mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
      const frozenRoot = join(artifactRoot, 'inputs');
      mkdirSync(frozenRoot, { mode: 0o700 });
      for (const file of captured) {
        const target = join(frozenRoot, file.path);
        mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
        writeFileSync(target, file.bytes, { mode: 0o600 });
      }
      emit({ type: 'run_started', message: `Assessment started for ${subject.name}.`, timestamp: stamp() });
      emit({ type: 'collection_completed', message: `Captured and froze ${captured.length} selected input file(s). Evaluation has not started.`, timestamp: stamp() });
      const toolState = await this.getTools();
      const evidenceFor = (file: CapturedFile): string => {
        let existing = assessment.evidence.find(e => e.toolId === 'project-files' && e.source === file.path);
        if (!existing) { existing = this.addEvidence(assessment, 'project-files', VERSION, file.path, file.bytes, { path: file.path, present: true }); }
        return existing.id;
      };
      const result = (criterionId: string, status: CriterionStatus, rationale: string, files: CapturedFile[], limitations: string[] = []): CriterionResult => ({ criterionId, status, rationale, evidenceIds: files.map(evidenceFor), coverage: files.map(f => f.path), limitations });
      const scanVulnerabilities = async (criterionId: string, configuredPaths: string[], maxFindings: number, requireNodeManifest: boolean): Promise<CriterionResult> => {
        const locks = captured.filter(f => configuredPaths.includes(f.path));
        const usableLocks = locks.filter(f => f.bytes.toString().trim() && (!f.path.endsWith('.json') || parseManifest(f)));
          if (requireNodeManifest && !captured.some(f => f.path === 'package.json')) return result(criterionId, 'not_applicable', 'No root Node.js package manifest was found.', []);
          if (!usableLocks.length) return result(criterionId, 'insufficient_evidence', 'A supported root lockfile is required. The project was not installed to generate one.', locks);
          const osv = toolState.find(t => t.id === 'osv-scanner')!;
          if (!osv.available) return result(criterionId, 'insufficient_evidence', 'OSV-Scanner is not installed or could not report its version. Install it and rerun this check.', usableLocks);
          const semanticVersion = /(?:^|version\s*[:=]?\s*)v?(\d+)\.(\d+)\.(\d+)/im.exec(osv.version ?? '');
          if (!semanticVersion || semanticVersion[1] !== '2') return result(criterionId, 'insufficient_evidence', 'This adapter requires OSV-Scanner v2. The installed version is not supported.', usableLocks);
          const args = ['scan', 'source', '--format=json', '--all-packages', '--no-call-analysis=go'];
          if (assessment.networkMode === 'offline') args.push('--offline');
          for (const lock of usableLocks) args.push(`--lockfile=${join(frozenRoot, lock.path)}`);
          let stdout = '', stderr = '', exitCode = 0;
          try { const output = await execFileAsync(this.osvExecutable, args, { cwd: frozenRoot, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }); stdout = output.stdout; stderr = output.stderr; }
          catch (error) { const e = error as Error & { stdout?: string; stderr?: string; code?: number | string }; stdout = e.stdout ?? ''; stderr = e.stderr ?? e.message; exitCode = typeof e.code === 'number' ? e.code : -1; }
          const execution = this.addEvidence(assessment, 'osv-scanner', osv.version!, 'OSV execution diagnostics', Buffer.from(JSON.stringify({ executable: 'osv-scanner', args: args.map(a => a.replaceAll(frozenRoot, '<frozen-inputs>')), exitCode, stderr }, null, 2)), { exitCode, networkMode: assessment.networkMode });
          const output = this.addEvidence(assessment, 'osv-scanner', osv.version!, 'OSV JSON output', Buffer.from(stdout), { format: 'json' });
          const row = result(criterionId, 'insufficient_evidence', 'The vulnerability scan did not produce usable evidence.', usableLocks, ['Only the configured frozen lockfiles are scanned; source reachability and installed dependencies are not evaluated.', 'Advisory data changes over time. The raw output is retained; its complete database snapshot is not bundled.']);
          row.evidenceIds.push(execution.id, output.id);
          if (![0, 1].includes(exitCode)) { row.rationale = `OSV could not complete the scan${assessment.networkMode === 'offline' ? ' with the available local advisory database' : ''}. Inspect execution diagnostics; no passing result was inferred.`; return row; }
          let payload: unknown;
          try { payload = JSON.parse(stdout); } catch { row.rationale = 'OSV returned invalid JSON. No passing result was inferred.'; return row; }
          const packages = validOsvPackages(payload);
          if (!packages) { row.rationale = 'OSV output did not match the expected package and vulnerability schema. No passing result was inferred.'; return row; }
          const vulnerabilityCount = packages.reduce((n, p) => n + (p.vulnerabilities?.length ?? 0), 0);
          if (packages.length === 0) { row.rationale = 'OSV did not identify packages in the selected inputs. Dependency coverage cannot be established.'; return row; }
          if ((exitCode === 0 && vulnerabilityCount > 0) || (exitCode === 1 && vulnerabilityCount === 0)) { row.rationale = 'OSV output and its exit status disagree. Inspect the retained diagnostics; no passing result was inferred.'; return row; }
          row.status = vulnerabilityCount > maxFindings ? 'not_satisfied' : 'satisfied';
          row.rationale = maxFindings > 0 ? `${vulnerabilityCount} known vulnerability finding(s) were reported across ${packages.length} package records; this policy permits at most ${maxFindings}. This is not a safety certification.` : vulnerabilityCount ? `${vulnerabilityCount} known vulnerability finding(s) were reported across ${packages.length} package records. Inspect the original output for advisory identifiers and affected versions.` : `No known vulnerabilities were reported in ${packages.length} package records against the advisory data available at scan time. This is not proof that the project is secure.`;
          return row;
      };
      const evaluate = async (criterionId: string): Promise<CriterionResult> => {
        const file = (name: string): CapturedFile | undefined => captured.find(f => f.path === name);
        const manifestFile = file('package.json');
        if (criterionId === 'project-metadata') {
          if (!manifestFile) return result(criterionId, 'not_applicable', 'No root package.json was found. This Node.js package identity criterion is not applicable.', []);
          if (!manifest) return result(criterionId, 'not_satisfied', 'package.json is not a valid JSON object.', [manifestFile]);
          const valid = labelManifest(manifest, 'name') && labelManifest(manifest, 'version');
          return result(criterionId, valid ? 'satisfied' : 'not_satisfied', valid ? 'The package declares a name and version.' : 'The package must declare both a name and version.', [manifestFile]);
        }
        if (criterionId === 'license-evidence') {
          const document = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE'].map(file).find(f => f && f.bytes.toString().trim());
          const declaration = labelManifest(manifest, 'license');
          const files = [manifestFile, document].filter((f): f is CapturedFile => Boolean(f));
          return result(criterionId, declaration && document ? 'satisfied' : 'not_satisfied', declaration && document ? `A licence declaration (${declaration}) and a root licence document are available.` : `Missing ${!declaration ? 'a non-empty licence declaration' : ''}${!declaration && !document ? ' and ' : ''}${!document ? 'a non-empty root licence document' : ''}.`, files, ['No legal interpretation, SPDX validation, or compatibility assessment is performed.']);
        }
        if (criterionId === 'security-policy') {
          const document = ['SECURITY.md', '.github/SECURITY.md'].map(file).find(f => f && f.bytes.toString().trim());
          return result(criterionId, document ? 'satisfied' : 'not_satisfied', document ? 'A non-empty security policy is available for inspection.' : 'No non-empty root or .github security policy was found.', document ? [document] : [], ['The reporting channel and its operational effectiveness have not been validated.']);
        }
        const locks = captured.filter(f => LOCKFILES.includes(f.path));
        const usableLocks = locks.filter(f => f.bytes.toString().trim() && (!f.path.endsWith('.json') || parseManifest(f)));
        if (criterionId === 'dependency-lockfile') {
          if (!manifestFile) return result(criterionId, 'not_applicable', 'No root Node.js package manifest was found.', locks);
          return result(criterionId, usableLocks.length ? 'satisfied' : 'not_satisfied', usableLocks.length ? `${usableLocks.length} supported root lockfile(s) are available.` : 'No readable, non-empty supported root lockfile was found.', locks, ['Nested packages and exact dependency resolution consistency are not checked.']);
        }
        if (criterionId === 'dependency-vulnerabilities') return scanVulnerabilities(criterionId, LOCKFILES, 0, true);
        const documents = ['GOVERNANCE.md', '.github/GOVERNANCE.md', 'CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'README.md'].map(file).filter((f): f is CapturedFile => Boolean(f));
        return result(criterionId, 'insufficient_evidence', 'Human review is required. Inspect the documents, identify decision authority and contributor participation, and record a reasoned judgment.', documents, ['Document presence does not establish governance transparency in practice.', 'Reviewer identity is locally declared and is not independently authenticated.']);
      };
      const evaluateCriterion = async (criterion: TemplateCriterion): Promise<CriterionResult> => {
        const rule = criterion.evaluation;
        const configured = captured.filter(file => criterion.collector.paths.includes(file.path));
        let row: CriterionResult;
        if (rule.kind === 'builtin') {
          row = await evaluate(rule.criterionId);
          row.criterionId = criterion.id;
        } else if (rule.kind === 'files') {
          const checks = criterion.collector.paths.map(path => { const value = captured.find(file => file.path === path); return Boolean(value && value.bytes.length >= rule.minimumBytes); });
          const fulfilled = rule.match === 'all' ? checks.every(Boolean) : checks.some(Boolean);
          row = result(criterion.id, fulfilled ? 'satisfied' : 'not_satisfied', `${checks.filter(Boolean).length} of ${checks.length} configured files meet the ${rule.minimumBytes}-byte minimum; the rule requires ${rule.match === 'all' ? 'all files' : 'at least one file'}.`, configured, ['File availability does not establish content quality or operational effectiveness.']);
        } else if (rule.kind === 'json-field') {
          const input = configured[0];
          if (!input) row = result(criterion.id, 'not_satisfied', 'The configured JSON evidence file was not found.', []);
          else {
            let value: unknown;
            let parsed = true;
            try { value = JSON.parse(input.bytes.toString('utf8')); } catch { parsed = false; }
            let found = parsed;
            for (const component of rule.field) {
              if (!found || value === null || typeof value !== 'object' || !Object.hasOwn(value, component)) { found = false; break; }
              value = (value as Record<string, unknown>)[component];
            }
            const fulfilled = found && (rule.operator === 'exists' || value === rule.expected);
            const rationale = !parsed ? 'The configured file is not valid JSON.' : !found ? 'The configured own JSON field was not found.' : rule.operator === 'exists' ? 'The configured own JSON field exists.' : fulfilled ? 'The own JSON field equals the configured scalar value.' : 'The own JSON field does not equal the configured scalar value; no type coercion is performed.';
            row = result(criterion.id, fulfilled ? 'satisfied' : 'not_satisfied', rationale, [input], ['Only the configured JSON field condition is assessed.']);
          }
        } else if (rule.kind === 'vulnerabilities') row = await scanVulnerabilities(criterion.id, criterion.collector.paths, rule.maxFindings, false);
        else row = result(criterion.id, 'insufficient_evidence', 'An attributed expert must inspect the configured evidence and record a judgment against this criterion’s requirements.', configured, ['Document availability does not supply an expert judgment.', 'Reviewer identity is locally declared and not independently authenticated.']);
        const intrinsicallyExpert = rule.kind === 'expert' || (rule.kind === 'builtin' && rule.criterionId === 'governance-review');
        if (criterion.requiresReview && !intrinsicallyExpert) {
          row.automaticResult = { status: row.status, rationale: row.rationale };
          row.status = 'insufficient_evidence';
          row.rationale = `Automatic rule: ${row.automaticResult.rationale} A separate attributed expert decision is required before finalisation.`;
        }
        return row;
      };
      const builtChart = buildAssessmentChart(template.criteria, {
        sourceDigest: assessment.sourceSnapshot.digest,
        initializeStarted: () => emit({ type: 'stage_started', stageId: INITIALIZE_STAGE_ID, message: 'Initializing the recorded evaluation state.', timestamp: stamp() }),
        evaluate: async (criterion, scope) => {
          const criterionId = criterion.id;
          emit({ type: 'criterion_started', criterionId, message: `Checking ${criterion.title}.`, timestamp: stamp() });
          let row: CriterionResult;
          try { row = await evaluateCriterion(criterion); } catch (error) { row = result(criterionId, 'evaluation_error', `Evaluation failed: ${plainError(error)}`, []); }
          assessment.results.push(row);
          scope.findings = [...scope.findings, { criterionId, status: row.status, evidenceIds: row.evidenceIds }];
          emit({ type: 'criterion_completed', criterionId, message: row.rationale, timestamp: stamp() });
        },
      });
      const executor = new FlowChartExecutor(builtChart);
      executor.enableNarrative();
      executor.attachFlowRecorder({ id: 'assessment-live-stage-events', onStageExecuted: event => {
        if (event.traversalContext?.stageId === INITIALIZE_STAGE_ID) emit({ type: 'stage_completed', stageId: INITIALIZE_STAGE_ID, message: 'Initialized evaluation state with the already captured source digest.', timestamp: stamp() });
      } });
      executor.attachScopeRecorder(metrics());
      await executor.run({ input: { projectPath: subject.path, criterionIds: selected } });
      const snapshot = executor.getSnapshot();
      const recording: WorkflowRecording = { schemaVersion: 1, recorder: 'footprintjs', version: '9.44.1', scope: 'automated-evaluation', assessmentId: assessment.id, policyDigest: assessment.framework.policyDigest, sourceDigest: assessment.sourceSnapshot.digest, snapshot, structure: builtChart.buildTimeStructure, narrativeEntries: executor.getNarrativeEntries() };
      const trace = JSON.stringify(recording, null, 2);
      this.addEvidence(assessment, 'footprintjs', '9.44.1', 'Recorded assessment workflow', Buffer.from(trace), { format: 'footprintjs-workflow', schemaVersion: 1, scope: 'automated-evaluation', stages: selected.length + 1 });
      assessment.status = template.criteria.some(c => c.requiresReview) ? 'awaiting_review' : 'completed';
      assessment.automationCompletedAt = stamp();
      assessment.completedAt = assessment.status === 'completed' ? assessment.automationCompletedAt : null;
      emit({ type: 'run_completed', message: assessment.status === 'awaiting_review' ? 'Automated checks completed. Required expert review is pending.' : 'Assessment completed.', timestamp: stamp() });
      return structuredClone(assessment);
    } catch (error) {
      if (run) { run.status = 'interrupted'; run.completedAt = stamp(); run.limitations.push(`Execution interrupted: ${plainError(error)}`); emit({ type: 'run_interrupted', message: `Assessment interrupted: ${plainError(error)}`, timestamp: stamp() }); }
      throw error;
    } finally { this.active = false; }
  }

  listRuns(): RunSummary[] {
    return (this.db.prepare('SELECT payload FROM runs ORDER BY started_at DESC').all() as Array<{ payload: string }>).map(({ payload }) => {
      const run = JSON.parse(payload) as AssessmentRun;
      return { id: run.id, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt, subject: run.subject, assessmentType: run.assessmentType, counts: counts(run), ...(run.template ? { template: { id: run.template.id, name: run.template.name, version: run.template.version, policyDigest: run.template.policyDigest } } : {}) };
    });
  }
  getRun(id: string): AssessmentRun | null {
    const row = this.db.prepare('SELECT payload FROM runs WHERE id=?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as AssessmentRun : null;
  }
  getWorkflow(runId: string): WorkflowResponse {
    const run = this.getRun(runId);
    if (!run) throw new AssessmentError(404, 'Assessment run not found.');
    this.assertRunPolicy(run);
    const evidence = run.evidence.filter(item => item.toolId === 'footprintjs' && item.source === 'Recorded assessment workflow').at(-1);
    if (!evidence) return { kind: 'unavailable', note: 'No completed automated execution recording is available for this run. Its recorded activity and findings remain available.' };
    const bytes = this.readEvidence(run.id, evidence.id, MAX_REPLAY_BYTES);
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a recording object.');
      parsed = value as Record<string, unknown>;
    } catch { throw new AssessmentError(409, 'The recorded workflow is not valid JSON.'); }
    if (parsed.schemaVersion === undefined && Array.isArray(parsed.commitLog) && parsed.sharedState && typeof parsed.sharedState === 'object') {
      return { kind: 'legacy', evidenceId: evidence.id, note: 'This earlier run retained commits and narrative, but did not record the full execution tree, chart structure, or measured stage timings. Available history is shown below; start a new assessment to capture full replay.', narrativeEntries: Array.isArray(parsed.narrative) ? parsed.narrative : [] };
    }
    const snapshot = parsed.snapshot as Record<string, unknown> | undefined;
    const structure = parsed.structure as Record<string, unknown> | undefined;
    if (parsed.schemaVersion !== 1 || parsed.recorder !== 'footprintjs' || parsed.scope !== 'automated-evaluation' || !snapshot || typeof snapshot !== 'object' || !snapshot.executionTree || typeof snapshot.executionTree !== 'object' || !Array.isArray(snapshot.commitLog) || !snapshot.sharedState || typeof snapshot.sharedState !== 'object' || !structure || typeof structure !== 'object' || typeof structure.id !== 'string' || typeof structure.name !== 'string' || !Array.isArray(parsed.narrativeEntries)) throw new AssessmentError(409, 'The execution recording has an unsupported or incomplete replay format.');
    if (parsed.assessmentId !== run.id || parsed.policyDigest !== run.framework.policyDigest || parsed.sourceDigest !== run.sourceSnapshot.digest) throw new AssessmentError(409, 'Execution recording integrity check failed: its assessment, policy, or source identity does not match this run.');
    return { kind: 'replay', evidenceId: evidence.id, recording: parsed as unknown as WorkflowRecording };
  }
  submitReview(input: ReviewInput): AssessmentRun {
    this.db.exec('BEGIN IMMEDIATE');
    try { const run = this.applyReview(input); this.db.exec('COMMIT'); return run; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private applyReview(input: ReviewInput): AssessmentRun {
    const run = this.getRun(input.runId);
    if (!run) throw new AssessmentError(404, 'Assessment run not found.');
    if (run.status === 'running' || run.status === 'interrupted') throw new AssessmentError(409, 'This assessment is not ready for review.');
    const definitions = run.criteria ?? CATALOG;
    const criterion = definitions.find(c => c.id === input.criterionId);
    const result = run.results.find(r => r.criterionId === input.criterionId);
    if (!criterion || !result || criterion.mode !== 'expert') throw new AssessmentError(400, 'Only an assessed expert criterion can receive a human review.');
    if (!['satisfied', 'not_satisfied', 'insufficient_evidence'].includes(input.decision)) throw new AssessmentError(400, 'Invalid review decision.');
    const reviewer = typeof input.reviewer === 'string' ? input.reviewer.trim() : '';
    const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : '';
    if (reviewer.length < 2 || reviewer.length > 120) throw new AssessmentError(400, 'Provide a reviewer name between 2 and 120 characters.');
    if (rationale.length < 10 || rationale.length > 8000) throw new AssessmentError(400, 'Provide a review rationale between 10 and 8000 characters.');
    run.reviews.push({ id: randomUUID(), criterionId: input.criterionId, reviewer, decision: input.decision, rationale, createdAt: stamp(), evidenceIds: [...result.evidenceIds] });
    result.status = input.decision;
    result.rationale = `Human review by ${reviewer}: ${rationale}`;
    run.status = run.results.some(r => definitions.find(c => c.id === r.criterionId)?.mode === 'expert' && r.status === 'insufficient_evidence') ? 'awaiting_review' : 'completed';
    run.completedAt = run.status === 'completed' ? stamp() : null;
    run.revision = (run.revision ?? 1) + 1;
    this.save(run);
    return run;
  }
  readEvidence(runId: string, evidenceId: string, maximumBytes?: number): Buffer {
    const run = this.getRun(runId);
    const evidence = run?.evidence.find(e => e.id === evidenceId);
    if (!run || !evidence) throw new AssessmentError(404, 'Evidence not found.');
    const path = resolve(this.dataDir, evidence.rawArtifactRef);
    const artifactRoot = realpathSync(join(this.dataDir, 'runs', run.id));
    const actual = realpathSync(path);
    if (!actual.startsWith(artifactRoot + sep) || lstatSync(path).isSymbolicLink()) throw new Error('Artifact path is outside its assessment run.');
    if (maximumBytes !== undefined && statSync(actual).size > maximumBytes) throw new AssessmentError(409, 'The execution recording exceeds the supported 8 MiB replay size. Inspect its original evidence instead.');
    const content = readFileSync(actual);
    if (maximumBytes !== undefined && content.length > maximumBytes) throw new AssessmentError(409, 'The execution recording exceeds the supported 8 MiB replay size. Inspect its original evidence instead.');
    if (sha(content) !== evidence.sha256) throw new AssessmentError(409, 'Evidence integrity check failed: the stored artifact has changed.');
    return content;
  }
  exportReport(runId: string, format: 'json' | 'html'): string {
    const run = this.getRun(runId);
    if (!run) throw new AssessmentError(404, 'Assessment run not found.');
    this.assertRunPolicy(run);
    for (const evidence of run.evidence) this.readEvidence(run.id, evidence.id);
    const frozenRoot = realpathSync(join(this.dataDir, 'runs', run.id, 'inputs'));
    for (const input of run.sourceSnapshot.files) {
      const frozenPath = realpathSync(join(frozenRoot, input.path));
      if (!frozenPath.startsWith(frozenRoot + sep) || sha(readFileSync(frozenPath)) !== input.sha256) throw new AssessmentError(409, 'Frozen input integrity check failed: an assessment input has changed.');
    }
    if (format === 'json') return JSON.stringify(run, null, 2);
    if (format !== 'html') throw new Error('Export format must be html or json.');
    const definitions = run.criteria ?? CATALOG;
    const findings = run.results.map(row => {
      const definition = definitions.find(criterion => criterion.id === row.criterionId);
      const requirements = definition?.evidenceRequirements ?? [];
      const automatic = row.automaticResult ? `<p><strong>Retained automatic finding:</strong> ${escapeHtml(row.automaticResult.status)}<br>${escapeHtml(row.automaticResult.rationale)}</p>` : '';
      return `<tr><td>${escapeHtml(definition?.title ?? row.criterionId)}<br><small>${escapeHtml(definition?.rule ?? '')}</small>${requirements.length ? `<p><small>Evidence requirements: ${requirements.map(escapeHtml).join('; ')}</small></p>` : ''}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.rationale)}${automatic}<br><small>${escapeHtml(row.limitations.join(' '))}</small></td></tr>`;
    }).join('');
    const templateRecord = run.template ? `<h2>${run.template.version === 0 ? 'Captured one-off policy' : 'Captured template'}</h2><p>${escapeHtml(run.template.name)}${run.template.version === 0 ? '' : ` · version ${run.template.version}`} <br>Identifier: ${escapeHtml(run.template.id)}<br>Policy SHA-256: <small>${escapeHtml(run.template.policyDigest)}</small></p><details><summary>Exact policy used for this assessment</summary><pre>${escapeHtml(JSON.stringify(run.template, null, 2))}</pre></details>` : '';
    const sourceRecord = run.subject.source ? `<h2>Fetched source origin</h2><p>${escapeHtml(run.subject.source.kind === 'npm' ? 'Published npm package files' : 'GitHub source archive')} · ${escapeHtml(run.subject.source.name)}<br>Pinned revision: ${escapeHtml(run.subject.source.revision)}<br>Fetched: ${escapeHtml(run.subject.source.fetchedAt)}<br>Origin: ${escapeHtml(run.subject.source.url)}<br>Selected inputs: ${escapeHtml(run.subject.source.selectedInputs)}<br>Archive SHA-256: ${escapeHtml(run.subject.source.archiveSha256)}</p><pre>${escapeHtml(JSON.stringify(run.subject.source, null, 2))}</pre>` : '';
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(run.subject.name)} — AssessmentFootprint</title><style>body{font:16px/1.65 system-ui,sans-serif;max-width:1000px;margin:48px auto;padding:0 24px;color:#182a33;background:#faf9f6}h1{font-size:36px}h2{margin-top:32px}.tag{display:inline-block;background:#e3eee9;padding:4px 12px;border-radius:8px}table{border-collapse:collapse;width:100%}td,th{padding:12px;text-align:left;border-bottom:1px solid #d8dfdb;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf0eb;padding:16px}small{color:#53666b}</style><h1>AssessmentFootprint</h1><p class="tag">Self-assessment · ${escapeHtml(run.status)} · revision ${run.revision ?? 1}</p><h2>${escapeHtml(run.subject.name)}</h2><p>Framework: ${escapeHtml(run.framework.name)} ${escapeHtml(run.framework.version)}<br>Collected: ${escapeHtml(run.startedAt)}<br>Commit: ${escapeHtml(run.subject.gitCommit ?? 'Local folder; no repository commit recorded')}<br>Network: ${escapeHtml(run.networkMode)}</p>${sourceRecord}${templateRecord}<h2>Criterion findings</h2><table><thead><tr><th>Criterion</th><th>Result</th><th>Rationale</th></tr></thead><tbody>${findings}</tbody></table><h2>Limitations</h2><ul>${run.limitations.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul><h2>Evidence index</h2><table><thead><tr><th>Source</th><th>Tool</th><th>SHA-256</th></tr></thead><tbody>${run.evidence.map(e => `<tr><td>${escapeHtml(e.source)}</td><td>${escapeHtml(e.toolId)} ${escapeHtml(e.toolVersion)}</td><td><small>${escapeHtml(e.sha256)}</small></td></tr>`).join('')}</tbody></table><h2>Review history</h2>${run.reviews.length ? run.reviews.map(r => `<p><strong>${escapeHtml(r.reviewer)}</strong> · ${escapeHtml(r.createdAt)} · ${escapeHtml(r.decision)}<br>${escapeHtml(r.rationale)}</p>`).join('') : '<p>No human review has been recorded.</p>'}<h2>Assessment input snapshot</h2><p>${escapeHtml(run.sourceSnapshot.scope)}</p><pre>${escapeHtml(JSON.stringify(run.sourceSnapshot, null, 2))}</pre><small>The report is a record of checks and judgments within their stated scope. It does not certify software safety or compliance.</small></html>`;
  }
  close(): void { this.db.close(); }

  private assertRunPolicy(run: AssessmentRun): void {
    if (run.template && (policyDigest(run.template) !== run.template.policyDigest || policyDigest({ ...run.template, criteria: run.criteria as TemplateCriterion[] }) !== run.template.policyDigest || run.framework.policyDigest !== run.template.policyDigest || run.framework.id !== run.template.id || run.framework.name !== run.template.name || run.framework.version !== String(run.template.version) || run.networkMode !== run.template.networkMode)) throw new AssessmentError(409, 'Assessment policy integrity check failed: the retained template or criterion definitions have changed.');
  }
  private save(run: AssessmentRun): void { this.db.prepare('INSERT INTO runs(id,started_at,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(run.id, run.startedAt, JSON.stringify(run)); }
  private addEvidence(run: AssessmentRun, toolId: string, toolVersion: string, source: string, content: Buffer, value: unknown): EvidenceRecord {
    const id = randomUUID();
    const rawArtifactRef = join('runs', run.id, `${id}.txt`);
    writeFileSync(join(this.dataDir, rawArtifactRef), content, { mode: 0o600 });
    const record = { id, toolId, toolVersion, collectedAt: stamp(), source, sha256: sha(content), bytes: content.length, rawArtifactRef, value };
    run.evidence.push(record);
    return record;
  }
  private async projectRoot(projectPath: string): Promise<string> {
    if (typeof projectPath !== 'string' || !projectPath.trim() || projectPath.includes('\0')) throw new AssessmentError(400, 'Provide a local project folder path.');
    let root: string;
    try { root = await realpath(resolve(projectPath)); } catch { throw new AssessmentError(400, 'The project folder does not exist or cannot be read.'); }
    if (!(await stat(root)).isDirectory()) throw new AssessmentError(400, 'The project path must be a directory.');
    return root;
  }
  private async capture(root: string, requestedPaths: string[] = INPUT_FILES): Promise<CapturedFile[]> {
    const captured: CapturedFile[] = [];
    let totalBytes = 0;
    for (const path of requestedPaths) {
      const candidate = join(root, path);
      if (!existsSync(candidate)) continue;
      const actual = await realpath(candidate);
      if (!actual.startsWith(root + sep)) throw new Error(`Assessment input resolves outside the selected project: ${path}`);
      const info = await stat(actual);
      if (!info.isFile()) continue;
      if (info.size > MAX_FILE_BYTES) throw new Error(`Assessment input exceeds the 8 MiB limit: ${path}`);
      if (totalBytes + info.size > MAX_SNAPSHOT_BYTES) throw new Error('Assessment inputs exceed the 32 MiB total snapshot limit.');
      const bytes = await readFile(actual);
      if (bytes.length > MAX_FILE_BYTES) throw new Error(`Assessment input exceeds the 8 MiB limit: ${path}`);
      totalBytes += bytes.length;
      if (totalBytes > MAX_SNAPSHOT_BYTES) throw new Error('Assessment inputs exceed the 32 MiB total snapshot limit.');
      captured.push({ path, bytes, sha256: sha(bytes) });
    }
    return captured;
  }
}
