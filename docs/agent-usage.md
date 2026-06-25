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
`artshelf ui detail <record-id> --ledger <path> --json` returns the read-only artifact detail drawer with inspect-card output, provenance, audit trail, existence facts, needs-context badge, and last action.
Both views are metadata-only and never preview file contents.
The session command defaults to user-level, multi-ledger review and stores session state under `~/.artshelf/ui`; use `--scope repo` or `--ledger <path>` when the review needs a narrower target.
The browser records decisions, the agent polls with `artshelf ui poll <session-id> --json`, runs existing approval-gated commands only after exact human approval, replies with `artshelf ui reply`, and closes with `artshelf ui end`.
There is no browser-direct mutation path.
Treat the session token printed by `artshelf ui` as a secret same-machine browser-write capability; ending the session revokes future browser writes while keeping the audit trail readable.

## Portable Skill

The repo ships a portable skill at
[`skills/artshelf`](../skills/artshelf). Agents that support local skills can
copy or reference the whole directory directly, including the bundled
`scripts/render-review-report.mjs` renderer plus schema and example copies.
