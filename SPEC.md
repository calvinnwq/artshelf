# Artshelf V1 Spec

## Problem

Agents and humans create temporary directories, backups, run artifacts, debug
outputs, and quarantine folders during work. Those artifacts often have a clear
reason when created, but that reason is lost later. Cleanup then becomes risky:
we either keep everything forever or delete based on weak filesystem age.

Artshelf makes artifact creation accountable at the moment it happens.

## One-Line Product Definition

Artshelf is a tiny CLI for putting temporary artifacts, backups, and run outputs
somewhere accountable, with an expiry tag and a cleanup plan.

## Goals

- Record why an artifact exists, who created it, and how long it should stay.
- Make due cleanup visible without guessing from filesystem timestamps.
- Make cleanup previewable and auditable.
- Give agents a deterministic tool they can call instead of leaving scratch
  files behind.
- Stay small enough that agents actually use it.

## Non-Goals

- Not a full backup system.
- Not a daemon.
- Not Kortex.
- Not a desired-state reconciler.
- Not a general disk cleaner.
- Not a content indexer.
- Not a credential scanner in v1.
- Not allowed to silently delete files.

## V1 CLI

### `artshelf put`

Records an existing file or directory in the ledger.

```bash
artshelf put <path> --reason "why this exists" --ttl 7d --kind scratch
```

Required:

- `path`
- `--reason`
- one of `--ttl`, `--retain-until`, or `--manual-review`

Optional:

- `--kind scratch|backup|run-artifact|evidence|cache|quarantine|other`
- `--cleanup trash|review|delete` (`delete` records intent, but cleanup
  execution refuses it as `cleanup-refused`)
- `--owner <string>`
- `--label <label>` repeatable
- `--ledger <path>`
- `--registry <path>`
- `--json`

Defaults:

- `kind=other`
- `cleanup=review`
- `owner=manual`

`put` should refuse to record a path that does not exist unless a future flag
explicitly supports planned artifacts. After appending the record, `put`
registers the ledger in the ledger registry. Registry registration is
best-effort: if it fails, the record remains appended and output includes a
registry warning or `registryError`.

### `artshelf ledgers`

Lists or registers known Artshelf ledgers.

```bash
artshelf ledgers list
artshelf ledgers list --json
artshelf ledgers list --plain
artshelf ledgers add --ledger <path> --name <project> --scope repo --json
```

Rules:

- `list` validates each registered ledger by default and reports
  ok/missing/invalid status, entry counts, and warning/error counts so agents can
  detect stale registry entries without a separate validate pass. It reads
  ledgers but never mutates them, and exits non-zero when the registry or any
  registered ledger is broken.
- `list --plain` is the fast path that lists registered ledgers without reading
  them; it does not validate and exits zero whenever the registry itself is
  readable.
- `add` requires an existing ledger path.
- `--name` defaults from the ledger path when omitted.
- `--scope` is optional; when omitted, Artshelf infers `repo`, `user`, or
  `other` from the ledger path.

### `artshelf list`

Shows ledger entries in a human-readable format.

```bash
artshelf list
artshelf list --json
artshelf list --status active
artshelf list --status resolved --json
artshelf list --all --status active --json
```

`--status` filters the audit trail to one record status:

- `active`
- `review-required`
- `trashed`
- `cleanup-refused`
- `resolved`

`--all` reads every registered ledger through the registry. All-mode reads
validate registered ledgers first and report stale or invalid entries before
returning records.

### `artshelf find`

Read-only ledger query for integrations that need idempotent artifact
registration without parsing `list` output.

```bash
artshelf find --path <path> --json
artshelf find --path <path> --owner <agent-or-runtime> --label <task-or-run-id> --status active --json
artshelf find --all --owner <agent-or-runtime> --json
```

Accepted selectors:

- `--path <path>`: exact artifact path match after path normalization.
- `--owner <string>`
- `--label <label>` repeatable; all labels must match.
- `--status active|review-required|trashed|cleanup-refused|resolved`

