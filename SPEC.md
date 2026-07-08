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

`review`, `status`, `doctor`, `ledgers prune --dry-run`, `dispose --dry-run`,
and `get --inspect` expose agent-oriented render modes. For review/status/doctor, the default human render
leads each ledger and summary line with a `✓`/`⚠` attention glyph. `--json` stays
the full, backward-compatible public audit report; and `--agent` emits a compact,
deterministic single-line JSON decision packet for agents, taking precedence over
`--json` when both are passed. For `dispose --dry-run`, `--agent` returns the per-request plan or blocked packet.
For `get --inspect`, `--agent` returns the
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
  physical trash purge requires a separate reviewed purge plan or exact approved `trash-purge` bundle.

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

### `artshelf ui`

Starts or resumes a durable agent-mediated review session, and exposes read-only dashboard/detail views plus approval-bundle workbench views for live review state.
The command family is the AXI-style shell for the human review UI contract: the browser records exact-target triage intents and approval bundles in the session log, `ui review` or a host poller processes those events, approved non-purge bundles run through existing exact-target approval-gated paths, purge bundles are reserved for separate explicit one-way-door execution, and the agent replies with receipts.
The read-only dashboard/detail subcommands are data surfaces over existing ledger, registry, trash, and inspect state.
The browser captures human triage intents and approval bundle submissions as session events but never mutates ledgers, files, trash, or plans directly.

The intended product experience is a managed agent-attached review workflow, not
just disconnected CLI primitives. `artshelf ui review` starts or resumes the UI
session from the original conversation, starts the loopback server as a managed
foreground child, shares the capability URL, and stays attached to the same
session with a polling loop until the workflow ends. Every pending browser event
is immediately marked `in_progress`, processed inside the read-only, dry-run, or
exact-approval boundary, then completed with a reply payload that names the
result, safety boundary, and any exact approval target. Exact keep/trash/resolve/defer
decisions and exact dispose dry-run requests become reviewed dispose dry-run
plans whose plan id and exact approval text ride in the reply, so the dashboard's
prepared-plan approval row can carry the workflow into the approve-then-execute
half. Dashboard lane dry-run requests can prepare reviewed cleanup plans, check
missing files, check source problems, or prepare purge review workbench handoffs.
Approved non-purge bundles submitted through the workbench run through the
existing exact-target `ui execute` core, while purge bundles are reserved for a
separate explicit one-way-door execute.
The served UI refreshes activity and live dashboard state so the user can continue
submitting actions without restarting. A browser close submission queues
`session_done`; the attached loop replies, cancels still-pending work with
visible cancelled replies, runs `ui end` semantics, stops the served UI process,
and returns a concise summary. Interrupts tear down the same way. If another
agent or host cannot keep the server and poller attached, it should not present
the session as a live review workflow.

```bash
artshelf ui [--scope user|repo] [--ledger <path>] [--json]
artshelf ui dashboard [--registry <path>] [--json]
artshelf ui detail <record-id> [--ledger <path>] [--registry <path>] [--json]
artshelf ui serve [--scope user|repo] [--port <port>] [--registry <path>] [--ledger <path>] [--json]
artshelf ui review [--scope user|repo] [--port <port>] [--poll-interval-ms <ms>] [--registry <path>] [--ledger <path>] [--json]
artshelf ui poll <session-id> [--scope user|repo] [--json]
artshelf ui reply <session-id> --event <event-id> --status <status> [--payload <json>] [--scope user|repo] [--json]
artshelf ui bundle <session-id> [<bundle-id>] [--scope user|repo] [--json]
artshelf ui execute <session-id> <bundle-id> [--scope user|repo] [--json]
artshelf ui end <session-id> [--scope user|repo] [--json]
```

Rules:

