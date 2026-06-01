# Shelf

Shelf is a tiny CLI for putting temporary artifacts, backups, and run outputs
somewhere accountable, with an expiry tag and a cleanup plan.

It is built for agent-heavy workflows where files and directories are often
created in `tmp/`, repo folders, or backup locations and then forgotten.

## V1 Shape

```bash
shelf put <path> --reason "debug parser output" --ttl 3d --kind scratch
shelf list
shelf due
shelf validate
shelf cleanup --dry-run
shelf cleanup --execute --plan-id <id>
```

Use `shelf help` or `shelf help <command>` for command details.

## Examples

Record a scratch directory for three days:

```bash
shelf put tmp/run-output --reason "debug parser output" --ttl 3d --kind scratch
```

Use an explicit ledger for tests, demos, and unusual workflows:

```bash
shelf put /tmp/parser-output --reason "parser fixture" --ttl 1d --ledger /tmp/shelf-ledger.jsonl --json
shelf list --ledger /tmp/shelf-ledger.jsonl
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

V1 only moves `cleanup=trash` entries into Shelf's local trash folder. Entries
marked `cleanup=review` stay review-only, and physical `delete` is refused.

## Product Posture

- Ledger-first, not filesystem-scan-first.
- Dry-run before mutation.
- Execute only from a reviewed plan id.
- Trash/review by default, not delete.
- Agent-friendly JSON output from every command.
- Small enough to actually use.

See [SPEC.md](SPEC.md) for the v1 contract.

## Development

```bash
pnpm install
pnpm check
```

During tests or one-off runs, pass `--ledger <path>` to keep entries out of the
default repo-local `.shelf/ledger.jsonl`.
