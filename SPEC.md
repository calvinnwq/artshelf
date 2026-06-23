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

### Help and option presentation

Top-level help is compact and points readers to focused command help.

```bash
artshelf help
artshelf --help
artshelf <command> --help
artshelf help <command>
artshelf <command> <subcommand> --help
artshelf help <command> <subcommand>
```

Rules:

- `artshelf help`, `artshelf --help`, and `artshelf -h` show a grouped command
  list with one-line summaries instead of dumping every command variant.
- Command groups are `Create`, `Inspect`, `Review`, `Clean`, and `System`.
- `artshelf <command> --help` and `artshelf help <command>` show focused help
  for that command.
- Nested help is supported for `trash list`, `trash purge`, `ledgers list`,
  `ledgers add`, and `ledgers prune`.
- `artshelf trash help` and `artshelf ledgers help` are aliases for the focused
  help of those commands, matching `artshelf help trash` and `artshelf help ledgers`.
- Top-level help presents `-h, --help` and `-v, --version` as global options,
  `--json` as the output mode, and `--ledger`, `--registry`, and `--all` as
  command-specific scope flags. The short `-h` and `-v` forms work both at the
  top level and after a command.

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
best-effort: if it fails, the record remains appended and a registry warning is
printed to stderr in human mode, or surfaced as a `registryError` field in
`--json` output, so stdout stays machine-clean.

### `artshelf ledgers`

Lists, registers, or prunes known Artshelf ledger registrations.

```bash
artshelf ledgers list
artshelf ledgers list --json
artshelf ledgers list --plain
artshelf ledgers add --ledger <path> --name <project> --scope repo --json
artshelf ledgers prune --dry-run --registry <path> --json
artshelf ledgers prune --dry-run --registry <path> --agent
artshelf ledgers prune --execute --plan-id <id> --registry <path> --json
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
- `prune --dry-run` classifies registry entries whose ledger files are missing,
  writes a reviewed registry-prune plan only when prunable entries exist, and
  never mutates the registry. Repeated matching dry-runs reuse the same
  unexecuted plan id. Duplicate registry paths are ambiguous and are reported as
  blocked for manual repair, never pruned automatically.
- `prune --dry-run --agent` emits a compact single-line packet with the prunable
  count, blocked count, plan id, and exact approval target:
  `approve artshelf ledgers prune registry <registry-path> plan <plan-id>`.
- `prune --execute --plan-id <id>` binds to one exact registry path and reviewed
  plan id. It re-checks the live registry, removes only entries still classified
  as prunable, skips stale plan entries whose file reappeared or became
  ambiguous, writes a rollback copy before mutation, writes a receipt after, and
  exits non-zero if verification fails.
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
artshelf get <id> --inspect
artshelf get <id> --inspect --json
artshelf get <id> --inspect --agent
artshelf get <id> --inspect --all --registry <path> --agent
```

`get` is for audit and handoff follow-up. Missing ids are an error. `--all`
searches registered ledgers until the id is found. With `--inspect --all`, the
registry is only used for lookup; the decision card reports the concrete ledger
that owns the matching record.

`--inspect` turns a record into a review decision card. It never moves files or
mutates the ledger; it only reports existence, node kind, size, age, retention/due and
manual-review state, cleanup mode, reason, and a recommendation bucket with the
exact next-safe action. It never reads or previews arbitrary file contents:

- `keep` — held for manual review, already resolved, already trashed, or due
  with `cleanup=review`; it needs your judgment but nothing auto-runs.
- `snooze` — retention has not expired yet; re-inspect after it is due.
- `trash-safe` — due with `cleanup=trash`; safe to plan a reviewed dispose
  `trash-resolve` decision.
- `resolve-only` — the recorded path is gone; resolve the record (ledger-only)
  rather than cleaning a file.
- `blocked` — needs a human decision first: `cleanup=delete` (refused at
  execute), a review-required flag, or a prior cleanup refusal.

