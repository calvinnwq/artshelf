# Shelf

Shelf is a tiny CLI for putting temporary artifacts, backups, and run outputs
somewhere accountable, with an expiry tag and a cleanup plan.

It is built for agent-heavy workflows where files and directories are often
created in `tmp/`, repo folders, or backup locations and then forgotten. Shelf
records why an artifact exists at creation time, then makes later cleanup
visible and reviewable.

## Status

Shelf is an early v1 MVP. Version 0.1.0 is a GitHub/source-first release and is
not published to npm. The current focus is dogfooding the ledger, dry-run
cleanup plan, and agent usage contract from local installs.

## Install

Shelf is not published to npm. The supported installation path is local only:
clone the repo, build it, and link the CLI with `npm link`.

```bash
git clone https://github.com/calvinnwq/shelf.git
cd shelf
corepack enable
pnpm install --frozen-lockfile
pnpm run build
npm link
shelf --version
```

To remove the linked command later:

```bash
npm unlink -g shelf
```

For Calvin's OpenClaw setup, see the copy-paste guide in
[docs/openclaw-setup.md](docs/openclaw-setup.md).

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
marked `cleanup=review` become `review-required`, and physical `delete` is
refused as `cleanup-refused`.

After `cleanup --execute`, Shelf writes a receipt and updates touched ledger
records. Handled records stop appearing in `due` and future dry-run cleanup
plans, while `shelf list` still keeps the audit trail visible.

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

See the [docs site](https://calvinnwq.github.io/shelf/) for install,
quickstart, agent usage, and CLI reference. The source repo also keeps the
[v1 spec](SPEC.md), [agent usage guide](docs/agent-usage.md), and
[OpenClaw setup guide](docs/openclaw-setup.md).

## Agent Skill

The package includes an agent-facing skill at `skills/shelf/SKILL.md`. Agents
that support local skills can copy or reference this file to learn when to call
`shelf put`, how to report Shelf ids in handoffs and issue comments, and why
`cleanup --execute` requires explicit approval for a reviewed plan id.

From a source checkout, use `skills/shelf/SKILL.md` directly. Agents should ask
where the user wants Shelf cloned before installing or linking it. Package-manager
distribution for agent skills can come later.

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
