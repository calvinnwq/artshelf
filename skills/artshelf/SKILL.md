---
name: artshelf
description: "Use before any final response, status update, handoff, or done report to check whether created/copied/exported/quarantined/backed-up/preserved non-source files or directories outlive the command; and when registering temporary artifacts, backups, run outputs, debug evidence, daily Artshelf reviews, cleanup plans, trash listings, or trash purge plans with Artshelf."
---

# Artshelf

Artshelf is a tiny CLI for accountable temporary artifact retention. Use this
skill when work creates or reviews non-source files that should survive the
current command but should not be kept forever.

Core rule: register artifacts at creation time, while the reason is still fresh.
Humans approve dangerous mutations; agents install, register, monitor, produce
review packets, and verify results.

## Contract

- Before final/status/handoff/done, check whether the task created, copied,
  exported, quarantined, backed up, or preserved any non-source file or
  directory that may outlive this command.
- Register meaningful eligible artifacts with `artshelf put --json`; otherwise
  record a clear skip reason.
- Include reason, TTL or manual-review, cleanup mode, owner, and labels.
- Report the Artshelf id anywhere restart or cleanup context matters.
- Use read-only commands freely; execute cleanup, trash purge, or resolve only
  after exact human approval.
- Do not call work done while known eligible artifacts are neither registered
  nor explicitly skipped.

## Setup

Check for the CLI first:

```bash
artshelf --version
artshelf doctor
artshelf help put
```

If missing, install from npm when appropriate:

```bash
npm install -g artshelf
artshelf doctor
```

For source installs, ask where to clone the repo. Do not hard-code a personal
repo path or create a custom shim.

```bash
git clone https://github.com/calvinnwq/artshelf.git "$ARTSHELF_REPO"
cd "$ARTSHELF_REPO"
corepack enable
pnpm install --frozen-lockfile
pnpm run build
npm link
artshelf doctor
```

Install, copy, or reference this portable skill only after the user chooses the
integration path. Offer to schedule read-only review job delivery in the host
runtime.

## Create

Use lookup-before-put for idempotent registration:

```bash
artshelf find --path <path> --owner <agent-or-runtime> --label <task-or-run-id> --json
artshelf put <path> --reason "<why this exists>" --ttl 3d --kind run-artifact --cleanup review --owner agent --label <project-or-task> --json
artshelf get <id> --json
```

Register backups, quarantine folders, debug output, generated reports, long-run
evidence, and copied files kept for review. Skip source files, cheap regenerated
build output, dependency caches, secrets, credential dumps, and artifacts already
owned by another durable ledger.

Defaults: `kind=scratch` for temp dirs, `backup` for rollback copies,
`run-artifact` for logs/reports/evidence, `quarantine` for isolated questionable
files. Use `cleanup=review` when judgment is needed and `cleanup=trash` only when
later disposal is clearly safe.

When JSON registration succeeds, include this deterministic Artshelf footnote:

```text
Artshelf footnote: registered <artifact-path> as <artshelf-id>; reason: <short reason>; due: <YYYY-MM-DD|manual-review>; cleanup=<cleanup-mode>.
```

## Monitor

Use the ledger registry for whole-machine review:

```bash
artshelf ledgers list --json
artshelf status --all --json
artshelf review --all --json
artshelf trash list --all --json
```

`artshelf ledgers list --json` reports per-ledger validation status. `--plain`
skips validation. `--all` is for discovery and review, not mutation permission.

Register existing project ledgers explicitly:

```bash
artshelf ledgers add --ledger <repo>/.artshelf/ledger.jsonl --name <project> --scope repo --json
```

### Scheduled Review

Scheduled jobs are review/report only. Reports should name the ledger path and
plan id when attention exists. They may run:

```bash
artshelf validate --json
artshelf due --json
artshelf review --all --json
artshelf cleanup --dry-run --json
artshelf cleanup --dry-run --all --json
artshelf trash list --all --json
artshelf doctor --json
artshelf status --all --json
```

