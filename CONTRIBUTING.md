# Contributing

Shelf is intentionally small. Contributions should keep it boring, predictable,
and safe around file cleanup.

## Local Setup

```bash
pnpm install
pnpm check
```

Use `--ledger <path>` in examples and tests so you do not write to your default
repo-local or user-global ledger by accident.

## Pull Requests

- Keep changes scoped.
- Add or update tests for CLI behavior.
- Keep cleanup behavior previewable and plan-id gated.
- Do not add background daemons, broad filesystem scanning, or silent deletion
  behavior in v1.
- Update README or SPEC when user-facing behavior changes.

## Release Process

Release Please owns release PRs and changelog updates after the GitHub remote is
created. Use conventional commit messages so release notes stay useful.