File-content previews are intentionally outside Artshelf core; an acting agent or
host runtime may inspect file contents separately when appropriate.
`--inspect --json` returns `{ inspect: <report> }`; `--inspect --agent` returns a compact single-line
decision packet with a read-only safety block, the next-safe action, and a
reproducer command, and takes precedence over `--json`. Both shapes are
deterministic so portable agent skills can act without re-deriving anything.

Example pattern — the dogfooding case that motivated this surface was an old
rollback `backup` registered with `cleanup=review` (the kind of stale record
`ledgers prune` and `review --all` surface). Inspect it before deciding, using
the record id and ledger path rather than hardcoding either:

```bash
artshelf get <id> --inspect --ledger <ledger-path>
```

```text
✓ <id> [backup] — keep
path: <backup-path>
status: active · cleanup: review · owner: agent · labels: registry-prune
existence: present (directory, 49 B) · age: 14d · retention: manual-review · due: manual-review
reason: rollback backup before registry prune
next: Held for manual review — run `artshelf dispose --id <id> --action keep --dry-run --reason '<why>' --ledger <ledger-path>` to keep it quiet through a reviewed decision, or choose resolve-only/snooze deliberately.
ledger: <ledger-path>
```

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
artshelf review --agent
artshelf review --all --json
artshelf review --all --agent
```

`review` is the compact report surface for scheduled checks. `--all` reads every
registered ledger from the registry; stale, invalid, and valid no-op ledgers are
included with a `not-created` plan instead of writing a plan file.

In `--all` mode, review emits an aggregate triage summary on top of the
per-ledger detail. JSON includes a `summary` block with affected-ledger, due,
manual-review, missing-path, executable, skipped, and reconcile entry/blocked
counts plus the preview plan ids; JSON also includes the next safe action. The
per-ledger human detail appends a `reconcile` count when a ledger has reconcile
drift. Human output adds a one-line triage count with the same reconcile counts
and states the same next safe action (repair broken ledgers, dry-run cleanup,
registry-prune dry-run for missing registered ledgers, dry-run reconcile for
missing-path or reconcile drift, or nothing to do). Review never writes a plan,
so the next action always points at an explicit follow-up command.

`review`, `status`, `doctor`, `ledgers prune --dry-run`, and `get --inspect`
expose agent-oriented render modes. For review/status/doctor, the default human render
leads each ledger and summary line with a `✓`/`⚠` attention glyph. `--json` stays
the full, backward-compatible public audit report; and `--agent` emits a compact,
deterministic single-line JSON decision packet for agents, taking precedence over
`--json` when both are passed. For `get --inspect`, `--agent` returns the
per-record decision packet and requires `--inspect`. For `review`, the packet sorts records into
ready-for-approval, needs-review-first, and blocked groups. Because review is
read-only and never mints a cleanup or registry-prune plan, the exact approval
targets it emits are `resolve missing` and `reconcile`; the `reconcile` target
appears only when a prior reviewed reconcile plan still matches the live drift.
Cleanup-eligible records and reconcile drift without a reviewed plan stay
needs-review-first and point at `cleanup --dry-run` or `reconcile --dry-run`,
which mint the reviewed plan id to approve. Missing registered ledger files in
`--all` mode surface as blocked registry fixes that point at `ledgers prune
--dry-run --registry <path>`; the prune dry-run produces the registry-prune
approval target. Invalid-but-present ledger files still point at manual
re-register/fix work. Blocked or ambiguous reconcile findings surface in the
blocked group with no approval target.

### `artshelf doctor`

Reports whether Artshelf is healthy on the current machine without mutating
anything.

```bash
artshelf doctor
artshelf doctor --json
artshelf doctor --agent
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
registered ledger exits non-zero with actionable errors. When stale/missing
registrations exist, the agent next action points at `artshelf ledgers prune
--dry-run --registry <path>` before re-running doctor; invalid ledger files still
need manual repair. Humans should run `artshelf doctor` after install or when
`--all` commands behave unexpectedly; agents may run it on a schedule to catch
stale registry entries before relying on cleanup planning. Doctor never creates
plans, receipts, or records. Like `review`
and `status`, `doctor` accepts `--agent` for a compact single-line JSON decision
packet (health, registry and registered-ledger health, blockers, cleanup-safety
posture, next action, and a verify command); `--agent` takes precedence over
`--json`.

