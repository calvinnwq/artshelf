# Artshelf

Artshelf is a tiny CLI for putting temporary artifacts, backups, and run outputs
somewhere accountable, with an expiry tag and a cleanup plan.

It is built for agent-heavy workflows where files and directories are often
created in `tmp/`, repo folders, or backup locations and then forgotten. Artshelf
records why an artifact exists at creation time, then makes later cleanup
visible and reviewable.

Artshelf centers on four approval-first workflows: **register a temp artifact** the
moment it is created, **review everything safely** before anything moves,
**approve cleanup safely** from a reviewed plan, and **purge old trash
explicitly** from a separate reviewed plan. The reference sections further down
stay out of the way until you need them.

## Status

Artshelf is an early v1 MVP. The CLI is being prepared for npm distribution
under the unscoped `artshelf` package name. The existing local/source install
path remains supported as a fallback while npm publishing is wired up.

## Install

Use the npm package once it is published:

```bash
npm install -g artshelf
artshelf --version
artshelf doctor
```

With pnpm:

```bash
pnpm add -g artshelf
artshelf --version
artshelf doctor
```

Source install remains the fallback path: clone the repo, build it, and link the
CLI with `npm link`.

```bash
git clone https://github.com/calvinnwq/artshelf.git
cd artshelf
corepack enable
pnpm install --frozen-lockfile
pnpm run build
npm link
artshelf --version
artshelf doctor
```

To remove the linked command later:

```bash
npm uninstall -g artshelf
npm unlink -g artshelf
```

## Core Workflows

Artshelf is built around four approval-first workflows. Start here; the reference
sections below are there when you need them, not before.

### 1. Register a temp artifact

Record an artifact the moment it is created, while the reason is still fresh:

```bash
artshelf put tmp/run-output --reason "debug parser output" --ttl 3d --kind scratch --cleanup trash
```

Artshelf returns an id. Capture it anywhere future cleanup context matters.

### 2. Review everything safely

Inspect the ledger and preview cleanup without moving anything:

```bash
artshelf list
artshelf status
artshelf due
artshelf cleanup --dry-run
```

Because this example keeps the artifact for three days, an immediate dry-run
reports `not-created` and writes no plan. A dry-run returns a real plan id only
after `due` shows cleanup entries.

### 3. Approve cleanup safely

Execute only from a reviewed plan id, and only after a human approves it:

```bash
artshelf cleanup --execute --plan-id plan_20260601_120000_ab12
```

There is no auto-execute, no global execute, and no fresh-plan-then-execute
shortcut. Execution writes a receipt and updates the touched ledger records.

### 4. Purge old trash explicitly

Cleanup execution with `cleanup=trash` moves artifacts into Artshelf's local trash
folder. Those trashed records remain discoverable (`artshelf trash list`) for review
and should only be physically removed through a separately reviewed trash purge
plan:

```bash
artshelf trash purge --older-than 30d --dry-run --json
artshelf trash purge --execute --plan-id purge_20260601_120000_ab12
```

This adds a separate approval boundary between quarantine and destructive deletion.

## Explicit Ledgers

By default, Artshelf writes repo-local `.shelf/ledger.jsonl` inside a git repo and
`~/.shelf/ledger.jsonl` outside one. Use `--ledger <path>` and an isolated
`--registry <path>` for tests, demos, and unusual workflows:

```bash
artshelf put /tmp/parser-output --reason "parser fixture" --ttl 1d --ledger /tmp/artshelf-ledger.jsonl --registry /tmp/artshelf-registry.json --json
artshelf list --ledger /tmp/artshelf-ledger.jsonl
```

Artshelf also keeps a small global registry of known ledgers at
`~/.shelf/ledgers.json`. Override it with `--registry <path>` or
`ARTSHELF_REGISTRY`. `put` registers its ledger automatically, and you can register
an existing ledger explicitly:

```bash
artshelf ledgers list
artshelf ledgers add --ledger /path/to/repo/.shelf/ledger.jsonl --name my-repo
```

`artshelf ledgers list` validates each registered ledger by default — reporting
ok/missing/invalid status with entry counts, and exiting non-zero when the
registry or any ledger is broken — so it doubles as a stale-entry check. Add
`--plain` for the fast listing that skips validation.

Use `--all` for one read-only discovery entry point across registered ledgers:

```bash
artshelf review --all --json
artshelf status --all --json
artshelf due --all --json
artshelf trash list --all --json
artshelf find --all --owner <agent-or-runtime> --json
```

