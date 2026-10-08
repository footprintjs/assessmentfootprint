# Reuse analysis

The first implementation reuses the part of the FootprintJS ecosystem that fits a deterministic local assessment: the execution recorder. It keeps assessment-domain evidence, findings, review history, and persistence in this repository, so a domain finding is not forced into an agent-specific concept.

## Used now: FootprintJS

`package.json` pins published package `footprintjs` to `9.44.1`. The core imports `flowChart` and `FlowChartExecutor` from the main public export. It creates an input-digest stage, adds an asynchronous stage for each selected criterion, enables narrative capture, and executes the chart. The resulting workflow evidence includes the real commit log and write provenance.

This gives the workbench a replayable account of how its own evaluation state changed without adding an LLM runtime. It does not independently validate the external evidence or prove that a criterion was well chosen. File snapshots/hashes, scanner diagnostics, and criterion limitations remain AssessmentFootprint's responsibility. The first browser displays retained workflow evidence as an original artifact; it does not include an animated Lens replay surface.

FootprintJS also exports `decide` for rule/operand evidence and tracing helpers under `footprintjs/trace`. Those are potential additions when more expressive deterministic policies justify them; the initial file checks are ordinary criterion evaluators rather than fabricated `decide` branches.

Primary project: [FootprintJS](https://github.com/footprintjs/footPrint).

## Optional integrations

| Package | Verified local package | Potential role | Why it is not required in this slice |
| --- | --- | --- | --- |
| AgentFootprint | `agentfootprint` `9.135.1` | A local-model reviewer or an assessment tool exposed through `defineTool` / `runbookAsTool`, with `coverage`, `absent`, and `describedResult` envelopes. | Current criteria are deterministic or human-reviewed. A model runtime adds no necessary capability. |
| AgentFootprint Lens | `agentfootprint-lens` `0.72.1` | Recorded agent replay using `lensRecorder`, `observeRecording`, and `<Lens>`, plus findings/coverage/proof views. | Its recording contract expects agent events; the current deterministic trace does not manufacture those. The existing browser also has no React/xyflow dependency. |
| HCIFootprint | `hcifootprint` `2.6.0` | Typed action definitions and journey/session records for an agent-operable review interface. | Displaying findings and submitting a human review does not yet require a declared agent action graph. |
| VizFootprint | `vizfootprint` `0.1.0`, private | `buildDashboard`, interaction sessions, branching exploration, and provenance-aware chart actions. | The local workspace package is private and its public repository describes a pre-alpha state. The initial workbench needs a simple results/evidence interface, not a coordinated analysis dashboard. |

These versions describe the focused local repositories inspected during implementation, not promises of compatibility with arbitrary published versions. Existing ecosystem repositories were not modified.

Primary projects: [AgentFootprint](https://github.com/footprintjs/agentfootprint), [Lens](https://github.com/footprintjs/agentfootprint-lens), [HCIFootprint](https://github.com/footprintjs/hcifootprint), [VizFootprint](https://github.com/footprintjs/vizfootprint).

No `EvidenceFootprint` package or export alias was found in the five focused local package manifests/source trees. This does not establish that no private or future project uses the name. The implementation therefore does not claim or depend on an existing EvidenceFootprint layer.

## Existing assessment tools

The OSV adapter integrates [OSV-Scanner](https://github.com/google/osv-scanner), rather than recreating a vulnerability database. It stores raw results and applies a small declared criterion rule while preserving missing-data states. Native scanner installation and advisory preparation remain separate from scanning the assessed project.

[npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/) and [OpenSSF Scorecard](https://github.com/ossf/scorecard) are not implemented adapters. npm audit normally sends dependency information to a registry; Scorecard's complete assessment includes hosted-repository information unavailable in a passive local folder scan. Future adapters should state these boundaries explicitly instead of silently converting a local assessment into a token-dependent remote operation.

The distinction this product aims to make is a reviewable assessment record: frozen inputs, scoped findings, preserved original evidence, and attributed human judgments. Scores, rule explanations, and vulnerability results already exist elsewhere. FootprintJS contributes execution provenance; judgment quality and evidence completeness still require their own explicit treatment.
