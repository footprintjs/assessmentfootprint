export type CriterionStatus = 'satisfied' | 'not_satisfied' | 'insufficient_evidence' | 'not_applicable' | 'evaluation_error';
export type ReviewDecision = 'satisfied' | 'not_satisfied' | 'insufficient_evidence';
export interface CriterionDefinition {
  id: string;
  title: string;
  description: string;
  dimension: string;
  mode: 'automatic' | 'expert';
  rule: string;
  evidenceRequirements: string[];
  defaultEnabled: boolean;
}
export type EvaluationRule =
  | { kind: 'builtin'; criterionId: string; revision?: string }
  | { kind: 'files'; match: 'all' | 'any'; minimumBytes: number }
  | { kind: 'json-field'; field: string[]; operator: 'exists' | 'equals'; expected?: string | number | boolean | null }
  | { kind: 'vulnerabilities'; maxFindings: number }
  | { kind: 'expert' };
export interface TemplateCriterionInput {
  id: string;
  title: string;
  description: string;
  dimension: string;
  evidenceRequirements: string[];
  collector: { toolId: 'project-files' | 'osv-scanner'; paths: string[] };
  evaluation: EvaluationRule;
  requiresReview: boolean;
}
export interface TemplateCriterion extends CriterionDefinition, TemplateCriterionInput {}
export interface TemplateDraft {
  id?: string;
  name: string;
  description: string;
  networkMode: 'offline' | 'online';
  criteria: TemplateCriterionInput[];
  expectedVersion?: number;
}
export interface TemplateVersion {
  id: string;
  name: string;
  description: string;
  version: number;
  createdAt: string;
  policyDigest: string;
  networkMode: 'offline' | 'online';
  criteria: TemplateCriterion[];
  builtIn: boolean;
}
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  latestVersion: number;
  versionCount: number;
  updatedAt: string;
  policyDigest: string;
  builtIn: boolean;
}
export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  available: boolean;
  version: string | null;
  network: 'none' | 'optional' | 'required';
  setupInstructions: string[];
  supportedCriteria: string[];
}
export interface ProjectInfo {
  path: string;
  name: string;
  packageVersion: string | null;
  gitCommit: string | null;
  gitDirty: boolean | null;
  detectedFiles: string[];
}
export interface EvidenceRecord {
  id: string;
  toolId: string;
  toolVersion: string;
  collectedAt: string;
  source: string;
  sha256: string;
  bytes: number;
  rawArtifactRef: string;
  value: unknown;
}
export interface CriterionResult {
  criterionId: string;
  status: CriterionStatus;
  rationale: string;
  evidenceIds: string[];
  coverage: string[];
  limitations: string[];
  automaticResult?: { status: CriterionStatus; rationale: string };
}
export interface ReviewRecord {
  id: string;
  criterionId: string;
  reviewer: string;
  decision: ReviewDecision;
  rationale: string;
  createdAt: string;
  evidenceIds: string[];
}
export interface RunEvent {
  type: 'run_started' | 'criterion_started' | 'criterion_completed' | 'run_completed' | 'run_interrupted';
  criterionId?: string;
  message: string;
  timestamp: string;
}
export interface AssessmentRun {
  id: string;
  status: 'running' | 'awaiting_review' | 'completed' | 'interrupted';
  startedAt: string;
  completedAt: string | null;
  automationCompletedAt: string | null;
  revision: number;
  subject: ProjectInfo;
  framework: { id: string; name: string; version: string; policyDigest: string };
  criteria: CriterionDefinition[];
  template?: TemplateVersion;
  sourceSnapshot: { scope: string; digest: string; requestedPaths?: string[]; files: Array<{ path: string; sha256: string; bytes: number }> };
  results: CriterionResult[];
  evidence: EvidenceRecord[];
  reviews: ReviewRecord[];
  events: RunEvent[];
  assessmentType: 'self-assessment';
  execution: { ownerPid: number };
  networkMode: 'offline' | 'online';
  limitations: string[];
}
export type RunSummary = Pick<AssessmentRun, 'id' | 'status' | 'startedAt' | 'completedAt' | 'subject' | 'assessmentType'> & {
  counts: Record<CriterionStatus, number>;
  template?: { id: string; name: string; version: number; policyDigest: string };
};
export interface RunInput {
  projectPath: string;
  criterionIds?: string[];
  templateId?: string;
  templateVersion?: number;
  networkMode?: 'offline' | 'online';
  onEvent?: (event: RunEvent) => void;
}
export interface ReviewInput {
  runId: string;
  criterionId: string;
  reviewer: string;
  decision: ReviewDecision;
  rationale: string;
}
