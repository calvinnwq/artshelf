# Agent Usage

Agents that support local skills can copy or reference
the whole [`skills/artshelf`](../skills/artshelf) directory. The public docs site at
<https://calvinnwq.github.io/artshelf/> explains the same contract in browsable
form.

Artshelf is meant to be operated by agents through a small skill contract and
read-only scheduled reviews. Agents remember and summarize. Humans approve
mutation.

## Workflow Summary

Use Artshelf as a five-stage loop around agent work:

1. **Create**: register durable temp artifacts with lookup-before-put and
   `artshelf put`, or state the skip reason.
2. **Monitor**: run read-only checks for registry health, due records, missing
   paths, and trash state.
3. **Review**: turn raw output into an `ArtshelfReviewReport` decision packet
   with exact approval targets.
4. **Clean**: execute approved cleanup plans (which trash, never delete),
   resolve confirmed ids, then verify quiet.
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
- [Clean](agent-clean.html): approval-only cleanup, resolve, receipts, and
  verify-quiet checks.
- [Purge](agent-purge.html): separately reviewed trash purge that physically
  deletes, with its own approval target and receipts.

## Operating Principles

- Agents remember with the portable skill.
- Scheduled checks read and report only; set `ARTSHELF_NO_UPDATE_CHECK=1` when
  they must avoid npm network checks and update-cache writes.
- Review output is a decision packet, not raw counts.
- Approval names the exact ledger, plan id, or record ids.
- Every approved action ends with a read-only verification.

## Portable Skill

The repo ships a portable skill at
[`skills/artshelf`](../skills/artshelf). Agents that support local skills can
copy or reference the whole directory directly, including the bundled
`scripts/render-review-report.mjs` renderer plus schema and example copies.
