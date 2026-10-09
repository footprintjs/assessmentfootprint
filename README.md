# AssessmentFootprint

A local software assessment workbench that keeps reusable policies, findings, their evidence, and human judgments together. Create a saved assessment template, choose a local folder or fetch a public GitHub repository or npm package, run its scoped checks, inspect the original evidence, record required human reviews, and export the result.

The browser and CLI use the same assessment engine and saved templates. There is no hosted service, account, GitHub token, or paid model dependency. The built-in template assesses selected documents and lockfiles of a root Node.js package. Custom templates can configure bounded file/JSON checks, supported lockfile scans, and expert judgments; they do not turn a selected folder into a complete software-system assessment. The default template is offline; a saved template controls its own offline/online profile.

Every run is labelled **self-assessment**. Reviewer names are declared locally, not independently authenticated. Results are not JRC certification, institutional endorsement, or proof of software safety or legal compliance.

## Run from this checkout

Install [Node.js 24 or newer](https://nodejs.org/en/download), then open a terminal in this repository:

```sh
npm ci
npm start -- /absolute/path/to/project
```

`npm ci` installs this workbench's dependencies. The assessed project is never installed by the assessment engine. Node runs the engine and CLI TypeScript source directly. The browser replay viewer uses a locally bundled React application; this checkout includes its generated assets and does not load libraries from a CDN. After changing viewer source or dependencies, rebuild those assets with `npm run build:viewer` before launching Studio.

Studio opens a local browser page and prints its address. The server listens on `127.0.0.1`, using a free port unless one is specified. Stop it with Ctrl+C.

### First trial

1. Start Studio using the instructions above. A local folder is optional: `npm start` opens the workbench with the current folder selected.
2. In **Project**, keep **Local folder**, or select **GitHub repository** / **npm package** and choose **Fetch project**. For example, enter a public repository URL or `footprintjs@9.44.1`. A remote source is downloaded to this computer before assessment. Choose **Continue to Method**; a local folder is inspected before advancing.
3. In **Method**, keep the built-in **Local open-source readiness** template for the first run. Continue to **Flow**, click a stage to see its rule and evidence requirements, then choose **Run assessment**.
4. In **Results**, use **Findings** to inspect the source scope, original evidence, and required human reviews. Switch to **Replay what happened** to explore the saved execution. Missing files or an unavailable scanner remain visible as negative or incomplete findings. The governance stage waits for a human review.
5. Export HTML or JSON when ready to share the assessment. These exports contain source paths and supplied reviewer details, so inspect them before sharing.

No model, API key, account, or cloud service is needed for these built-in checks. GitHub/npm fetching needs an Internet connection; file checks run locally, and offline vulnerability checks additionally need the optional scanner and its prepared advisory database. The public link selects **what to assess**, not where the assessment runs.

```sh
npm start -- /absolute/path/to/project --port 4317 --no-open
```

Use the path syntax appropriate to your platform; quote paths containing spaces. The runtime targets macOS, Linux, and Windows with Node 24+. This does not claim that every platform has been exercised by the local verification run.

This repository is currently `private: true` and unpublished. There is no published npm installation or `npx` launch to rely on. To make the checkout's `assessment` command available on your local PATH, optionally run `npm link` from this repository. Otherwise use the direct commands below.

## CLI

```sh
node bin/assessment.mjs tools
node bin/assessment.mjs run /absolute/path/to/project --json
node bin/assessment.mjs run /absolute/path/to/project --criteria project-metadata,license-evidence,security-policy
node bin/assessment.mjs report RUN_ID --format html --output ./assessment-report.html
node bin/assessment.mjs report RUN_ID --format json --output ./assessment-report.json
node bin/assessment.mjs --help
```

Saved templates have their own CLI commands:

```sh
node bin/assessment.mjs templates list --json
node bin/assessment.mjs templates show TEMPLATE_ID --version 1 --json
node bin/assessment.mjs templates import ./policy.json --json
node bin/assessment.mjs templates import ./policy-update.json --expected-version 1 --json
node bin/assessment.mjs templates export TEMPLATE_ID --version 1 --output ./policy-export.json
node bin/assessment.mjs run /absolute/path/to/project --template TEMPLATE_ID --template-version 1 --json
```

Replace `TEMPLATE_ID` with an identifier shown by `templates list` or returned on import. These commands also accept `--data-dir PATH`. Without a pinned template version, a run uses the latest saved version. A saved-template run cannot combine `--criteria` with `--template`; a network option must agree with the template's saved profile. Publish a new template version to change its configuration.

After optional `npm link`, replace `node bin/assessment.mjs` with `assessment`.

The project path defaults to the current working directory. Stored data defaults to `.assessmentfootprint` **in the current working directory**, not necessarily in the assessed project. `studio`, `run`, and `report` accept `--data-dir PATH`; use the same directory when reading an earlier run.

```sh
node bin/assessment.mjs run /absolute/path/to/project --data-dir ./assessment-data
node bin/assessment.mjs studio /absolute/path/to/project --data-dir ./assessment-data
node bin/assessment.mjs report RUN_ID --format json --data-dir ./assessment-data
```

`run` exit codes describe the findings, with the following precedence:

| Code | Meaning |
| --- | --- |
| `3` | An evaluation error, execution/argument error, or interrupted operation. |
| `1` | At least one criterion is `not_satisfied`, and no evaluation error takes precedence. |
| `2` | Incomplete evidence or pending human review, with no preceding error or negative result. |
| `0` | No negative, incomplete, or error result; `not_applicable` results are allowed. |

A completed run means that the selected checks finished. It can still contain negative or incomplete findings. Selecting all six criteria normally leaves governance review pending until a person records a judgment in Studio. An empty-scope or skipped criterion is not a security assurance.

## Flow workspace

Studio uses four focused steps: **Project** selects the subject, **Method** selects or configures the assessment policy, **Flow** shows the connected chart built by the same FootprintJS definition that runs the checks, and **Results** shows the saved run's report and replay. Your source inputs, fetched folder, and method selection stay in place when moving between steps. Results is disabled for a new draft until a run has been saved. A recorded run locks Project and Method. **New assessment** returns to Project setup without launching checks; fresh evaluation starts with **Run assessment** in step **3 · Flow**. An unpublished flow editor also locks setup until **Leave draft**, which retains it in Templates.

The Flow chart runs from top to bottom and automatically fits the available viewport. Click a node to inspect its rule, evidence paths, tool, and review requirement. On wider screens, the inspector scrolls independently alongside the chart; on mobile, switch between **Chart** and **Selected stage**. Larger graphs support zoom, drag panning, **Fit chart**, and the stage selector, which also provides a keyboard alternative. Fitting a large graph may require zooming in to read individual stages. Arrows retain the actual evaluation order, not causal dependencies between findings.

Choose **Configure stage** or **Edit flow** to use the template editor in the side inspector. The initial node opens flow settings; a criterion node opens its rule and collector controls. Copies of the built-in policy become custom drafts. Draft edits are validated by the engine and must be published before running. **Publish flow** selects the returned exact version. Older versions and runs remain unchanged; editing an older saved version cannot silently replace a newer one. **Leave draft** retains the unfinished editor in Templates and restores the workspace's selected published method.

**Run assessment** in step **3 · Flow** freezes the selected policy and displays actual engine events on the nodes. File capture is shown as an activity before the evaluation chart, not as a fabricated chart stage. A node's execution state and current criterion finding are separate: a finished check can be negative or inconclusive. Fast steps can finish between browser repaints; the saved replay retains their execution order. Results opens when automation ends, with human review still pending where required. Opening a run from history also opens Results.

Results uses the same fixed workspace shell as Flow, with separate **Findings** and **Replay what happened** panes. Findings contains criterion judgments, original evidence, and review forms. Replay uses the same vertical chart style, with playback and chart controls above it, and moves through the saved execution without rerunning the assessment. **View recorded flow** or step **3 · Flow** returns to the same run's stored, integrity-checked chart; step **4 · Results** returns to that run's results. Chart finding badges show current judgments, including subsequent review, while replay preserves the original evaluation state. Older runs without full recording data keep their limited-history or unavailable message. A lost live connection does not cancel or automatically restart the local assessment; inspect its saved report or Run history before starting another.

Returning from Flow to the same run restores the chosen Findings/Replay pane and selected replay step within the current Studio page. Opening a different run from history starts in Findings, and its replay starts at the first step. This navigation state stays in browser memory; it does not change the saved assessment or recording and is not retained after reloading the page.

## GitHub and npm sources

In Studio, choose **GitHub repository** or **npm package** under **Project source**, enter a public link, and choose **Fetch project**. Fetching explicitly uses the Internet and saves files in this workspace's data directory. The subsequent assessment uses the same local engine and selected template network policy as a local-folder run; fetching does not switch an offline template to online mode. No assessed-package installation, dependency installation, build, or lifecycle script runs.

A GitHub source is resolved to an exact commit before its archive is downloaded. An npm source is resolved to an exact published version; the download is checked against the registry's integrity metadata. The source pin and archive SHA-256 are retained with the project and report. The assessment still freezes and hashes its selected input files independently. If those selected files have changed locally since download, the report identifies that difference instead of treating the original pin as proof of the assessed bytes.

An npm package is its **published archive**, which may omit repository source, tests, documentation, or lockfiles. Missing files are findings about that archive, not proof that the development repository lacks them. A GitHub archive contains a single revision without Git history or a recursive checkout of submodules. Private sources, custom registries, and authentication tokens are not supported; use an existing local checkout for those. Fetched folders remain available locally for later assessments.

## Tool configuration direction

Current collectors use local files and an optional locally installed OSV-Scanner. A future tool adapter could offer **Local installation** or **Remote API**, with local availability checks for the first and an endpoint plus an optional credential reference for the second. Remote assessment services are a planned extension, not a current feature.

That extension should keep credentials out of shared templates, evidence, and exported reports; declare the inputs sent to the service; require a network-enabled assessment policy; and retain the actual service response and tool identity as evidence. The same rules for missing evidence and human review must apply to either tool location. See the [architecture notes](docs/architecture.md#future-remote-tool-adapters) for the intended boundary.

## Saved templates

Studio's Templates view creates new templates, copies the built-in template, edits saved policies, publishes new versions, and imports/exports JSON manifests. A browser import opens an unpublished copy for inspection; publishing gives it a new local identity and history. Configure the template's name, description, network profile, criterion definitions, evidence requirements, collector paths, evaluation rules, and review requirements. The same published version can then assess different local projects through Studio or the CLI.

A template contains 1–32 criteria. A criterion chooses one registered collector: `project-files` or `osv-scanner`; there is no custom executable or shell-command field. Each collector declares 1–32 unique, portable paths relative to the assessed project, with at most 128 unique configured paths across the template. Nested paths are supported. Absolute paths, Windows/backslash paths, parent traversal, root `.git` inputs regardless of capitalization, and paths escaping the project through symlinks are rejected. Each captured file is limited to 8 MiB; the total captured snapshot is limited to 32 MiB. Root `package.json` is also captured when present to identify the subject, even when it is not a criterion's input; its bytes count towards the total.

Each criterion supports up to 20 authored evidence-requirement descriptions. Requiring human review adds a retained attributed-review requirement when needed. Blank requirements default to the collector paths, or one explicit reference to those paths for larger lists, so an application-generated manifest remains valid when read, edited, or imported again.

Supported evaluation rules are:

| Rule | Meaning |
| --- | --- |
| `builtin` | Reuse a built-in criterion at its declared revision and fixed evidence paths. Its scope stays the same as the built-in rule. |
| `files` | Require all or any configured files to exist and meet a minimum byte count. This does not validate their meaning or operational effectiveness. |
| `json-field` | In exactly one configured JSON file, require an explicit own field to exist or equal a string, finite number, boolean, or null. Nested field components are arrays, and traversal does not read inherited prototype properties. |
| `vulnerabilities` | Require a usable OSV v2 scan of configured supported lockfiles to report no more than a declared finding count. Missing tools/data/coverage never satisfy the threshold. This counts findings, not severity, exploitability, or unique CVEs. |
| `expert` | Collect the configured documents and require an attributed human decision against the stated evidence requirements. |

Any automatic rule can additionally require human review. The run retains its `automaticResult` and remains pending until review; a human disagreement updates the current judgment without rewriting that automatic result or the raw evidence. Expert rules always require review.

For example, save the following JSON as `policy.json` and import it with the command above:

```json
{
  "name": "Release documentation",
  "description": "Check release guidance and review whether it is usable.",
  "networkMode": "offline",
  "criteria": [
    {
      "id": "release-guidance",
      "title": "Release guidance",
      "description": "The release procedure should be documented and reviewed.",
      "dimension": "Release process",
      "evidenceRequirements": ["A documented release procedure a maintainer can follow"],
      "collector": { "toolId": "project-files", "paths": ["docs/RELEASE.md"] },
      "evaluation": { "kind": "files", "match": "all", "minimumBytes": 50 },
      "requiresReview": true
    }
  ]
}
```

Importing this draft without an ID generates a local template identifier and publishes version 1. Publishing an edit stores a new version; earlier versions are retained. Edits supply the current `expectedVersion` so a stale editor cannot overwrite newer work. The built-in template is read-only and must be copied before modification. Criterion rule prose is generated from validated configuration, rather than trusted from imported descriptions.

Exported manifests include the template ID, version, creation time, policy digest, and normalized criteria. CLI/API import revalidates their configuration and publishes a local version directly. A custom ID absent from the local store starts at local version 1 and must not claim an existing destination version. An existing ID requires an explicit `expectedVersion` for the **destination store's current version** and publishes the next local version; in the CLI, supply `--expected-version N`. The exported source version is never a destination concurrency guard. Importing the built-in ID makes a custom copy. Studio instead opens imported JSON as a new draft for review before publication. Incoming creation time, version history, origin labels, and digest are not trusted as external provenance; identical normalized content can share a policy digest without proving authorship.

Every assessment freezes the exact selected template manifest, policy digest, criterion definitions, requested input paths, captured file hashes, results, evidence, and reviews. Editing a template later does not change an earlier run. Template version numbers and assessment review revision numbers are separate.

## The built-in six criteria

| Identifier | Rule and scope |
| --- | --- |
| `project-metadata` | Root `package.json` must be a JSON object with non-empty string `name` and `version`. This checks identity, not package maturity. Without a root manifest, the criterion is not applicable. |
| `license-evidence` | A non-empty string `license` declaration in the manifest and a non-empty root `LICENSE`, `LICENSE.md`, `LICENSE.txt`, or `LICENCE` document must both exist. There is no SPDX, legal-validity, or compatibility determination. |
| `security-policy` | A non-empty root `SECURITY.md` or `.github/SECURITY.md` must exist. The reporting channel and its effectiveness are not tested. |
| `dependency-lockfile` | A readable, non-empty root `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, or `yarn.lock` must exist. JSON lockfiles must parse as objects. Manifest/lockfile consistency and reproducible builds are not established. Without a root manifest, this is not applicable. |
| `dependency-vulnerabilities` | OSV-Scanner v2 checks the frozen root lockfiles. A usable scan identifying packages and reporting vulnerabilities is not satisfied; a usable scan identifying packages and reporting none is satisfied only within that scan's scope. Missing scanners, unsupported scanner versions, missing databases, empty package coverage, or unusable output remain insufficient evidence. Without a root manifest, this is not applicable. |
| `governance-review` | A person inspects available governance, contribution, and README documents, identifies decision authority and contributor participation, and records a decision with a rationale. Document presence alone does not satisfy this criterion. |

The built-in template is `oss-readiness`, published template version `1`, using built-in rule revision `0.1.0`. Each run stores its policy digest, copies of the selected criterion definitions, and their results, so an older finding keeps the rule it was assessed against. It has no aggregate score that turns missing evidence into a passing mark. One-off built-in criterion selection remains available and is captured as its own run policy.

## Optional OSV-Scanner

Only OSV vulnerability rules require an external scanner. File/JSON checks, expert review, template configuration, and the browser work without it. Use the [official OSV installation instructions](https://google.github.io/osv-scanner/installation/) and ensure the installed native executable is on PATH:

```sh
# macOS or Linux with Homebrew
brew install osv-scanner
```

```powershell
# Windows
winget install Google.OSVScanner
```

Prebuilt Linux, macOS, and Windows binaries are also available from [OSV's releases](https://github.com/google/osv-scanner/releases). Confirm the scanner reports a v2 version with `osv-scanner --version` and inspect workbench availability with `node bin/assessment.mjs tools`.

Prepare advisory data separately while connected to the internet. OSV documents automatic downloads through `--download-offline-databases` combined with offline mode, and manual ecosystem database downloads. For an npm root lockfile, a preparation scan can be:

```sh
osv-scanner scan source --offline --download-offline-databases --no-call-analysis=go --lockfile=/absolute/path/to/project/package-lock.json
```

Use the appropriate actual lockfile path. A vulnerability finding can produce a non-zero scan exit even after the database download. The workbench inherits `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY` when set. For **OSV-Scanner 2.6.0**, set that variable to the cache base directory and place an npm database at `<cache-base>/osv-scalibr/npm/all.zip`. The scanner uses the Scalibr cache layout; older offline documentation shows an `osv-scanner` suffix. The exact current layout is confirmed by [OSV 2.6.0's environment binding](https://github.com/google/osv-scanner/blob/v2.6.0/cmd/osv-scanner/internal/helper/flags.go) and [its pinned Scalibr database-path implementation](https://github.com/google/osv-scalibr/blob/3090dbb7aaa2/enricher/vulnmatch/osvlocal/matcher.go). Moving an existing downloaded `npm/all.zip` into the correct layout avoids downloading it again. See [OSV's offline-mode documentation](https://github.com/google/osv-scanner/blob/main/docs/offline-mode.md) for ecosystem downloads. Offline preparation is not performed automatically by AssessmentFootprint.

During assessment, the adapter passes only explicit frozen configured lockfiles to `scan source`, requests JSON and all package records, and disables Go call analysis. The built-in rule uses root lockfiles; custom vulnerability rules may select nested lockfiles with supported filenames. Offline mode adds OSV's `--offline` flag. It does not install the project, invoke build or test scripts, remediate dependencies, recursively discover packages, or scan source reachability. [OSV documents](https://google.github.io/osv-scanner/usage/scan-source) the separate call-analysis behavior and its additional execution requirements.

To permit OSV's online advisory lookup for a one-off run, supply `--online`, or select online mode in Studio. For a saved template, publish its network profile as online. That can disclose dependency identifiers to OSV services; it still runs on the laptop. Offline results reflect locally available advisory data. Raw scan output is preserved, but this version does not bundle or timestamp the complete advisory database for reproducible historical matching.

## Evidence and review

The data directory contains `assessment.sqlite` and `runs/<run-id>/`. SQLite holds published template versions as well as run records. Selected input files are copied into a run's `inputs/` folder before evaluation. Evidence records identify their source, collection time, tool and version, byte size, SHA-256 digest, and local raw artifact reference. The original scanner JSON, diagnostics, and FootprintJS workflow are retained as evidence.

FootprintJS `9.44.1` actually executes a linear chart: an input-digest stage followed by the selected criterion stages. A workflow evidence artifact retains its full runtime snapshot, chart structure, scope state, commits, write provenance, narrative, and stage metrics captured during execution. Each recording identifies the assessment, captured policy, and input digest. This is recorded execution, not an explanation generated after the result.

Studio's execution replay uses `footprint-explainable-ui` `0.38.0` to show the recorded chart, execution steps, finding context, scope state after each step, and measured evaluation durations. Selecting an earlier step shows the findings recorded by that point. The full recorded narrative remains in the original workflow evidence. Loading replay reads the retained artifact and does not rescan the project or rerun its checks. Artifact hashes and assessment/policy/input identity are checked before replay. Older flat workflow artifacts receive an explicit limited-history view; a run without a recording reports that replay is unavailable. Missing chart structure or timings are not reconstructed as facts.

Replay covers **automated evaluation after input collection**. The initial stage records the already captured input digest; its duration is not file-collection time. A stage finishing means execution completed, even if its finding is negative or incomplete. Later human review appears in the current findings and review history while the automation recording stays unchanged. Scope reads/writes and evidence references do not establish a complete causal proof from every source-file byte to a decision.

The state adapter rounds stage timings to milliseconds. Studio's timeline instead uses the raw saved Metrics durations to four significant digits, preserving fractional measurements; its stage offsets sum those displayed durations for this sequential evaluation. A recorded zero remains a measured zero. If measurements are missing, incomplete, or invalid, the viewer shows untimed execution order without inventing durations. The frozen overlay has no wall-clock step timestamps or reconstructed live-error channel.

Studio shows run history, criterion findings, original evidence, and attributed review forms for criteria requiring review. Reviews append to the review history, increment the run revision, and update the current finding within a database transaction; an automatic result remains separately available. The automation completion timestamp is separate from final completion: a run awaiting review keeps its final completion timestamp unset. HTML and JSON reports include findings, retained rules and evidence requirements, the exact captured template, automatic results, evidence metadata, limitations, and review history; raw artifact files remain in the local data directory and are not embedded as a portable evidence bundle. Evidence reads verify stored bytes against their recorded digest; exports also verify frozen inputs and consistency of retained policy/criterion/network/framework metadata. These hashes are integrity checks, not signatures or independent authentication of the whole local record.

Git HEAD is recorded only as contextual metadata where available. The workbench deliberately does not run `git status`, which can invoke repository-defined filters; `gitDirty` remains unknown and the frozen inputs can differ from that commit. If a run's owning process exits before finalisation, reopening its data directory records the abandoned run as interrupted while retaining completed evidence. Start a new assessment to finish the checks; recovery does not resume an arbitrary subprocess.

## Development and current limits

```sh
npm run check
```

This checks engine/CLI and viewer TypeScript, verifies that the locally bundled viewer assets match their source, and runs the test suite. Build updated viewer assets with `npm run build:viewer`. Avoid claiming a verification count without running the current suite.

Template configuration is limited to the declared collectors and rule forms above. Arbitrary programs, arbitrary DSL expressions, custom script runners, severity-based vulnerability policies, npm-audit/Scorecard adapters, remote governance checks, repository cloning, automatic multi-package discovery, general language/toolchain evaluation, local-model judgments, authenticated independent reviewers, and hosted collaboration are not implemented. A custom template can select nested files or supported lockfiles, but only those explicit inputs are assessed. No whole-source or installed-dependency inventory is inferred.

See [architecture](docs/architecture.md) and [reuse analysis](docs/reuse-analysis.md) for implementation boundaries.

## Prepared tools on this workspace

The initial local checkout has a verified OSV-Scanner 2.6.0 binary and a downloaded npm advisory database in its ignored `.tools/` directory. The launcher uses tools from its own application installation, never from the assessed project. `npm start` therefore supports the prepared offline scan on this machine. These machine-specific files are not committed to Git; other checkouts should follow the OSV setup instructions above. The release and database checksums are recorded in `.tools/INSTALLATION.json`.