`find` requires at least one selector. It never creates, resolves, moves, or
deletes records. `--all` applies the same selector set to every registered
ledger.

### `artshelf get`

Read-only lookup of a single ledger record by Artshelf id.

```bash
artshelf get <id>
artshelf get <id> --json
artshelf get <id> --all --json
```

`get` is for audit and handoff follow-up. Missing ids are an error. `--all`
searches registered ledgers until the id is found.

### `artshelf due`

Shows entries whose retention has expired or that need manual review.
Only `active` records participate in due classification; records already handled
by cleanup execution remain visible through `list` and validation.

```bash
artshelf due
artshelf due --json
artshelf due --all --json
```

V1 due statuses:

- `due`
- `manual-review`
- `missing-path`
- `kept`

`--all` classifies active entries across registered ledgers.

### `artshelf validate`

Checks ledger health without mutating files.

```bash
artshelf validate
artshelf validate --json
artshelf validate --all --json
```

V1 validation checks:

- ledger file is parseable JSONL
- required fields are present
- IDs are unique
- paths are absolute or resolvable
- TTL/retain-until/manual-review is valid
- cleanup action is known
- resolved records include `resolvedAt` and `resolutionReason`
- handled cleanup records include required cleanup metadata (`cleanupPlanId`,
  `receiptPath`, and `cleanedAt`; trashed records also require `targetPath`)
- active and review-required recorded paths still exist, reported as warnings not hard failures
- trashed `targetPath` values still exist, reported as warnings not hard failures

`--all` validates registered ledgers and reports stale registry entries when a
registered ledger is missing from disk.

### `artshelf review`

Runs validation, due classification, and cleanup plan preview without mutating
files or writing a plan.

```bash
artshelf review --json
artshelf review --all --json
```

`review` is the compact report surface for scheduled checks. `--all` reads every
registered ledger from the registry; stale, invalid, and valid no-op ledgers are
included with a `not-created` plan instead of writing a plan file.

In `--all` mode, review emits an aggregate triage summary on top of the
per-ledger detail. JSON includes a `summary` block with affected-ledger, due,
manual-review, missing-path, executable, and skipped counts plus the preview
plan ids; JSON also includes the next safe action. Human output adds a one-line
triage count and states the same next safe action (repair broken ledgers, dry-run
cleanup, inspect missing paths, or nothing to do). Review never writes a plan, so
the next action always points at an explicit follow-up command.

### `artshelf doctor`

Reports whether Artshelf is healthy on the current machine without mutating
anything.

```bash
artshelf doctor
artshelf doctor --json
artshelf doctor --ledger <path>
artshelf doctor --registry <path>
```

Doctor reports:

- CLI version and Node runtime version.
- The selected/default ledger path and selected/global registry path, and whether they exist.
- Registered ledger health, flagging stale (missing from disk) and invalid
  (unparseable or malformed) entries.
- The cleanup safety posture, including that `cleanup --execute` is scoped to
  one selected/default ledger and still requires a reviewed `--plan-id`, that
  global execute is refused, that `cleanup=delete` is refused in v1, and that
  physical trash purge requires a separate reviewed purge plan.

A healthy machine exits 0. A broken registry file or any stale or invalid
registered ledger exits non-zero with actionable errors. Humans should run
`artshelf doctor` after install or when `--all` commands behave unexpectedly; agents
may run it on a schedule to catch stale registry entries before relying on
cleanup planning. Doctor never creates plans, receipts, or records.

### `artshelf status`

The lightweight daily "what is going on?" view across ledgers.

```bash
artshelf status
artshelf status --json
artshelf status --all --json
artshelf status --all --registry <path> --json
```

Status reports:

- Registry health and the number of registered ledgers (with single `--ledger`
  it reports just that ledger).
- Per-ledger and aggregated counts of active artifacts, kept, due,
  manual-review, and missing-path entries.
- The pending cleanup count: how many entries a cleanup plan would currently
  contain, computed read-only without writing a plan.

