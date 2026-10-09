---
name: customize-assessmentfootprint
description: Customize an installed AssessmentFootprint workbench for a user's own checks, evidence, tools, and review process while retaining its ready-made flow, results, and replay UI. Use for template configuration or focused source extensions to this application.
---

# Customize AssessmentFootprint

Keep the installed application's working UI and recording engine. Adapt the user's checks and review process within that foundation. Today this is a configurable assessment app: templates are supported, while custom collectors and new rule forms require source changes. There is no drop-in plugin SDK.

## Find the installation and the need

Locate the app checkout and its `AGENTS.md` from the user's context. When this skill lives in that checkout's `skills/` directory, the app root is two directories above this skill directory. A copy installed in an assistant's personal skills folder still needs the actual application path.

Identify the user's intended inputs, checks, result meaning, human-review requirements, and local-tool needs. Preserve the existing UI unless the request needs a specific change. Do not scaffold a second app just to add another policy. Keep saved user runs and template history; perform verification with a separate data directory.

## Choose configuration before code

| User need | Supported path |
| --- | --- |
| Different document paths, file presence/size rules, explicit JSON field checks, supported-lockfile vulnerability thresholds, or human judgment | Create or copy a versioned template. Use existing collectors and rule forms. |
| New local collector or new kind of evaluation | Make a focused source extension in the installed app. Update types, validation, execution, tool availability, editor, reporting, and tests as needed. |
| A different domain model, branching, mid-run approval/resume, remote service, or model-based decision | Explain the additional capability required and implement only the requested scope. These are not available merely by importing a template. |

### Template customization

Read the README's Saved templates section and `src/types.ts` / `src/templates.ts` for exact forms and bounds. Use `builtin`, `files`, `json-field`, `vulnerabilities`, or `expert` as appropriate. Each criterion declares its actual evidence paths and rule; prose does not add executable behavior. File presence does not establish document quality.

Use [assets/release-handoff-policy.json](assets/release-handoff-policy.json) as a small importable example when helpful. It checks an explicit JSON value and separately requests expert review. Adapt paths, values, and evidence requirements to the user's actual need. Do not assume the example's release policy is appropriate for every domain.

Validate a new policy in an isolated data directory through the existing engine or CLI, including a meaningful incomplete/negative case. A new policy without an ID gets a generated identity and version 1. Updating an existing CLI/API policy needs its destination `expectedVersion` and publishes a new immutable version; the built-in template is read-only. Browser import opens a new draft copy. Do not rewrite historical policies or reinterpret saved runs.

Deliver the JSON and exact import steps. Publish it to the user's live store when requested or already authorized; preparing a policy for review alone does not authorize replacing their selected configuration.

### Source extension

Read [references/implementation-map.md](references/implementation-map.md) and the relevant app source before editing. Check the lockfile and installed APIs; the map's pinned versions describe the reference, not arbitrary later versions. Preserve one shared engine and validation path for browser and CLI. A template's `toolId` is a validated choice, not a dynamic module loader; declaring a new string alone cannot register a tool.

Keep the shared chart builder as the source of both preview and actual execution. Extend real callbacks and persisted outcomes; do not simulate progress for a new tool. Record its identity/version, scoped inputs, actual output, errors, and limitations. Missing tools or unusable output must remain incomplete/error outcomes. Default to local operation. Remote tools need explicit network/data behavior and credentials outside templates, recordings, and exports; that integration does not already exist.

Retain bounded paths, artifact hashes, and local HTTP/session checks. Use direct executable calls with argument arrays for trusted local tools, not commands assembled from user-controlled project text. Existing collectors never install or execute assessed-project scripts.

## Preserve the product contract

- Keep **Project → Method → Flow → Results**, stage selection/configuration, Findings, and saved Replay usable without forcing users through a new app.
- Execution completion and business outcome are distinct. Preserve negative, incomplete, not-applicable, and error states when they have different meanings.
- Record actual runtime snapshots, chart structure, narrative, and metrics with run/configuration/input identity. Validate the retained artifact before replay; selecting Replay or returning to Results must never rerun tools.
- Earlier replay steps show only state recorded by that point. Missing history or timing remains explicitly missing. Input capture precedes the reference chart; the first stage's timing is not collection time.
- Keep automatic results and later attributed human decisions separate. Human review updates current findings and review history without rewriting the automation recording. Current review happens after automation; mid-run pause/resume is a separate feature.
- Share chart geometry and controls across Flow and Replay. Preserve same-run pane/cursor state, reset it for another run, and guard late asynchronous responses from replacing current navigation.

## Verify and hand over

For template-only changes, verify real import/export and representative outcomes in isolated data. For source changes, follow the app's `AGENTS.md`; rebuild changed viewer source with `npm run build:viewer`, then run `npm run check`. Add checks for the new behavior and its failure modes rather than copying existing test wording. Use browser verification at desktop and narrow widths if the UI changes.

Report what the user can now customize, how to apply/use it, what was verified, and remaining limitations. Distinguish template configuration, a source extension, and a future plugin capability. Do not claim a published package, an authenticated reviewer, certification, or a general framework feature that was not implemented.
