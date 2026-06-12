# Agent Instructions

Before changing Artshelf CLI routing, command behavior, output rendering,
storage paths, update checks, or cleanup safety rules, read
[`ARCHITECTURE.md`](ARCHITECTURE.md).

Command behavior lives in `src/commands/`, with renderers, adapters, config, and
shared contracts in their sibling folders. Keep `src/cli.ts` a thin entrypoint and
do not add new command behavior to it.

Preserve these hard boundaries:

- `--json` stdout stays machine-clean
- update notices and non-blocking warnings go to stderr
- cleanup execution remains approval-only and plan-id bound
- `cleanup --execute --all` stays refused
- read-only commands stay read-only
