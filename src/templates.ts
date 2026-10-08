import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { AssessmentError } from './errors.ts';
import type { CriterionDefinition, EvaluationRule, TemplateCriterion, TemplateDraft, TemplateVersion } from './types.ts';

export const BUILTIN_POLICY_REVISION = '0.1.0';
export const DEFAULT_TEMPLATE_ID = 'oss-readiness';
export const LOCKFILE_NAMES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];
const BUILTIN_PATHS: Record<string, string[]> = {
  'project-metadata': ['package.json'],
  'license-evidence': ['package.json', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE'],
  'security-policy': ['SECURITY.md', '.github/SECURITY.md'],
  'dependency-lockfile': ['package.json', ...LOCKFILE_NAMES],
  'dependency-vulnerabilities': ['package.json', ...LOCKFILE_NAMES],
  'governance-review': ['GOVERNANCE.md', '.github/GOVERNANCE.md', 'CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'README.md'],
};
const reserved = new Set(Object.getOwnPropertyNames(Object.prototype).map(name => name.toLowerCase()));

function fail(message: string): never { throw new AssessmentError(400, message); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (!empty && !value.trim())) fail(`${label} must be ${empty ? 'a string' : 'a non-empty string'} of at most ${max} characters.`);
  return value.trim();
}
export function templateIdentifier(value: unknown): string {
  const id = text(value, 'Identifier', 64);
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(id) || reserved.has(id.toLowerCase())) fail('Identifiers must start with a letter and contain only letters, numbers, dots, underscores, or hyphens. Reserved object names are not allowed.');
  return id;
}
export function relativeInputPath(value: unknown): string {
  const path = text(value, 'Evidence path', 300);
  if (path.startsWith('/') || path.includes('\\') || path.includes(':') || path.split('/').some(part => part === '' || part === '.' || part === '..') || path.split('/')[0].toLowerCase() === '.git') fail('Evidence paths must be portable paths relative to the selected project, without .git, absolute paths, or parent traversal.');
  return path;
}
function paths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) fail('A collector needs between 1 and 32 evidence paths.');
  const result = value.map(relativeInputPath);
  if (new Set(result).size !== result.length) fail('Evidence paths must not be duplicated.');
  return result;
}
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return value as number;
}
function scalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}
function allowKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) fail(`${label} contains unsupported configuration fields.`);
}

