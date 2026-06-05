---
name: shelf
description: "Use before any final response, status update, handoff, or done report to check whether created/copied/exported/quarantined/backed-up/preserved non-source files or directories outlive the command; and when registering temporary artifacts, backups, run outputs, debug evidence, daily Shelf reviews, or cleanup plans with Shelf."
---

# Shelf

Shelf is a tiny CLI for accountable temporary artifact retention. Use this
skill when an agent creates or reviews files that should survive the current
command but should not be kept forever.

Core rule: register artifacts at creation time, while the reason is still
fresh. Do not infer intent later from filesystem age or path names.

## Contract

- Mandatory trigger: before final response, handoff, status, or "done"
  reporting, check whether the task created, copied, exported, quarantined,
  backed up, or preserved any non-source file or directory that may outlive the
  current command.
- Use `shelf put` for meaningful temporary artifacts, backups, run outputs, and
  debug evidence immediately after the path exists.
- If an eligible artifact is not registered, record a clear skip reason.
- Include a clear reason, retention rule, cleanup mode, owner, and useful
  labels.
- Capture the Shelf id in handoffs, PRs, issue comments, memory, or run
  summaries when the artifact matters for restart or review.
- Cleanup execution is approval-only. Read-only review is fine; mutation needs
  a reviewed plan id and explicit human approval.

## Register

Check the installed CLI first:

```bash
shelf --version
shelf doctor
shelf help put
```

If Shelf is not installed, ask the user where to clone the repo before making
changes. Do not hard-code a personal repo path. The supported setup method for
now is local only: clone the repo, build it, run `npm link`, then verify
`shelf --version` and `shelf doctor`. Do not use an npm registry install or
custom shim until the docs say that method is supported.

```bash
git clone https://github.com/calvinnwq/shelf.git "$SHELF_REPO"
cd "$SHELF_REPO"
corepack enable
pnpm install --frozen-lockfile
pnpm run build
npm link
shelf --version
shelf doctor
```

Common registration:

```bash
shelf put <path> \
  --reason "<why this exists>" \
  --ttl 3d \
  --kind run-artifact \
  --cleanup review \
  --owner agent \
  --label <project-or-task> \
  --json
```

Use `--json` when another tool or handoff needs the entry id.

## Lookup

Use read-only lookup before `put` when a workflow needs idempotent artifact
registration:

```bash
shelf find --path <path> --owner <agent-or-runtime> --label <task-or-run-id> --json
shelf get <id> --json
```

`find` requires at least one selector: `--path`, `--owner`, `--label`, or
`--status`. Multiple labels must all match. If a matching record already
exists, reuse its Shelf id instead of creating a duplicate record.

Use the ledger registry when reviewing all known Shelf state from one entry
point:

```bash
shelf ledgers list --json
shelf review --all --json
shelf status --all --json
shelf find --all --owner <agent-or-runtime> --json
```

`shelf ledgers list --json` reports per-ledger validation status
(ok/missing/invalid) with entry and warning/error counts, so you can detect
stale registry entries without a separate validate pass; `--plain` skips
validation. `shelf review --all --json` adds an aggregate triage summary and the
next safe action.

`put` registers its ledger automatically. For existing project ledgers, register
them explicitly:

```bash
shelf ledgers add --ledger <repo>/.shelf/ledger.jsonl --name <project> --scope repo --json
```

`--all` is for discovery and review. Do not use it as permission to mutate
files.

## Daily Review Workflow

Use this flow when a scheduled review, recurring task, or user request asks for
Shelf cleanup attention:

1. Register artifacts early during work, or state why an eligible artifact was
   skipped.
2. Review state with read-only commands first:
   `shelf ledgers list --json` and `shelf review --all --json`.
3. Present a decision packet instead of raw counts. Include registry health,
   affected ledgers, due/manual-review/missing-path counts, executable entries,
   skipped entries, refused entries, and the next safe action.
4. Classify each candidate:
   - `trash-safe`: disposable after the reviewed plan moves it into Shelf trash.
   - `needs-human-review`: `cleanup=review`, evidence, backups, reports, or
     anything that should be inspected before closing.
   - `resolve-candidate`: already handled, missing, or no longer needed; use
     `shelf resolve` only after confirmation.
   - `registry-problem`: stale, missing, or invalid ledger; fix registry health
     before touching artifacts.
5. If cleanup execution is appropriate, generate or reuse a dry-run plan, then
   ask for explicit approval naming the ledger path and reviewed plan id.
6. For any `trash-safe` candidates moved by `cleanup=trash`, run `shelf trash list`
   and then require a separate reviewed purge plan before physical deletion:

```bash
shelf trash list --ledger <ledger-path>
shelf trash purge --older-than 7d --dry-run --ledger <ledger-path> --json
shelf trash purge --execute --plan-id <purge-plan-id> --ledger <ledger-path> --json
```

7. After approved cleanup execute, trash purge, or resolve, verify quiet with
   `shelf review --all --json`, plus `shelf trash list --ledger <ledger-path> --json`
   and purge receipt evidence after purge, or explain what remains.

Approval wording should be exact:

```text
approve shelf cleanup ledger <ledger-path> plan <plan-id>
approve shelf trash purge ledger <ledger-path> plan <purge-plan-id>
```

Never execute from a read-only preview id. Never generate a fresh plan and
execute it in the same step. `trash` moves artifacts into Shelf trash; physical
deletion requires a separate reviewed trash purge plan.

