# Changelog

## Unreleased

- Added read-only `artshelf get <id> --inspect` decision cards with human,
  `--json`, and `--agent` render modes, including registry-wide `--all` lookup,
  metadata-only existence/size reporting, recommendation buckets, and exact
  next-safe actions without reading file contents or mutating ledgers.
- Added approval-gated `artshelf ledgers prune` registry maintenance: dry-run
  writes or reuses a reviewed plan for missing registered ledger files, `--agent`
  emits the exact registry-prune approval target, execute binds to one registry
  and plan id, writes a rollback copy and receipt, and `doctor`/`status`/`review`
  agent guidance routes stale registrations to this flow instead of manual JSON
  edits.
- Hardened `cleanup --execute` with durable resumability: a `started` receipt is
  written before the first filesystem move so an interrupted run is detectable,
  terminal receipt evidence preserves an artifact's original
  `executedAt`/`cleanedAt`, an artifact already moved into the plan's trash
  directory without terminal receipt evidence is recorded as `trashed` at resume
  time without moving it again, a missing original path with no trash target and no
  receipt evidence stays a skipped missing path rather than a success, and a
  completed receipt replays idempotently without duplicating the Artshelf-owned
  receipt record (NGX-427).
- Renamed the published package and CLI binary from `shelf` to `artshelf`,
  moved project URLs to `calvinnwq/artshelf`, and prepared public npm publishing.
- Added a user-level ledger registry plus `--all` review commands so Artshelf can
  discover known project/user ledgers from one CLI entry point.
- Added read-only `find` and `get` commands for ledger lookup and idempotent
  agent integrations.
- Documented `find` / `get` as the lookup surface agents should use before
  creating duplicate records with `put`.
- Tightened portable agent trigger guidance and removed setup-specific docs so
  Artshelf remains workflow-agnostic.
- Added `pnpm docs:serve` for local static docs preview.
- Changed cleanup dry-run to avoid writing plan files when there are no
  executable cleanup entries, and registered Artshelf-created plans/receipts as
  Artshelf-owned ledger artifacts.
- Reuse unchanged cleanup dry-run plans by refreshing the existing plan timestamp
  and Artshelf-owned plan record instead of creating duplicate plan files.
- Added a read-only `artshelf doctor` command that reports CLI and runtime version,
  the selected/default ledger path, selected/global registry path,
  registered-ledger health (stale or invalid entries), and the cleanup safety
  posture, exiting non-zero when the registry or a registered ledger is broken.
- Added a read-only `artshelf status` dashboard: single-ledger mode reports
  selected-ledger counts, while `--all` adds registry health, total ledgers, and
  aggregated active, kept, due, manual-review, missing-path, and pending-cleanup
  counts, with `--all --json` suited to cron and human output short enough to
  paste into a chat.
- Changed `artshelf ledgers list` to validate each registered ledger by default,
  reporting ok/missing/invalid status, entry counts, and warning/error counts in
  both human and JSON output and exiting non-zero when the registry or any
  registered ledger is broken, so agents can detect stale registry entries
  without a separate validate pass. Added `--plain` for the backward-compatible
  fast path that lists registered ledgers without reading them.
- Changed `artshelf review --all` to emit an aggregate triage summary alongside the
  existing per-ledger detail: JSON gains a `summary` block (affected ledgers,
  due, manual-review, missing-path, executable, skipped counts, and plan ids) and
  human output adds a triage line plus the next safe action. Review stays
  read-only and never writes cleanup plans.
- Added approval-first `artshelf trash list` and `artshelf trash purge` commands for
  reviewing quarantined trash and physically deleting it only from a reviewed,
  ledger-scoped purge plan.
- Changed ledger validation to require cleanup metadata on trashed records and
  warn when a trashed target path is missing.
- Hardened trash purge execution with ledger-local path checks, durable failure
  receipts, interrupted-run resume, and refusal of completed purge receipts.
- Reorganized the README and docs quickstart to lead with the approval-first
  workflows — register a temp artifact, review everything safely, approve
  cleanup safely, and purge old trash explicitly — keeping reference material
  available below the lead.
- Tightened the portable agent skill description so the completion-gate trigger
  is visible before final responses, status updates, handoffs, and done reports.
- Added packaged `ArtshelfReviewReport` schema, canonical example files, and a
  portable renderer script for deterministic agent review reports, plus
  deterministic footnote guidance for `artshelf put --json` registrations.
- Split the agent docs into Create, Monitor, Review, Clean, and Purge workflow
  pages backed by shared docs-site chrome, search, and navigation.
- Added `artshelf update` plus cached npm update notices, with
  `ARTSHELF_NO_UPDATE_CHECK=1` for no-network scheduled jobs.
- Rewrote `artshelf help` into a compact, grouped command list (Create, Inspect,
  Review, Clean, System) with one-line summaries and focused per-command help,
  added nested help for `trash`/`ledgers` subcommands plus `artshelf trash help`
  and `artshelf ledgers help` aliases, advertised short `-h`/`-v` flags, and
  reclassified `--ledger`, `--registry`, and `--all` as command-specific scope
  flags instead of global options.
- Added an `--agent` render mode to `artshelf review`, `status`, and `doctor`: a
  compact, deterministic single-line JSON decision packet (health, counts,
  attention categories or classified decision groups, blockers, the next safe
  action, and a verification command) tuned for agents acting on results.
  `--agent` takes precedence over `--json`, while `--json` stays the full,
  backward-compatible audit report. The default human renders of these three
  commands now lead each ledger and summary line with a `✓`/`⚠` attention glyph
  (plain Unicode, no color) so redirected output stays clean.
