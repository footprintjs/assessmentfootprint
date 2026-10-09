import { flowChart } from 'footprintjs';
import type { TypedScope } from 'footprintjs';
import type { CriterionStatus, TemplateCriterion } from './types.ts';

export const INITIALIZE_STAGE_ID = '_freeze-inputs';
export type AssessmentTraceState = {
  activeCriterion: string;
  findings: Array<{ criterionId: string; status: CriterionStatus; evidenceIds: string[] }>;
  subjectDigest: string;
};

interface ChartCallbacks {
  sourceDigest: string;
  initializeStarted?: () => void;
  evaluate: (criterion: TemplateCriterion, scope: TypedScope<AssessmentTraceState>) => Promise<void>;
}

/** One FootprintJS definition supplies draft structure and the chart actually executed. */
export function buildAssessmentChart(criteria: TemplateCriterion[], callbacks?: ChartCallbacks) {
  const builder = flowChart<AssessmentTraceState>('Initialize recorded assessment', scope => {
    callbacks?.initializeStarted?.();
    scope.subjectDigest = callbacks?.sourceDigest ?? '';
    scope.findings = [];
    scope.activeCriterion = '';
  }, INITIALIZE_STAGE_ID);
  for (const criterion of criteria) {
    builder.addFunction(criterion.title, async scope => {
      scope.activeCriterion = criterion.id;
      await callbacks?.evaluate(criterion, scope);
    }, criterion.id, criterion.description);
  }
  return builder.build();
}