`artshelf status --all --json` is suitable for cron and reporting, and the human
output is short enough to paste into a chat. Status is strictly read-only: it
never creates plans or receipts and never mutates records. A healthy machine
exits 0. In `--all` mode, a broken registry or any stale or invalid registered
ledger exits non-zero. Due entries are normal operational state and do not change
the exit code. With single `--ledger`, a not-yet-created ledger reports empty
counts.

### `artshelf update`

Checks the latest published npm version and, for npm global installs, updates the
package with npm.

```bash
artshelf update
artshelf update --json
```

Rules:

- Normal commands may perform a best-effort npm update check after command
  handling and print a non-blocking notice to stderr when a newer version is
  available.
- Read-only command guarantees refer to ledger and artifact mutation; automatic
  update-check cache writes are separate and can be disabled.
- Update notices must never pollute JSON stdout.
- Automatic checks cache successful and failed latest-version lookups at
  `~/.artshelf/update-check.json` by default, with a 24-hour TTL.
- `ARTSHELF_NO_UPDATE_CHECK=1` disables automatic checks for scheduled jobs,
  tests, and no-network environments.
- `ARTSHELF_UPDATE_CACHE` overrides the update-cache path,
  `ARTSHELF_UPDATE_CHECK_TTL_MS` overrides the cache TTL, and
  `ARTSHELF_NPM_REGISTRY_URL` overrides the npm latest-version endpoint.
- `ARTSHELF_LATEST_VERSION` overrides the discovered latest version for tests.
- `ARTSHELF_UPDATE_DRY_RUN=1` makes `artshelf update` report the npm command it
  would run without invoking npm.
- `artshelf update` forces a fresh latest-version check and does not run the
  automatic post-command notice check.
- If the current version is already current, update exits 0 and reports that no
  update was installed.
- When an update is available, `artshelf update` runs
  `npm install -g artshelf@latest`; `--json` captures npm stdout/stderr and
  returns npm's exit code.
- `artshelf update` is for npm global installs only. pnpm global installs should
  use `pnpm add -g artshelf@latest`; source installs should pull, rebuild, and
  link the checkout again.

### `artshelf cleanup --dry-run`

Creates a cleanup plan when there are executable cleanup entries, but does not
mutate artifacts. If there are no executable cleanup entries, dry-run reports
`planId=not-created`, `planPath=null`, and does not write a plan file.
If an existing plan has the same executable cleanup entries, Artshelf reuses that
plan id, refreshes `generatedAt`, rewrites the same plan file, and refreshes the
Artshelf-owned plan artifact record instead of creating a duplicate plan.

```bash
artshelf cleanup --dry-run
artshelf cleanup --dry-run --json
artshelf cleanup --dry-run --all --json
```

Written plans must include:

- `planId`
- generated timestamp
- candidate entry IDs
- planned action per entry
- skipped/refused entries with reasons
- plan file path

`--all` creates dry-run plans only for registered ledgers that have executable
cleanup entries, and only after every registered ledger validates. Global
cleanup execution is refused.

When a dry-run writes a cleanup plan, Artshelf appends or refreshes an Artshelf-owned
ledger record for the plan file with `owner=artshelf`, `kind=run-artifact`,
`ttl=14d`, `cleanup=trash`, and labels including `artshelf`, `cleanup-plan`, and the
plan id.

### `artshelf cleanup --execute`

Executes a previously generated cleanup plan.

```bash
artshelf cleanup --execute --plan-id <id>
artshelf cleanup --execute --plan-id <id> --json
```

Rules:

- Requires `--plan-id`.
- Refuses to generate a fresh live cleanup set during execute.
- Writes a cleanup receipt and appends or refreshes an Artshelf-owned ledger record
  for that receipt with `owner=artshelf`, `kind=run-artifact`, `ttl=30d`,
  `cleanup=review`, and labels including `artshelf`, `cleanup-receipt`, and the
  plan id.
