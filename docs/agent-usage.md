# Agent Usage

Agents that support local skills can copy or reference
the whole [`skills/artshelf`](../skills/artshelf) directory. The public docs site at
<https://calvinnwq.github.io/artshelf/> explains the same contract in browsable
form.

Artshelf is meant to be operated by agents through a small skill contract and
read-only scheduled reviews. Agents remember and summarize. Humans approve
mutation.

## Workflow Summary

One simple loop runs the whole shelf, four moves:

- **Capture automatically**: register eligible artifacts at creation, or state
  the skip reason.
- **Review calmly**: read-only and dry-run only; turn the output into a decision
  packet. Nothing moves.
- **Approve exactly**: a human approves one exact reviewed ledger or registry
  plus plan id or record ids.
- **Verify quiet**: re-run a read-only check after every approved mutation.

Underneath, those four moves are five mechanical stages around agent work:

1. **Create**: register durable temp artifacts with lookup-before-put and
   `artshelf put`, or state the skip reason.
2. **Monitor**: run read-only checks for registry health, due records, missing
   paths, and trash state.
3. **Review**: use inspect plus cleanup, registry-prune, reconcile, and
   dispose dry-runs to turn raw output into an `ArtshelfReviewReport` decision
   packet with exact approval targets.
4. **Clean**: execute approved cleanup and dispose plans, resolve confirmed ids,
   then verify quiet.
5. **Purge**: clear old trash only from a separately reviewed purge plan or
   exact approved `trash-purge` bundle; physical deletion never piggybacks on the cleanup plan.

This maps to the product loop: **Create -> Monitor -> Review -> Clean -> Purge**.

## Child Pages

The browsable docs split the workflow into focused child pages:

- [Create](agent-create.html): registration triggers, lookup-before-put, skip
  reasons, and Artshelf id footnotes.
- [Monitor](agent-monitor.html): registry health, scheduled read-only checks,
  and preview plans.
- [Review](agent-review.html): decision packet schema, classifications, and
  exact approval wording.
- [Clean](agent-clean.html): approval-only cleanup, dispose, resolve, receipts,
  and verify-quiet checks.
- [Purge](agent-purge.html): separately reviewed trash purge that physically
  deletes, with its own approval target and receipts.

## Operating Principles

- Agents remember with the portable skill.
- Scheduled checks read and report only; set `ARTSHELF_NO_UPDATE_CHECK=1` when
  they must avoid npm network checks and update-cache writes.
- Review output is a decision packet, not raw counts.
- Stale registry entries route through `ledgers prune --dry-run`, not manual JSON edits.
- Approval names the exact ledger or registry, plan id, or record ids.
- Every approved action ends with a read-only verification.

## Render modes

`review`, `status`, `doctor`, `ledgers prune --dry-run`, `dispose --dry-run`,
and per-record `get --inspect` share agent-oriented render modes so the same data fits both
people and agents:

- **default**: a human render — scannable grouped counts, attention states, and a
  short next action for a person at the terminal.
- **`--agent`**: a deterministic, token-efficient decision packet (single-line
  compact JSON) with health, counts, classifications, blockers, record
  recommendations, approval targets where applicable, and a verification
  command. Use it when an agent acts on the result.
- **`--json`**: the backward-compatible public audit contract — complete
  machine-readable JSON for debugging and integrations.

Reach for `--agent` when an agent needs to decide and act cheaply; reach for
`--json` when you want the full record, plan, or health detail for audit or
debugging. `--agent` takes precedence if both flags are passed; on `get`, it
requires `--inspect`.


## UI sessions