- `artshelf ui` defaults to user-level, multi-ledger review and stores the session under `~/.artshelf/ui` unless an explicit UI home override is set.
- `--scope repo` anchors the session home at the current repository's `.artshelf/ui` tree, and `--ledger <path>` narrows the session target while keeping the same session model.
- Starting an active session for the same scope and ledger target resumes it instead of creating a duplicate, and legacy active sessions that predate stored registry or repo metadata are resumed and backfilled with that scope metadata.
- `artshelf ui --json` returns the session token separately from the public session view; the token is a same-machine browser access and write capability and must be treated as secret.
- `ui dashboard` recomputes a multi-ledger snapshot from registered ledgers and surfaces needs-review, needs-context, cleanup, resolve, trash, purge-candidates, registry/reconcile, recent-receipts, and served-session activity without mutating anything.
The purge-candidate lane groups rows by source/ledger, shows per-group totals and exact row details, states there is no recovery path, and starts with nothing selected by default.
- `ui detail <record-id>` composes the path label, inspect decision card, provenance, audit trail, existence facts, needs-context badge, and last action for one record without reading or previewing file contents.
- Records with missing or vague reasons, or present-but-uninformative provenance, surface through the needs-context badge instead of normal review lanes.
- `ui serve` hosts the `ui dashboard`, `ui detail`, and approval-bundle workbench surfaces as a local browser page so a human can open and click through them; it binds to loopback (`127.0.0.1`) only - never a wildcard interface - recomputes live state on every request, requires the active UI session capability token printed in the serve URL, supports `--json` for a compact launch packet, and runs in the foreground until interrupted with Ctrl-C.
- `ui review` is the managed foreground lifecycle. It starts the same token-protected server, keeps a poll loop attached to the session, marks browser work `in_progress`, replies completed/rejected/stale/failed/cancelled outcomes into activity, translates exact keep/trash/resolve/defer decisions and exact dispose dry-run requests into reviewed dispose dry-run plans (replying the plan id and exact approval text; defer/snooze uses a default `7d` horizon), handles dashboard lane dry-run requests by preparing reviewed cleanup plans, source/missing-file checks, or purge review workbench handoffs, runs approved non-purge bundles through the exact-target `ui execute` core, reserves purge bundles for a separate explicit one-way-door execute, rejects broad or execution-shaped browser requests, and closes by cancelling still-pending events, ending the session, and stopping the server. Its `--json` output is newline-delimited lifecycle packets.
- The served pages embed no file contents and load no external assets: the dashboard alone carries a nonce-bound session-activity poller for token-scoped `GET /activity`, while detail and bundle pages remain scriptless.
The server accepts safe GET/HEAD reads for pages, health checks, and the read-only activity fragment, a token-bound `POST /intents` that records dashboard decisions and the detail drawer's human triage intents (inspect, comment, keep/trash/resolve/defer, dry-run request), a token-bound `POST /approve` that records approval-bundle submissions as pending session events, and a token-bound `POST /close` that records a `session_done` close request for the attached agent.
It refuses any other mutating method and renders bad or missing ledgers, records, and bundles as explicit non-crashing problem states rather than blank panels.
The captured intents and approval bundles never mutate ledgers, files, trash, or plans directly; the agent executes approved bundles through `ui execute` or handles other approval-gated commands through the agent-mediated `ui` session loop.
- After a dashboard submit, the redirect includes a bounded queued count and lands on the session-activity panel.
The served dashboard shows pending browser events, stale/rejected/failed states with a reload-safe next action, dry-run continuity, final execution receipts, and row-level "sent to agent" badges; its `/activity` poll reads only session history, requires the active token in the query string, and stops when the session ends.
Completed dry-run replies that include a reviewed dispose plan id become ready-for-approval required-action rows, replacing the original row while the plan is still live and returning to the original row if the plan becomes stale.
Prepared plans can be approved one by one or with the prepared-plan approve-all control, which queues one exact approval bundle per live plan.
Submitted approvals remain visibly queued and disabled until the agent handles them or the reviewer unqueues pending browser events from the activity rail; grouped pending work renders one grouped unqueue action, and unqueue records cancellation in the session without mutating ledgers, files, trash, or plans.
Completed `ui execute` receipts refresh required actions so handled rows and stale ready-for-approval rows disappear from the approval surface.
- `GET /bundle/<bundle-id>` renders one persisted workbench source snapshot or submitted approval bundle as a browser workbench: grouped candidate rows that clearly distinguish the deliberately selected exact targets from the merely reviewed ones, the exact action being approved, and the human row labels captured at approval time.
The page requires the active session token, renders the immutable source snapshot, and provides scriptless selection inputs that can submit a revised non-empty subset through `POST /approve`.
That submit carries only the source snapshot id and selected target ids; the server rehydrates the action, reviewed facts, and exact target rows from the stored source snapshot before creating a new immutable submitted approval snapshot and queuing an `approval_bundle_submitted` event.
For a `trash-purge` bundle, the workbench repeats the one-way-door/no-recovery warning before approval.
It never trusts hidden browser target JSON as approval evidence, never edits the original bundle, and never executes a workflow.
Absent or malformed bundle ids render as non-crashing not-found states.
- `ui bundle <session-id> [<bundle-id>]` is the agent's read surface over submitted approval bundles, scoped to `user` or `repo` (default `user`).
With a bundle id it loads one immutable event-backed reviewed snapshot and resolves its deliberate selection to the exact per-target rows, emitting the agent-facing JSON the executor revalidates against live ledger, registry, record, plan, and trash-fact state before any exact-target execution.
With no bundle id it lists only the session's approved bundles with matching `approval_bundle_submitted` events as a compact discovery summary.
Browser-only workbench source snapshots can still be opened by the token-protected `GET /bundle/<bundle-id>` route, but `ui bundle` does not list or load them.
It only reads approval records - it never executes a bundle or mutates ledgers, files, trash, or plans - and a bundle revalidation is fresh only when every selected target is still present and unchanged and no reviewed fact drifted; otherwise `ui execute` refuses whole-bundle drift or skips per-target drift with visible receipts for human re-review.
- `ui execute <session-id> <bundle-id>` is the agent's mutating path for an approved bundle and the one `ui` subcommand that changes live state, scoped to `user` or `repo` (default `user`).
It loads the immutable submitted approval snapshot, re-reads live ledger/registry/trash state, then runs a revalidate -> execute -> verify loop through the existing approval-gated dispose paths or the exact-target one-way-door purge path, and replies the per-target receipts and aggregate result to the session by advancing the bundle's `approval_bundle_submitted` event.
Execution is exact-target only: a stale, missing, mismatched, or unapproved target is refused or skipped, never force-applied, and the agent verifies live state after each command rather than trusting the command exit.
There is no `ui execute --all` and no browser-direct execution.
Dispose-backed targets bind approval to the reviewed dispose-plan entry digest, so missing or unreadable reviewed plans, subject content drift, or changed same-id plan entry contents such as reason, subject snapshot, target path, or retention make the bundle stale/refused before any dispose receipt is written instead of changing execution semantics.
Purge-backed targets use the `trash-purge` action, bind approval to the exact live trash facts by digest, permanently delete only the reviewed trashed artifact with no recovery path, and skip or require manual review for stale, missing, changed, unsafe, or out-of-scope targets instead of force-applying them.
If an earlier run claimed the approval event as `in_progress` and stopped before final receipts, rerunning the same session and bundle resumes that claim.
Each selected target receives one of four visible outcomes - `executed`, `skipped_stale`, `failed`, or `needs_manual_review` - so a partial run never hides a target's state; a clean run (every selected target executed) exits 0, while a partial or refused run exits non-zero with every receipt still recorded in the session.
- `ui poll` is read-only and returns only pending actionable browser events in compact single-line JSON when `--json` is set.
- `ui reply` appends an agent reply for one event with status `acknowledged`, `in_progress`, `completed`, `rejected`, `stale`, `failed`, or `cancelled`, plus an optional JSON-object payload for receipts, results, validation failures, questions, or notes.
- `ui end` marks the session ended, records a `session_done` event, and revokes future browser writes plus served dashboard/detail/bundle access while keeping the session readable for audit.
- A managed UI review loop must use `ui review` or an equivalent host-owned lifecycle:
  serve, poll, acknowledge, process, reply, refresh, repeat, then end and tear
  down. Silent server exit, orphaned polling, or browser submissions that remain
  pending without an agent-visible processing state are product failures.
