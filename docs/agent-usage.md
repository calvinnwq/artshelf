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
5. **Purge**: clear old trash only from a separate, separately reviewed purge
   plan; physical deletion never piggybacks on the cleanup plan.

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
`artshelf ui serve [--scope user|repo] [--port <port>] [--json]` hosts those dashboard and detail views as a local browser page for a human reviewer; it binds to loopback (127.0.0.1) only, recomputes live state per request, requires the active UI session capability token printed in the serve URL, serves no script and no file contents, and supports `--json` for a compact launch packet.
The dashboard stays display-only, while the detail drawer adds scriptless forms that capture lightweight human triage intents - inspect, comment, keep/trash/resolve/defer, and dry-run request - recording each as a pending event in the durable session log for the agent to act on after approval.
The served bundle workbench at `GET /bundle/<bundle-id>` shows the selected exact targets, reviewed-only rows, and exact action from an immutable approval snapshot.
With the active token, its scriptless form can submit a revised non-empty subset through `POST /approve`, creating a new immutable approval snapshot and pending approval event without editing the original bundle or executing a workflow.
The session command defaults to user-level, multi-ledger review and stores session state under `~/.artshelf/ui`; use `--scope repo` or `--ledger <path>` when the review needs a narrower target.
The browser records exact-target triage intents and approval bundle submissions, the agent polls with `artshelf ui poll <session-id> --json`, uses `artshelf ui execute` for approved bundles or runs existing approval-gated commands only after exact human approval, replies with `artshelf ui reply`, and closes with `artshelf ui end`.
The browser captures triage intents and approval bundles only and never mutates ledgers, files, trash, or plans directly.
`artshelf ui bundle <session-id> [<bundle-id>] --json` is the agent's read surface over persisted approval bundles: with a bundle id it loads one immutable snapshot plus its resolved deliberate selection so the agent can revalidate live state before execution; with no bundle id it lists the session's approved bundles.
It never executes a bundle.
`artshelf ui execute <session-id> <bundle-id> --json` is the agent's mutating path and the one `ui` subcommand that changes live state: it loads the immutable reviewed snapshot, re-reads live ledger/registry/trash state, then runs a revalidate -> execute -> verify loop through the existing approval-gated dispose paths and replies per-target receipts plus the aggregate result to the session.
Execution is exact-target only - a stale, missing, mismatched, or unapproved target is refused or skipped, never force-applied - and the agent verifies live state after each command rather than trusting the command exit; there is no `ui execute --all` and no browser-direct execution.
For dispose-backed targets, approval also binds to the reviewed dispose-plan entry contents, so changing a same-id plan artifact's reason, subject snapshot, target, or retention after approval makes the bundle stale instead of changing execution semantics.
Each selected target receives one of four visible outcomes - `executed`, `skipped_stale`, `failed`, or `needs_manual_review` - so a partial run never hides a target's state, and a clean run exits 0 while a partial or refused run exits non-zero with every receipt still recorded.
Treat the session token printed by `artshelf ui` and `artshelf ui serve` as a secret same-machine browser capability; ending the session revokes future browser writes and served dashboard/detail/bundle access while keeping the audit trail readable.

## Portable Skill

The repo ships a portable skill at
[`skills/artshelf`](../skills/artshelf). Agents that support local skills can
copy or reference the whole directory directly, including the bundled
`scripts/render-review-report.mjs` renderer plus schema and example copies.
