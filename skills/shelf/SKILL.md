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
shelf due --json
shelf cleanup --dry-run --json
```

Requires explicit approval that names the reviewed plan id:

```bash
shelf cleanup --execute --plan-id <id>
```

Never generate a fresh plan and execute it in the same step.

## Review

When asked to review Shelf state:

1. Run `shelf validate --json`.
2. Run `shelf due --json`.
3. If cleanup is requested, run `shelf cleanup --dry-run --json`.
4. Report plan id, executable entries, skipped entries, and refused entries.
5. Stop before `cleanup --execute` unless the user explicitly approves that
   plan id.

## Safety

- Do not register secrets or credential dumps.
- Do not use Shelf as a replacement for git, workflow ledgers, or backups.
- Do not silently delete files.
- Do not treat `cleanup=delete` as permission to delete unless the reviewed
  plan and user approval both allow it.
