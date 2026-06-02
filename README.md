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
shelf doctor
```

To remove the linked command later:

```bash
npm unlink -g shelf
```

## Quickstart

Record a scratch directory for three days:

```bash
shelf put tmp/run-output --reason "debug parser output" --ttl 3d --kind scratch
```

Check the ledger:

```bash
shelf list
shelf status
```

Review cleanup before anything moves:

```bash
shelf due
shelf cleanup --dry-run
```

Because this example keeps the artifact for three days, an immediate dry-run
reports `not-created` and writes no plan. Execute only after `due` shows cleanup
entries and a dry-run returns a real plan id.

Execute only from a reviewed plan id:

```bash
shelf cleanup --execute --plan-id plan_20260601_120000_ab12
```

## Explicit Ledgers

By default, Shelf writes repo-local `.shelf/ledger.jsonl` inside a git repo and
`~/.shelf/ledger.jsonl` outside one. Use `--ledger <path>` and an isolated
`--registry <path>` for tests, demos, and unusual workflows:

```bash
shelf put /tmp/parser-output --reason "parser fixture" --ttl 1d --ledger /tmp/shelf-ledger.jsonl --registry /tmp/shelf-registry.json --json
shelf list --ledger /tmp/shelf-ledger.jsonl
```

Shelf also keeps a small global registry of known ledgers at
`~/.shelf/ledgers.json`. Override it with `--registry <path>` or
`SHELF_REGISTRY`. `put` registers its ledger automatically, and you can register
an existing ledger explicitly:

```bash
shelf ledgers list
shelf ledgers add --ledger /path/to/repo/.shelf/ledger.jsonl --name my-repo
```

Use `--all` for one read-only discovery entry point across registered ledgers:

```bash
shelf review --all --json
shelf status --all --json
shelf due --all --json
shelf find --all --owner <agent-or-runtime> --json
```

Use global dry-run cleanup when you want Shelf to write cleanup plans for
registered ledgers with cleanup entries, without moving files:

```bash
shelf cleanup --dry-run --all --json
```

Global execution is intentionally refused. To mutate files, review a dry-run
plan, then execute it against the specific ledger that produced it.
Repeated dry-runs with the same executable cleanup entries reuse the existing
plan id and refresh its timestamp instead of creating duplicate plan files.

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

Dry-run cleanup writes a plan only when there are executable cleanup entries.
No-op dry-runs report `not-created` and avoid writing plan files. When Shelf does
write a plan, it also records that plan in the ledger as a Shelf-owned artifact.

After `cleanup --execute`, Shelf writes a receipt, records the receipt as a
Shelf-owned artifact, and updates touched ledger records. Handled records stop
appearing in `due` and future dry-run cleanup plans, while `shelf list` still
keeps the audit trail visible.

## Commands

```bash
shelf put <path> --reason "debug parser output" --ttl 3d --kind scratch
shelf ledgers list
shelf ledgers add --ledger <path>
shelf list
shelf list --all
shelf list --status active
shelf find --path <path> --owner <agent-or-runtime> --label <task-or-run-id>
shelf find --all --owner <agent-or-runtime>
shelf get <id>
shelf get <id> --all
shelf due
shelf due --all
shelf validate
shelf validate --all
shelf review
shelf review --all
shelf doctor
shelf status
shelf status --all
shelf cleanup --dry-run
shelf cleanup --dry-run --all
shelf cleanup --execute --plan-id <id>
shelf resolve <id> --status resolved --reason "inspected and no longer needed"
```

Use `shelf help` or `shelf help <command>` for command details. All core
commands support `--json`.

See the [docs site](https://calvinnwq.github.io/shelf/) for install,
quickstart, agent usage, and CLI reference. The source repo also keeps the
[v1 spec](SPEC.md) and [agent usage guide](docs/agent-usage.md).

## Agent Skill

The package includes an agent-facing skill at `skills/shelf/SKILL.md`. Agents
that support local skills can copy or reference this file to learn when to call
`shelf put`, how to report Shelf ids in handoffs and issue comments, why
`shelf find` / `shelf get` are the read-only idempotency lookup surface, why
`cleanup --execute` requires explicit approval for a reviewed plan id, and when
`shelf resolve <id> --status resolved --reason <text>` may mark confirmed
handled, missing, or no-longer-needed records without moving or deleting files.

From a source checkout, use `skills/shelf/SKILL.md` directly. Agents should ask
where the user wants Shelf cloned before installing or linking it. Package-manager
distribution for agent skills can come later.

## Development

```bash
pnpm install
pnpm check
```

Preview the static docs site locally:

```bash
pnpm docs:serve
```

Then open <http://127.0.0.1:8080/>.

During tests or one-off runs, pass both `--ledger <path>` and `--registry <path>`
to keep entries and registry updates out of default Shelf storage.

## Contributing

Shelf is small on purpose. Keep new behavior ledger-first, previewable, and
covered by tests. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Support And Security

Use GitHub issues for bugs and feature ideas once the public remote exists. See
[SUPPORT.md](SUPPORT.md) and [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