- Updates touched ledger records so handled artifacts stop appearing as active
  cleanup candidates.
- Uses trash/review behavior by default.
- `delete` is refused in v1: even when a ledger entry says `cleanup=delete`,
  execute records a `cleanup-refused` receipt (`delete is disabled in v1`) and
  never removes the file. Physical deletion is only available later through a
  separately reviewed `artshelf trash purge --execute` plan for quarantined trash.

### `artshelf trash list`

Read-only listing of records that cleanup execution moved into Artshelf trash
(`status=trashed`).

```bash
artshelf trash list
artshelf trash list --ledger <path> --json
artshelf trash list --all --json
```

Rules:

- Reports `id`, `targetPath`, `cleanedAt`, `receiptPath`, `cleanupPlanId`, and a
  human-readable `age` for each trashed record.
- Never moves, deletes, or resolves records.
- `--all` reads every registered ledger through the registry and validates those
  ledgers first, the same way `list --all` and `review --all` do.

### `artshelf trash purge`

Approval-first physical deletion of quarantined trash. Trashed artifacts stay in
Artshelf trash until a separately reviewed purge plan removes them, mirroring the
cleanup dry-run/execute boundary.

```bash
artshelf trash purge --older-than <ttl> --dry-run --ledger <path> --json
artshelf trash purge --execute --plan-id <id> --ledger <path> --json
```

Rules:

- Scoped to a single ledger. `--all` is refused for purge (it is only supported
  by `trash list`); there is no global blind delete.
- Requires either `--dry-run` or `--execute`; there is no non-persisted preview
  that looks like an executable reviewed plan.
- `--dry-run` builds an age-based purge plan from records whose `cleanedAt` is
  older than `--older-than`, writes it to `<ledger-dir>/purge-plans/<id>.json`,
  and registers an Artshelf-owned plan record (`ttl=14d`, `cleanup=review`, labels
  including `artshelf`, `trash-purge-plan`, and the purge plan id). No-op dry-runs
  report `not-created` and write no plan file.
- The purge plan records `purgePlanId`, `generatedAt`, `ledgerPath`,
  `olderThan`, and the computed `cutoff`. Each executable entry includes
  `id`, `targetPath`, `cleanedAt`, `receiptPath`, and `cleanupPlanId`; skipped
  records include `id`, `targetPath`, and the skip `reason`.
- `--execute` requires a `--plan-id` produced by an earlier reviewed dry-run; it
  refuses to compute a fresh purge set and refuses to rerun a purge plan with an
  already completed receipt. It physically removes each planned trash target,
  skipping entries whose record is missing, is no longer `trashed`, or whose
  target is already gone. Before removal it also re-checks that the plan entry
  still matches the live ledger record and that the target remains inside Artshelf's
  ledger-local trash directory for that cleanup plan.
- Writes a `started` purge receipt to `<ledger-dir>/purge-receipts/<id>.json`
  before deletion, records `pending` and `deleting` result states during the run,
  then completes the receipt with `purged`, `skipped`, or `failed` results. If an
  interrupted purge left a started receipt, a later execute resumes from those
  results and reconciles a `deleting` entry whose target is already gone as
  `purged`.
- Registers the completed receipt (`ttl=30d`, `cleanup=review`, labels including
  `artshelf`, `trash-purge-receipt`, and the purge plan id) so the final deletion
  stays auditable.
- Marks purged records `resolved` with `purgedAt`, `purgePlanId`, and
  `purgeReceiptPath`, so they no longer reappear as trashed.

### `artshelf resolve`

Marks a handled, missing, or no-longer-needed record as manually resolved while
keeping it in the ledger audit trail.

```bash
artshelf resolve <id> --status resolved --reason <text>
artshelf resolve <id> --status resolved --reason <text> --json
```

Rules:

- Requires `<id>`, `--status resolved`, and `--reason`.
- Does not move or delete files.
- Removes the record from future `due` and cleanup dry-run output.
- Keeps the record visible through `list` and `list --status resolved`.
- Refuses records that are already `resolved`; the original reason is preserved.

