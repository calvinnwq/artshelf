# Agent Usage

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

Before Shelf is published, local dogfooding can use the built CLI:

```bash
node dist/src/cli.js put <path> --reason "<why this exists>" --ttl 3d --kind run-artifact --cleanup review --owner agent
```

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
shelf due --json
shelf cleanup --dry-run --json
```

Agents must not run this without explicit human approval:

```bash
shelf cleanup --execute --plan-id <id>
```

Approval should name the plan id. Do not generate a fresh plan and execute it in
the same breath. Review the dry-run first, then execute the reviewed plan id.

## Handoff Pattern

When a task creates registered artifacts, add a short section like this:

```text
Shelf artifacts:
- shf_20260601_182800_ab12: /tmp/parser-output, debug evidence for SK-123,
  retain until 2026-06-04, cleanup=review
```

If there are no registered artifacts, say nothing. Do not invent Shelf entries
after the fact just to make a handoff look tidy.
