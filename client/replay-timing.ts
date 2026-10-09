import type { ExplainableRecording, StageSnapshot } from 'footprint-explainable-ui';

/** Preserve recorded fractional measurements without changing replay state. */
export function measuredTimelineSteps(snapshots: StageSnapshot[], recording: ExplainableRecording | null): { steps: StageSnapshot[]; measured: boolean } {
  const metrics = recording?.snapshot.recorders?.find(recorder => recorder.name === 'Metrics');
  const data = metrics?.data && typeof metrics.data === 'object' ? metrics.data as Record<string, unknown> : null;
  const recordedSteps = data?.steps && typeof data.steps === 'object' && !Array.isArray(data.steps) ? data.steps as Record<string, unknown> : null;
  const durations = snapshots.map(snapshot => {
    const id = snapshot.runtimeStageId;
    const step = id && recordedSteps && Object.hasOwn(recordedSteps, id) ? recordedSteps[id] : null;
    const duration = step && typeof step === 'object' ? (step as Record<string, unknown>).duration : undefined;
    return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : null;
  });
  const measured = snapshots.length > 0 && durations.every(duration => duration !== null);
  let offset = 0;
  const steps = snapshots.map((snapshot, index) => {
    // An incomplete measurement set uses the viewer's untimed order view.
    if (!measured) return { ...snapshot, startMs: 0, durationMs: 0 };
    const durationMs = Number(durations[index]!.toPrecision(4));
    const result = { ...snapshot, startMs: offset, durationMs };
    offset += durationMs;
    return result;
  });
  return { steps, measured };
}
