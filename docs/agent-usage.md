# Agent Usage

Agents that support local skills can copy or reference
[`skills/shelf/SKILL.md`](../skills/shelf/SKILL.md). The public docs site at
<https://calvinnwq.github.io/shelf/> explains the same contract in browsable
form.

Shelf works best when agents register artifacts at creation time, while the
reason is still fresh. Do not wait for a cleanup pass to infer intent from file
age or path names.

## When To Register

Call `shelf put` immediately after creating something that should survive the
current command but should not live forever:

- config backups
- rollback copies
- quarantine folders
- debug output directories
- generated reports
- temporary repo artifacts
- long-running task evidence
- copied files kept so a reviewer can inspect them later

Do not register normal source files, committed documentation, package build
outputs that can be regenerated cheaply, or dependency caches.

## Command Shape

Use the installed CLI when available:

```bash
shelf put <path> --reason "<why this exists>" --ttl 3d --kind run-artifact --cleanup review --owner agent
```

If Shelf is not installed, do not assume a repo path. Ask where the user wants
the Shelf repo cloned, then use the supported local install path:

```bash
git clone https://github.com/calvinnwq/shelf.git "$SHELF_REPO"
cd "$SHELF_REPO"
corepack enable
pnpm install --frozen-lockfile
pnpm run build
npm link
shelf --version
```

For now, do not choose an npm registry install or a custom shim. npm publishing
is deferred, and `npm link` from a local clone is the supported method.

Useful defaults for agents:

- `--kind scratch` for temporary working directories.
- `--kind backup` for rollback copies.
- `--kind run-artifact` for logs, reports, and generated evidence.
- `--kind quarantine` for files isolated because they may be unsafe or wrong.
- `--cleanup review` when a human or future agent should inspect before moving.
- `--cleanup trash` only when the artifact is definitely disposable after the
  retention window.
- `--owner openclaw`, `--owner codex`, or another concrete agent/runtime name.
- `--label <project>` and `--label <task-id>` when the artifact relates to a
  repo, PR, Linear issue, workflow id, or run id.

Use `--json` when another tool needs to capture the Shelf entry id.

## Idempotent Lookup

Integrations should check the ledger before creating another record for the
same artifact. Use `find` and `get` for read-only lookup:

```bash
shelf find --path <path> --owner coding-workflow-pipeline --label <run-id> --json
shelf get <id> --json
```

`find` requires at least one selector: `--path`, `--owner`, `--label`, or
`--status`. Multiple labels are an all-label match. If `find` returns an
existing record, report that Shelf id instead of calling `put` again. If it
returns no entries, call `put` and record the new id.

## Reasons

Write reasons as small audit notes. A good reason lets a future agent decide
whether the artifact still matters without replaying the whole conversation.

Good:

```text
postflight autofix backup before rewriting migration order for SK-450
```

Weak:

```text
backup
```

Include the source of authority when useful: PR number, Linear issue, workflow
id, command, failing check, or user request.

## Reporting Shelf IDs

After registration, include the Shelf id anywhere future cleanup context will be
read:

- handoff notes
- PR comments
- Linear comments
- daily memory
- task run summaries
- incident or debugging notes

Example:

```text
Temporary parser output registered in Shelf as shf_20260601_182800_ab12.
Retain until 2026-06-04; cleanup=review.
```

## Cleanup Boundary

Agents may run read-only cleanup checks:

```bash
shelf validate --json
shelf due --json
shelf cleanup --dry-run --json
```

Agents must not run this without explicit human approval:

```bash
shelf cleanup --execute --plan-id <id>
```

Approval should name the plan id. Do not generate a fresh plan and execute it in
the same breath. Review the dry-run first, then execute the reviewed plan id.
Execution writes a receipt and updates touched ledger records to `trashed`,
`review-required`, or `cleanup-refused`, so handled artifacts stop reappearing in
future due and dry-run cleanup output.

Agents may mark a ledger record manually resolved when the user confirms the
artifact was inspected, is already missing, or is no longer needed:

```bash
shelf resolve <id> --status resolved --reason <text>
```

Use a specific reason. `resolve` only updates the ledger; it does not move or
delete files. Resolved records stop reappearing in future due and dry-run
cleanup output while remaining visible in `shelf list --status resolved`.

## Scheduled Review

Agents may schedule routine Shelf reviews for stale artifacts through their host
runtime, such as an agent cron, CI job, or recurring task. Keep the scheduled
job read-only:

```bash
shelf validate --json
shelf due --json
shelf cleanup --dry-run --json
```

The scheduled job should report the ledger path, due/manual-review/missing-path
counts, cleanup dry-run plan id, executable entries, skipped entries, and refused
entries. It should be quiet when nothing needs attention unless the user asked
for a regular summary.

Use explicit ledger paths when scheduling checks for a known project or user
ledger. Do not scan arbitrary filesystem locations looking for ledgers unless
the user has opted into that discovery scope.

Scheduled jobs must not run:

```bash
shelf cleanup --execute --plan-id <id>
```

Execution still requires a human to review the dry-run output and approve that
specific plan id.

## Handoff Pattern

When a task creates registered artifacts, add a short section like this:

```text
Shelf artifacts:
- shf_20260601_182800_ab12: /tmp/parser-output, debug evidence for SK-123,
  retain until 2026-06-04, cleanup=review
```

If there are no registered artifacts, say nothing. Do not invent Shelf entries
after the fact just to make a handoff look tidy.