`artshelf ui` starts or resumes a durable browser review session for the agent-mediated loop.
`artshelf ui dashboard --json` returns the read-only multi-ledger review buckets, including needs-context, cleanup, resolve, trash, purge candidates, registry/reconcile problems, and recent receipts.
`artshelf ui detail <record-id> --ledger <path> --json` returns the read-only artifact detail drawer with path label, inspect-card output, provenance, audit trail, existence facts, needs-context badge, and last action.
Both views are metadata-only and never preview file contents.
`artshelf ui serve [--scope user|repo] [--port <port>] [--json]` hosts those dashboard and detail views as a local browser page for a human reviewer; it binds to loopback (127.0.0.1) only, recomputes live state per request, requires the active UI session capability token printed in the serve URL, embeds no file contents, loads no external assets, and supports `--json` for a compact launch packet.
The dashboard includes a nonce-bound session-activity poller for the token-scoped `/activity` fragment; detail and bundle pages remain scriptless.
The dashboard presents compact required-action cards before the status summary and collapsed source details.
Reviewers can queue recommended card approvals, lane-level keep/trash/resolve choices, individual row choices, and dashboard dry-run requests into one `Queued for agent` submit bar, while conflicting card/bulk/row selections are refused.
Bulk lane approvals carry the reviewed row set from the loaded dashboard and are rejected if the lane changed before submit.
Dashboard dry-run requests enter the agent queue as lane events: cleanup prepares a cleanup plan, resolve checks missing files, purge-candidates requests delete review, and registry/reconcile checks source problems.
Completed dry-run replies that produce reviewed dispose plans become ready-for-approval rows in Required actions, replacing the original row while the plan remains live; those plans can be approved individually or with the prepared-plan approve-all control.
After a dashboard submit, the page lands on session activity with a bounded queued count, marks affected rows as sent to the agent, and refreshes pending decisions, prepared plans, stale/rejected states, and execution receipts without mutating ledgers, files, trash, or plans from the browser.
Submitted approvals stay visibly queued until the agent handles them, and the activity rail can unqueue pending browser work without touching ledgers, files, trash, or plans.
The detail drawer adds record-level forms for inspect, comment, keep/trash/resolve/defer, and dry-run requests.
The served bundle workbench at `GET /bundle/<bundle-id>` shows the selected exact targets, reviewed-only rows, and exact action from an immutable approval snapshot.
With the active token, its scriptless form can submit a revised non-empty subset through `POST /approve`, creating a new immutable approval snapshot and pending approval event without editing the original bundle or executing a workflow.
That submit carries only the source bundle id and selected target ids; the server rehydrates the action, reviewed facts, and exact target rows from the stored source bundle instead of trusting hidden browser target JSON.
The session command defaults to user-level, multi-ledger review and stores session state under `~/.artshelf/ui`; use `--scope repo` or `--ledger <path>` when the review needs a narrower target.
The browser records exact-target triage intents and approval bundle submissions, the agent polls with `artshelf ui poll <session-id> --json`, uses `artshelf ui execute` for approved bundles or runs existing approval-gated commands only after exact human approval, replies with `artshelf ui reply`, and closes with `artshelf ui end`.
The browser captures triage intents and approval bundles only and never mutates ledgers, files, trash, or plans directly.
`artshelf ui bundle <session-id> [<bundle-id>] --json` is the agent's read surface over persisted approval bundles: with a bundle id it loads one immutable snapshot plus its resolved deliberate selection so the agent can revalidate live state before execution; with no bundle id it lists the session's approved bundles.
It never executes a bundle.
`artshelf ui execute <session-id> <bundle-id> --json` is the agent's mutating path and the one `ui` subcommand that changes live state: it loads the immutable reviewed snapshot, re-reads live ledger/registry/trash state, then runs a revalidate -> execute -> verify loop through the existing approval-gated dispose or one-way-door purge paths and replies per-target receipts plus the aggregate result to the session.
Execution is exact-target only - a stale, missing, mismatched, or unapproved target is refused or skipped, never force-applied - and the agent verifies live state after each command rather than trusting the command exit; there is no `ui execute --all` and no browser-direct execution.
For dispose-backed targets, approval also binds to the reviewed dispose-plan entry contents, so a missing or unreadable reviewed plan, subject content drift, or changing a same-id plan artifact's reason, subject snapshot, target, or retention after approval makes the bundle stale before any dispose receipt is written.
A purge-backed bundle uses the `trash-purge` action and routes each target through the one-way-door purge executor, which permanently deletes the trashed artifact with no recovery path - distinct from the reversible dispose path.
The dashboard purge lane groups purge candidates by source/ledger with a per-group total and renders a no-recovery warning, and the approval workbench restates that warning for a purge bundle; nothing is preselected, so the agent purges only an exact, grouped selection a human approves.
The purge approval is bound to the exact live trash facts (record id, ledger, trashed artifact path, and cleanup provenance) via a digest, so any drift between approval and execution makes the target stale before the irreversible deletion runs.
If an earlier execution claimed the approval event as `in_progress` and stopped before final receipts, rerunning the same session and bundle resumes that claim.
Each selected target receives one of four visible outcomes - `executed`, `skipped_stale`, `failed`, or `needs_manual_review` - so a partial run never hides a target's state, and a clean run exits 0 while a partial or refused run exits non-zero with every receipt still recorded.
Treat the session token printed by `artshelf ui` and `artshelf ui serve` as a secret same-machine browser capability; ending the session revokes future browser writes and served dashboard/detail/bundle access while keeping the audit trail readable.

### Managed UI review workflow

The user-facing review should behave like one attached workflow, not a manual
handoff between browser and shell commands. When a user asks to review Artshelf
actions through the UI, the agent or host should:

1. Start or resume `artshelf ui` from the original conversation.
2. Start `artshelf ui serve` as a managed foreground process and give the user
   the capability URL.
3. Keep polling the same session with `artshelf ui poll <session-id> --json`.
4. For every pending event, immediately reply with `acknowledged` or
   `in_progress` so the UI shows the work was picked up.
5. Run only read-only, dry-run, or exactly approved actions allowed by the event.
6. Reply with the final status and payload through `artshelf ui reply`, including
   receipts, dry-run plan ids, rejection reasons, stale-state explanations, and
   exact approval text when another approval is needed.
7. Continue polling and processing more submissions until the user sends an
   explicit close/end action.
8. On close, drain or cancel work safely, run `artshelf ui end`, stop the served
   UI process, and summarize the session back in the original conversation.

If the agent cannot keep both the served UI and the polling loop alive, it should
say managed UI review is unavailable rather than pretending the browser is
attached. A dead server, orphaned poller, or pending event that never visibly
moves to processing is a broken workflow.

## Portable Skill

The repo ships a portable skill at
[`skills/artshelf`](../skills/artshelf). Agents that support local skills can
copy or reference the whole directory directly, including the bundled
`scripts/render-review-report.mjs` renderer plus schema and example copies.
