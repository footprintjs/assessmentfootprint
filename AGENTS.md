# AssessmentFootprint agent instructions

AssessmentFootprint is a local Node 24+ application distributed as source on GitHub. Its npm package remains unpublished (`private: true` prevents accidental npm publishing). Work in this repository only unless the user requests changes elsewhere. Existing FootprintJS ecosystem repositories are separate dependencies, not an invitation to edit them.

For a request to customize this installed application for a user’s purpose, read `skills/customize-assessmentfootprint/SKILL.md` and load its implementation map if source changes are needed. `docs/agent-handoff.md` supplies portable prompts. Prefer supported template configuration and preserve the shared flow/results/replay UI. These instructions do not imply a plugin SDK or permission to change unrelated projects.

## Core contract

- `src/core.ts` is the shared assessment engine and `src/templates.ts` owns validated template configuration. The CLI and browser server must reuse them; never implement different template validation or finding rules in the two interfaces.
- Preserve the distinction between source evidence, criterion findings, and human review. Every factual result must come from captured bytes, actual tool output, or an explicitly attributed reviewer decision.
- Keep criteria narrow and versioned. Built-in rules retain explicit revisions; custom rules use the declared file/JSON/vulnerability/expert forms. Derive rule prose and policy digests from normalized configuration. Missing tools, missing data, invalid output, or unestablished package coverage must never become a passing result.
- Published template versions are immutable. A change publishes a new version with an expected-version guard; do not update old rows or the read-only built-in template. A run freezes its exact template manifest, criteria, digest, network profile, and inputs, so later edits do not reinterpret it. Imported version metadata is not authenticated external provenance.
- Keep `not_applicable`, `insufficient_evidence`, `not_satisfied`, and `evaluation_error` distinct. Workflow completion does not mean every criterion is satisfied. Preserve documented CLI exit-code precedence.
- Preserve frozen selected inputs, source hashes, original scanner output, diagnostics, tool versions, retained criterion definitions, revision numbering, limitations, and review history. Keep automation completion separate from final completion. Do not claim a whole-repository snapshot when only named root inputs were collected.
- An automatic criterion requiring review must retain its `automaticResult` before and after human judgment. Never overwrite that result to make the automatic evaluation appear to agree with the reviewer.
- FootprintJS actually runs the evaluation chart. Capture its full runtime snapshot, chart structure, narrative, and metrics during traversal; do not invent agent events or post-hoc explanations that pretend to be recorded execution. Replay must consume the stored artifact with hash and assessment/policy/source checks, never rerun checks to populate a historical view.
- Keep replay scope honest: it records automated evaluation after input capture, not file-collection timing or complete file-to-decision causal proof. Stage completion is separate from criterion satisfaction. Missing legacy structure, timing, wall-clock timestamps, and live error telemetry must remain absent. Human review must not rewrite the automation recording.

## Execution and local boundaries

- Default to offline assessment. External advisory downloads and optional online scans must remain explicit operations, with their network scope described accurately.
- Collectors must not install the assessed project, execute its lifecycle/build/test scripts, invoke dependency remediation, or run repository-supplied commands. Use direct executable calls with argument arrays, never a shell assembled from project paths or input.
- Keep OSV scans on explicit frozen configured lockfiles, with Go call analysis disabled. The built-in policy uses root lockfiles; custom paths remain portable, bounded, project-relative inputs. A broader scanner mode requires its own declared scope and meaningful verification.
- Preserve limits on criterion/path count, individual file size, total snapshot size, and imported bodies. A published template must remain exportable/importable within the supported bounds; verify real round trips rather than only configuration parsing.
- JSON-field rules traverse only explicit own keys at every component and use scalar equality without coercion. Do not introduce object/prototype merges while validating or hashing imported policies. Criterion identifiers must not collide with reserved object names.
- Retain artifact containment/hash checks and the loopback host/origin/session boundary. Render project documents and reviewer text as untrusted data. Do not add arbitrary file-serving endpoints.
- Keep Git inspection passive: avoid `git status` and repository-defined filters; an unknown dirty state is preferable to fabricated metadata. Preserve abandoned-run detection without presenting process-ID recovery as automatic job continuation.
- Reviewer identity is locally declared. Do not label a self-assessment as independently authenticated, certified, or endorsed by JRC or another institution.

## Source and verification

Use the existing ESM/native TypeScript style with `.ts` local import extensions and `import type` for types. Avoid runtime TypeScript syntax unsupported by Node's type stripping. The React replay source in `client/` is bundled separately with `npm run build:viewer`; retain locally generated assets and avoid remote CDN dependencies. Reuse installed Explainable UI adapters for recorded chart, state, and overlay rather than fabricating parallel trace semantics. AgentFootprint, Lens, HCI, and Viz integrations are optional until their actual use is implemented.

Run `npm run check` after relevant changes, including viewer type checking and bundle freshness. Add meaningful tests for changes to evidence interpretation, storage, process execution, replay compatibility, CLI status, and local HTTP boundaries. Check documentation against current behavior; never fabricate scanner results, test counts, supported platforms, or a published npm launcher. Update the README and architecture notes when the supported scope changes.
