---
name: shelf
description: "Use when registering temporary artifacts, backups, run outputs, debug evidence, or cleanup plans with Shelf."
---

# Shelf

Shelf is a tiny CLI for accountable temporary artifact retention. Use this
skill when an agent creates or reviews files that should survive the current
command but should not be kept forever.

Core rule: register artifacts at creation time, while the reason is still
fresh. Do not infer intent later from filesystem age or path names.

## Contract

- Use `shelf put` for meaningful temporary artifacts, backups, run outputs, and
  debug evidence.
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
shelf help put
```

If Shelf is not installed, ask the user where to clone the repo before making
changes. Do not hard-code a personal repo path. The supported setup method for
now is local only: clone the repo, build it, run `npm link`, then verify
`shelf --version`. Do not use an npm registry install or custom shim until the
docs say that method is supported.

```bash
git clone https://github.com/calvinnwq/shelf.git "$SHELF_REPO"
cd "$SHELF_REPO"
corepack enable
pnpm install --frozen-lockfile
pnpm run build
npm link
shelf --version
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
shelf find --path <path> --owner <runtime> --label <run-id> --json
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
shelf find --all --owner <runtime> --json
```

`put` registers its ledger automatically. For existing project ledgers, register
them explicitly:

```bash
shelf ledgers add --ledger <repo>/.shelf/ledger.jsonl --name <project> --scope repo --json
```

`--all` is for discovery and review. Do not use it as permission to mutate
files.

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

## Defaults

- `kind=scratch` for temporary working directories.
- `kind=backup` for rollback copies.
- `kind=run-artifact` for logs, reports, and generated evidence.
- `kind=quarantine` for isolated questionable files.
- `cleanup=review` when judgment is needed later.
- `cleanup=trash` only when disposal after the retention window is clearly safe.
- `owner=<runtime>` should name the runtime or agent, such as `codex`,
  `claude`, `openclaw`, or `manual`.

## Report

After registration, include the Shelf id where the future reader will look:

```text
Shelf artifact: shf_20260601_182800_ab12, /tmp/parser-output, retain until
2026-06-04, cleanup=review.
```

## Cleanup

Allowed without extra approval:

```bash
shelf validate --json
shelf validate --all --json
shelf due --json
shelf due --all --json
shelf cleanup --dry-run --json
shelf cleanup --dry-run --all --json
```

Requires explicit approval that names the reviewed plan id:

```bash
shelf cleanup --execute --plan-id <id>
```

Never generate a fresh plan and execute it in the same step.
Execution writes a receipt and updates touched ledger records to `trashed`,
`review-required`, or `cleanup-refused`, so handled artifacts stop reappearing in
future due and dry-run cleanup output.

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
shelf cleanup --dry-run --json
```

The report should include the ledger path, due/manual-review/missing-path counts,
cleanup dry-run plan id, executable entries, skipped entries, and refused
entries. Stay quiet when nothing needs attention unless a regular summary was
requested.

Use explicit ledger paths for scheduled checks. Do not scan arbitrary filesystem
locations for ledgers unless the user opted into that discovery scope.

Never schedule this without explicit human approval for the reviewed plan id:

```bash
shelf cleanup --execute --plan-id <id>
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
- Do not treat `cleanup=delete` as permission to delete unless the reviewed
  plan and user approval both allow it.
