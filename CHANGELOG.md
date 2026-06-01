# Changelog

## Unreleased

- Added read-only `find` and `get` commands for ledger lookup and idempotent
  agent integrations.
- Documented `find` / `get` as the lookup surface agents should use before
  creating duplicate records with `put`.

## 0.1.0 - 2026-06-01

- Initial Shelf CLI MVP.
- Added JSONL ledger writes, `put`, `list`, `due`, `validate`, cleanup dry-run
  plans, plan-id-based cleanup execution, `list --status`, and manual `resolve`.
- Added Node test coverage and public-ready repository bootstrap.
- Added GitHub Pages docs, source-install instructions, packaged agent skill,
  OpenClaw local setup guide, and scheduled-review guidance for agents.