### `artshelf status`

The lightweight daily "what is going on?" view across ledgers.

```bash
artshelf status
artshelf status --json
artshelf status --agent
artshelf status --all --json
artshelf status --all --agent
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
ledger exits non-zero. When stale/missing registrations exist, `--all --agent`
points at `artshelf ledgers prune --dry-run --registry <path>` before re-running
status; invalid ledgers are still manual repair. Due entries are normal
operational state and do not change the exit code. With single `--ledger`, a
not-yet-created ledger reports empty counts. Like `review` and `doctor`,
`status` accepts `--agent` for a compact
single-line JSON decision packet (health, counts, attention categories, blockers,
next action, and a verify command); `--agent` takes precedence over `--json`.

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
- Automatic checks cache latest-version lookups at
  `~/.artshelf/update-check.json` by default. Cached update-available results
  (`latest > current`) keep the long 24-hour TTL; cached no-update, failed,
  missing, or null results use a shorter 1-hour TTL so newly published releases
  are noticed sooner.
- `ARTSHELF_NO_UPDATE_CHECK=1` disables automatic checks for scheduled jobs,
  tests, and no-network environments.
- `ARTSHELF_UPDATE_CACHE` overrides the update-cache path,
  `ARTSHELF_UPDATE_CHECK_TTL_MS` overrides the update-available cache TTL,
  `ARTSHELF_NO_UPDATE_CHECK_TTL_MS` overrides the no-update/failed cache TTL
  (falling back to `ARTSHELF_UPDATE_CHECK_TTL_MS` for compatibility), and
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
artshelf cleanup --execute --plan-id <id> [--ledger <path>]
artshelf cleanup --execute --plan-id <id> [--ledger <path>] --json
```

Rules:

- Requires `--plan-id`, and refuses an unsafe plan id (anything outside
  `[A-Za-z0-9_-]`, such as a value containing path separators or `..`) before
  touching the filesystem.
- Refuses to generate a fresh live cleanup set during execute.
- Binds the loaded plan to the request before any mutation: the plan file's
  `planId` must match the requested id, its `ledgerPath` must match the executing
  ledger, and its entries must be well-formed. A mismatched or malformed plan is
  refused without moving files or writing a receipt, mirroring the live-record
  re-checks `trash purge --execute` performs.
- Writes a `started` cleanup receipt to `<ledger-dir>/receipts/<plan-id>.json` before
  the first filesystem move, then completes the receipt with `completedAt` and the
  per-entry `trashed`, `review-required`, `refused`, or `skipped` results.
- Appends or refreshes an Artshelf-owned ledger record for the completed receipt with
  `owner=artshelf`, `kind=run-artifact`, `ttl=30d`, `cleanup=review`, and labels
  including `artshelf`, `cleanup-receipt`, and the plan id.
- Resumes an interrupted run on rerun of the same plan id: terminal receipt evidence
  for an artifact keeps its original `executedAt`/`cleanedAt`, an artifact already
  moved into the plan's trash directory without terminal receipt evidence is recorded
  as `trashed` at resume time without moving it again, a missing original path with no
  trash target and no receipt evidence stays a skipped missing path rather than a
  success, and a completed receipt replays idempotently without duplicating the
  Artshelf-owned receipt record.
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

### `artshelf reconcile`