## Ledger Storage

V1 supports two scopes:

- repo-local: `.artshelf/ledger.jsonl`
- user-global: `~/.artshelf/ledger.jsonl`

Default behavior:

- If the current directory is inside a git repo, write repo-local.
- Otherwise write user-global.
- Allow `--ledger <path>` for explicit tests and unusual workflows.

V1 also supports a user-level registry of known ledgers:

- registry: `~/.artshelf/ledgers.json`
- `--registry <path>` overrides the registry path. Without it,
  `ARTSHELF_REGISTRY` is read first, then legacy `SHELF_REGISTRY`, then the
  default registry path.
- Legacy `.shelf` ledgers are not deleted or moved automatically. Migration is
  copy-first: copy ledger directories to `.artshelf`, rewrite registry entries,
  validate the new registry, and retain the old `.shelf` directories for
  rollback until the new paths are proven quiet.
- Retention and due calculations use wall-clock time by default. `ARTSHELF_NOW`
  overrides it for tests and controlled runs; legacy `SHELF_NOW` is read only
  when `ARTSHELF_NOW` is unset.
- Automatic npm update checks cache their latest-version result at
  `~/.artshelf/update-check.json` by default. `ARTSHELF_NO_UPDATE_CHECK=1`
  disables automatic checks, `ARTSHELF_UPDATE_CACHE` overrides the cache path,
  and `ARTSHELF_UPDATE_CHECK_TTL_MS` overrides the cache TTL.
- `put` registers the ledger it writes to.
- `ledgers add` registers an existing ledger explicitly.
- `--all` reads registered ledgers as one review surface.
- `trash list --all` reads trashed records across registered ledgers after
  registry validation.
- `cleanup --execute --all` and `trash purge --all` are refused; execution stays
  scoped to one explicit ledger and one reviewed plan id.

## Ledger Registry Schema

```json
{
  "version": 1,
  "ledgers": [
    {
      "name": "my-repo",
      "path": "/absolute/path/to/repo/.artshelf/ledger.jsonl",
      "scope": "repo",
      "createdAt": "2026-06-01T05:42:00Z",
      "updatedAt": "2026-06-01T05:42:00Z"
    }
  ]
}
```

## Ledger Record Schema

```json
{
  "id": "shf_20260601_154200_ab12",
  "path": "/absolute/path/to/artifact",
  "kind": "scratch",
  "reason": "debug parser output",
  "createdAt": "2026-06-01T05:42:00Z",
  "retainUntil": "2026-06-04T05:42:00Z",
  "retention": {
    "mode": "ttl",
    "ttl": "3d"
  },
  "cleanup": "trash",
  "owner": "manual",
  "labels": ["debug"],
  "status": "active"
}
```

V1 record statuses:

- `active`: eligible for `due` classification and cleanup dry-run planning.
- `review-required`: execution surfaced the artifact for manual review.
- `trashed`: execution moved a `cleanup=trash` artifact into Artshelf trash.
- `cleanup-refused`: execution refused the requested action, such as physical
  delete in v1.
- `resolved`: a human or agent marked the record as manually handled.

Handled records may include cleanup outcome fields:

```json
{
  "cleanupPlanId": "plan_20260601_154200_cd34",
  "receiptPath": "/absolute/path/.artshelf/receipts/plan_20260601_154200_cd34.json",
  "cleanedAt": "2026-06-01T05:45:00Z",
  "targetPath": "/absolute/path/.artshelf/trash/plan_20260601_154200_cd34/shf_20260601_154200_ab12-artifact",
  "cleanupReason": "delete is disabled in v1"
}
```

Manually resolved records include:

```json
{
  "resolvedAt": "2026-06-01T05:45:00Z",
  "resolutionReason": "artifact inspected and no longer needed"
}
```

Records removed by `artshelf trash purge --execute` become `resolved` and also carry
the purge provenance:

