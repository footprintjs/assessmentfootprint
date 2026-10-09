# Customize your installed workbench

Install AssessmentFootprint, keep its ready-made **Project → Method → Flow → Results** UI, and adapt the checks and review process for your purpose. The included skill helps a coding agent choose supported configuration first, then make a focused extension when new behavior is necessary.

This is currently a configurable assessment application. An extensible application framework is the direction: a reusable engine and UI with user-specific behavior. Custom collectors and new rule forms still need source changes; there is no drop-in plugin SDK yet.

## What you can change today

| Your need | How to do it |
| --- | --- |
| Different criteria, evidence paths, file/JSON checks, vulnerability thresholds, or required human reviews | Create, copy, or import a template in the installed app. Existing UI and engine handle it. |
| Another trusted local tool or a new evaluation rule | Extend this app's source and its validated configuration/editor together. Keep results and replay integrated. |
| Mid-run human approval, arbitrary branches, remote tools, or a substantially different domain | Additional development is needed. These are not existing template options. |

## Give the skill to your coding agent

The skill lives at [`skills/customize-assessmentfootprint/SKILL.md`](../skills/customize-assessmentfootprint/SKILL.md). Give the agent access to the installed app's source and this file. Its linked implementation map identifies the actual extension points and the contracts that keep evidence, findings, reviews, and replay trustworthy.

An assistant with a skills directory can use the complete `customize-assessmentfootprint` folder there. For Codex personal skills, use `$CODEX_HOME/skills` when configured, otherwise `~/.codex/skills`. Other tools use their own conventions. Alternatively, ask the agent to read `SKILL.md` directly. Copying the skill does not install the app, and repository placement does not guarantee every assistant automatically discovers it.

The instructions are plain Markdown and do not require a particular model. A coding assistant must be able to read the relevant files; the workbench itself does not need a model or API key for its built-in checks.

## Copy this prompt

Replace the bracketed parts:

```text
Customize my installed AssessmentFootprint app at [app checkout] for
[my purpose]. Read skills/customize-assessmentfootprint/SKILL.md there,
or use $customize-assessmentfootprint if that skill is installed.

My inputs are [files/project]. I need [checks and result meaning].
Human review is required for [conditions, or none].
Any additional tool I need is [tool, or none].

Keep the existing wizard, flow chart, results, evidence, and replay UI.
First use supported template configuration. If that cannot express the
requirement, explain the needed source extension and implement the
requested behavior within this app. Keep existing runs and templates.
Test with a separate data directory. Give me the configuration or code
change, how to use it, verification results, and remaining limitations.
```

## Try a template without changing the application

The included [release handoff policy](../skills/customize-assessmentfootprint/assets/release-handoff-policy.json) checks that `handoff.json` declares numeric `schemaVersion: 1` and asks a person to review `docs/HANDOFF.md`. Those files are inputs from the project being assessed. Passing the JSON check does not establish release quality; review remains a separate judgment.

In Studio, open **Templates**, import the JSON, inspect the draft, and publish it. Select that policy in **Method**, then run through **Flow** and inspect **Results**. Browser import creates a new copy; it does not replace a previous policy.

For an isolated CLI demonstration, run from the source checkout with Node 24+:

```sh
node bin/assessment.mjs templates import skills/customize-assessmentfootprint/assets/release-handoff-policy.json --data-dir /absolute/path/to/demo-data --json
```

Use the template ID returned by that command:

```sh
node bin/assessment.mjs run /absolute/path/to/example-project --template TEMPLATE_ID --template-version 1 --data-dir /absolute/path/to/demo-data --json
```

Required review means the run remains pending even when the automatic check passes. Review it in Studio using the same demo data directory:

```sh
npm start -- /absolute/path/to/example-project --data-dir /absolute/path/to/demo-data
```

If dependencies are not installed, first run `npm ci` in the workbench checkout; that installs this application's dependencies and normally needs registry access. The workbench does not install or execute the assessed project's scripts. The example policy needs no external scanner or model. See the [README](../README.md) for the broader installation and CLI behavior, including outcome exit codes.

## What an extension must preserve

The same configured chart should drive preview and real execution. Replay must read retained execution data, and earlier steps must show the state available then. Later human decisions must leave the original automated result and recording intact. Switching between Flow and Results should preserve the user's inspection state for the same run. New tools must expose actual output, failures, and missing evidence through those existing surfaces.

The source archive includes this guide, the portable skill, example policy, implementation, and tests. Local run data, prepared machine-specific tools, and installed dependencies are excluded.