Approval-gated ledger/registry housekeeping that turns recorded-path drift into a
reviewed plan and then applies exactly one reviewed plan id. Reconcile is **not**
cleanup: it never creates, moves, or deletes files. It only rewrites drifted ledger
paths and resolves rows that can no longer be acted on, mirroring the cleanup
dry-run/execute boundary.

```bash
artshelf reconcile --dry-run [--ledger <path>] [--json]
artshelf reconcile --dry-run --all [--registry <path>] [--json]
artshelf reconcile --execute --plan-id <id> --ledger <path> [--json]
```

Dry-run classifies each drifted record into one finding category:

- `remap`: the recorded path is gone, but provenance reconstructs the artifact under
  the current ledger/repo root (for example after a `shelf` -> `artshelf` or
  `.shelf` -> `.artshelf` rename) and the basename plus optional file fingerprint
  still match. The path can be safely rewritten to the reconstructed location.
- `resolve-missing`: an `active` or `review-required` record's path is gone and no
  safe remap target was found (external path, legacy row, or nothing matches). The
  row can be resolved after review.
- `resolve-stale-trash`: an already-`trashed` record's trash target is gone. The
  ledger row is resolved ledger-only; the filesystem is never touched.
- `blocked`: a candidate exists at the reconstructed location but its name or
  fingerprint does not match, or evidence is otherwise ambiguous or unsafe. Blocked
  findings are surfaced for review and never auto-applied.

`registry-remap` is reserved in the finding taxonomy for a future registry pass that
updates a registered ledger whose path moved; the current dry-run classifies drift
within a single ledger's records and does not yet emit `registry-remap`.

Dry-run rules:

- Read-only except for reviewed plan artifact creation/reuse. It classifies drift
  and, when actionable entries exist, persists the plan to
  `<ledger-dir>/reconcile-plans/<id>.json` and registers an Artshelf-owned plan
  record (`owner=artshelf`, `kind=run-artifact`, `ttl=14d`, `cleanup=trash`, labels
  including `artshelf`, `reconcile-plan`, and the plan id).
- A no-op dry-run (only blocked or no findings) reports `planId=not-created`,
  `planPath=null`, and writes no plan file. A later dry-run whose actionable entries
  match an existing plan reuses that plan id and refreshes its plan artifact.
- `--all` is dry-run only and previews every registered ledger after the registry
  validates. There is no global execute.

Execute rules:

- Requires `--plan-id` and one explicit `--ledger`. It binds to one reviewed plan id
  and refuses a missing, unknown, or id/ledger-mismatched plan before any mutation.
  There is no `reconcile --execute --all` and no fresh-plan-then-execute.
- Before applying each entry it re-classifies the live ledger and refuses entries
  whose live state has drifted since review (record gone, status changed, remap
  target vanished, or path reappeared), skipping them instead of mutating stale rows.
- A `remap` rewrites the record `path` and recomputes its provenance for the new
  location while keeping the row's status; every resolve category archives the row
  ledger-only as `resolved`.
- Preserves audit provenance on every touched row (`previousPath`, the rewritten
  `path` for a remap, `reconcilePlanId`, `reconcileReceiptPath`, `reconciledAt`, and
  `reconcileReason`), and writes a reconcile receipt to
  `<ledger-dir>/reconcile-receipts/<id>.json` registered as an Artshelf-owned
  artifact (`ttl=30d`, `cleanup=review`, labels including `artshelf`,
  `reconcile-receipt`, and the plan id).
- Never creates or deletes filesystem artifacts. Reconcile is ledger/registry
  bookkeeping only, and `doctor`, `status`, `review`, and `validate` never perform
  silent reconcile edits.

JSON output is deterministic (findings preserve ledger order) so agents can render a
decision packet and approve a specific plan id.

### `artshelf dispose`

Approval-gated disposition for one reviewed record. `dispose` is the command
surface that follows `get --inspect`: inspect stays read-only, then dispose
creates or executes the exact reviewed plan for the chosen decision.