```json
{
  "resolvedAt": "2026-06-01T06:10:00Z",
  "resolutionReason": "trash purge completed",
  "purgedAt": "2026-06-01T06:10:00Z",
  "purgePlanId": "purge_20260601_061000_ef56",
  "purgeReceiptPath": "/absolute/path/.artshelf/purge-receipts/purge_20260601_061000_ef56.json"
}
```

## Cleanup Safety Model

Cleanup execution is intentionally boring and approval-only. Five boundaries
hold, and every future feature (`status`, `doctor`, `review`, scheduled jobs,
...) must preserve them rather than add a shortcut around them:

- **No daemon.** Artshelf never runs in the background or watches the clock. It
  only does work while you are running an `artshelf` command.
- **No auto-execute.** No command cleans up as a side effect. The only commands
  that move, trash, or delete files are `artshelf cleanup --execute` and
  `artshelf trash purge --execute`, each run by a human against a separately
  reviewed plan id.
- **No global execute.** `cleanup --execute --all` and `trash purge --all`
  are refused; `--all` is read-only or dry-run reporting only. Execution is
  always scoped to a single reviewed plan id.
- **No fresh-plan-then-execute.** `cleanup --execute` refuses to compute a new
  live set. It acts only on a plan id that an earlier `cleanup --dry-run`
  produced and a human reviewed; it will not plan and execute in one step.
- **No silent deletion.** Cleanup trashes or flags for review and writes a
  receipt to the ledger. The `cleanup=delete` action stays refused in v1; the
  one sanctioned physical deletion is `artshelf trash purge --execute`, which only
  removes already-quarantined trash through its own reviewed purge plan and
  receipt. Nothing leaves the filesystem without an auditable trail.

Operational rules that back those boundaries:

- Dry-run first.
- Execute only by plan id.
- Trash/review before delete.
- Execute updates ledger state after writing the cleanup receipt. A trashed,
  review-required, or refused record no longer participates in future `due` or
  cleanup dry-run output by default.
- Missing paths update the report; they are not treated as a successful cleanup
  unless the user explicitly repairs the ledger later.
- Cleanup never scans arbitrary filesystem paths for deletion in v1.
- Cleanup only acts on ledger entries.
- Trash purge is scoped to one ledger, requires a reviewed purge plan id, and
  writes a purge receipt before removing quarantined files.

## Agent Usage Contract

Agents should call `artshelf put` immediately after creating:

- config backups
- quarantine folders
- debug output directories
- temporary repo artifacts
- one-off generated reports
- copied files kept for rollback

Agents should not run `artshelf cleanup --execute` or
`artshelf trash purge --execute` without explicit approval naming the ledger path
and reviewed plan id.

Agents may run `artshelf find` and `artshelf get` before `put` to avoid duplicate
registrations. `find`/`get` are read-only ledger queries; they must not be used
as permission to clean up or resolve a record.

When `artshelf put --json` succeeds, agents should include a deterministic
Artshelf footnote in the same handoff, status, final response, or run summary
that mentions the artifact:

```text
Artshelf footnote: registered <artifact-path> as <artshelf-id>; reason: <short reason>; due: <YYYY-MM-DD|manual-review>; cleanup=<cleanup-mode>.
```

Agents may run `artshelf resolve <id> --status resolved --reason <text>` only
after explicit confirmation that the record has been handled, is missing, or is
no longer needed. The reason must be specific; resolve does not move or delete
files.

For batches of missing-path records, agents should ask for exact approval before
resolving:

```text
approve artshelf resolve missing ledger <ledger-path> ids <id...>
```

Scheduled jobs may run:

```bash
artshelf due --json
artshelf due --all --json
artshelf review --all --json
artshelf doctor --json
artshelf status --all --json
artshelf cleanup --dry-run --json
artshelf cleanup --dry-run --all --json
artshelf trash list --ledger <path> --json
artshelf trash list --all --json
artshelf trash purge --older-than <ttl> --dry-run --ledger <path> --json
```

