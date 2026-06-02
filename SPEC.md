# Shelf V1 Spec

## Problem

Agents and humans create temporary directories, backups, run artifacts, debug
outputs, and quarantine folders during work. Those artifacts often have a clear
reason when created, but that reason is lost later. Cleanup then becomes risky:
we either keep everything forever or delete based on weak filesystem age.

Shelf makes artifact creation accountable at the moment it happens.

## One-Line Product Definition

Shelf is a tiny CLI for putting temporary artifacts, backups, and run outputs
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

### `shelf put`

Records an existing file or directory in the ledger.

```bash
shelf put <path> --reason "why this exists" --ttl 7d --kind scratch
```

Required:

- `path`
- `--reason`
- one of `--ttl`, `--retain-until`, or `--manual-review`

Optional:

- `--kind scratch|backup|run-artifact|evidence|cache|quarantine|other`
- `--cleanup trash|review|delete`
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

### `shelf ledgers`

Lists or registers known Shelf ledgers.

```bash
shelf ledgers list
shelf ledgers add --ledger <path> --name <project> --scope repo
```

Rules:

- `list` reads the registry without mutating ledgers.
- `add` requires an existing ledger path.
- `--name` defaults from the ledger path when omitted.
- `--scope` is optional; when omitted, Shelf infers `repo`, `user`, or
  `other` from the ledger path.

### `shelf list`

Shows ledger entries in a human-readable format.

```bash
shelf list
shelf list --json
shelf list --status active
shelf list --status resolved --json
shelf list --all --status active --json
```

`--status` filters the audit trail to one record status:

- `active`
- `review-required`
- `trashed`
- `cleanup-refused`
- `resolved`

`--all` reads every registered ledger through the registry.

### `shelf find`

Read-only ledger query for integrations that need idempotent artifact
registration without parsing `list` output.

```bash
shelf find --path <path> --json
shelf find --path <path> --owner coding-workflow-pipeline --label <run-id> --status active --json
shelf find --all --owner coding-workflow-pipeline --json
```

Accepted selectors:

- `--path <path>`: exact artifact path match after path normalization.
- `--owner <string>`
- `--label <label>` repeatable; all labels must match.
- `--status active|review-required|trashed|cleanup-refused|resolved`

`find` requires at least one selector. It never creates, resolves, moves, or
deletes records. `--all` applies the same selector set to every registered
ledger.

### `shelf get`

Read-only lookup of a single ledger record by Shelf id.

```bash
shelf get <id>
shelf get <id> --json
shelf get <id> --all --json
```

`get` is for audit and handoff follow-up. Missing ids are an error. `--all`
searches registered ledgers until the id is found.

### `shelf due`

Shows entries whose retention has expired or that need manual review.
Only `active` records participate in due classification; records already handled
by cleanup execution remain visible through `list` and validation.

```bash
shelf due
shelf due --json
shelf due --all --json
```

V1 due statuses:

- `due`
- `manual-review`
- `missing-path`
- `kept`

`--all` classifies active entries across registered ledgers.

### `shelf validate`

Checks ledger health without mutating files.

```bash
shelf validate
shelf validate --json
shelf validate --all --json
```

V1 validation checks:

- ledger file is parseable JSONL
- required fields are present
- IDs are unique
- paths are absolute or resolvable
- TTL/retain-until/manual-review is valid
- cleanup action is known
- resolved records include `resolvedAt` and `resolutionReason`
- active and review-required recorded paths still exist, reported as warnings not hard failures

`--all` validates registered ledgers and reports stale registry entries when a
registered ledger is missing from disk.

### `shelf review`

Runs validation, due classification, and cleanup plan preview without mutating
files or writing a plan.

```bash
shelf review --json
shelf review --all --json
```

`review` is the compact report surface for scheduled checks. `--all` reads every
registered ledger from the registry.

### `shelf cleanup --dry-run`

Creates a cleanup plan but does not mutate artifacts.

```bash
shelf cleanup --dry-run
shelf cleanup --dry-run --json
shelf cleanup --dry-run --all --json
```

The plan must include:

- `planId`
- generated timestamp
- candidate entry IDs
- planned action per entry
- skipped/refused entries with reasons
- plan file path

`--all` creates dry-run plans for registered ledgers only after every registered
ledger validates. Global cleanup execution is refused.

### `shelf cleanup --execute`

Executes a previously generated cleanup plan.

```bash
shelf cleanup --execute --plan-id <id>
shelf cleanup --execute --plan-id <id> --json
```

Rules:

- Requires `--plan-id`.
- Refuses to generate a fresh live cleanup set during execute.
- Writes a cleanup receipt.
- Updates touched ledger records so handled artifacts stop appearing as active
  cleanup candidates.
