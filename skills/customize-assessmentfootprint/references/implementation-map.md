# Implementation map

All paths below are relative to the AssessmentFootprint reference checkout. Locate that checkout before following them; copying this skill alone does not install the application. Use this map when a requested customization needs source changes; template-only configuration usually needs just src/types.ts, src/templates.ts, and the README.

## Reference baseline

The source inspected for this guide is AssessmentFootprint `0.3.0`, based on commit `8c15651` (the guide itself is added later). Its manifest uses `private: true` to prevent accidental npm publishing; that flag does not control GitHub visibility. It is not a published `npx` launcher or a generic engine package for importing into another app.

The checked-in dependency set uses Node 24+, FootprintJS `9.44.1`, Explainable UI `0.38.0`, React/ReactDOM `19.2.5`, and React Flow `12.10.2`. These are reference versions, not a recommendation to upgrade or proof of compatibility with later releases. Inspect the target's installed packages before adapting calls.

## Where to start

| Concern | Source and useful symbols | What to transfer |
| --- | --- | --- |
| Shared chart definition | `src/chart.ts`: `buildAssessmentChart`, `AssessmentTraceState` | One builder with stable stage IDs supplies preview structure and executable callbacks. |
| Preview and execution | `src/core.ts`: `previewFlow`, `runAssessment`; search `new FlowChartExecutor` | Preview builds without executing. Run freezes inputs/configuration and calls the same builder with real callbacks. |
| Recording envelope | `src/types.ts`: `WorkflowRecording`, `WorkflowResponse`; `src/core.ts`: `getWorkflow` | Versioned recording, run/policy/input association, artifact verification, and explicit replay/legacy/unavailable states. Adapt domain names deliberately. |
| Input and policy retention | `src/templates.ts`; `src/core.ts`: `resolveRunTemplate`, `saveTemplate`, `readEvidence` | Validated immutable configuration versions, captured input scope, and retained artifact bytes. |
| Local interfaces | `src/cli.ts`, `src/server.ts`, `src/types.ts`: `RunEvent`, `RunStreamPacket` | Browser and CLI share the engine; progress is tied to actual run identity. Preserve loopback host/origin/session boundaries for this reference. |
| Draft/live chart | `client/workspace.tsx`: `WorkspaceOptions`, `mountWorkspace`, `traversalState` | Derive nodes/edges with `graphFromStructure`; display execution state and business findings separately. |
| Shared chart layout | `client/assessment-chart.tsx`: `AssessmentStageCard`, `ChartViewportControls`, `placeAssessmentGraph` | Shared dimensions, controls, and node treatment across configuration/live/replay. Single-path placement preserves existing graph identities; it does not create runtime branches. |
| Saved replay | `client/replay.tsx`: `ReplayOptions`, `mountReplay`, `ReplaySurfaces` | `ExplainableProvider` and `TracedFlow` consume retained recordings; selected-step state stays historical. |
| Timing presentation | `client/replay-timing.ts`: `measuredTimelineSteps` | Use actual recorded measurements. Missing metrics remain missing; measured zero is different from absent timing. |
| Wizard and navigation | `web/app.js`: `showRunFlow`, `openFlowReport`, `setResultsPane`, `selectedResultsPane`; `web/index.html`, `web/styles.css` | Separate page navigation, run identity, pane selection, and replay cursor. Guard stale requests. Share chart frame sizing and accessible labels. |
| Human review | `src/core.ts`: `submitReview`; `src/types.ts`: `CriterionResult`, `ReviewRecord` | Preserve `automaticResult` and append attributed decisions. Review updates current findings, not the automation trace. |
| Export | `src/core.ts`: `exportReport`; `README.md`: Evidence and review | Reports contain results and evidence metadata. Current JSON/HTML exports do not embed a portable archive of all artifact bytes. |

## Actual recording sequence

Inspect the implementation around `new FlowChartExecutor` in `src/core.ts` for exact imports and API usage:

1. Build the selected chart with callbacks that update actual domain state.
2. Construct `FlowChartExecutor(builtChart)` and enable narrative capture.
3. Attach the flow recorder for execution events and `metrics()` as a scope recorder before running.
4. Await `executor.run(...)`.
5. Retain `executor.getSnapshot()`, `builtChart.buildTimeStructure`, and `executor.getNarrativeEntries()` in the versioned recording envelope.
6. Persist and hash the recording as evidence. Read it through `getWorkflow`, which checks artifact integrity, shape, and assessment/policy/source identity before returning replay data.

In this app, input capture finishes before the chart begins. `_freeze-inputs` writes the already captured digest into traced state; its duration is not collection time. A completed recording covers automated evaluation. Interrupted runs can have persisted activity/findings without a completed full replay artifact. Do not promise streaming durable snapshots or automatic continuation after process failure from this implementation.

## Verification anchors

| Tests | Behavior to inspect or adapt |
| --- | --- |
| `tests/flow.test.ts` | Shared chart identity, execution events, preview validation, streaming, and unchanged results. |
| `tests/replay.test.ts` | Retained recordings, historical state, timing, legacy data, integrity checks, and review isolation. |
| `tests/ui-navigation.test.ts` | Run identity, same-run pane/cursor retention, cancellation, late responses, and history refresh. These exercise shipping navigation functions; use browser checks for actual geometry. |
| `tests/templates.test.ts` | Immutable versions, input/path bounds, rule normalization, policy digests, and import/export. |
| `tests/core.test.ts`, `tests/server.test.ts`, `tests/cli.test.ts` | Domain semantics, local HTTP boundaries, review/report behavior, and CLI outcomes. |

Keep these regression checks when extending the application. Validate actual chart frame/layout in both a desktop viewport and a narrow viewport when a UI change is required.

## Boundaries to retain or replace deliberately

- The selected criteria form a linear evaluation chart. Rendering libraries' graph capabilities do not establish support for arbitrary authored graphs in the assessment engine.
- The engine and component interfaces use `AssessmentRun`, criteria, evidence, and assessment statuses. They require adaptation for claims processing, data pipelines, approvals, or other domains.
- Live Flow badges can include current human judgments; saved Replay shows the original recorded state. Keep those labels clear.
- Human review follows automation. There is no built-in mid-stage approval pause/resume engine or independently authenticated reviewer identity.
- No model is required for the built-in deterministic rules. AgentFootprint, Lens, HCI, Viz, and remote-tool adapters are optional ideas, not implemented dependencies of this workflow.
- Hashes check consistency against retained metadata; they do not establish an external signature or complete file-to-decision causal proof.

For supported current scope, read `README.md`, `AGENTS.md`, and `docs/architecture.md`. For ecosystem choices, read `docs/reuse-analysis.md` and verify any new integration against its actual installed API before promising it.
