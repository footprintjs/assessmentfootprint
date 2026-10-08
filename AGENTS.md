# AssessmentFootprint agent instructions

AssessmentFootprint is a local Node 24+ application, currently private and unpublished. Work in this repository only unless the user requests changes elsewhere. Existing FootprintJS ecosystem repositories are separate dependencies, not an invitation to edit them.

## Core contract

- `src/core.ts` is the shared assessment engine. The CLI and browser server must reuse it; never implement different finding rules in the two interfaces.
- Preserve the distinction between source evidence, criterion findings, and human review. Every factual result must come from captured bytes, actual tool output, or an explicitly attributed reviewer decision.
- Keep criteria narrow and versioned. Changes to the built-in catalogue/rules require a framework version and policy-digest review. Missing tools, missing data, invalid output, or unestablished package coverage must never become a passing result.
- Keep `not_applicable`, `insufficient_evidence`, `not_satisfied`, and `evaluation_error` distinct. Workflow completion does not mean every criterion is satisfied. Preserve documented CLI exit-code precedence.
- Preserve frozen selected inputs, source hashes, original scanner output, diagnostics, tool versions, limitations, and review history. Do not claim a whole-repository snapshot when only named root inputs were collected.
- FootprintJS actually runs the evaluation chart. Capture trace state/narrative during traversal; do not invent agent events or post-hoc explanations that pretend to be recorded execution.

## Execution and local boundaries

- Default to offline assessment. External advisory downloads and optional online scans must remain explicit operations, with their network scope described accurately.
- Collectors must not install the assessed project, execute its lifecycle/build/test scripts, invoke dependency remediation, or run repository-supplied commands. Use direct executable calls with argument arrays, never a shell assembled from project paths or input.
- Keep OSV scans on explicit frozen root lockfiles, with Go call analysis disabled. A broader scanner mode requires its own declared scope and meaningful verification.
- Retain artifact containment/hash checks and the loopback host/origin/session boundary. Render project documents and reviewer text as untrusted data. Do not add arbitrary file-serving endpoints.
- Reviewer identity is locally declared. Do not label a self-assessment as independently authenticated, certified, or endorsed by JRC or another institution.

## Source and verification

Use the existing ESM/native TypeScript style with `.ts` local import extensions and `import type` for types. Avoid runtime TypeScript syntax unsupported by Node's type stripping. Keep runtime dependencies proportionate to delivered capabilities; AgentFootprint, Lens, HCI, and Viz integrations are optional until their actual use is implemented.

Run `npm run check` after relevant changes. Add meaningful tests for changes to evidence interpretation, storage, process execution, CLI status, and local HTTP boundaries. Check documentation against current behavior; never fabricate scanner results, test counts, supported platforms, or a published npm launcher. Update the README and architecture notes when the supported scope changes.
