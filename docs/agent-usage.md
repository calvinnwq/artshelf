# Agent Usage

Agents that support local skills can copy or reference
[`skills/shelf/SKILL.md`](../skills/shelf/SKILL.md). The public docs site at
<https://calvinnwq.github.io/shelf/> explains the same contract in browsable
form.

Shelf works best when agents register artifacts at creation time, while the
reason is still fresh. Do not wait for a cleanup pass to infer intent from file
age or path names.

## When To Register

Treat Shelf as a finalization trigger, not an optional cleanup habit. Before an
agent reports a task as done, it must check whether the task created, copied,
exported, quarantined, backed up, or preserved any non-source file or directory
that may outlive the current command.

Call `shelf put` immediately after creating an eligible artifact:

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

If an eligible artifact is not registered, the agent should state why. Common
valid reasons are: the artifact is source-controlled, it is a cheap
regeneratable cache/build output, it contains secrets, it belongs to another
durable artifact system, or the user explicitly asked not to retain it.

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
- `--owner <agent-or-runtime>` should name the agent, tool, CI job, or human
  process that created the artifact.
- `--label <project>` and `--label <task-id>` when the artifact relates to a
  repo, PR, issue, workflow id, or run id.

Use `--json` when another tool needs to capture the Shelf entry id.

## Idempotent Lookup

Integrations should check the ledger before creating another record for the
same artifact. Use `find` and `get` for read-only lookup:

```bash
shelf find --path <path> --owner <agent-or-runtime> --label <task-or-run-id> --json
shelf get <id> --json
```

`find` requires at least one selector: `--path`, `--owner`, `--label`, or
`--status`. Multiple labels are an all-label match. If `find` returns an
existing record, report that Shelf id instead of calling `put` again. If it
returns no entries, call `put` and record the new id.

## Ledger Registry

Shelf keeps a user-level registry at `~/.shelf/ledgers.json` so one CLI can
review all known ledgers without moving project records into one global file.
`put` registers the ledger it writes to. Register existing ledgers explicitly
when adopting Shelf for an existing project:

```bash
shelf ledgers add --ledger <repo>/.shelf/ledger.jsonl --name <project> --scope repo
shelf ledgers list --json
```

Use the registry for read-only review and discovery:

```bash
shelf review --all --json
shelf due --all --json
shelf find --all --owner <agent-or-runtime> --json
```

Use global cleanup dry-run when you want Shelf to write cleanup plans for
registered ledgers with cleanup entries, without moving files:

```bash
shelf cleanup --dry-run --all --json
```

Do not use `--all` as permission to mutate files. Cleanup execution remains
ledger-specific and requires a reviewed plan id for that ledger.
If the executable cleanup entries have not changed, dry-run reuses the existing
plan id and refreshes the same plan file instead of creating duplicate plans.

## Reasons

Write reasons as small audit notes. A good reason lets a future agent decide
whether the artifact still matters without replaying the whole conversation.

Good:

```text
backup before rewriting migration order for issue-123
```

Weak:

```text
backup
```

Include the source of authority when useful: PR number, issue id, workflow id,
command, failing check, or user request.

## Reporting Shelf IDs

After registration, include the Shelf id anywhere future cleanup context will be
read:

- handoff notes
- PR comments
- issue comments
- daily memory
- task run summaries
- incident or debugging notes

Example:

```text
Temporary parser output registered in Shelf as shf_20260601_182800_ab12.
Retain until 2026-06-04; cleanup=review.
```

## Cleanup Boundary

Agents may run non-destructive cleanup checks:

```bash
shelf validate --json
shelf validate --all --json
shelf due --json
shelf due --all --json
```

Cleanup dry-run is safe to run. It writes plan files for later review only when
there are executable cleanup entries:

```bash
shelf cleanup --dry-run --json
shelf cleanup --dry-run --all --json
```

Agents must not run this without explicit human approval:

```bash
shelf cleanup --execute --plan-id <id>
```

Approval should name the plan id. Do not generate a fresh plan and execute it in
the same breath. Review the dry-run first, then execute the reviewed plan id.
No-op dry-runs report `not-created` and do not write plan files. When dry-run or
execute creates plan or receipt artifacts, Shelf records those artifacts in the
ledger as `owner=shelf`.

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
job non-destructive:

```bash
shelf validate --json
shelf due --json
```

Scheduled cleanup dry-run may write plan files for later review when cleanup
entries exist, but must not move or delete files:

```bash
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
- shf_20260601_182800_ab12: /tmp/parser-output, debug evidence for issue-123,
  retain until 2026-06-04, cleanup=review
```

If there are no eligible artifacts, say nothing. If eligible artifacts were
skipped instead of registered, include the brief skip reason from the completion
checklist. Do not invent Shelf entries after the fact just to make a handoff look
tidy.

## Completion Checklist

Before final response or handoff, agents should review their own file actions
from the current task:

1. Did I create, copy, export, quarantine, back up, or preserve any non-source
   file or directory?
2. Will any of those paths outlive this command?
3. If yes, did I either register them with Shelf or record a clear skip reason?

Do not call work done while known eligible artifacts are neither registered nor
explicitly skipped.