Set `ARTSHELF_NO_UPDATE_CHECK=1` for scheduled jobs that must avoid npm network
checks and update-cache writes.

`artshelf review --all --json` is the read-only all-ledger triage surface;
scheduled reports should include its aggregate `summary` and `nextAction` when
whole-machine review is needed.

Scheduled trash reports may use `artshelf trash list --all --json` for
registered-ledger discovery and should include trashed record counts and target
ages. Purge dry-runs stay scoped to one explicit ledger and should report any
plan id, matching entries, and skipped entries.

When a scheduled review or dry-run produces cleanup or trash purge plans,
deterministic integrations should build an `ArtshelfReviewReport` packet first,
then render a compact decision report from it. The packet schema is
`schemas/artshelf-review-report.schema.json`, the canonical example is
`examples/artshelf-review-report.json`, and the portable skill includes
`scripts/render-review-report.mjs` for deterministic text rendering. Packaged
docs/skills carry matching copies for browsable docs and portable agent
installs. The report groups decisions into ready-for-approval,
needs-review-first, and blocked sections, and must still include exact approval
targets in the message body.

Scheduled jobs must never run `artshelf cleanup --execute` or
`artshelf trash purge --execute`; they may only dry-run and report plans for later
human review.

## Dogfood Scenarios

1. Record a repo-local `tmp/` scratch directory with a 3-day TTL.
2. Record a config backup with manual review retention.
3. Generate a dry-run cleanup plan after TTL expiry using fixture data.
4. Execute a cleanup plan in a temporary test fixture and verify receipt output.
5. List trashed records, dry-run an old-trash purge, then execute the reviewed
   purge plan in a fixture and verify receipt output plus resolved ledger state.

## V1 Acceptance Criteria

- CLI can record entries to JSONL.
- CLI can register known ledgers and list them with per-ledger validation status
  by default, or a `--plain` fast path that skips validation.
- CLI can review registered ledgers through `--all` read-only entry points,
  emitting an aggregate triage summary and the next safe action.
- CLI refuses records without a reason.
- CLI requires TTL, retain-until, or manual-review.
- CLI can list, filter by status, and show due entries.
- CLI can find existing records by path/owner/label/status and get records by id.
- CLI can mark records manually resolved with a required reason.
- CLI validates ledger shape.
- CLI reports machine and registry health through `artshelf doctor`, exiting
  non-zero when the registry or a registered ledger is broken.
- CLI reports a read-only daily dashboard through `artshelf status`, with
  `--all --json` suitable for cron and human output short enough to paste into
  a chat; status never creates plans, receipts, or records.
- CLI can check for npm package updates, print non-blocking stderr notices, and
  update npm global installs through `artshelf update`.
- Cleanup dry-run creates a plan id only when there are executable cleanup
  entries; no-op dry-runs do not write plan files.
- Cleanup dry-run and execute register the plan/receipt artifacts that Artshelf
  creates.
- Cleanup execute refuses to run without a plan id.
- Cleanup execute writes a receipt.
- CLI can list trashed records (single ledger or `--all`) and purge them through
  an approval-first, ledger-scoped dry-run/execute boundary that writes a purge
  receipt; purge refuses `--all` and never deletes without a reviewed plan id.
- Package includes the deterministic `ArtshelfReviewReport` schema, canonical
  example, and portable renderer script for agent-rendered review reports.
- All core commands support `--json`.
- Tests cover record/list/find/get/status-filter/due/validate/resolve/registry,
  `artshelf doctor`, the `artshelf status` dashboard, `--all` review, stale-registry,
  dry-run, global-dry-run, execute-plan, and trash list/purge behavior.

## Deferred

- Cron integration.
- Agent skill adapters.
- GitHub Action.
- Fake/demo mode.
- Rollback command.
- Retention classes like keep-daily/weekly/monthly.
- Dependency roots and pinning.
- Credential scanning.
