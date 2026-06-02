# Changelog

## Unreleased

- Added a user-level ledger registry plus `--all` review commands so Shelf can
  discover known project/user ledgers from one CLI entry point.
- Added read-only `find` and `get` commands for ledger lookup and idempotent
  agent integrations.
- Documented `find` / `get` as the lookup surface agents should use before
  creating duplicate records with `put`.
- Tightened portable agent trigger guidance and removed setup-specific docs so
  Shelf remains workflow-agnostic.
- Added `pnpm docs:serve` for local static docs preview.
- Changed cleanup dry-run to avoid writing plan files when there are no
  executable cleanup entries, and registered Shelf-created plans/receipts as
  Shelf-owned ledger artifacts.
- Reuse unchanged cleanup dry-run plans by refreshing the existing plan timestamp
  and Shelf-owned plan record instead of creating duplicate plan files.
- Added a read-only `shelf doctor` command that reports CLI and runtime version,
  the default ledger and registry paths, registered-ledger health (stale or
  invalid entries), and the cleanup safety posture, exiting non-zero when the
  registry or a registered ledger is broken.
- Added a read-only `shelf status` dashboard (single `--ledger` and `--all`)
  reporting registry health plus per-ledger and aggregated active, kept, due,
  manual-review, missing-path, and pending-cleanup counts, with `--all --json`
  suited to cron and human output short enough to paste into a chat.

## 0.1.0 - 2026-06-01

- Initial Shelf CLI MVP.
- Added JSONL ledger writes, `put`, `list`, `due`, `validate`, cleanup dry-run
  plans, plan-id-based cleanup execution, `list --status`, and manual `resolve`.
- Added Node test coverage and public-ready repository bootstrap.
- Added GitHub Pages docs, source-install instructions, packaged agent skill,
  and scheduled-review guidance for agents.
