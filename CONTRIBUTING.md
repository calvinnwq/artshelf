# Contributing

Artshelf is intentionally small. Contributions should keep it boring, predictable,
and safe around file cleanup.

## Local Setup

```bash
pnpm install
pnpm check
```

Use both `--ledger <path>` and `--registry <path>` in examples and tests so you
do not write to your default repo-local/user-global ledger or registry by
accident.

## Pull Requests

- Keep changes scoped.
- Add or update tests for CLI behavior.
- Preserve the cleanup and trash purge execution contracts: no daemon, no
  auto-execute, no global execute, and no fresh-plan-then-execute shortcut.
- Do not add broad filesystem scanning or silent physical deletion behavior in
  v1; `cleanup=delete` stays refused, and trash purge must stay ledger-scoped,
  plan-reviewed, and receipted.
- Update README or SPEC when user-facing behavior changes.

## Release Process

Release Please owns release PRs and changelog updates after the GitHub remote is
created. Use conventional commit messages so release notes stay useful.