```bash
artshelf dispose --id <id> --action trash-resolve --dry-run [--reason <text>] [--ledger <path>] [--json|--agent]
artshelf dispose --id <id> --action resolve-only --dry-run --reason <text> [--ledger <path>] [--json|--agent]
artshelf dispose --id <id> --action snooze --dry-run (--ttl <ttl>|--retain-until <date>) [--reason <text>] [--ledger <path>] [--json|--agent]
artshelf dispose --id <id> --action keep --dry-run [--reason <text>] [--ledger <path>] [--json|--agent]
artshelf dispose --execute --plan-id <id> --ledger <path> [--json]
```

Actions:

- `trash-resolve`: move the recorded path into plan-scoped Artshelf trash and
  mark the row resolved with dispose audit fields.
- `resolve-only`: resolve the ledger row only; requires `--reason`.
- `snooze`: extend retention; requires `--ttl` or `--retain-until`.
- `keep`: stamp that the record was reviewed and kept.

Dry-run rules:

- Classifies exactly one record id and action. There is no `--all` path.
- Writes a reviewed plan only when the request is actionable, under
  `<ledger-dir>/dispose-plans/<id>.json`.
- Registers the plan as an Artshelf-owned artifact (`owner=artshelf`,
  `kind=run-artifact`, `ttl=14d`, `cleanup=trash`, labels including
  `artshelf`, `dispose-plan`, and the plan id).
- Prints the exact approval target:
  `approve artshelf dispose ledger <ledger-path> plan <plan-id>`.
- A blocked request reports `planId=not-created`, writes no plan, and exits
  non-zero while still returning a JSON/agent packet when requested.

Execute rules:

- Requires one explicit reviewed `--plan-id` and the target `--ledger`.
- Refuses missing, unknown, id-mismatched, ledger-mismatched, malformed, stale,
  drifted, or target-conflicting plans before mutating.
- Re-snapshots the subject before execution; stale entries are skipped rather
  than applied.
- Writes a dispose receipt to `<ledger-dir>/dispose-receipts/<id>.json` and
  registers it as an Artshelf-owned artifact (`ttl=30d`, `cleanup=review`,
  labels including `artshelf`, `dispose-receipt`, and the plan id).
- There is no fresh-plan-then-execute, no global execute, no daemon, and no
  physical deletion.

## Ledger Storage

V1 supports two scopes:

- repo-local: `.artshelf/ledger.jsonl`
- user-global: `~/.artshelf/ledger.jsonl`

Default behavior:

- If the current directory is inside a git repo, write repo-local.
- Otherwise write user-global.
- Allow `--ledger <path>` for explicit tests and unusual workflows.

Write durability:

- Every mutation of a ledger or the registry runs under a cross-process advisory
  lock keyed on the target file, so overlapping `artshelf` processes serialize
  their writes instead of racing. The lock is re-entrant within a process and
  reclaims a stale lock left by a crashed holder.
- Ledger writes — both single-record appends and full rewrites — land through a
  unique temp file and an atomic rename, so an interrupted write cannot truncate
  the ledger or lose already-recorded entries.

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
  `~/.artshelf/update-check.json` by default. Cached update-available results
  use the long 24-hour TTL; cached no-update, failed, missing, or null results
  use a shorter 1-hour TTL. `ARTSHELF_NO_UPDATE_CHECK=1` disables automatic
  checks, `ARTSHELF_UPDATE_CACHE` overrides the cache path,
  `ARTSHELF_UPDATE_CHECK_TTL_MS` overrides the update-available TTL, and
  `ARTSHELF_NO_UPDATE_CHECK_TTL_MS` overrides the no-update/failed TTL
  (falling back to `ARTSHELF_UPDATE_CHECK_TTL_MS` for compatibility).