- Shortened the automatic update-check cache so no-update, failed, missing, or
  null results expire after 1 hour while update-available results keep the
  24-hour TTL, letting newly published releases surface sooner. `artshelf update`
  forces a fresh latest-version check instead of trusting a stale no-update
  cache, `ARTSHELF_NO_UPDATE_CHECK_TTL_MS` overrides the no-update/failed TTL
  (falling back to `ARTSHELF_UPDATE_CHECK_TTL_MS` for compatibility), and a
  non-numeric TTL value falls back to the default instead of disabling expiry.
- Made concurrent ledger and registry writes safe: ledger mutations now take the
  same cross-process advisory lock as the registry (extracted into a shared
  `withPathLock` helper in `src/locks.ts`), and ledger appends and rewrites commit
  through a unique temp file and an atomic rename, so overlapping `put`,
  `resolve`, and cleanup runs no longer drop records or leave a partially written
  ledger.
- Hardened `cleanup --execute` to reject unsafe plan ids and bind the loaded plan
  to the request before any filesystem mutation: the plan's `planId` must match
  the requested id, its `ledgerPath` must match the executing ledger, and its
  entries must be well-formed, so mismatched or malformed plans are refused before
  moving files or writing a receipt — the plan-id-bound posture trash purge
  already enforces.
- Added path provenance to new ledger records: each record now captures a
  `provenance` block (root class, root-relative path, basename, path kind, and an
  optional byte-size fingerprint) so a later reconcile can rebuild a moved
  artifact's path after a root rename without a daemon, watcher, or shell hook.
  Provenance is additive and backward compatible — records written before it
  simply omit the field and still validate, read, list, find, and get as legacy
  rows, while `validate` reports a malformed provenance block only when the field
  is present.
- Added the approval-gated `artshelf reconcile` command for ledger/registry
  housekeeping that never creates, moves, or deletes files. `--dry-run`
  classifies recorded-path drift into a reviewed plan (`remap`, `resolve-missing`,
  `resolve-stale-trash`, or `blocked`), writing and registering an Artshelf-owned
  plan only when actionable entries exist and reusing a matching plan id
  otherwise, and `--all` previews every registered ledger as dry-run only.
  `--execute` applies exactly one reviewed `--plan-id` against one explicit
  `--ledger`, refuses missing, unknown, or mismatched plans and entries whose live
  state drifted since review, stamps the reconcile audit trail (`previousPath`,
  `reconcilePlanId`, `reconcileReceiptPath`, `reconciledAt`, `reconcileReason`) on
  every touched row, and writes an Artshelf-owned reconcile receipt.
- Integrated reconcile findings into `review --agent`, `status --agent`, and
  `doctor --agent` triage: missing-path warnings now route to reconcile dry-run
  guidance before approval, reconciled plans escalate to ready-for-approval, and
  the `ArtshelfReviewReport` schema adds the `reconcile` action type (NGX-438).
- Moved `artshelf put` registry-warning output from stdout to stderr in human
  mode; `--json` output is unchanged (NGX-429).

## [0.17.0](https://github.com/calvinnwq/artshelf/compare/v0.16.0...v0.17.0) (2026-06-29)


### Features

