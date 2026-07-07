---
name: artshelf
description: "Use before any final response, status update, handoff, or done report to check whether created/copied/exported/quarantined/backed-up/preserved non-source files or directories outlive the command; and when registering temporary artifacts, backups, run outputs, debug evidence, daily Artshelf reviews, cleanup plans, dispose plans, trash listings, or trash purge plans with Artshelf."
---

# Artshelf

Artshelf is a tiny CLI for accountable temporary artifact retention. Use this
skill when work creates or reviews non-source files that should survive the
current command but should not be kept forever.

Core rule: register artifacts at creation time, while the reason is still fresh.
Humans approve dangerous mutations; agents install, register, monitor, produce
review packets, and verify results.

## Workflow

One loop, four moves. **Capture automatically**: register eligible artifacts at
creation with `artshelf put`, or record a clear skip reason. **Review calmly**:
read-only and dry-run only, turned into a decision packet - nothing moves.
**Approve exactly**: a human approves one exact reviewed ledger or registry plus
plan id or record ids. **Verify quiet**: re-run a read-only check after every
approved mutation. The stages below - Create, Monitor, Review, Clean, Purge - are
the mechanics behind those moves.

## Contract

- Before final/status/handoff/done, check whether the task created, copied, exported, quarantined, backed up, or preserved any non-source file or directory that may outlive this command.
- Register meaningful eligible artifacts with `artshelf put --json`; otherwise record a clear skip reason.
- Include reason, TTL or manual-review, cleanup mode, owner, and labels.
- Report the Artshelf id anywhere restart or cleanup context matters.
- Use read-only and dry-run commands freely; execute cleanup, dispose, trash purge, approved bundles, or resolve only after exact human approval.
- Do not call work done while known eligible artifacts are neither registered nor explicitly skipped.

## Setup

Check for the CLI first:

```bash
artshelf --version
artshelf doctor
```

If missing, install from npm when appropriate:

```bash
npm install -g artshelf
artshelf doctor
```

Update npm globals with `artshelf update` when a notice appears; use
`pnpm add -g artshelf@latest` for pnpm or pull/rebuild/`npm link` for source.

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

Install, copy, or reference this portable skill only after the user chooses the integration path. Offer to schedule read-only review job delivery in the host runtime.

## Create

Use lookup-before-put for idempotent registration:

```bash
artshelf find --path <path> --owner <agent-or-runtime> --label <task-or-run-id> --json
artshelf put <path> --reason "<why this exists>" --ttl 3d --kind run-artifact --cleanup review --owner agent --label <project-or-task> --json
artshelf get <id> --json
```

Register backups, quarantine folders, debug output, generated reports, long-run evidence, and copied files kept for review. Skip source files, cheap regenerated
build output, dependency caches, secrets, credential dumps, and artifacts already owned by another durable ledger.

Defaults: `kind=scratch` for temp dirs, `backup` for rollback copies, `run-artifact` for logs/reports/evidence, `quarantine` for isolated questionable
files. Use `cleanup=review` when judgment is needed and `cleanup=trash` only when later disposal is clearly safe.

When JSON registration succeeds, include this deterministic Artshelf footnote:

```text
Artshelf footnote: registered <artifact-path> as <artshelf-id>; reason: <short reason>; due: <YYYY-MM-DD|manual-review>; cleanup=<cleanup-mode>.
```

## Monitor

Use the ledger registry for whole-machine review:

```bash
artshelf ledgers list --json
artshelf status --all --agent
artshelf review --all --agent
artshelf trash list --all --json
```
`artshelf ledgers list --json` reports per-ledger validation status. `--plain`
skips validation. `--all` is for discovery and review, not mutation permission.
Use `--agent` on `review`, `status`, `doctor`, `ledgers prune --dry-run`,
`dispose --dry-run`, and `get --inspect` for compact decisions; use `--json`
for full audit/API payloads, custom rendering, or debugging. On `get`, `--agent` requires `--inspect`.
For browser review sessions, use `artshelf ui`, read-only `ui dashboard --json` / `ui detail <record-id> --ledger <path> --json`, token-protected `ui serve [--json]`, `ui bundle <session-id> [<bundle-id>] --json`, `ui execute <session-id> <bundle-id> --json`, `ui poll`, `ui reply`, and `ui end`.
The served dashboard, detail drawer, and approval workbench share system fonts, inline styles, and CSS `:has()`/`<details>` state.
The dashboard also has a nonce-bound session-activity poller for the token-scoped `/activity` fragment; detail and bundle pages remain scriptless.
The dashboard now reads top to bottom as compact required-action cards with their CTAs in priority order (one-way-door purge first), an at-a-glance status summary, then collapsed source details.
Required-action cards own their expandable row lists, and reviewers can queue recommended card approvals, lane-level choices, or individual row choices into one global `Queued for agent` submit bar.
Bulk lane approvals carry the reviewed row set and are rejected if the lane changes before submit; conflicting card/bulk/row selections are refused.
Dashboard dry-run lane requests map to `prepare_cleanup_plan`, `check_missing_files`, `review_delete_forever`, or `check_source_problems`.
Completed dry-run replies that produce reviewed dispose plans become ready-for-approval rows in Required actions, replacing the original row while the plan remains live; those plans can be approved individually or with the prepared-plan approve-all control.
After dashboard submit, the session-activity panel shows the bounded queued count, pending agent work, prepared plans, stale/rejected states, and execution receipts, while affected rows show they were sent to the agent.
Submitted approvals stay visibly queued until the agent handles them, and the activity rail can unqueue pending browser work without touching ledgers, files, trash, or plans.
Sources are collapsed by default behind the source details drawer.
Use `ui bundle` to list approved bundles or load one immutable snapshot plus its selected exact targets before live-state revalidation, then `ui execute` (the one mutating `ui` subcommand) to run an approved bundle through the revalidate -> execute -> verify loop, recording one of `executed`/`skipped_stale`/`failed`/`needs_manual_review` per target; dispose-backed targets also bind to the reviewed plan entry digest, so missing or unreadable plans, subject content drift, or same-id plan rewrites become stale before receipts instead of changing reason, subject, target, or retention semantics. `ui execute` runs only the bundle's selected exact targets; there is no `ui execute --all` broad action (it is refused), and a purge-lane target is a one-way door - the approved trashed artifact is physically deleted with no recovery path, independently verified afterward, and stamped with a per-target no-recovery receipt.
If `ui execute` claimed an approval event as `in_progress` and stopped before final receipts, rerun the same session and bundle id to resume that claim.
The browser captures triage intents and approval bundles only, with no direct ledger/file/trash/plan mutation and no file-content preview.
Treat the session token printed by `artshelf ui` and `ui serve` as a secret same-machine browser capability; `ui end` revokes browser writes and served dashboard/detail/bundle access while preserving the audit trail.

For a live UI review request, run one attached lifecycle: start/resume `artshelf ui --scope user --json`, keep `artshelf ui serve --scope user --port 0 --json` alive as a managed foreground process, poll repeatedly, reply `in_progress` immediately, process only read-only/dry-run or exactly approved work, reply with a useful final payload, and keep looping until an explicit close/end signal. On close, finish or cancel safely, run `artshelf ui end <session-id> --scope user --json`, stop the served UI process, and summarize back in the originating conversation. If you cannot keep the server and poller attached, say managed UI review is unavailable instead of presenting the browser as live.
Register existing project ledgers explicitly:

```bash
artshelf ledgers add --ledger <repo>/.artshelf/ledger.jsonl --name <project> --scope repo --json
```

### Scheduled Review

Scheduled jobs are review/report only. Set `ARTSHELF_NO_UPDATE_CHECK=1` for no
npm network/cache writes. Reports should name the ledger path or registry path and plan ids. They may run:

```bash
artshelf validate --json
artshelf due --json
artshelf review --all --json
artshelf cleanup --dry-run --json
artshelf cleanup --dry-run --all --json
artshelf trash list --all --json
artshelf doctor --json
artshelf status --all --json
artshelf ledgers prune --dry-run --registry <registry-path> --json
```

For old-trash review, dry-run purge only for an explicit ledger:

```bash
artshelf trash purge --older-than 7d --dry-run --ledger <ledger-path> --json
```
Do not scan arbitrary filesystem locations for ledgers unless the user opted
into that discovery scope. Scheduled jobs may review registry-prune plans but
must not execute them. Never schedule cleanup, dispose, registry-prune, purge, or approved bundle execution:

```bash
artshelf cleanup --execute --plan-id <id>
artshelf dispose --execute --plan-id <id>
artshelf ledgers prune --execute --plan-id <id>
artshelf trash purge --execute --plan-id <id>
artshelf ui execute <session-id> <bundle-id>
```

## Review

Daily Review Workflow: turn raw Artshelf output into a decision packet, not a
count dump.

1. Run read-only review first: `artshelf status --all --agent` for machine health,
   then `artshelf review --all --agent`, and `artshelf trash list --all --json`.