- `put` registers the ledger it writes to.
- `ledgers add` registers an existing ledger explicitly.
- `--all` reads registered ledgers as one review surface.
- `trash list --all` reads trashed records across registered ledgers after
  registry validation.
- Registry-prune artifacts live next to the registry: `registry-prune-plans/`,
  `registry-prune-rollbacks/`, and `registry-prune-receipts/`.
- `cleanup --execute --all`, `reconcile --execute --all`, and `trash purge --all`
  are refused; execution stays scoped to one explicit ledger or registry and one
  reviewed plan id.

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

Records touched by `artshelf reconcile --execute` carry the reconcile audit trail so a
remap or resolve stays traceable to the reviewed plan that produced it:

```json
{
  "previousPath": "/old-absolute/path/build/out.txt",
  "reconcilePlanId": "reconcile_20260601_062000_ab12",
  "reconcileReceiptPath": "/absolute/path/.artshelf/reconcile-receipts/reconcile_20260601_062000_ab12.json",
  "reconciledAt": "2026-06-01T06:20:00Z",
  "reconcileReason": "recorded path is missing; reconstructed at the current root"
}
```

`previousPath` preserves the path the row held before the action; for a `remap` the new
location is the rewritten `path`, while resolve categories leave `path` and set
`status=resolved`. These fields are additive and absent on records reconcile never
touched.

### Path provenance

New records carry a `provenance` block alongside the absolute `path`. The absolute
path is still the audit record of where the artifact lived; provenance adds the data
a future reconcile needs to reason about an artifact that moved because its root was
renamed (for example `shelf` -> `artshelf` or `.shelf` -> `.artshelf`). Capturing it
at write time is what lets reconcile remap paths later **without** Artshelf running as
a daemon, watcher, or shell hook.

```json
{
  "provenance": {
    "root": "repo",
    "rootPath": "/absolute/path/to/repo",
    "relativePath": "build/out.txt",
    "basename": "out.txt",
    "pathKind": "file",
    "fingerprint": { "byteSize": 1024 }
  }
}
```

- `root` is `repo`, `ledger`, or `external`. Ledger-owned paths (`trash/`, `plans/`,
  `receipts/`) classify as `ledger`; other paths inside the repo classify as `repo`;
  anything else is `external`.
- `rootPath` and `relativePath` are the matched root and the POSIX path beneath it.
  The relative path is what survives a root rename, so a reconcile can rebuild the
  current absolute path from the current root. `external` paths cannot be rebuilt, so
  both fields are `null`.
- `basename`, `pathKind`, and the optional file `fingerprint` (byte size only) are
  cheap matching hints for disambiguating rename candidates.

Provenance is additive and backward compatible. Records written before provenance
existed simply omit the field; they are treated as **legacy records with missing
provenance, not malformed data**, and continue to validate, read, list, find, and get
normally. `artshelf validate` only inspects provenance when the field is present: a
present-but-structurally-invalid block (bad `root`, missing reconstruct data on a
`repo`/`ledger` root, reconstruct data on an `external` root, non-numeric fingerprint)
is reported as an error, while an absent block is not.

Provenance only records evidence. It never moves, deletes, or rewrites artifacts, and
capturing it does not change any path. Acting on provenance to remap a ledger remains
an explicit, approval-gated reconcile step — never an automatic side effect of `put`,
`doctor`, `status`, `review`, or `validate`.

## Cleanup Safety Model

Cleanup execution is intentionally boring and approval-only. Five boundaries
hold, and every future feature (`status`, `doctor`, `review`, scheduled jobs,
...) must preserve them rather than add a shortcut around them:

- **No daemon.** Artshelf never runs in the background or watches the clock. It
  only does work while you are running an `artshelf` command.
- **No auto-execute.** No command cleans up as a side effect. The only commands
  that move, trash, or delete files are `artshelf cleanup --execute`,
  `artshelf dispose --execute`, and `artshelf trash purge --execute`, each run
  by a human against a separately reviewed plan id.