## What To Register

Register:

- config backups and rollback copies
- quarantine folders
- debug output directories
- generated evidence or reports
- long-running workflow run artifacts
- copied files kept for review

Skip:

- source files that belong in git
- cheap regenerated build outputs
- dependency caches
- artifacts already owned by a durable workflow ledger
- secrets or credential dumps

If you skip an otherwise eligible artifact, report the reason briefly. Examples:
source-controlled, regeneratable, secret-bearing, already tracked by another
durable ledger, or user asked not to retain it.

## Defaults

- `kind=scratch` for temporary working directories.
- `kind=backup` for rollback copies.
- `kind=run-artifact` for logs, reports, and generated evidence.
- `kind=quarantine` for isolated questionable files.
- `cleanup=review` when judgment is needed later.
- `cleanup=trash` only when disposal after the retention window is clearly safe.
- `owner=<agent-or-runtime>` should name the agent, tool, CI job, or human
  process that created the artifact.

## Report

After registration, include the Shelf id where the future reader will look:

```text
Shelf artifact: shf_20260601_182800_ab12, /tmp/parser-output, retain until
2026-06-04, cleanup=review.
```

## Completion Check

Before finalizing a task, review your own file actions:

1. Did you create, copy, export, quarantine, back up, or preserve any non-source
   file or directory?
2. Will any of those paths outlive this command?
3. If yes, did you register them with Shelf or state why Shelf is not
   appropriate?

Do not call work done while known eligible artifacts are neither registered nor
explicitly skipped.

## Cleanup

Allowed without extra approval because they do not move or delete files:

```bash
shelf validate --json
shelf validate --all --json
shelf due --json
shelf due --all --json
shelf review --all --json
```

Cleanup dry-run is safe to run. It writes plan files for later review only when
there are executable cleanup entries:

```bash
shelf cleanup --dry-run --json
shelf cleanup --dry-run --all --json
```

Requires explicit approval that names the reviewed plan id:

```bash
shelf cleanup --execute --plan-id <id>
```

After cleanup execution, review and execute trash purges separately:

```bash
shelf trash list --ledger <ledger-path>
shelf trash purge --older-than 7d --dry-run --ledger <ledger-path> --json
shelf trash purge --execute --plan-id <purge-plan-id> --ledger <ledger-path> --json
```

No-op dry-runs report `not-created` and do not write plan files.
Never generate a fresh plan and execute it in the same step.
Execution writes a receipt and updates touched ledger records to `trashed`,
`review-required`, or `cleanup-refused`, so handled artifacts stop reappearing in
future due and dry-run cleanup output.
Shelf records generated plans and receipts as `owner=shelf` artifacts.

You may mark a record manually resolved when the user confirms the artifact was
inspected, is already missing, or is no longer needed:

```bash
shelf resolve <id> --status resolved --reason <text>
```

Use a specific reason. `resolve` only updates the ledger; it does not move or
delete files. Resolved records stop reappearing in future due and dry-run
cleanup output while remaining visible in `shelf list --status resolved`.

## Scheduled Review

Agents may schedule routine Shelf checks for stale artifacts through their host
runtime, such as an agent cron, CI job, or recurring task. Scheduled jobs are
review/report only.

Allowed in scheduled jobs:

```bash
shelf validate --json
shelf due --json
shelf review --all --json
shelf cleanup --dry-run --json
```

Read-only health and dashboard checks are also safe to schedule. Run
`shelf review --all --json` for aggregate triage (`summary` and `nextAction`),
`shelf doctor --json` to catch a broken or stale registry before relying on
cleanup planning, and `shelf status --all --json` for a compact cron summary:

```bash
shelf doctor --json
shelf status --all --json
```

The report should include the ledger path, due/manual-review/missing-path counts,
cleanup dry-run plan id, executable entries, skipped entries, and refused
entries. Stay quiet when nothing needs attention unless a regular summary was
requested.

Repeated dry-runs with the same executable cleanup entries reuse the existing
plan id and refresh that plan file's timestamp instead of creating duplicate
plans.

Use explicit ledger paths for scheduled checks. Do not scan arbitrary filesystem
locations for ledgers unless the user opted into that discovery scope.

Never schedule cleanup execution or trash purge execution. Scheduled jobs may
only dry-run and report plans for later human review:

```bash
shelf cleanup --execute --plan-id <id>
shelf trash purge --execute --plan-id <id>
```

## Review

When asked to review Shelf state:

1. Run `shelf validate --json`.
2. Run `shelf due --json`.
3. If cleanup is requested, run `shelf cleanup --dry-run --json`.
4. Report plan id, executable entries, skipped entries, and refused entries.
5. Stop before `cleanup --execute` unless the user explicitly approves that
   plan id.

For a whole-machine Shelf review, prefer:

```bash
shelf review --all --json
```

If the user asks for cleanup candidates across projects, run
`shelf cleanup --dry-run --all --json` and report each ledger's plan id. Execute
only a specific reviewed plan against its specific ledger.

## Safety

- Do not register secrets or credential dumps.
- Do not use Shelf as a replacement for git, workflow ledgers, or backups.
- Do not silently delete files.
- Do not treat `cleanup=delete` as permission to delete. Cleanup execution
  records `cleanup-refused` with `delete is disabled in v1`; physical deletion
  requires a separate reviewed trash purge plan.
