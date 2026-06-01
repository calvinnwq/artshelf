# Shelf

Shelf is a tiny CLI for putting temporary artifacts, backups, and run outputs
somewhere accountable, with an expiry tag and a cleanup plan.

It is built for agent-heavy workflows where files and directories are often
created in `tmp/`, repo folders, or backup locations and then forgotten. Shelf
records why an artifact exists at creation time, then makes later cleanup
visible and reviewable.

## Status

Shelf is an early v1 MVP. It is usable from source, but it is not published to
npm yet. The current focus is dogfooding the ledger, dry-run cleanup plan, and
agent usage contract before package publishing.

## Install

```bash
git clone https://github.com/calvinnwq/shelf.git
cd shelf
pnpm install
pnpm build
```

Run locally:

```bash
node dist/src/cli.js --version
```

When Shelf is published, the intended CLI name is `shelf`.

## Quickstart

Record a scratch directory for three days:

```bash
shelf put tmp/run-output --reason "debug parser output" --ttl 3d --kind scratch
```

List the ledger:

```bash
shelf list
```

Review cleanup before anything moves:

```bash
shelf due
shelf cleanup --dry-run
```

Execute only from a reviewed plan id:

```bash
shelf cleanup --execute --plan-id plan_20260601_120000_ab12
```

## Explicit Ledgers

By default, Shelf writes repo-local `.shelf/ledger.jsonl` inside a git repo and
`~/.shelf/ledger.jsonl` outside one. Use `--ledger <path>` for tests, demos, and
unusual workflows:

```bash
shelf put /tmp/parser-output --reason "parser fixture" --ttl 1d --ledger /tmp/shelf-ledger.jsonl --json
shelf list --ledger /tmp/shelf-ledger.jsonl
```

## Safety Model

- Ledger-first, not filesystem-scan-first.
- Dry-run before mutation.
- Execute only from a reviewed plan id.
- Trash/review by default, not delete.
- Agent-friendly JSON output from every command.
- Small enough to actually use.

V1 only moves `cleanup=trash` entries into Shelf's local trash folder. Entries
marked `cleanup=review` stay review-only, and physical `delete` is refused.

## Commands

```bash
shelf put <path> --reason "debug parser output" --ttl 3d --kind scratch
shelf list
shelf due
shelf validate
shelf cleanup --dry-run
shelf cleanup --execute --plan-id <id>
```

Use `shelf help` or `shelf help <command>` for command details. All core
commands support `--json`.

See [SPEC.md](SPEC.md) for the v1 contract and [docs/](docs/) for project docs.

## Development

```bash
pnpm install
pnpm check
```

During tests or one-off runs, pass `--ledger <path>` to keep entries out of the
default repo-local `.shelf/ledger.jsonl`.

## Contributing

Shelf is small on purpose. Keep new behavior ledger-first, previewable, and
covered by tests. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Support And Security

Use GitHub issues for bugs and feature ideas once the public remote exists. See
[SUPPORT.md](SUPPORT.md) and [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
