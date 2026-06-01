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

## Product Posture

- Ledger-first, not filesystem-scan-first.
- Dry-run before mutation.
- Execute only from a reviewed plan id.
- Trash/review by default, not delete.
- Agent-friendly JSON output from every command.
- Small enough to actually use.

See [SPEC.md](SPEC.md) for the v1 contract.