* add durable Artshelf UI sessions ([e1dadad](https://github.com/calvinnwq/artshelf/commit/e1dadadbe98afe02922f2083ace5490026617eae))
* **dashboard:** Implemented the NGX-535 read-only multi-ledger dashboard aggregation domain core (src/dashboard.ts) via TDD, composing existing read-only surfaces into the eight UI v1 buckets with 12 focused tests, all five verification gates green. ([a06c5b9](https://github.com/calvinnwq/artshelf/commit/a06c5b94520f24975418b70e3819a1761a6a6697))
* **dashboard:** Implemented the NGX-536 artifact detail drawer domain core (src/artifact-detail.ts) via TDD, composing the read-only inspect decision card with provenance, the full audit trail, last action, and the NGX-537 needs-context badge into the contract's Minimum Human-Judgment Fields, with 8 focused tests and all five verification gates green. ([cb24fb7](https://github.com/calvinnwq/artshelf/commit/cb24fb7ca9f363984540bbd0299d68fc97af53c5))
* **dashboard:** Implemented the NGX-537 needs-context classifier in the NGX-535 dashboard module via TDD, routing weak-reason/insufficient-provenance records out of the review lanes with display copy, all five verification gates green. ([af31a13](https://github.com/calvinnwq/artshelf/commit/af31a1342ea062f6f1d30e523c5a690bc5ea9efd))
* **session:** Implemented NGX-531: the durable Artshelf UI review session contract and storage model (src/session.ts + types) with 15 focused TDD tests, with all five verification gates passing. ([49940a9](https://github.com/calvinnwq/artshelf/commit/49940a94b42861301b191b1279230f5a1c70d200))
* **ui:** add approval bundle snapshots ([73a70a9](https://github.com/calvinnwq/artshelf/commit/73a70a966b03a51436822c87a7f885cd04e31bb2))
* **ui:** add browser triage intent events ([03e3c55](https://github.com/calvinnwq/artshelf/commit/03e3c55b7f8eca39bcf105119739402add838f66))
* **ui:** add grouped one-way-door purge approvals ([d3832ba](https://github.com/calvinnwq/artshelf/commit/d3832ba39cc3cf156db0fc4505a4646a8eae48d2))
* **ui:** add read-only human review dashboard ([0317322](https://github.com/calvinnwq/artshelf/commit/031732204dcaf1788ef8dc2d7359e415a59960c8))
* **ui:** Added the NGX-538 browser triage-intent write path: a capability-token-guarded POST /intents endpoint plus scriptless detail-drawer forms for all seven intents (inspect/comment/keep/trash/resolve/defer/dry-run) that record each as a pending event in the durable session log, with 9 focused TDD tests, an end-to-end serve→POST→poll→reply smoke, and all five verification gates green (456 tests pass). ([0c4c5ac](https://github.com/calvinnwq/artshelf/commit/0c4c5acd0b5491c374bdacfcad2651c4916eedaa))
* **ui:** Added the NGX-539 agent-facing CLI approval-bundle read surface (artshelf ui bundle) that loads one persisted immutable snapshot as the agent-facing revalidation JSON or lists a session's approved bundles, backed by a new listApprovalSnapshots session primitive, with 5 TDD tests and all five verification gates green. ([568af0c](https://github.com/calvinnwq/artshelf/commit/568af0c34fcd24dd2d1d9975b985aa699d89b8eb))
* **ui:** Added the NGX-539 approval-bundle drift/staleness revalidation primitive (revalidateApprovalSnapshot) that compares a persisted bundle against live ledger/registry/record/plan facts and returns a fresh/stale verdict, satisfying AC6, with 6 TDD tests and all five verification gates green. ([415e2d2](https://github.com/calvinnwq/artshelf/commit/415e2d2fdae9796818b3284923e5a48571f7f050))
* **ui:** Added the NGX-539 browser approval-workbench presentation layer (renderApprovalWorkbenchPage + view-model types) that renders grouped reviewed candidate rows with a clear selected-vs-unselected distinction, the exact action being approved, a deliberate non-approve-all submit, and empty/invalid-selection states, satisfying the AC4 rendering core with 8 TDD tests and all five verification gates green. ([7006f0d](https://github.com/calvinnwq/artshelf/commit/7006f0dd537138c4a81507d7544a18a8e0ce5e31))
* **ui:** Added the NGX-540 live-facts re-read primitive (collectApprovalLiveFacts) that re-reads live ledger/record state for an approved bundle's selected targets into UiApprovalLiveFacts - the live re-read the executor revalidates against - TDD'd with 8 focused tests, all five verification gates green. ([1d9961f](https://github.com/calvinnwq/artshelf/commit/1d9961ffbc8db2f067d41123f13825010a10280c))
* **ui:** Added the NGX-540 session-level agent-execution orchestration (executeApprovedBundle) that loads an approved bundle, re-reads live state, runs the revalidate-&gt;execute-&gt;verify loop, and writes per-target receipts plus aggregate state back to the session by replying to the bundle's approval_bundle_submitted event - TDD'd with 8 focused tests, all five verification gates green. ([d15fdc5](https://github.com/calvinnwq/artshelf/commit/d15fdc5eb09cb912eb60893d467a390e01bfd782))
* **ui:** Added the user-facing `artshelf ui execute <session> <bundle> [--json]` CLI command wiring executeApprovedBundle into the agent's mutating execution path, with help text and 6 TDD CLI smoke tests; all five verification gates green. ([c60d67c](https://github.com/calvinnwq/artshelf/commit/c60d67c3aa091160f0e4b360741c40fdea880d63))
* **ui:** Built the read-only loopback browser surface (artshelf ui serve) that renders the NGX-535 dashboard and NGX-536 detail drawer as live HTML with the NGX-537 needs-context badge - the browser-rendered experience all three tickets named as their missing acceptance area - with 13 focused tests and all five gates green. ([f3db0bb](https://github.com/calvinnwq/artshelf/commit/f3db0bb1f2f355d4b289a785267d6b446916d8e1))
* **ui:** Completed NGX-541 by adding the approval-flow one-way-door/no-recovery warning and closing the last two Verification gaps (receipt projection + no-recovery receipt display) with mutation-verified TDD tests, all five gates green. ([485fa4d](https://github.com/calvinnwq/artshelf/commit/485fa4d0c001a4e9fb4611c640f869afa75ed53c))
* **ui:** execute approved bundles with live verification ([d471914](https://github.com/calvinnwq/artshelf/commit/d47191409f50896b30d1efb710dce11edc88361f))
* **ui:** Extended the NGX-538 exact-target validation core to the inspect_requested and comment_added triage intents (requiring an exact record+ledger target, and a non-empty body for comments), with 5 focused TDD tests and all five verification gates green (447 tests pass). ([b445419](https://github.com/calvinnwq/artshelf/commit/b44541913d703df7fb0ed9cc8d69aeea5fb15043))
* **ui:** Implemented and TDD-tested the decision_submitted decision-intent validation domain core for NGX-538, adding strict keep/trash/resolve/defer triage-intent validation with exact record+ledger targets to the durable UI session log. ([565c9ed](https://github.com/calvinnwq/artshelf/commit/565c9ed3d2c0344bea2a663cb7e9b298c783aeea))
* **ui:** Implemented NGX-532: the AXI-style `artshelf ui`/`ui poll`/`ui reply`/`ui end` command surface over the NGX-531 session core, with compact JSON + human help, 13 focused end-to-end tests, and all five verification gates passing. ([238f842](https://github.com/calvinnwq/artshelf/commit/238f8429c70663acd6fe8312a2963991ae9f6d07))
* **ui:** Implemented NGX-538 acceptance criterion 5 by surfacing the UI session's triage-intent and agent-reply history on the browser detail drawer, with a new readSessionHistory projection, 3 focused TDD tests, an end-to-end render smoke, and all five verification gates green (459 tests pass). ([a50b066](https://github.com/calvinnwq/artshelf/commit/a50b06662aaa47b80b457d781b2f2e6f214e52b0))
* **ui:** Implemented NGX-541's "selected purge bundle" data model: a pure builder converting grouped purge candidates into exact, digest-bound approval targets for a fingerprinted one-way-door purge bundle, verified end-to-end through approval-snapshot persistence under TDD with all gates green. ([c9b209e](https://github.com/calvinnwq/artshelf/commit/c9b209ee4516771a91cae996f7959b1abf4a72ff))
* **ui:** Implemented NGX-541's real one-way-door purge executor: the agent-mediated, exact-target, approval-gated deletion now physically purges the approved trashed artifact, independently verifies the deletion + ledger stamp, and writes a per-target no-recovery receipt, wired as the default execute route under TDD with all gates green. ([cad04ef](https://github.com/calvinnwq/artshelf/commit/cad04ef5ebc84667017de6073369ae60970e8697))
* **ui:** Implemented the foundational display slice of NGX-541: a grouped purge-candidate dashboard lane with one-way-door (no-recovery) warning copy, source/ledger grouping with per-group totals, and a read-only no-preselection presentation, all under TDD with full verification gates passing. ([b967e39](https://github.com/calvinnwq/artshelf/commit/b967e395af7b9a17b0b6c26c27f1ee84dce9452e))
* **ui:** Implemented the NGX-539 partial-selection approval-bundle storage foundation: bundles now persist a reviewed candidate pool plus a deliberate selection, fingerprint over only the selected targets, and reject vague/global approvals at the storage seam, with 12 TDD tests and all five verification gates green. ([aaf3bb9](https://github.com/calvinnwq/artshelf/commit/aaf3bb93de9d8e97284200d4b9665a70186e56bc))
* **ui:** Implemented the NGX-540 approved-bundle execution orchestration core (revalidation safety gate + per-target outcome/receipt model) with TDD, all five verification gates green. ([a1587ce](https://github.com/calvinnwq/artshelf/commit/a1587ce350c12bceb05cc79800edd62bb94e2d32))
* **ui:** Implemented the real NGX-540 dispose-backed approval-bundle executor with an independent post-execute live-state verification loop, TDD'd with 9 focused tests, all five verification gates green. ([4ef4f1b](https://github.com/calvinnwq/artshelf/commit/4ef4f1bd585583c2053ad7bca4fb9ce19bea82b6))
* **ui:** Made the agent's pre-execution approval-bundle safety gate purge-aware (NGX-541 AC5+AC7): a one-way-door "trash-purge" bundle is now accepted and each still-trashed candidate is revalidated against its live trash facts via the shared digest, with vanished/already-purged/drifted candidates skipped_stale instead of causing broad failure. ([9852573](https://github.com/calvinnwq/artshelf/commit/9852573ef2b739acf77ab7242c0f5ef615ef43d4))
* **ui:** Made the NGX-535 dashboard and NGX-536 detail-drawer domain cores reachable as read-only `artshelf ui dashboard` and `artshelf ui detail` CLI subcommands (surfacing the NGX-537 needs-context badge through both), with 10 focused e2e tests and all five verification gates green. ([89c6730](https://github.com/calvinnwq/artshelf/commit/89c67300e1dcfdcabdd9fb738668477c556b1ad5))
* **ui:** Wired the NGX-539 approval-workbench renderer into the loopback server via a read-only GET /bundle/&lt;id&gt; route backed by a new buildApprovalWorkbenchView projection, realizing AC4 against persisted immutable snapshots, with 4 TDD tests and all five verification gates green. ([296995e](https://github.com/calvinnwq/artshelf/commit/296995eb77a0a39f995393f70de4e351be3d4c82))


### Bug Fixes

* **ui:** avoid localhost-wide auth cookie ([9373d16](https://github.com/calvinnwq/artshelf/commit/9373d163c68e350c66e27b7efb5458ace5b2a458))
* **ui:** bind approval execution events ([5c41fe2](https://github.com/calvinnwq/artshelf/commit/5c41fe2b532ca689b790e3edcced59b16577642f))
* **ui:** bind approval execution to dispose plan entries ([a0be99c](https://github.com/calvinnwq/artshelf/commit/a0be99c5764bb2851678f57ef2b546e4a0d24fb7))
* **ui:** bind approval submissions to stored bundles ([ec44b9d](https://github.com/calvinnwq/artshelf/commit/ec44b9d1a5340b0b1125507dded88eb78ae41c45))
* **ui:** claim approval execution events ([a9dedf1](https://github.com/calvinnwq/artshelf/commit/a9dedf1a13511f1345c92ef5adf0e5e3c4db1a9f))
* **ui:** harden approval bundle execution gates ([286e414](https://github.com/calvinnwq/artshelf/commit/286e414d023880f9826161be2555939e9a9b5724))
* **ui:** harden approval replay validation ([4476ca0](https://github.com/calvinnwq/artshelf/commit/4476ca03b95e07b2df730472499b95b72f7079f3))
* **ui:** harden browser review surface ([f981d40](https://github.com/calvinnwq/artshelf/commit/f981d40cbdcd308a410fe06cf97081170df2fd41))
* **ui:** harden browser triage intent targets ([5b480e7](https://github.com/calvinnwq/artshelf/commit/5b480e7c1c391e03b7ab2a03cec2d913e06b8ec1))
* **ui:** honor ledger scope in browser server ([534b1a5](https://github.com/calvinnwq/artshelf/commit/534b1a575e995e4022ae3757fe4dac51503a3b4e))
* **ui:** tighten session reply contract ([42d0f7c](https://github.com/calvinnwq/artshelf/commit/42d0f7cbb43a638516346d069ac10017f8de2577))

## [0.16.0](https://github.com/calvinnwq/artshelf/compare/v0.15.0...v0.16.0) (2026-06-24)


### Features

* **dispose:** add approval-gated artifact disposition ([ee2406e](https://github.com/calvinnwq/artshelf/commit/ee2406e1850f6f2775d5d581bb529fac295b5159))
* **dispose:** add disposition dry-run domain layer ([c7bdbb3](https://github.com/calvinnwq/artshelf/commit/c7bdbb3d8a40ffc3c9c14c7da6eb6acfedb42859))
* **dispose:** add disposition execute domain layer ([b9fda32](https://github.com/calvinnwq/artshelf/commit/b9fda3254576d99e5c222a6d1a04c25b1a08d8b0))
* **dispose:** wire disposition CLI command ([7fe7921](https://github.com/calvinnwq/artshelf/commit/7fe792123b2d4a05bef37d360ced573b82dcd322))

## [0.15.0](https://github.com/calvinnwq/artshelf/compare/v0.14.0...v0.15.0) (2026-06-20)


### Features

* **inspect:** add read-only Artshelf review cards ([08478a8](https://github.com/calvinnwq/artshelf/commit/08478a871f624b048173a986511cc57cf2a2e609))
* **inspect:** add read-only inspect decision model ([334ea7d](https://github.com/calvinnwq/artshelf/commit/334ea7de99326ed0b0c3129228beaa0d33f378b9))
* **inspect:** wire get inspect output modes ([4a7270d](https://github.com/calvinnwq/artshelf/commit/4a7270df29f1895efe9032b2cfb7a2c1d47e971f))

## [0.14.0](https://github.com/calvinnwq/artshelf/compare/v0.13.1...v0.14.0) (2026-06-19)


### Features

* **commands:** add approval-gated registry pruning ([beaaca8](https://github.com/calvinnwq/artshelf/commit/beaaca84b6d0c62e66f4438ecf9323f482fcdba4))
* **ledgers:** Implemented the approval-gated `artshelf ledgers prune --dry-run` registry-prune planning slice of NGX-481 — new domain module, command wiring with human/JSON/agent output carrying the exact approval target, help text, and 12 focused tests — with all verification gates passing. ([6d2de1f](https://github.com/calvinnwq/artshelf/commit/6d2de1fe2390785aa9e0ffa2b009e318e350e06e))
* **ledgers:** Implemented the approval-gated `artshelf ledgers prune --execute --plan-id` slice of NGX-481 — plan-id-bound registry mutation with a pre-mutation rollback copy, post-mutation receipt with verification, and stale/duplicate/mismatch refusals — with 10 new tests and all five verification gates passing. ([11e03db](https://github.com/calvinnwq/artshelf/commit/11e03dbde7c5e4e933f241548bd8f88d316ae5a4))
* **ledgers:** Wired doctor, status --all, and review --all to point users at the approval-gated `artshelf ledgers prune --dry-run` flow when the registry has stale (missing-file) registrations, completing the last NGX-481 scope bullet with 4 focused tests and all five verification gates passing. ([66cd791](https://github.com/calvinnwq/artshelf/commit/66cd791dae2a6f5b60ab506a4f4e2be8358369d6))

## [0.13.1](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.13.0...artshelf-v0.13.1) (2026-06-15)


### Bug Fixes

* **cleanup:** make cleanup --execute resumable after interruption ([d0188f7](https://github.com/calvinnwq/artshelf/commit/d0188f73a62b1ff2d173e26c61c826a67bbc9542))
* **cleanup:** make cleanup execution resumable ([7ec0ebe](https://github.com/calvinnwq/artshelf/commit/7ec0ebe113f589ccd00ed0fdd1a54034afc242ec))

## [0.13.0](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.12.0...artshelf-v0.13.0) (2026-06-15)


### Features

* **review:** integrate reconcile findings into agent review packets ([878785e](https://github.com/calvinnwq/artshelf/commit/878785e72c4e65bd8e09572525b05cc020d2f1e1))
* **review:** integrate reconcile findings into agent triage; move put registry-warning to stderr (NGX-438, NGX-429) ([2573470](https://github.com/calvinnwq/artshelf/commit/25734701b439f617a33609ac98c3fae895199640))


### Bug Fixes

* **review:** include reconcile counts in all-ledger triage ([2eeb2fe](https://github.com/calvinnwq/artshelf/commit/2eeb2fea6eae58bfd652be959f2bb6e28d7cb90f))
* **review:** keep reconcile approval schema and blocked triage consistent ([0c8925a](https://github.com/calvinnwq/artshelf/commit/0c8925a851023622796f2b8d847fcc89cab3c5f0))

## [0.12.0](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.11.0...artshelf-v0.12.0) (2026-06-15)


### Features

* **ledger:** add path-provenance foundation for NGX-436 ([f0bf797](https://github.com/calvinnwq/artshelf/commit/f0bf797223e5032e326842cc1dd8fcb47130ed3e))
* **ledger:** add provenance validation distinguishing legacy from malformed rows (NGX-436) ([ce5128a](https://github.com/calvinnwq/artshelf/commit/ce5128a85bcc6353f73c3b47bd9a433918236ee0))
* **reconcile:** add path-provenance foundation and approval-gated reconcile command ([ad4bcec](https://github.com/calvinnwq/artshelf/commit/ad4bcec7839e004a0f7ca3cc9a8ecebb0caaac0f))
* **reconcile:** add read-only classification engine for NGX-437 ([3245738](https://github.com/calvinnwq/artshelf/commit/3245738c8d7b3e3dfd95c49fae414596b35c22e1))
* **reconcile:** add reconcile dry-run plan layer for NGX-437 ([ddc8881](https://github.com/calvinnwq/artshelf/commit/ddc8881713d26f1e43575b3097e49558c22cc2e7))
* **reconcile:** add reconcile execute layer with audit trail and stale-state refusals (NGX-437) ([50a12d4](https://github.com/calvinnwq/artshelf/commit/50a12d49cdf0552b675bfaa75a0220c886bd64e5))
* **reconcile:** wire reconcile CLI command with integration tests (NGX-437) ([0ea033b](https://github.com/calvinnwq/artshelf/commit/0ea033b73e96910de87a832e5ada835bc603ff12))

## [0.11.0](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.10.2...artshelf-v0.11.0) (2026-06-14)


### Features

* **ledger:** add cross-process advisory file lock and unique temp paths for atomic writes (NGX-428) ([0f553e4](https://github.com/calvinnwq/artshelf/commit/0f553e485737cf96390d451f4ae92f52e1abbf2a))


### Bug Fixes

* **cleanup:** reject unsafe plan-ids and mismatched plans before filesystem mutation (NGX-426) ([79debb7](https://github.com/calvinnwq/artshelf/commit/79debb7c3610984a969adea7f93b27ca08150647))
* **ledger:** make ledger writes atomic and concurrency-safe and reject unsafe cleanup plans ([ac98c4e](https://github.com/calvinnwq/artshelf/commit/ac98c4eaf917b695e166f2ca7c40b6759d6e5f53))

## [0.10.2](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.10.1...artshelf-v0.10.2) (2026-06-13)


### Code Refactoring

* **cli:** extract command dispatch and shared modules from the monolithic
  entrypoint ([c198c19](https://github.com/calvinnwq/artshelf/commit/c198c194693e756dd02b2525e2f6abbee5741d59))
* **cli:** separate status, doctor, review, and JSON renderers from command
  orchestration ([4ec76b0](https://github.com/calvinnwq/artshelf/commit/4ec76b0b0e4f45562d0e98a1237602bc5d41ca67))
* **cli:** extract update environment, package, path, and process adapter seams
  ([4ec76b0](https://github.com/calvinnwq/artshelf/commit/4ec76b0b0e4f45562d0e98a1237602bc5d41ca67))
* **cli:** restore real per-command modules, add the validate command module,
  and strengthen architecture guardrails
  ([a617ba3](https://github.com/calvinnwq/artshelf/commit/a617ba36e7de7d8a5725d1ba47eb3419ae3c6329))
* **cli:** move help rendering out of the entrypoint and into shared help text
  ([8e2698b](https://github.com/calvinnwq/artshelf/commit/8e2698bce1b47073d434113cbe1e8cfb32ec34e2))

## [0.10.1](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.10.0...artshelf-v0.10.1) (2026-06-12)


### Bug Fixes

* **cli:** shorten no-update cache TTL for update checks ([d41e49e](https://github.com/calvinnwq/artshelf/commit/d41e49e7d5da02dfaa86fb70eaa7d5e7fb3d543e))
* **cli:** split update-check cache TTL so new releases surface sooner ([5afcfaa](https://github.com/calvinnwq/artshelf/commit/5afcfaafac4941b71f6a84c694139a64774a1d59))

## [0.10.0](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.9.0...artshelf-v0.10.0) (2026-06-12)


### Features

* **cli:** add --agent decision-packet render mode for review, status, and doctor ([4d2dee0](https://github.com/calvinnwq/artshelf/commit/4d2dee099569803b887ae49438b0747d1330ec5d))
* **cli:** add --agent render mode and implement status --agent ([36f8e78](https://github.com/calvinnwq/artshelf/commit/36f8e7839d535fcabddadfc616ba518a9b444114))
* **cli:** add ✓/⚠ attention glyphs to human renders of status/doctor/review ([6f6cbe8](https://github.com/calvinnwq/artshelf/commit/6f6cbe85d54886cfd137791863e1b3554ca908f0))
* **cli:** implement artshelf doctor --agent compact decision packet ([d9abd4e](https://github.com/calvinnwq/artshelf/commit/d9abd4e75a7f4b2898eeacc3b3404221f4456bd4))
* **cli:** implement artshelf review --agent compact decision packet ([6f5476c](https://github.com/calvinnwq/artshelf/commit/6f5476ca987de3190f7a8760c6bb9c1efa8b9fce))


### Bug Fixes

* **cli:** preserve ledger scope in agent next actions ([a583683](https://github.com/calvinnwq/artshelf/commit/a583683064cdd16dd929766dc01f23fc31fa50e7))

## [0.9.0](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.8.0...artshelf-v0.9.0) (2026-06-11)


### Features

* **cli:** rewrite help with grouped commands, focused per-command help, and short flags ([7310638](https://github.com/calvinnwq/artshelf/commit/73106385ce3e3d037921cdb4ff534614d024244f))
* **cli:** rewrite top-level help with grouped commands, focused per-command help, and subcommand routing ([c8dea22](https://github.com/calvinnwq/artshelf/commit/c8dea2255628915eb629c5cc4cbc2ef1ec31c3a7))


### Bug Fixes

* **cli:** advertise short help flag ([825c4ae](https://github.com/calvinnwq/artshelf/commit/825c4ae38aa61209f22c702a82f51b93c5ea3d09))
* **cli:** advertise short version flag ([23ca99b](https://github.com/calvinnwq/artshelf/commit/23ca99b0ba7c596a8df89ec3c0384286c55d2a96))
* **cli:** polish nested help output ([109255d](https://github.com/calvinnwq/artshelf/commit/109255dfa3baa50c6aae837190adb19cfa7249b8))
* **cli:** support ledgers help subcommand ([18723ce](https://github.com/calvinnwq/artshelf/commit/18723ce384fbdeed33fe066ad0093093d30dc5a5))
* **cli:** support short help flag ([081b50f](https://github.com/calvinnwq/artshelf/commit/081b50f67a5e0821341aca4f98ab3244ab316338))

## [0.8.0](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.7.0...artshelf-v0.8.0) (2026-06-11)


### Features

* **cli:** add update command ([#35](https://github.com/calvinnwq/artshelf/issues/35)) ([c55f689](https://github.com/calvinnwq/artshelf/commit/c55f689d1a58a10430d1ea00a1dea5de408e5ac2))

## [0.7.0](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.6.0...artshelf-v0.7.0) (2026-06-10)


### Features

* **docs:** adopt Ledger redesign for docs site ([#32](https://github.com/calvinnwq/artshelf/issues/32)) ([155aaab](https://github.com/calvinnwq/artshelf/commit/155aaab8c44d1e1a2f373cd47e704dde301fc308))

## [0.6.0](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.5.0...artshelf-v0.6.0) (2026-06-07)


### Features

* **artshelf:** add public review report assets ([6bc89ae](https://github.com/calvinnwq/artshelf/commit/6bc89ae78150bbb161a387f844f32c7ac23f30da))


### Bug Fixes

* **docs:** constrain review approval targets ([eccc16d](https://github.com/calvinnwq/artshelf/commit/eccc16d019f1245a9ab052db51137654a2c3363b))

## [0.5.0](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.4.1...artshelf-v0.5.0) (2026-06-05)


### Features

* default storage to .artshelf paths ([95ef94e](https://github.com/calvinnwq/artshelf/commit/95ef94edef5862c45e5526a27c4adf0bf40306ca))
* default storage to .artshelf paths ([0da2cda](https://github.com/calvinnwq/artshelf/commit/0da2cda19ff56f78f203840ed71c2379f533750b))

## [0.4.1](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.4.0...artshelf-v0.4.1) (2026-06-05)


### Bug Fixes

* read CLI version from package metadata ([dafffe9](https://github.com/calvinnwq/artshelf/commit/dafffe9c6d1f1d4aba0062ae64b15f8a919b5b62))
* read CLI version from package metadata ([72dcc9d](https://github.com/calvinnwq/artshelf/commit/72dcc9d03d34f3c688a05a1d767931d82587d88a))

## [0.4.0](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.3.0...artshelf-v0.4.0) (2026-06-05)


### Features

* **cli:** add approval-first trash list and purge workflow ([20405db](https://github.com/calvinnwq/artshelf/commit/20405db8a7856440afe6aaf487cc156e6c66245d))
* **cli:** add approval-first trash list and purge workflow ([5a389f3](https://github.com/calvinnwq/artshelf/commit/5a389f3e4f18c75973f29dc727969063e3b3f54b))
* **cli:** add ledger registry review ([0cbdcc6](https://github.com/calvinnwq/artshelf/commit/0cbdcc6c1c1706b78e84a738fd8dfef900459045))
* **cli:** add ledger registry review ([d070131](https://github.com/calvinnwq/artshelf/commit/d0701317514f36ee266ca06c30b4ee67a6e45e42))
* **cli:** add read-only `shelf doctor` health command ([0ce18ea](https://github.com/calvinnwq/artshelf/commit/0ce18ea560ae7f870ea68b7248d097f4c7033b91))
* **cli:** add read-only `shelf status` dashboard command ([699035c](https://github.com/calvinnwq/artshelf/commit/699035c97009cb29caa0c995025a2d74533e21f1))
* **cli:** add shelf doctor and status commands ([c0f9a10](https://github.com/calvinnwq/artshelf/commit/c0f9a109cee58de7d7e8cf27e3860fee62941686))
* **cli:** add shelf lookup commands ([9092ea7](https://github.com/calvinnwq/artshelf/commit/9092ea72695b6b383a8ff3b74ccaabc2974e67fb))
* **cli:** improve shelf review triage and ledger listing ([6dc3c65](https://github.com/calvinnwq/artshelf/commit/6dc3c65e6837e542510d53890f1f49d3a28e0878))
* **cli:** optimize cleanup plan lifecycle ([f78773c](https://github.com/calvinnwq/artshelf/commit/f78773ca737b9d7a8318725d63590c9ed8184ba5))
* **cli:** resolve shelf records ([f21318d](https://github.com/calvinnwq/artshelf/commit/f21318d6edd16a170fcb6539c40899ec8b83c1ba))
* **cli:** summarize all-ledger review triage ([3284bd8](https://github.com/calvinnwq/artshelf/commit/3284bd886998777bd06a681ab3bfe0b819938c84))
* **cli:** validate registered ledgers in ledgers list ([327e4f8](https://github.com/calvinnwq/artshelf/commit/327e4f815c814c6b540fcbae8b42dbd8873fb4ab))
* optimize cleanup plan lifecycle ([4d77b2b](https://github.com/calvinnwq/artshelf/commit/4d77b2bed4a7bc963d2e9900a4dbbf3fed672514))
* rename Shelf package and CLI to Artshelf ([127649d](https://github.com/calvinnwq/artshelf/commit/127649d3689493700a4ef68922b6a837a2d53fc2))
* rename shelf to artshelf ([e7d250c](https://github.com/calvinnwq/artshelf/commit/e7d250cee56c27494bae224fe294387497fa8713))
* resolve shelf records ([dcd5109](https://github.com/calvinnwq/artshelf/commit/dcd5109c5a73f5080d89db51f375b9a5e307c65b))
* update ledger state after cleanup ([#7](https://github.com/calvinnwq/artshelf/issues/7)) ([31add84](https://github.com/calvinnwq/artshelf/commit/31add8466f0e37e397cfaf3dc146bd8060f57717))


### Bug Fixes

* build artshelf before packing ([470ea86](https://github.com/calvinnwq/artshelf/commit/470ea8637be29978e686f66b2bf1bb838a8a4fa8))
* clarify approval-only cleanup safety model ([20b8258](https://github.com/calvinnwq/artshelf/commit/20b82584e86a0a8f9b4067d2fbdc94d2c8064253))
* **cli:** align cleanup preview reuse ([b918a5d](https://github.com/calvinnwq/artshelf/commit/b918a5dc09536a9b87964fbf552b66ea16c0c62a))
* **cli:** harden registry diagnostics ([098f88e](https://github.com/calvinnwq/artshelf/commit/098f88e9ec8167333cb4d8f67876054b1076f922))
* **cli:** keep shelf review read-only ([8c417c2](https://github.com/calvinnwq/artshelf/commit/8c417c2e5737ee778c6f7a86b0c7e559d3cae7dc))
* **cli:** normalize review no-plan output ([57a6275](https://github.com/calvinnwq/artshelf/commit/57a6275b5960385102e8e4c54cfa498404df562d))
* **cli:** report stale ledgers in all-mode reads ([bc035ef](https://github.com/calvinnwq/artshelf/commit/bc035efbc15ba7877634cb7ec6c0702416d8510b))
* harden artshelf rename migration ([a84957c](https://github.com/calvinnwq/artshelf/commit/a84957c186f442d9067d07ec132fda4201cbc59e))
* **trash:** harden purge execution guardrails ([e569b1b](https://github.com/calvinnwq/artshelf/commit/e569b1be4a4f931f856fa9683afcb14023724ad9))

## [0.3.0](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.2.0...artshelf-v0.3.0) (2026-06-05)


### Features

* **cli:** add approval-first trash list and purge workflow ([20405db](https://github.com/calvinnwq/artshelf/commit/20405db8a7856440afe6aaf487cc156e6c66245d))
* **cli:** add approval-first trash list and purge workflow ([5a389f3](https://github.com/calvinnwq/artshelf/commit/5a389f3e4f18c75973f29dc727969063e3b3f54b))


### Bug Fixes

* **trash:** harden purge execution guardrails ([e569b1b](https://github.com/calvinnwq/artshelf/commit/e569b1be4a4f931f856fa9683afcb14023724ad9))

## [0.2.0](https://github.com/calvinnwq/artshelf/compare/artshelf-v0.1.0...artshelf-v0.2.0) (2026-06-04)


### Features

* **cli:** add ledger registry review ([0cbdcc6](https://github.com/calvinnwq/artshelf/commit/0cbdcc6c1c1706b78e84a738fd8dfef900459045))
* **cli:** add ledger registry review ([d070131](https://github.com/calvinnwq/artshelf/commit/d0701317514f36ee266ca06c30b4ee67a6e45e42))
* **cli:** add read-only `artshelf doctor` health command ([0ce18ea](https://github.com/calvinnwq/artshelf/commit/0ce18ea560ae7f870ea68b7248d097f4c7033b91))
* **cli:** add read-only `artshelf status` dashboard command ([699035c](https://github.com/calvinnwq/artshelf/commit/699035c97009cb29caa0c995025a2d74533e21f1))
* **cli:** add artshelf doctor and status commands ([c0f9a10](https://github.com/calvinnwq/artshelf/commit/c0f9a109cee58de7d7e8cf27e3860fee62941686))
* **cli:** add artshelf lookup commands ([9092ea7](https://github.com/calvinnwq/artshelf/commit/9092ea72695b6b383a8ff3b74ccaabc2974e67fb))
* **cli:** improve artshelf review triage and ledger listing ([6dc3c65](https://github.com/calvinnwq/artshelf/commit/6dc3c65e6837e542510d53890f1f49d3a28e0878))
* **cli:** optimize cleanup plan lifecycle ([f78773c](https://github.com/calvinnwq/artshelf/commit/f78773ca737b9d7a8318725d63590c9ed8184ba5))
* **cli:** resolve artshelf records ([f21318d](https://github.com/calvinnwq/artshelf/commit/f21318d6edd16a170fcb6539c40899ec8b83c1ba))
* **cli:** summarize all-ledger review triage ([3284bd8](https://github.com/calvinnwq/artshelf/commit/3284bd886998777bd06a681ab3bfe0b819938c84))
* **cli:** validate registered ledgers in ledgers list ([327e4f8](https://github.com/calvinnwq/artshelf/commit/327e4f815c814c6b540fcbae8b42dbd8873fb4ab))
* optimize cleanup plan lifecycle ([4d77b2b](https://github.com/calvinnwq/artshelf/commit/4d77b2bed4a7bc963d2e9900a4dbbf3fed672514))
* resolve artshelf records ([dcd5109](https://github.com/calvinnwq/artshelf/commit/dcd5109c5a73f5080d89db51f375b9a5e307c65b))
* update ledger state after cleanup ([#7](https://github.com/calvinnwq/artshelf/issues/7)) ([31add84](https://github.com/calvinnwq/artshelf/commit/31add8466f0e37e397cfaf3dc146bd8060f57717))


### Bug Fixes

* clarify approval-only cleanup safety model ([20b8258](https://github.com/calvinnwq/artshelf/commit/20b82584e86a0a8f9b4067d2fbdc94d2c8064253))
* **cli:** align cleanup preview reuse ([b918a5d](https://github.com/calvinnwq/artshelf/commit/b918a5dc09536a9b87964fbf552b66ea16c0c62a))
* **cli:** harden registry diagnostics ([098f88e](https://github.com/calvinnwq/artshelf/commit/098f88e9ec8167333cb4d8f67876054b1076f922))
* **cli:** keep artshelf review read-only ([8c417c2](https://github.com/calvinnwq/artshelf/commit/8c417c2e5737ee778c6f7a86b0c7e559d3cae7dc))
* **cli:** normalize review no-plan output ([57a6275](https://github.com/calvinnwq/artshelf/commit/57a6275b5960385102e8e4c54cfa498404df562d))
* **cli:** report stale ledgers in all-mode reads ([bc035ef](https://github.com/calvinnwq/artshelf/commit/bc035efbc15ba7877634cb7ec6c0702416d8510b))

## 0.1.0 - 2026-06-01

- Initial Artshelf CLI MVP.
- Added JSONL ledger writes, `put`, `list`, `due`, `validate`, cleanup dry-run
  plans, plan-id-based cleanup execution, `list --status`, and manual `resolve`.
- Added Node test coverage and public-ready repository bootstrap.
- Added GitHub Pages docs, source-install instructions, packaged agent skill,
  and scheduled-review guidance for agents.
