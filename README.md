# AssessmentFootprint

A local software assessment workbench that keeps findings, their evidence, and human judgments together. Choose a project folder, run scoped checks, inspect the original evidence, record a governance review, and export the result.

The browser and CLI use the same assessment engine. There is no hosted service, account, GitHub token, or paid model dependency. Assessment runs default to offline mode. This first version assesses selected documents and lockfiles of a root Node.js package; it does not assess an entire software system.

Every run is labelled **self-assessment**. Reviewer names are declared locally, not independently authenticated. Results are not JRC certification, institutional endorsement, or proof of software safety or legal compliance.

## Run from this checkout

Install [Node.js 24 or newer](https://nodejs.org/en/download), then open a terminal in this repository:

```sh
npm ci
npm start -- /absolute/path/to/project
```

`npm ci` installs this workbench's dependencies. The assessed project is never installed by the assessment engine. The application runs its TypeScript source directly with Node; no application build step is required.

Studio opens a local browser page and prints its address. The server listens on `127.0.0.1`, using a free port unless one is specified. Stop it with Ctrl+C.

```sh
npm start -- /absolute/path/to/project --port 4317 --no-open
```

Use the path syntax appropriate to your platform; quote paths containing spaces. The runtime targets macOS, Linux, and Windows with Node 24+. This does not claim that every platform has been exercised by the local verification run.

This repository is currently `private: true` and unpublished. There is no published npm installation or `npx` launch to rely on. To make the checkout's `assessment` command available on your local PATH, optionally run `npm link` from this repository. Otherwise use the direct commands below.

## CLI

```sh
node src/cli.ts tools
node src/cli.ts run /absolute/path/to/project --json
node src/cli.ts run /absolute/path/to/project --criteria project-metadata,license-evidence,security-policy
node src/cli.ts report RUN_ID --format html --output ./assessment-report.html
node src/cli.ts report RUN_ID --format json --output ./assessment-report.json
node src/cli.ts --help
```

After optional `npm link`, replace `node src/cli.ts` with `assessment`.

The project path defaults to the current working directory. Stored data defaults to `.assessmentfootprint` **in the current working directory**, not necessarily in the assessed project. `studio`, `run`, and `report` accept `--data-dir PATH`; use the same directory when reading an earlier run.

```sh
node src/cli.ts run /absolute/path/to/project --data-dir ./assessment-data
node bin/assessment.mjs studio /absolute/path/to/project --data-dir ./assessment-data
node src/cli.ts report RUN_ID --format json --data-dir ./assessment-data
```

`run` exit codes describe the findings, with the following precedence:

| Code | Meaning |
| --- | --- |
| `3` | An evaluation error, execution/argument error, or interrupted operation. |
| `1` | At least one criterion is `not_satisfied`, and no evaluation error takes precedence. |
| `2` | Incomplete evidence or pending human review, with no preceding error or negative result. |
| `0` | No negative, incomplete, or error result; `not_applicable` results are allowed. |

A completed run means that the selected checks finished. It can still contain negative or incomplete findings. Selecting all six criteria normally leaves governance review pending until a person records a judgment in Studio. An empty-scope or skipped criterion is not a security assurance.

## The six criteria

| Identifier | Rule and scope |
| --- | --- |
| `project-metadata` | Root `package.json` must be a JSON object with non-empty string `name` and `version`. This checks identity, not package maturity. Without a root manifest, the criterion is not applicable. |
| `license-evidence` | A non-empty string `license` declaration in the manifest and a non-empty root `LICENSE`, `LICENSE.md`, `LICENSE.txt`, or `LICENCE` document must both exist. There is no SPDX, legal-validity, or compatibility determination. |
| `security-policy` | A non-empty root `SECURITY.md` or `.github/SECURITY.md` must exist. The reporting channel and its effectiveness are not tested. |
| `dependency-lockfile` | A readable, non-empty root `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, or `yarn.lock` must exist. JSON lockfiles must parse as objects. Manifest/lockfile consistency and reproducible builds are not established. Without a root manifest, this is not applicable. |
| `dependency-vulnerabilities` | OSV-Scanner v2 checks the frozen root lockfiles. A usable scan identifying packages and reporting vulnerabilities is not satisfied; a usable scan identifying packages and reporting none is satisfied only within that scan's scope. Missing scanners, unsupported scanner versions, missing databases, empty package coverage, or unusable output remain insufficient evidence. Without a root manifest, this is not applicable. |
| `governance-review` | A person inspects available governance, contribution, and README documents, identifies decision authority and contributor participation, and records a decision with a rationale. Document presence alone does not satisfy this criterion. |

The framework is `oss-readiness`, version `0.1.0`. Each run stores its policy digest, copies of the selected criterion definitions, and their results, so an older finding keeps the rule it was assessed against. It has no aggregate score that turns missing evidence into a passing mark.

## Optional OSV-Scanner

Only dependency-vulnerability assessment requires an external scanner. The other checks and the browser work without it. Use the [official OSV installation instructions](https://google.github.io/osv-scanner/installation/) and ensure the installed native executable is on PATH:

```sh
# macOS or Linux with Homebrew
brew install osv-scanner
```

```powershell
# Windows
winget install Google.OSVScanner
```

Prebuilt Linux, macOS, and Windows binaries are also available from [OSV's releases](https://github.com/google/osv-scanner/releases). Confirm the scanner reports a v2 version with `osv-scanner --version` and inspect workbench availability with `node src/cli.ts tools`.

Prepare advisory data separately while connected to the internet. OSV documents automatic downloads through `--download-offline-databases` combined with offline mode, and manual ecosystem database downloads. For an npm root lockfile, a preparation scan can be:

```sh
osv-scanner scan source --offline --download-offline-databases --no-call-analysis=go --lockfile=/absolute/path/to/project/package-lock.json
```

Use the appropriate actual lockfile path. A vulnerability finding can produce a non-zero scan exit even after the database download. The workbench inherits `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY` when set. For **OSV-Scanner 2.6.0**, set that variable to the cache base directory and place an npm database at `<cache-base>/osv-scalibr/npm/all.zip`. The scanner uses the Scalibr cache layout; older offline documentation shows an `osv-scanner` suffix. The exact current layout is confirmed by [OSV 2.6.0's environment binding](https://github.com/google/osv-scanner/blob/v2.6.0/cmd/osv-scanner/internal/helper/flags.go) and [its pinned Scalibr database-path implementation](https://github.com/google/osv-scalibr/blob/3090dbb7aaa2/enricher/vulnmatch/osvlocal/matcher.go). Moving an existing downloaded `npm/all.zip` into the correct layout avoids downloading it again. See [OSV's offline-mode documentation](https://github.com/google/osv-scanner/blob/main/docs/offline-mode.md) for ecosystem downloads. Offline preparation is not performed automatically by AssessmentFootprint.

During assessment, the adapter passes only explicit frozen root lockfiles to `scan source`, requests JSON and all package records, and disables Go call analysis. Offline mode adds OSV's `--offline` flag. It does not install the project, invoke build or test scripts, remediate dependencies, or scan source reachability. [OSV documents](https://google.github.io/osv-scanner/usage/scan-source) the separate call-analysis behavior and its additional execution requirements.

To permit OSV's online advisory lookup for a run, supply `--online`, or select online mode in Studio. That can disclose dependency identifiers to OSV services; it still runs on the laptop. Offline results reflect locally available advisory data. Raw scan output is preserved, but this version does not bundle or timestamp the complete advisory database for reproducible historical matching.

## Evidence and review

The data directory contains `assessment.sqlite` and `runs/<run-id>/`. Selected input files are copied into a run's `inputs/` folder before evaluation. Evidence records identify their source, collection time, tool and version, byte size, SHA-256 digest, and local raw artifact reference. The original scanner JSON, diagnostics, and FootprintJS workflow are retained as evidence.

FootprintJS `9.44.1` actually executes a linear chart: an input-digest stage followed by the selected criterion stages. Its state writes, commit log, write provenance, and narrative are saved in a workflow evidence artifact. This is recorded execution, not an invented explanation generated after the result.

Studio shows run history, criterion findings, original evidence, and an attributed governance-review form. Reviews append to the review history, increment the run revision, and update the current expert finding within a database transaction. The automation completion timestamp is separate from final completion: a run awaiting review keeps its final completion timestamp unset. HTML and JSON reports include findings, retained rules, evidence metadata, limitations, and review history; raw artifact files remain in the local data directory and are not embedded as a portable evidence bundle. Evidence reads verify stored bytes against their recorded digest; exports also verify frozen inputs. These hashes are integrity checks, not signatures or independent authentication of the whole local record.

Git HEAD is recorded only as contextual metadata where available. The workbench deliberately does not run `git status`, which can invoke repository-defined filters; `gitDirty` remains unknown and the frozen inputs can differ from that commit. If a run's owning process exits before finalisation, reopening its data directory records the abandoned run as interrupted while retaining completed evidence. Start a new assessment to finish the checks; recovery does not resume an arbitrary subprocess.

## Development and current limits

```sh
npm run check
```

This runs TypeScript checking and the test suite. Avoid claiming a verification count without running the current suite.

The first version has a fixed six-criterion framework. It does not provide a general framework editor, custom script runners, npm-audit or OpenSSF Scorecard adapters, GitHub/remote governance checks, repository cloning, multi-package traversal, broader language assessment, local-model judgments, authenticated independent reviewers, or hosted collaboration. Input capture excludes application source code, installed dependencies, and hosting settings; each selected input is limited to 8 MiB.

See [architecture](docs/architecture.md) and [reuse analysis](docs/reuse-analysis.md) for implementation boundaries.

## Prepared tools on this workspace

The initial local checkout has a verified OSV-Scanner 2.6.0 binary and a downloaded npm advisory database in its ignored `.tools/` directory. The launcher uses tools from its own application installation, never from the assessed project. `npm start` therefore supports the prepared offline scan on this machine. These machine-specific files are not committed to Git; other checkouts should follow the OSV setup instructions above. The release and database checksums are recorded in `.tools/INSTALLATION.json`.
