# Agent Instructions

Before changing Artshelf CLI routing, command behavior, output rendering,
storage paths, update checks, or cleanup safety rules, read
[`ARCHITECTURE.md`](ARCHITECTURE.md).

For NGX-406, keep the work doc/guardrail first. Do not move command behavior out
of `src/cli.ts` until the follow-up implementation slice.

Preserve these hard boundaries:

- `--json` stdout stays machine-clean
- update notices and non-blocking warnings go to stderr
- cleanup execution remains approval-only and plan-id bound
- `cleanup --execute --all` stays refused
- read-only commands stay read-only