- `ARTSHELF_UI_URL` may provide a trusted review UI base URL for printed links; when unset, the command prints a host-local instruction instead of inventing a localhost URL.

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
- `ARTSHELF_UI_HOME` overrides the durable UI session home for tests or controlled hosts; legacy `SHELF_UI_HOME` is read only when it is unset.
- `ARTSHELF_UI_URL` sets the trusted base URL printed by `artshelf ui` for browser review links.
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

- `trash-resolve`: move the recorded path into plan-scoped Artshelf trash,
  mark the row `trashed`, and leave physical deletion to a separate trash purge.
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


## UI Session Storage

The Artshelf UI session model is durable user-level storage by default, separate from ledger records and cleanup plans.
It is a handoff contract for review state, not an execution engine.

Default layout:

- user scope: `~/.artshelf/ui`
- repo scope: `<repo>/.artshelf/ui`
- override for tests or controlled hosts: `ARTSHELF_UI_HOME` (legacy `SHELF_UI_HOME` is still read as a fallback)

Per-session layout under the resolved UI home:

```text
sessions/<session-id>/session.json
sessions/<session-id>/events.jsonl
sessions/<session-id>/bundles/<bundle-id>.json
```

`session.json` stores versioned metadata, the scope, lifecycle status, timestamps, optional ledger path, optional registry path, optional repo root, and the same-machine browser capability token.
When an older active session has the same scope and target but lacks registry or repo metadata, starting or serving it backfills those fields so the session stays resumable while later approval execution can still enforce scope.
The token authorizes browser reads plus intent and approval writes only while the session is active; ending the session revokes browser access without deleting audit history.
`events.jsonl` is append-only and stores exact-target browser triage intents plus agent replies as separate log lines, with read-side projections folding replies into the current event status and preserving reply payloads for record history.
Snapshots under `bundles/` are immutable JSON documents that persist the full reviewed candidate pool, the deliberate selection, exact per-target ledger or registry context for every selected target, optional reviewed dispose-plan entry or trash-fact digests, and a deterministic fingerprint over the selected targets and reviewed facts.
Browser workbench source snapshots may have an empty selection while they are being prepared and have no `approval_bundle_submitted` event.
Submitted approval snapshots must have a non-empty, duplicate-free deliberate selection, never a vague approve-all, plus a matching `approval_bundle_submitted` event before the agent-facing `ui bundle` and `ui execute` paths will expose or act on them.
Before running any approval-gated command, an executor revalidates the bundle against live ledger, registry, record, plan, and trash facts, comparing the persisted fingerprint and the selected per-target context with what live state now reports.
Session scope is also rechecked: ledger-scoped sessions accept only that ledger, repo-scoped sessions accept only ledgers in that repo, and registry-scoped browser approvals must still point at ledgers registered in the served registry.
The bundle is fresh only when every selected target is still present and unchanged, every reviewed dispose plan remains readable with the same entry digest and subject snapshot, every reviewed purge target still matches its trash-fact digest, and no reviewed fact drifted; drift in a shared reviewed fact or unexplained fingerprint refuses the whole bundle, while missing or changed selected targets are skipped as stale per-target receipts and still require human re-review.
Drift in an unselected candidate row is ignored because only the approved subset gates execution.