For old-trash review, dry-run purge only for an explicit ledger:

```bash
artshelf trash purge --older-than 7d --dry-run --ledger <ledger-path> --json
```

Do not scan arbitrary filesystem locations for ledgers unless the user opted
into that discovery scope. Never schedule cleanup or purge execution:

```bash
artshelf cleanup --execute --plan-id <id>
artshelf trash purge --execute --plan-id <id>
```

## Review

Daily Review Workflow: turn raw Artshelf output into a decision packet, not a
count dump.

1. Run read-only review first: `artshelf ledgers list --json`,
   `artshelf review --all --json`, and `artshelf trash list --all --json`.
2. If cleanup attention exists, run `artshelf cleanup --dry-run --all --json`.
3. Classify candidates as `trash-safe`, `needs-human-review`,
   `resolve-candidate`, or `registry-problem`.
4. Use `ArtshelfReviewReport` from
   `schemas/artshelf-review-report.schema.json`; use
   `examples/artshelf-review-report.json` as the canonical packet.
5. Render the compact decision card with `scripts/render-review-report.mjs`;
   keep `decisionSummary` in audit, while `decisionGroups` drive counts.
   Emojis are encouraged only in host-specific wrappers, not the renderer.
6. Always include the exact approval target in the message body as a fallback.
   Do not paste the whole packet into chat unless the user asks for it.

### Review Plan Report Schema

Deterministic renderer:

```bash
cd /path/to/skills/artshelf
node scripts/render-review-report.mjs examples/artshelf-review-report.json
```

Expected card shape:

```text
Artshelf daily review
Status: <ok|attention needed>; registry <ok|attention>

Ready for approval: <n>
Needs review first: <n>
Blocked: <n>

Recommended action
<one short sentence>.

Ready for approval
1. <label>
   Why: <reason>
   Action: <next step>
   <approval target>

Needs review first
1. <label>
   Why: <reason>
   Suggested next step: <next step>

Blocked
<none, or blocker and repair step>

Safety
Dry-run only. No execute, resolve, or delete ran.
```

Approval wording:

```text
approve artshelf cleanup ledger <ledger-path> plan <plan-id>
approve artshelf trash purge ledger <ledger-path> plan <purge-plan-id>
approve artshelf resolve missing ledger <ledger-path> ids <id...>
```

Never execute from a read-only preview id. Never generate a fresh plan and
execute it in the same step. After any approved action, verify with `artshelf review --all --json` and report whether the review is quiet.

## Clean

Read-only and dry-run commands are safe:

```bash
artshelf validate --json
artshelf validate --all --json
artshelf due --json
artshelf due --all --json
artshelf cleanup --dry-run --json
artshelf cleanup --dry-run --all --json
```

Cleanup execution requires approval naming the reviewed ledger and plan id:

```bash
artshelf cleanup --execute --plan-id <id> --ledger <ledger-path> --json
```

Trash purge is separate from cleanup and needs its own reviewed purge plan:

```bash
artshelf trash list --ledger <ledger-path> --json
artshelf trash purge --older-than 7d --dry-run --ledger <ledger-path> --json
artshelf trash purge --execute --plan-id <purge-plan-id> --ledger <ledger-path> --json
```

Resolve only after confirmation; it updates the ledger and does not move or
delete files:

```bash
artshelf resolve <id> --status resolved --reason "<specific reason>" --ledger <ledger-path> --json
```

For batches, ask for exact approval:

```text
approve artshelf resolve missing ledger <ledger-path> ids <id...>
```

## Safety

- Do not register secrets or credential dumps.
- Do not use Artshelf as a replacement for git, durable workflow ledgers, or
  backups.
- Do not silently delete files.
- Do not treat `cleanup=delete` as permission to delete. Cleanup records a
  refusal; physical deletion requires a separate reviewed trash purge plan.
