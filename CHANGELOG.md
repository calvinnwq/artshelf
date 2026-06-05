# Changelog

## Unreleased

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