/** Sorted serialization avoids prototype-sensitive merges while hashing the exact policy contents. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function policyDigest(template: Pick<TemplateVersion, 'name' | 'description' | 'networkMode' | 'criteria'>): string {
  return createHash('sha256').update(canonical({ schema: 1, name: template.name, description: template.description, networkMode: template.networkMode, criteria: template.criteria })).digest('hex');
}

export function normalizeTemplateDraft(value: unknown, catalog: CriterionDefinition[]): TemplateDraft & { criteria: TemplateCriterion[] } {
  const input = object(value, 'Template');
  const name = text(input.name, 'Template name', 160);
  const description = text(input.description ?? '', 'Template description', 2000, true);
  const id = input.id === undefined ? undefined : templateIdentifier(input.id);
  const expectedVersion = input.expectedVersion === undefined ? undefined : integer(input.expectedVersion, 'Expected version', 1, 1_000_000);
  if (input.networkMode !== 'offline' && input.networkMode !== 'online') fail('Template network mode must be offline or online.');
  if (!Array.isArray(input.criteria) || input.criteria.length === 0 || input.criteria.length > 32) fail('A template needs between 1 and 32 criteria.');
  const criteria = input.criteria.map((value, index): TemplateCriterion => {
    const row = object(value, `Criterion ${index + 1}`);
    const criterionId = templateIdentifier(row.id);
    const title = text(row.title, 'Criterion title', 160);
    const criterionDescription = text(row.description ?? '', 'Criterion description', 2000, true);
    const dimension = text(row.dimension, 'Criterion dimension', 160);
    if (typeof row.requiresReview !== 'boolean') fail('Each criterion must declare whether expert review is required.');
    const collection = object(row.collector, 'Collector');
    allowKeys(collection, ['toolId', 'paths'], 'Collector');
    if (collection.toolId !== 'project-files' && collection.toolId !== 'osv-scanner') fail('Choose a registered local collector.');
    const inputPaths = paths(collection.paths);
    const evaluation = object(row.evaluation, 'Evaluation rule');
    let normalizedRule: EvaluationRule;
    let rule: string;
    let requiresReview = row.requiresReview;
    let requiredCollector: 'project-files' | 'osv-scanner' = 'project-files';
    if (evaluation.kind === 'builtin') {
      allowKeys(evaluation, ['kind', 'criterionId', 'revision'], 'Built-in rule');
      const builtin = catalog.find(c => c.id === evaluation.criterionId);
      if (!builtin || !Object.hasOwn(BUILTIN_PATHS, builtin.id)) fail('Unknown built-in criterion.');
      if (evaluation.revision !== undefined && evaluation.revision !== BUILTIN_POLICY_REVISION) fail('This built-in rule revision is not supported.');
      const expectedPaths = BUILTIN_PATHS[builtin.id];
      if (canonical(inputPaths) !== canonical(expectedPaths)) fail('Built-in rules use their declared evidence paths. Choose a custom rule to configure different paths.');
      requiredCollector = builtin.id === 'dependency-vulnerabilities' ? 'osv-scanner' : 'project-files';
      normalizedRule = { kind: 'builtin', criterionId: builtin.id, revision: BUILTIN_POLICY_REVISION };
      rule = builtin.rule;
      if (builtin.mode === 'expert' && !requiresReview) fail('This built-in criterion requires expert review.');
    } else if (evaluation.kind === 'files') {
      allowKeys(evaluation, ['kind', 'match', 'minimumBytes'], 'File rule');
      if (evaluation.match !== 'all' && evaluation.match !== 'any') fail('File matching must be all or any.');
      const minimumBytes = integer(evaluation.minimumBytes, 'Minimum file size', 0, 8 * 1024 * 1024);
      normalizedRule = { kind: 'files', match: evaluation.match, minimumBytes };
      rule = `${evaluation.match === 'all' ? 'Every configured file' : 'At least one configured file'} must be available and contain at least ${minimumBytes} byte(s). File presence does not validate its content or effectiveness.`;
    } else if (evaluation.kind === 'json-field') {
      allowKeys(evaluation, ['kind', 'field', 'operator', 'expected'], 'JSON rule');
      if (inputPaths.length !== 1) fail('A JSON field rule requires exactly one evidence file.');
      if (!Array.isArray(evaluation.field) || evaluation.field.length === 0 || evaluation.field.length > 16) fail('A JSON field needs between 1 and 16 path components.');
      const field = evaluation.field.map((value, index) => text(value, `JSON field component ${index + 1}`, 160));
      if (evaluation.operator !== 'exists' && evaluation.operator !== 'equals') fail('A JSON rule operator must be exists or equals.');
      if (evaluation.operator === 'equals' && !scalar(evaluation.expected)) fail('A JSON comparison needs a finite scalar expected value.');
      if (evaluation.operator === 'exists' && evaluation.expected !== undefined) fail('A field existence rule does not accept an expected value.');
      normalizedRule = evaluation.operator === 'equals' ? { kind: 'json-field', field, operator: 'equals', expected: evaluation.expected as string | number | boolean | null } : { kind: 'json-field', field, operator: 'exists' };
      rule = `The configured file must be valid JSON and its own field ${JSON.stringify(field)} must ${evaluation.operator === 'exists' ? 'exist' : `equal ${JSON.stringify(evaluation.expected)}`}. Only the stated field is assessed.`;
    } else if (evaluation.kind === 'vulnerabilities') {
      allowKeys(evaluation, ['kind', 'maxFindings'], 'Vulnerability rule');
      if (inputPaths.some(path => !LOCKFILE_NAMES.includes(posix.basename(path)))) fail('Vulnerability collectors require supported lockfile names.');
      const maxFindings = integer(evaluation.maxFindings, 'Maximum vulnerability findings', 0, 100_000);
      normalizedRule = { kind: 'vulnerabilities', maxFindings };
      requiredCollector = 'osv-scanner';
      rule = `A successful, schema-valid OSV v2 scan of the configured frozen lockfiles must report at most ${maxFindings} vulnerability finding(s). Unavailable tools, advisory data, or package coverage remain insufficient evidence. This threshold is not a safety certification.`;
    } else if (evaluation.kind === 'expert') {
      allowKeys(evaluation, ['kind'], 'Expert rule');
      if (!requiresReview) fail('An expert rule requires attributed human review.');
      normalizedRule = { kind: 'expert' };
      rule = 'An attributed reviewer must inspect the collected evidence against the stated requirements and record a reasoned decision. Document availability never supplies the expert judgment automatically.';
    } else fail('Unknown evaluation rule.');
    if (collection.toolId !== requiredCollector) fail(`The selected rule requires the ${requiredCollector} collector.`);
    if (!Array.isArray(row.evidenceRequirements) || row.evidenceRequirements.length > 21) fail('Evidence requirements must be a list of at most 20 descriptions, plus the generated review requirement.');
    const requirements = row.evidenceRequirements.map(value => text(value, 'Evidence requirement', 800));
    if (requirements.filter(requirement => requirement !== 'Attributed reviewer decision and rationale').length > 20) fail('Evidence requirements must contain at most 20 custom descriptions.');
    if (!requirements.length) requirements.push(...(inputPaths.length <= 20 ? inputPaths : ['Files declared in the collector paths']));
    if (requiresReview && !requirements.includes('Attributed reviewer decision and rationale')) requirements.push('Attributed reviewer decision and rationale');
    if (requiresReview && normalizedRule.kind !== 'expert' && !(normalizedRule.kind === 'builtin' && normalizedRule.criterionId === 'governance-review')) rule += ' A separate attributed expert decision is required before finalisation; the automatic result is retained.';
    return { id: criterionId, title, description: criterionDescription, dimension, evidenceRequirements: requirements, collector: { toolId: requiredCollector, paths: inputPaths }, evaluation: normalizedRule, requiresReview, mode: requiresReview ? 'expert' : 'automatic', rule, defaultEnabled: true };
  });
  if (new Set(criteria.map(c => c.id)).size !== criteria.length) fail('Criterion identifiers must be unique within a template.');
  if (new Set(criteria.flatMap(criterion => criterion.collector.paths)).size > 128) fail('A template may configure at most 128 unique evidence paths.');
  const draft = { ...(id ? { id } : {}), name, description, networkMode: input.networkMode, criteria, ...(expectedVersion ? { expectedVersion } : {}) } as TemplateDraft & { criteria: TemplateCriterion[] };
  if (Buffer.byteLength(JSON.stringify(draft)) > 60 * 1024) fail('Template configuration exceeds 60 KiB.');
  return draft;
}

export function builtInTemplate(catalog: CriterionDefinition[]): TemplateVersion {
  const input = { id: DEFAULT_TEMPLATE_ID, name: 'Local open-source readiness', description: 'The original six scoped checks for local Node.js projects.', networkMode: 'offline', criteria: catalog.map(c => ({ ...c, collector: { toolId: c.id === 'dependency-vulnerabilities' ? 'osv-scanner' : 'project-files', paths: [...BUILTIN_PATHS[c.id]] }, evaluation: { kind: 'builtin', criterionId: c.id }, requiresReview: c.mode === 'expert' })) };
  const draft = normalizeTemplateDraft(input, catalog);
  return { ...draft, id: DEFAULT_TEMPLATE_ID, version: 1, createdAt: new Date().toISOString(), builtIn: true, policyDigest: policyDigest(draft) };
}
export function generatedTemplateId(): string { return `template-${randomUUID()}`; }
export function templateInputPaths(template: TemplateVersion): string[] { return [...new Set(['package.json', ...template.criteria.flatMap(c => c.collector.paths)])].sort(); }
