# Reuse analysis

AssessmentFootprint reuses FootprintJS for its evaluation chart and execution recorder, and Explainable UI for the browser chart and saved replay. Assessment-domain evidence, findings, review history, and persistence remain in this repository.

## Used now: FootprintJS

`package.json` pins published package `footprintjs` to `9.44.1`. The shared [chart builder](../src/chart.ts) imports `flowChart`; the [core](../src/core.ts) executes that chart through `FlowChartExecutor`. The same definition supplies the draft preview and the actual execution graph: an initialization stage records the already captured input digest, followed by an asynchronous stage for each selected criterion. The retained artifact contains the full runtime snapshot, build-time structure, narrative entries, and metrics captured during traversal.

This gives the workbench a replayable account of how its own evaluation state changed without adding an LLM runtime. It does not independently validate the external evidence, prove that a criterion was well chosen, or establish complete file-to-decision causal proof. File snapshots/hashes, scanner diagnostics, and criterion limitations remain AssessmentFootprint's responsibility. The recording covers automated evaluation after input capture; human review remains a separate attributed judgment and does not rewrite it.

FootprintJS also exports `decide` for rule/operand evidence and tracing helpers under `footprintjs/trace`. Those are potential additions when more expressive deterministic policies justify them; the initial file checks are ordinary criterion evaluators rather than fabricated `decide` branches.

Primary project: [FootprintJS](https://github.com/footprintjs/footPrint).

## Used now: Explainable UI

`package.json` pins `footprint-explainable-ui` to `0.38.0` and includes React, React DOM, and `@xyflow/react`. The [workspace](../client/workspace.tsx) uses `graphFromStructure` to render the builder's real stage IDs and edges. The [replay viewer](../client/replay.tsx) uses `ExplainableProvider`, `useExplainableRun`, and `TracedFlow` to display saved execution state, with the same vertical stage-card style and chart controls. These assets are bundled locally.

Replay reads the retained artifact after byte-hash and run/policy/source identity checks; it never reruns an assessment. Stage completion and criterion satisfaction are separate, and the current reviewed findings remain separate from the recorded automation state. Earlier artifacts without a full recording receive an explicit legacy or unavailable view rather than invented replay frames or timings.

## Customizing this application

Users can install this repository locally and retain its ready-made Project / Method / Flow / Results interface, findings, human review, and saved replay. Versioned templates customize criteria, configured input paths, supported rules, and review requirements within the current assessment engine. The same chart builder, frozen inputs and method definitions, and real execution recordings continue to support those customized assessments.

This is a source-distributed application with a linear chart and software-assessment semantics; its npm package remains unpublished. An extensible framework is a future direction; custom collectors, new rule forms, or changes to the assessed domain currently require source modifications. There is no current plugin SDK. For guidance on customizing this app while preserving its evidence, finding, review, and replay contracts, see the accompanying [customize-assessmentfootprint skill](../skills/customize-assessmentfootprint/SKILL.md).

## Optional integrations

| Package | Local package observed during initial inspection | Potential role | Why it is not required now |
| --- | --- | --- | --- |
| AgentFootprint | `agentfootprint` `9.135.1` | A local-model reviewer or an assessment tool exposed through `defineTool` / `runbookAsTool`, with `coverage`, `absent`, and `describedResult` envelopes. | Current criteria are deterministic or human-reviewed. A model runtime adds no necessary capability. |
| AgentFootprint Lens | `agentfootprint-lens` `0.72.1` | Recorded agent replay using `lensRecorder`, `observeRecording`, and `<Lens>`, plus findings/coverage/proof views. | An actual AgentFootprint integration could supply the agent recording it expects. Explainable UI already displays the current deterministic workflow; adding Lens does not justify manufacturing agent events. |
| HCIFootprint | `hcifootprint` `2.6.0` | Typed action definitions and journey/session records for an agent-operable review interface. | Displaying findings and submitting a human review does not yet require a declared agent action graph. |
| VizFootprint | `vizfootprint` `0.1.0`, private | `buildDashboard`, interaction sessions, branching exploration, and provenance-aware chart actions. | At the initial inspection, the local package was private and the repository described a pre-alpha state. Its coordinated analysis dashboard is not required for the implemented assessment and replay surfaces. |

These optional-package versions are historical observations from the focused local repositories inspected during initial implementation on October 8, 2026. They are not current release claims or promises of compatibility with arbitrary published versions. Existing ecosystem repositories were not modified.

Primary projects: [AgentFootprint](https://github.com/footprintjs/agentfootprint), [Lens](https://github.com/footprintjs/agentfootprint-lens), [HCIFootprint](https://github.com/footprintjs/hcifootprint), [VizFootprint](https://github.com/footprintjs/vizfootprint).

No `EvidenceFootprint` package or export alias was found in the five focused local package manifests/source trees. This does not establish that no private or future project uses the name. The implementation therefore does not claim or depend on an existing EvidenceFootprint layer.

## Existing assessment tools

The OSV adapter integrates [OSV-Scanner](https://github.com/google/osv-scanner), rather than recreating a vulnerability database. It stores raw results and applies a small declared criterion rule while preserving missing-data states. Native scanner installation and advisory preparation remain separate from scanning the assessed project.

[npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/) and [OpenSSF Scorecard](https://github.com/ossf/scorecard) are not implemented adapters. npm audit normally sends dependency information to a registry; Scorecard's complete assessment includes hosted-repository information unavailable in a passive local folder scan. Future adapters should state these boundaries explicitly instead of silently converting a local assessment into a token-dependent remote operation.

The distinction this product aims to make is a reviewable assessment record: frozen inputs, scoped findings, preserved original evidence, and attributed human judgments. Scores, rule explanations, and vulnerability results already exist elsewhere. FootprintJS contributes execution provenance; judgment quality and evidence completeness still require their own explicit treatment.
