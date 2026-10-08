# Architecture

AssessmentFootprint is one local assessment engine with two interfaces. `src/core.ts` owns collection, evaluation, storage, review, evidence access, and report export. `src/cli.ts` invokes it directly. `src/server.ts` exposes that engine to the static browser interface in `web/`. Both interfaces therefore produce the same assessment record and criterion semantics.

## Runtime and persistence

Node 24+ runs the TypeScript source directly and supplies `node:sqlite`. The only runtime package dependency is pinned `footprintjs` `9.44.1`. The SQLite database uses WAL mode and stores a JSON payload per run; it is a run index and current record, not a relational evidence graph or a signed append-only ledger.

The configurable data directory defaults to `.assessmentfootprint` under the process's current working directory. It contains:

```text
assessment.sqlite
assessment.sqlite-wal / assessment.sqlite-shm  (when SQLite creates them)
runs/
  <run-id>/
    inputs/             frozen selected input documents and lockfiles
    <evidence-id>.txt    raw source, scanner output/diagnostics, or workflow JSON
```

Run IDs and evidence IDs are UUIDs. Reports reference these stored artifacts rather than embedding every raw file. A JSON export is an assessment record, not a self-contained evidence archive.

## Collection and source snapshot

The engine resolves the selected local project folder and collects a fixed list of root inputs: `package.json`; four supported Node lockfile names; four root licence-document names; root or `.github` security/governance/contribution documents; and root `README.md`. It accepts only files, rejects inputs resolving outside the project, and limits each input to 8 MiB. It does not recursively collect source code or nested packages.

The captured bytes are copied to `runs/<id>/inputs/` before criteria are evaluated. The snapshot lists each relative path, byte count, and SHA-256 digest, with a digest over that list. This identifies the assessed input set; it is not the digest of the entire repository. Optional local Git metadata records the root repository's HEAD and a dirty-state observation, when available. The dirty observation excludes untracked files and is metadata rather than the assessment identity.

Files used by findings become `EvidenceRecord`s, with a tool identity/version, timestamp, source label, content hash, byte count, artifact reference, and a small structured value. Absent documents are described in the result; absence is not fabricated as a successful source read.

## Evaluation and trace

The built-in `oss-readiness` catalogue has six criteria, five automatic and one expert. A policy digest covers the version and criterion definitions. The engine validates selected criterion IDs, executes one assessment at a time per engine instance, and emits persisted run/criterion start/completion events. Subscriber failures do not alter the run's evidence.

FootprintJS executes the selected evaluation sequence. A chart starts by writing the source digest and an empty findings array; each subsequent asynchronous criterion stage writes its active criterion and a summary of the actual result. The engine enables narrative capture before running and preserves FootprintJS's run ID, shared state, commit log, commit-value mode, write provenance, and narrative as evidence. It does not use an AgentFootprint runtime or pretend that these deterministic checks involve a model.

The five status values are `satisfied`, `not_satisfied`, `insufficient_evidence`, `not_applicable`, and `evaluation_error`. Automated file rules have deliberately narrow meanings. The expert governance criterion remains insufficient until a reviewer supplies a decision and rationale. `awaiting_review` and `completed` are workflow states; completion is not equivalent to a positive assessment. Unexpected run failure records an interrupted state when a run has already been created.

## OSV adapter

The engine probes a native `osv-scanner` executable with `--version` and accepts v2 for dependency assessment. It invokes the executable directly with an argument array, never through a shell. It scans explicit copies of usable root lockfiles in the frozen input directory and requests JSON, all package records, and disabled Go call analysis. Offline mode supplies `--offline`; preparing the advisory database is a separate operation.

Raw stdout and execution diagnostics are separate evidence artifacts. Missing tools or local advisory data, unsupported versions, invalid JSON, incompatible output, or a scan that identifies no packages cannot yield a positive finding. Known vulnerability findings yield `not_satisfied`; a usable scan identifying packages with none reported yields `satisfied` within its recorded scope. It neither runs `fix` nor installs, builds, tests, or executes the assessed package. Source reachability, installed dependencies, and nested packages are outside the adapter's scope.

The adapter's offline/online flag governs OSV behavior; it is not an operating-system network sandbox. The complete advisory database is not bundled with a run. Retained raw output supports inspection of this run, while later scans may differ as advisory data changes.

## Human review and reports

Only an expert criterion selected in the run can receive a review. The engine validates its decision, reviewer name, and rationale; it appends a timestamped review with the criterion's evidence IDs and updates the current finding. The declared reviewer name provides attribution within this local record, not independently verified identity. Prior review entries remain visible.

Evidence access resolves an artifact inside its run directory and checks its SHA-256 digest before returning bytes. A mismatch or escaped path fails the read. This protects the read boundary against accidental artifact changes; it does not establish authenticity if someone can coherently rewrite the local database and files.

JSON exports preserve the assessment record. HTML exports render its findings, limitations, evidence index, source snapshot, and review history with escaped text. Neither format is a signed certificate or an independent review, and neither claims JRC certification.

## Local browser boundary

The HTTP server binds to `127.0.0.1`, defaults to a free port, and accepts only its exact local host address. It checks request origins and cross-site browser headers. Mutating requests require a generated per-server session token, supplied by the same local page after bootstrap; this token is a local session boundary, not an account or institutional credential. JSON bodies are bounded to 64 KiB. A static asset allowlist, same-origin content policy, no-store responses, and text evidence responses constrain the browser surface.

The browser can change which local project folder is inspected; the server is not a restricted single-folder filesystem sandbox. Its boundary addresses unrelated websites controlling the local service, not hostile software already acting as the local user. The interface contains no remote dependencies or hosted storage.

## Deliberate first-version boundaries

The catalogue is fixed, and there is no generic framework builder or custom command runner. There are no npm-audit/Scorecard adapters, remote repository checks, clone operation, general multi-language inventory, nested workspace traversal, LLM judging, authenticated reviewer directory, or hosted collaboration. Adding these capabilities must retain explicit source coverage, criterion versioning, real tool outcomes, and missing-evidence states rather than broadening claims from the existing six checks.