`artshelf review --all` adds an aggregate triage summary (affected ledgers, due,
manual-review, missing-path, executable, and skipped counts plus preview plan
ids) and states the next safe action, while staying read-only.

Use global dry-run cleanup when you want Artshelf to write cleanup plans for
registered ledgers with cleanup entries, without moving files:

```bash
artshelf cleanup --dry-run --all --json
```

Global execution is intentionally refused. To mutate files, review a dry-run
plan, then execute it against the specific ledger that produced it.
Repeated dry-runs with the same executable cleanup entries reuse the existing
plan id and refresh its timestamp instead of creating duplicate plan files.

## Safety Model

- Ledger-first, not filesystem-scan-first.
- Dry-run before mutation.
- Execute only from a reviewed plan id.
- No daemon or auto-execute path.
- No global execute; cleanup execute and trash purge refuse `--all`.
  `--all` is read-only or dry-run reporting only.
- No fresh-plan-then-execute shortcut.
- Trash/review by default, not delete.
- No silent deletion; `cleanup=delete` stays refused, and trash purge needs its own reviewed plan.
- Agent-friendly JSON output from every command.
- Small enough to actually use.

V1 only moves `cleanup=trash` entries into Artshelf's local trash folder. Entries
marked `cleanup=review` become `review-required`, and `cleanup=delete` is
refused as `cleanup-refused`; physical deletion only happens through a separate
reviewed `artshelf trash purge --execute` plan.

Dry-run cleanup writes a plan only when there are executable cleanup entries.
No-op dry-runs report `not-created` and avoid writing plan files. When Artshelf does
write a plan, it also records that plan in the ledger as an Artshelf-owned artifact.

After `cleanup --execute`, Artshelf writes a receipt, records the receipt as a
Artshelf-owned artifact, and updates touched ledger records. Handled records stop
appearing in `due` and future dry-run cleanup plans, while `artshelf list` still
keeps the audit trail visible.

## Commands

```bash
artshelf put <path> --reason "debug parser output" --ttl 3d --kind scratch
artshelf ledgers list
artshelf ledgers list --plain
artshelf ledgers add --ledger <path>
artshelf list
artshelf list --all
artshelf list --status active
artshelf find --path <path> --owner <agent-or-runtime> --label <task-or-run-id>
artshelf find --all --owner <agent-or-runtime>
artshelf get <id>
artshelf get <id> --all
artshelf due
artshelf due --all
artshelf validate
artshelf validate --all
artshelf review
artshelf review --all
artshelf doctor
artshelf status
artshelf status --all
artshelf cleanup --dry-run
artshelf cleanup --dry-run --all
artshelf cleanup --execute --plan-id <id>
artshelf trash list [--all] [--ledger <path>] [--json]
artshelf trash purge --older-than <ttl> --dry-run [--ledger <path>] [--json]
artshelf trash purge --execute --plan-id <id> [--ledger <path>] [--json]
artshelf resolve <id> --status resolved --reason "inspected and no longer needed"
```

Use `artshelf help` or `artshelf help <command>` for command details. All core
commands support `--json`.

See the [docs site](https://calvinnwq.github.io/artshelf/) for install,
quickstart, agent usage, and CLI reference. The source repo also keeps the
[v1 spec](SPEC.md) and [agent usage guide](docs/agent-usage.md).

## Agent Skill

The package includes an agent-facing skill at `skills/artshelf/SKILL.md`. Agents
that support local skills can copy or reference this file to learn when to call
`artshelf put`, how to report Artshelf ids in handoffs and issue comments, why
`artshelf find` / `artshelf get` are the read-only idempotency lookup surface, why
`cleanup --execute` requires explicit approval for a reviewed plan id, how to
review trashed records with `artshelf trash list` before a separately approved trash
purge, and when `artshelf resolve <id> --status resolved --reason <text>` may mark
confirmed handled, missing, or no-longer-needed records without moving or
deleting files.

From a source checkout, use `skills/artshelf/SKILL.md` directly. Agents should ask
where the user wants Artshelf cloned before installing or linking it. Package-manager
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
to keep entries and registry updates out of default Artshelf storage.

## Contributing

Artshelf is small on purpose. Keep new behavior ledger-first, previewable, and
covered by tests. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Support And Security

Use GitHub issues for bugs and feature ideas once the public remote exists. See
[SUPPORT.md](SUPPORT.md) and [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