2. If stale registered ledgers exist, run `artshelf ledgers prune --dry-run --registry <registry-path> --json` to review removing missing registrations; duplicate paths remain manual registry-problem blockers.
3. If missing-path warnings exist inside valid ledgers, run `artshelf validate --all --json` then `artshelf reconcile --dry-run --all --json --registry <registry-path>` for renames, moves, deletes, topology after handoff/finalization, and `.shelf`/`.artshelf` migration fallout.
4. If cleanup attention exists, run `artshelf cleanup --dry-run --all --json`.
5. Classify candidates as `trash-safe`, `needs-human-review`,
   `resolve-candidate`, or `registry-problem`. For one flagged record (e.g. a
   stale `cleanup=review` backup), read-only `artshelf get <id> --inspect --agent`
   returns a per-record decision (`keep`, `snooze`, `trash-safe`, `resolve-only`,
   `blocked`) and the exact next-safe action without mutating anything.
6. Use the built-in `--agent` packet when the CLI output is enough to decide,
   because it is deterministic and token-efficient. Use
   `ArtshelfReviewReport` from `schemas/artshelf-review-report.schema.json` and `examples/artshelf-review-report.json` when you need a host-specific card, attachment, or richer audit record.
7. Render full packets with `scripts/render-review-report.mjs`; keep
   `decisionSummary` in audit, while `decisionGroups` drive counts. Emojis are encouraged only in host-specific wrappers, not the renderer.
8. For one inspected decision that needs a disposition plan, run `artshelf dispose --id <id> --action <trash-resolve|resolve-only|snooze|keep> --dry-run --ledger <ledger-path> --json` and include its exact approval target.
9. Always include the exact approval target in the message body as a fallback.
   Do not paste the whole packet into chat unless the user asks for it.

### Review Plan Report Schema

Deterministic compact decision card renderer:

```bash
cd /path/to/skills/artshelf
node scripts/render-review-report.mjs examples/artshelf-review-report.json
```

The renderer owns the exact layout.
It emits `Artshelf daily review`, `Ready for approval`, `Needs review first`, `Blocked`, `Recommended action`, `Why:`, `Action:`, `Suggested next step:`, and `Safety`.
Its safety line stays: `Dry-run only. No execute, resolve, or delete ran.`

Approval wording:

```text
approve artshelf cleanup ledger <ledger-path> plan <plan-id>
approve artshelf dispose ledger <ledger-path> plan <dispose-plan-id>
approve artshelf trash purge ledger <ledger-path> plan <purge-plan-id>
approve artshelf resolve missing ledger <ledger-path> ids <id...>
approve artshelf reconcile ledger <ledger-path> plan <plan-id>
approve artshelf ledgers prune registry <registry-path> plan <plan-id>
```

Never execute from a read-only preview id. Never generate a fresh plan and
execute it in the same step. After cleanup, dispose, resolve, registry-prune, or approved `ui execute` bundle execution, verify with `artshelf review --all --json` and `artshelf ledgers list --json`; after trash purge approval, also run `artshelf trash list --all --json`.

## Clean

Read-only and dry-run commands listed above are safe. Registry-prune execution requires approval naming the reviewed registry and plan id (`artshelf ledgers prune --execute --plan-id <id> --registry <registry-path> --json`); it removes only registrations whose ledger files are still missing, writes a rollback copy and receipt next to the registry, and skips entries that changed after review.

Cleanup execution requires approval naming the reviewed ledger and plan id:

```bash
artshelf cleanup --execute --plan-id <id> --ledger <ledger-path> --json
```

If cleanup is interrupted, rerun the same plan id; durable receipt/trash
evidence resumes or replays without a fresh plan. `cleanup=trash` quarantines
files into Artshelf trash. Physical deletion belongs to the separate Purge stage.

Dispose execution requires approval naming the reviewed ledger and plan id:

```bash
artshelf dispose --execute --plan-id <id> --ledger <ledger-path> --json
```

`dispose` applies one inspected record decision: `trash-resolve` moves the
subject into plan-scoped Artshelf trash and resolves the row, `resolve-only`
closes the row without moving files, `snooze` extends retention, and `keep`
stamps the record reviewed-and-kept. It refuses `--all`, stale plans, target
conflicts, fresh-plan-then-execute, and physical deletion.

Resolve only after confirmation; it updates the ledger and does not move or
delete files:

```bash
artshelf resolve <id> --status resolved --reason "<specific reason>" --ledger <ledger-path> --json
```

## Purge

Trash purge is separate from cleanup and needs its own reviewed purge plan. List
trash and dry-run purge freely; execute `artshelf trash purge --execute --plan-id <purge-plan-id> --ledger <ledger-path> --json` only after exact approval:
`approve artshelf trash purge ledger <ledger-path> plan <purge-plan-id>`. After
purge execute, verify quiet with `artshelf trash list --all --json` and `artshelf review --all --json`.

## Safety
- Do not register secrets or credential dumps.
- Do not use Artshelf as a replacement for git, durable workflow ledgers, or
  backups.
- Do not silently delete files.
- Do not treat `cleanup=delete` as permission to delete. Cleanup records a
  refusal; physical deletion requires a separate reviewed trash purge plan.
