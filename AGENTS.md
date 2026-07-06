# Agent Instructions

Before changing Artshelf CLI routing, command behavior, output rendering,
storage paths, update checks, UI review/session routing, or cleanup safety
rules, read [`ARCHITECTURE.md`](ARCHITECTURE.md).

Command behavior lives in `src/commands/`, with renderers, adapters, config, and
shared contracts in their sibling folders. Keep `src/cli.ts` a thin entrypoint and
do not add new command behavior to it.

Preserve these hard boundaries:

- `--json` stdout stays machine-clean
- update notices and non-blocking warnings go to stderr
- cleanup execution remains approval-only and plan-id bound
- `cleanup --execute --all` stays refused
- read-only commands stay read-only
- the UI browser only records human triage intents and approval bundles as
  session events; it never mutates ledgers, files, trash, or plans directly
- `ui dashboard`/`ui detail` stay read-only; served dashboard/detail views
  never preview file contents and only write token-bound session events
- `ui execute` is the only mutating `ui` subcommand and runs one approved
  bundle's exact targets; `ui execute --all` stays refused
- UI purge runs the same exact-target, approval-gated one-way door as the CLI:
  physical deletion with no recovery