The storage layer must not itself execute cleanup, dispose, reconcile, registry-prune, resolve, or purge actions.
Those remain explicit execution paths: reviewed plan-id CLI commands, or `ui execute` over an approved exact-target bundle.

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
- `cleanup --execute --all`, `dispose --all`, `reconcile --execute --all`, `ui execute --all`, and
  `trash purge --all` are refused; execution stays scoped to one explicit ledger
  or registry plus one reviewed plan id, or to one approved bundle whose selected targets each bind to exact reviewed plan or trash-fact context.

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

Records touched by `artshelf dispose --execute` carry the dispose audit trail so
reviewed disposition stays traceable to the plan and receipt that produced it:

```json
{
  "disposePlanId": "dispose_20260601_063000_ab12",
  "disposeReceiptPath": "/absolute/path/.artshelf/dispose-receipts/dispose_20260601_063000_ab12.json",
  "disposedAt": "2026-06-01T06:30:00Z",
  "disposeAction": "trash-resolve",
  "disposeReason": "reviewed and no longer needed"
}
```

`trash-resolve` also sets `previousPath` and `targetPath`; `resolve-only` sets
the resolve fields without moving the subject; `snooze` updates retention; and
`keep` leaves retention intact while making due classification quiet.

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
  `artshelf dispose --execute`, `artshelf trash purge --execute`, and agent-side
  `artshelf ui execute` over an approved bundle; each requires separately reviewed
  exact target context before mutation.
- **No global execute.** `cleanup --execute --all`, `dispose --all`, `ui execute --all`, and
  `trash purge --all` are refused; `--all` is read-only or dry-run reporting
  only where supported. Execution is scoped to a reviewed plan id or one approved
  bundle whose selected targets each bind to exact reviewed plan or trash-fact context.
- **No fresh-plan-then-execute.** `cleanup --execute` and `dispose --execute`
  refuse to compute a new live set. They act only on plan ids that earlier
  dry-runs produced and a human reviewed; they will not plan and execute in one
  step.
- **No silent deletion.** Cleanup trashes or flags for review and writes a
  receipt to the ledger. The `cleanup=delete` action stays refused in v1; the
  sanctioned physical deletion is limited to `artshelf trash purge --execute` or
  agent-side `artshelf ui execute` over an exact approved `trash-purge` bundle;
  both remove already-quarantined trash through reviewed purge context and a
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
- Trash purge is scoped to one ledger for the CLI plan-id path, or to exact selected targets for an approved UI `trash-purge` bundle.
  Both write a purge receipt before removing quarantined files.