- **No global execute.** `cleanup --execute --all`, `dispose --all`, and
  `trash purge --all` are refused; `--all` is read-only or dry-run reporting
  only where supported. Execution is always scoped to a single reviewed plan id.
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
- Execute writes a `started` cleanup receipt before the first filesystem move,
  updates ledger state after recording per-entry outcomes, and completes the
  receipt with `completedAt`. A trashed, review-required, or refused record no
  longer participates in future `due` or cleanup dry-run output by default.
- Rerunning the same plan id resumes or replays durable receipt/trash evidence:
  terminal receipt evidence keeps its original cleanup timestamp, existing
  plan-trash targets are not moved again, completed receipts are idempotent,
  and missing paths without receipt or trash evidence stay skipped rather than
  successful.
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

Scheduled jobs must never run `artshelf cleanup --execute`,
`artshelf ledgers prune --execute`, or `artshelf trash purge --execute`; they may
only dry-run and report plans for later human review.

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
- CLI can prune missing/stale ledger registrations through an approval-gated
  `artshelf ledgers prune` dry-run/execute workflow that writes a reviewed plan,
  rollback copy, and receipt; duplicate registry paths are blocked for manual
  repair.
- CLI refuses records without a reason.
- CLI requires TTL, retain-until, or manual-review.
- CLI can list, filter by status, and show due entries.
- CLI can find existing records by path/owner/label/status and get records by id.
- CLI can mark records manually resolved with a required reason.
- CLI validates ledger shape.
- Concurrent ledger and registry writes are serialized with a cross-process lock
  and committed atomically, so overlapping commands do not lose records.
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
- Cleanup execute refuses to run without a plan id, and refuses an unsafe,
  mismatched, or malformed plan before moving files or writing a receipt.
- Cleanup execute writes a started receipt before moving files, resumes or
  replays the same plan id from receipt/trash evidence, and completes the
  receipt idempotently.
- CLI can list trashed records (single ledger or `--all`) and purge them through
  an approval-first, ledger-scoped dry-run/execute boundary that writes a purge
  receipt; purge refuses `--all` and never deletes without a reviewed plan id.
- New records capture path provenance (root class, root-relative path, basename,
  path kind, and an optional byte-size fingerprint); provenance is additive and
  backward compatible, so legacy records without it still validate and read, and
  `validate` reports a malformed provenance block only when the field is present.
- CLI can reconcile drifted recorded paths through `artshelf reconcile` without
  ever creating, moving, or deleting files: `--dry-run` classifies drift into a
  reviewed plan (`remap`, `resolve-missing`, `resolve-stale-trash`, `blocked`) and
  `--all` previews every registered ledger as dry-run only, while `--execute`
  applies one reviewed plan id against one explicit ledger, refuses `--all`,
  mismatched plans, and entries whose live state drifted since review, and writes
  the reconcile audit trail and receipt.
- Package includes the deterministic `ArtshelfReviewReport` schema, canonical
  example, and portable renderer script for agent-rendered review reports.
- All core commands support `--json`.
- `review`, `status`, `doctor`, `ledgers prune --dry-run`, and `get --inspect`
  also support `--agent`, a compact single-line JSON decision packet for agents
  that takes precedence over `--json`.
- Tests cover record/list/find/get/status-filter/due/validate/resolve/registry,
  `artshelf doctor`, the `artshelf status` dashboard, `--all` review, stale-registry,
  dry-run, global-dry-run, execute-plan, cleanup plan-id validation, concurrent
  ledger writes, trash list/purge, path provenance validation, registry-prune,
  and reconcile dry-run/execute behavior.

## Deferred

- Cron integration.
- Agent skill adapters.
- GitHub Action.
- Fake/demo mode.
- Rollback command.
- Retention classes like keep-daily/weekly/monthly.
- Dependency roots and pinning.
- Credential scanning.