- Uses trash/review behavior by default.
- `delete` remains allowed only when the ledger entry explicitly says
  `cleanup=delete`; v1 may still choose to refuse physical delete until we have
  enough dogfood evidence.

### `shelf resolve`

Marks a handled, missing, or no-longer-needed record as manually resolved while
keeping it in the ledger audit trail.

```bash
shelf resolve <id> --status resolved --reason <text>
shelf resolve <id> --status resolved --reason <text> --json
```

Rules:

- Requires `<id>`, `--status resolved`, and `--reason`.
- Does not move or delete files.
- Removes the record from future `due` and cleanup dry-run output.
- Keeps the record visible through `list` and `list --status resolved`.
- Refuses records that are already `resolved`; the original reason is preserved.

## Ledger Storage

V1 supports two scopes:

- repo-local: `.shelf/ledger.jsonl`
- user-global: `~/.shelf/ledger.jsonl`

Default behavior:

- If the current directory is inside a git repo, write repo-local.
- Otherwise write user-global.
- Allow `--ledger <path>` for explicit tests and unusual workflows.

V1 also supports a user-level registry of known ledgers:

- registry: `~/.shelf/ledgers.json`
- `SHELF_REGISTRY` or `--registry <path>` can override the registry path.
- `put` registers the ledger it writes to.
- `ledgers add` registers an existing ledger explicitly.
- `--all` reads registered ledgers as one review surface.
- `cleanup --execute --all` is refused; execution stays scoped to one explicit
  ledger and one reviewed plan id.

## Ledger Registry Schema

```json
{
  "version": 1,
  "ledgers": [
    {
      "name": "my-repo",
      "path": "/absolute/path/to/repo/.shelf/ledger.jsonl",
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
- `trashed`: execution moved a `cleanup=trash` artifact into Shelf trash.
- `cleanup-refused`: execution refused the requested action, such as physical
  delete in v1.
- `resolved`: a human or agent marked the record as manually handled.

Handled records may include cleanup outcome fields:

```json
{
  "cleanupPlanId": "plan_20260601_154200_cd34",
  "receiptPath": "/absolute/path/.shelf/receipts/plan_20260601_154200_cd34.json",
  "cleanedAt": "2026-06-01T05:45:00Z",
  "targetPath": "/absolute/path/.shelf/trash/plan_20260601_154200_cd34/shf_20260601_154200_ab12-artifact",
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

## Cleanup Safety Model

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

## Agent Usage Contract

Agents should call `shelf put` immediately after creating:

- config backups
- quarantine folders
- debug output directories
- temporary repo artifacts
- one-off generated reports
- copied files kept for rollback

Agents should not run `shelf cleanup --execute` without explicit approval.

Agents may run `shelf find` and `shelf get` before `put` to avoid duplicate
registrations. `find`/`get` are read-only ledger queries; they must not be used
as permission to clean up or resolve a record.

Agents may run `shelf resolve <id> --status resolved --reason <text>` only
after explicit confirmation that the record has been handled, is missing, or is
no longer needed. The reason must be specific; resolve does not move or delete
files.

Scheduled jobs may run:

```bash
shelf due --json
shelf due --all --json
shelf cleanup --dry-run --json
shelf cleanup --dry-run --all --json
```

Scheduled jobs must not silently execute cleanup.

## Dogfood Scenarios

1. Record a repo-local `tmp/` scratch directory with a 3-day TTL.
2. Record an OpenClaw config backup with manual review retention.
3. Generate a dry-run cleanup plan after TTL expiry using fixture data.
4. Execute a cleanup plan in a temporary test fixture and verify receipt output.

## V1 Acceptance Criteria

- CLI can record entries to JSONL.
- CLI can register and list known ledgers.
- CLI can review registered ledgers through `--all` read-only entry points.
- CLI refuses records without a reason.
- CLI requires TTL, retain-until, or manual-review.
- CLI can list, filter by status, and show due entries.
- CLI can find existing records by path/owner/label/status and get records by id.
- CLI can mark records manually resolved with a required reason.
- CLI validates ledger shape.
- Cleanup dry-run creates a plan id.
- Cleanup execute refuses to run without a plan id.
- Cleanup execute writes a receipt.
- All core commands support `--json`.
- Tests cover record/list/find/get/status-filter/due/validate/resolve/registry,
  `--all` review, stale-registry, dry-run, global-dry-run, and execute-plan
  behavior.

## Deferred

- Cron integration.
- OpenClaw/Codex/Claude skill adapters.
- GitHub Action.
- Fake/demo mode.
- Rollback command.
- Retention classes like keep-daily/weekly/monthly.
- Dependency roots and pinning.
- Credential scanning.
- Public package publishing.