## Agent Usage Contract

Agents should call `artshelf put` immediately after creating:

- config backups
- quarantine folders
- debug output directories
- temporary repo artifacts
- one-off generated reports
- copied files kept for rollback

Agents should not run `artshelf cleanup --execute`,
`artshelf dispose --execute`, `artshelf trash purge --execute`, or
`artshelf ui execute` without explicit approval naming the ledger path and
reviewed plan id or approved bundle id.

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
targets in the message body. `dispose --dry-run --agent` already emits its own
compact per-record approval packet, so it does not require wrapping in this
review-report schema.

Scheduled jobs must never run `artshelf cleanup --execute`,
`artshelf ledgers prune --execute`, `artshelf dispose --execute`,
`artshelf trash purge --execute`, or `artshelf ui execute`; they may only
dry-run and report plans for later human review.

## Dogfood Scenarios

1. Record a repo-local `tmp/` scratch directory with a 3-day TTL.
2. Record a config backup with manual review retention.
3. Generate a dry-run cleanup plan after TTL expiry using fixture data.
4. Execute a cleanup plan in a temporary test fixture and verify receipt output.
5. Dispose one reviewed record through dry-run and exact execute approval, then
   verify the receipt, audit fields, and quiet review state.
6. List trashed records, dry-run an old-trash purge, then execute the reviewed
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
- CLI can define and persist durable UI review sessions with metadata, browser
  capability tokens, append-only events, agent replies, and immutable approval
  snapshots, defaulting to user-level multi-ledger review with optional repo or
  ledger scoping.
- CLI can run the AXI-style `artshelf ui` command family: start/resume a session,
  show the read-only multi-ledger dashboard and artifact detail drawer, poll
  pending browser events manually or through `ui review`, reply with agent receipts or notes, list or load
  approval bundles for agent revalidation, execute an approved bundle through
  exact-target revalidation plus post-execute verification, and end the session;
  dispose-backed approval targets bind to reviewed plan entry contents, not only
  the reusable plan id, and purge-backed approval targets bind to exact live
  trash facts with no recovery path.
  The browser captures human triage intents and approval bundle submissions but
  never mutates ledgers, files, trash, or plans directly.
- A host or agent can run `artshelf ui review` or wrap the lower-level `artshelf ui`
  primitives into the intended live review workflow: start the browser UI, stay
  attached to polling, acknowledge submitted actions, process them within the
  approval boundary, reply into the session, refresh live state, and end the
  session plus served process from an explicit close signal.
- Cleanup dry-run creates a plan id only when there are executable cleanup
  entries; no-op dry-runs do not write plan files.
- Cleanup dry-run and execute register the plan/receipt artifacts that Artshelf
  creates.
- Cleanup execute refuses to run without a plan id, and refuses an unsafe,
  mismatched, or malformed plan before moving files or writing a receipt.
- Cleanup execute writes a started receipt before moving files, resumes or
  replays the same plan id from receipt/trash evidence, and completes the
  receipt idempotently.
- CLI can dispose one reviewed record through `artshelf dispose`: `--dry-run`
  creates or reuses an exact reviewed plan for trash-resolve, resolve-only,
  snooze, or keep; `--execute` applies one plan id against one ledger, refuses
  `--all`, stale state, and target conflicts, writes a receipt, and never
  physically deletes.
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
- All core commands support `--json`; the `artshelf ui` family uses compact
  single-line JSON packets for the read-only dashboard/detail views, serve launch
  packet, approval-bundle read surface, execution receipt surface, and session loop.
- `review`, `status`, `doctor`, `ledgers prune --dry-run`, `dispose --dry-run`,
  and `get --inspect` also support `--agent`, a compact single-line JSON decision
  packet for agents that takes precedence over `--json`.
- Tests cover record/list/find/get/status-filter/due/validate/resolve/registry,
  `artshelf doctor`, the `artshelf status` dashboard, `--all` review, stale-registry,
  dry-run, global-dry-run, execute-plan, cleanup plan-id validation, concurrent
  ledger writes, trash list/purge, path provenance validation, registry-prune,
  reconcile dry-run/execute, dispose dry-run/execute, UI dashboard/detail,
  approval-bundle workbench, UI purge execution, and UI session/command behavior.

## Deferred

- Cron integration.
- Agent skill adapters.
- GitHub Action.
- Fake/demo mode.
- Rollback command.
- Retention classes like keep-daily/weekly/monthly.
- Dependency roots and pinning.
- Credential scanning.
