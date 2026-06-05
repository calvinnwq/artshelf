# Agent Usage

Agents that support local skills can copy or reference
[`skills/artshelf/SKILL.md`](../skills/artshelf/SKILL.md). The public docs site at
<https://calvinnwq.github.io/artshelf/> explains the same contract in browsable
form.

Artshelf works best when agents register artifacts at creation time, while the
reason is still fresh. Do not wait for a cleanup pass to infer intent from file
age or path names.

## When To Register

Treat Artshelf as a finalization trigger, not an optional cleanup habit. Before an
agent reports a task as done, it must check whether the task created, copied,
exported, quarantined, backed up, or preserved any non-source file or directory
that may outlive the current command.

Call `artshelf put` immediately after creating an eligible artifact:

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
artshelf put <path> --reason "<why this exists>" --ttl 3d --kind run-artifact --cleanup review --owner agent
```

If Artshelf is not installed, use the package-manager install path when
available:

```bash
npm install -g artshelf
artshelf --version
artshelf doctor
```

With pnpm:

```bash
pnpm add -g artshelf
artshelf --version
artshelf doctor
```

For source installs, do not assume a repo path. Ask where the user wants the
Artshelf repo cloned, then use the supported local path:

```bash
git clone https://github.com/calvinnwq/artshelf.git "$ARTSHELF_REPO"
cd "$ARTSHELF_REPO"
corepack enable
pnpm install --frozen-lockfile
pnpm run build
npm link
artshelf --version
artshelf doctor
```

Do not create a custom shim. Use the published package or `npm link` from a
local source checkout.

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

Use `--json` when another tool needs to capture the Artshelf entry id.

## Idempotent Lookup

Integrations should check the ledger before creating another record for the
same artifact. Use `find` and `get` for read-only lookup:

```bash
artshelf find --path <path> --owner <agent-or-runtime> --label <task-or-run-id> --json
artshelf get <id> --json
```

`find` requires at least one selector: `--path`, `--owner`, `--label`, or
`--status`. Multiple labels are an all-label match. If `find` returns an
existing record, report that Artshelf id instead of calling `put` again. If it
returns no entries, call `put` and record the new id.

## Ledger Registry

Artshelf keeps a user-level registry at `~/.shelf/ledgers.json` so one CLI can
review all known ledgers without moving project records into one global file.
`put` registers the ledger it writes to. Register existing ledgers explicitly
when adopting Artshelf for an existing project:

```bash
artshelf ledgers add --ledger <repo>/.shelf/ledger.jsonl --name <project> --scope repo
artshelf ledgers list --json
```

`artshelf ledgers list --json` validates each registered ledger and reports
ok/missing/invalid status with entry and warning/error counts, so agents can
detect stale registry entries without a separate validate pass. Add `--plain`
for a fast listing that skips validation.

Use the registry for read-only review and discovery:

```bash
artshelf review --all --json
artshelf status --all --json
artshelf due --all --json
artshelf find --all --owner <agent-or-runtime> --json
artshelf trash list --all --json
```

`artshelf review --all --json` returns an aggregate triage summary (affected
ledgers, due, manual-review, missing-path, executable, and skipped counts plus
preview plan ids) alongside the per-ledger detail, and states the next safe
action.

Use global cleanup dry-run when you want Artshelf to write cleanup plans for
registered ledgers with cleanup entries, without moving files:

```bash
artshelf cleanup --dry-run --all --json
```

Do not use `--all` as permission to mutate files. Cleanup execution remains
ledger-specific and requires a reviewed plan id for that ledger.
If the executable cleanup entries have not changed, dry-run reuses the existing
plan id and refreshes the same plan file instead of creating duplicate plans.

## Daily Review Workflow

Use this flow when a scheduled review, recurring task, or user request reports
Artshelf cleanup attention:

1. Register artifacts early during work, or state why an eligible artifact was
   skipped.
2. Review state with read-only commands first:
   `artshelf ledgers list --json`, `artshelf review --all --json`, and
   `artshelf trash list --all --json`; for old trash on a selected ledger, run
   `artshelf trash purge --older-than 7d --dry-run --ledger <ledger-path> --json`.
3. Present a decision packet instead of raw counts. Include registry health,
   affected ledgers, due/manual-review/missing-path counts, executable entries,
   skipped entries, refused entries, trashed record counts and ages, purge
   dry-run plan ids/skipped entries, and the next safe action.
4. Classify each candidate:
   - `trash-safe`: disposable after the reviewed plan moves it into Artshelf trash.
   - `needs-human-review`: `cleanup=review`, evidence, backups, reports, or
     anything that should be inspected before closing.
   - `resolve-candidate`: already handled, missing, or no longer needed; use
     `artshelf resolve` only after confirmation.
   - `registry-problem`: stale, missing, or invalid ledger; fix registry health
     before touching artifacts.
5. If cleanup execution is appropriate, generate or reuse a dry-run plan, then
   ask for explicit approval naming the ledger path and reviewed plan id.
6. For trashed records, require a separate reviewed purge plan before physical
   deletion:

```bash
artshelf trash list --ledger <ledger-path>
artshelf trash purge --older-than 7d --dry-run --ledger <ledger-path> --json
artshelf trash purge --execute --plan-id <purge-plan-id> --ledger <ledger-path> --json
```

7. After approved cleanup execute, trash purge, or resolve, verify quiet with
   `artshelf review --all --json`, plus `artshelf trash list --ledger <ledger-path> --json`
   and purge receipt evidence after purge, or explain what remains.

Approval wording should be exact:

```text
approve artshelf cleanup ledger <ledger-path> plan <plan-id>
approve artshelf trash purge ledger <ledger-path> plan <purge-plan-id>
```

Never execute from a read-only preview id. Never generate a fresh plan and
execute it in the same step. `trash` moves artifacts into Artshelf trash; physical
delete requires a separate reviewed trash purge plan.

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

## Reporting Artshelf IDs

After registration, include the Artshelf id anywhere future cleanup context will be
read:

- handoff notes
- PR comments
- issue comments
- daily memory
- task run summaries
- incident or debugging notes

Example:

```text
Temporary parser output registered in Artshelf as shf_20260601_182800_ab12.
Retain until 2026-06-04; cleanup=review.
```

## Cleanup Boundary

Agents may run non-destructive cleanup checks:

```bash
artshelf validate --json
artshelf validate --all --json
artshelf due --json
artshelf due --all --json
artshelf review --all --json
```

Cleanup dry-run is safe to run. It writes plan files for later review only when
there are executable cleanup entries:

```bash
artshelf cleanup --dry-run --json
artshelf cleanup --dry-run --all --json
```

Cleanup execution is approval-only: no daemon, no auto-execute, no global
execute, and no fresh-plan-then-execute shortcut. Agents must not run this
without explicit human approval:

```bash
artshelf cleanup --execute --plan-id <id>
```

Approval should name the plan id. Do not generate a fresh plan and execute it in
the same breath. Review the dry-run first, then execute the reviewed plan id.
After cleanup execution, agents may inspect trash and create a purge dry-run for
review:

```bash
artshelf trash list --ledger <ledger-path> --json
artshelf trash purge --older-than 7d --dry-run --ledger <ledger-path> --json
```

Trash purge execution is separately approval-only and must name the ledger and
reviewed purge plan id:

```bash
artshelf trash purge --execute --plan-id <purge-plan-id> --ledger <ledger-path> --json
```

No-op dry-runs report `not-created` and do not write plan files. When dry-run or
execute creates plan or receipt artifacts, Artshelf records those artifacts in the
ledger as `owner=artshelf`.

`cleanup=delete` stays refused; execution records `cleanup-refused` instead
of silently deleting files. Physical deletion requires a separate reviewed trash
purge plan.

Execution writes a receipt and updates touched ledger records to `trashed`,
`review-required`, or `cleanup-refused`, so handled artifacts stop reappearing in
future due and dry-run cleanup output.

Agents may mark a ledger record manually resolved when the user confirms the
artifact was inspected, is already missing, or is no longer needed:

```bash
artshelf resolve <id> --status resolved --reason <text>
```

Use a specific reason. `resolve` only updates the ledger; it does not move or
delete files. Resolved records stop reappearing in future due and dry-run
cleanup output while remaining visible in `artshelf list --status resolved`.

## Scheduled Review

Agents may schedule routine Artshelf reviews for stale artifacts through their host
runtime, such as an agent cron, CI job, or recurring task. Keep the scheduled
job non-destructive:

```bash
artshelf validate --json
artshelf due --json
artshelf review --all --json
```

Read-only health and dashboard checks are also safe to schedule. Run
`artshelf review --all --json` for aggregate triage (`summary` and `nextAction`),
`artshelf doctor --json` to catch a broken or stale registry before relying on
cleanup planning, and `artshelf status --all --json` for a compact cron summary:

```bash
artshelf doctor --json
artshelf status --all --json
```

Scheduled cleanup and trash purge dry-runs may write plan files for later review
when entries exist, but must not move or delete files:

```bash
artshelf cleanup --dry-run --json
artshelf trash list --ledger <ledger-path> --json
artshelf trash list --all --json
artshelf trash purge --older-than 7d --dry-run --ledger <ledger-path> --json
```

The scheduled job should report the ledger path, due/manual-review/missing-path
counts, cleanup dry-run plan id, executable entries, skipped entries, and refused
entries. When reporting trash, `artshelf trash list --all --json` may discover trashed
records across registered ledgers. Include trashed record counts and target ages;
run purge dry-runs only for an explicit ledger and report any plan id, matching
entries, and skipped entries. It should be
quiet when nothing needs attention unless the user asked for a regular summary.

Use explicit ledger paths when scheduling checks for a known project or user
ledger. Do not scan arbitrary filesystem locations looking for ledgers unless
the user has opted into that discovery scope.

Scheduled jobs must not run cleanup execution or trash purge execution. They
may only dry-run and report plans for later human review:

```bash
artshelf cleanup --execute --plan-id <id>
artshelf trash purge --execute --plan-id <id>
```

Any later execution requires a human to review the dry-run output and approve
that specific plan id.

## Handoff Pattern

When a task creates registered artifacts, add a short section like this:

```text
Artshelf artifacts:
- shf_20260601_182800_ab12: /tmp/parser-output, debug evidence for issue-123,
  retain until 2026-06-04, cleanup=review
```

If there are no eligible artifacts, say nothing. If eligible artifacts were
skipped instead of registered, include the brief skip reason from the completion
checklist. Do not invent Artshelf entries after the fact just to make a handoff look
tidy.

## Completion Checklist

Before final response or handoff, agents should review their own file actions
from the current task:

1. Did I create, copy, export, quarantine, back up, or preserve any non-source
   file or directory?
2. Will any of those paths outlive this command?
3. If yes, did I either register them with Artshelf or record a clear skip reason?

Do not call work done while known eligible artifacts are neither registered nor
explicitly skipped.
