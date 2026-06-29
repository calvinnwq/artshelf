# Contributing

Artshelf is intentionally small. Contributions should keep it boring, predictable,
and safe around file cleanup.

For CLI structure and ownership boundaries, read [ARCHITECTURE.md](ARCHITECTURE.md)
before changing routing, command behavior, renderers, config, adapters, UI
review/session routing, or cleanup safety rules.

Command behavior routes through real `src/commands/<command>.ts` modules, with
`src/commands/index.ts` limited to dispatch. New command files must own real
command-family implementation code; do not add marker modules that only export a
command name.

## Local Setup

```bash
pnpm install
pnpm check
```

Use both `--ledger <path>` and `--registry <path>` in examples and tests so you
do not write to your default repo-local/user-global ledger or registry by
accident. Set `ARTSHELF_NO_UPDATE_CHECK=1` when a test or example must avoid
npm network checks and update-cache writes.

## Pull Requests

- Keep changes scoped.
- Add or update tests for CLI behavior.
- Preserve the cleanup, dispose, and trash purge execution contracts: no daemon,
  no auto-execute, no global execute, and no fresh-plan-then-execute shortcut.
- Do not add broad filesystem scanning or silent physical deletion behavior in
  v1; `cleanup=delete` stays refused, and trash purge must stay ledger-scoped,
  plan-reviewed, and receipted.
- Update README or SPEC when user-facing behavior changes.

## Release Process

Release Please owns release PRs and changelog updates for the [Artshelf GitHub
repository](https://github.com/calvinnwq/artshelf). Use conventional commit
messages so release notes stay useful.
