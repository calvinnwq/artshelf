<div align="center">

# 🗃️ Artshelf

**Accountable retention for the temporary files agents leave behind.**

[![npm version](https://img.shields.io/npm/v/artshelf.svg)](https://www.npmjs.com/package/artshelf) [![npm downloads](https://img.shields.io/npm/dm/artshelf.svg)](https://www.npmjs.com/package/artshelf) [![CI](https://github.com/calvinnwq/artshelf/actions/workflows/ci.yml/badge.svg)](https://github.com/calvinnwq/artshelf/actions/workflows/ci.yml) [![docs](https://img.shields.io/badge/docs-site-blue.svg)](https://calvinnwq.github.io/artshelf/) [![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE) [![X @calvinnwq](https://img.shields.io/badge/X-%40calvinnwq-black?logo=x)](https://x.com/calvinnwq)

[**Docs**](https://calvinnwq.github.io/artshelf/) · [Quickstart](#quickstart) · [Spec](SPEC.md) · [Agent setup](INSTALL.md)

</div>

Agents make a mess. Coding agents, workflow runners, and review bots scatter
debug dumps, backups, and run outputs across `tmp/` and your repo — then forget
them. The clutter piles up, and nobody remembers what's safe to delete.

Artshelf makes that mess accountable. Every artifact is logged with a reason, an
expiry, and a cleanup plan the moment it's created. Later you review the ledger,
preview a cleanup, and execute only an approved plan — approval-first, trash
before delete, `--json` everywhere. No daemon, no surprise deletions, no guessing
from a filesystem scan.

> **Status:** early v1 MVP, published to npm as the unscoped `artshelf` package.

## Quickstart

Install globally — all methods end with the same `artshelf` command (requires
Node.js 22+):

```bash
# npm
npm install -g artshelf

# pnpm
pnpm add -g artshelf

# verify
artshelf --version
artshelf doctor

# later, for npm installs
artshelf update
```

<details>
<summary>Install from source</summary>

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

`npm link` connects the checkout to your global npm bin, so later rebuilds update
the command. Remove an npm install with `npm uninstall -g artshelf`; a source
install with `npm unlink -g artshelf`.
</details>

Artshelf checks npm occasionally and prints a non-blocking notice to stderr when
a newer published version is available. Available-update results are cached for
24 hours by default; failed, missing, or no-update results are cached for 1 hour
so a newly published release is noticed sooner. Run `artshelf update` only for
npm global installs; it forces a fresh latest-version check before upgrading
with `npm install -g artshelf@latest`. pnpm global installs should update with
`pnpm add -g artshelf@latest`, and source installs still update by pulling,
rebuilding, and linking the checkout. Set `ARTSHELF_NO_UPDATE_CHECK=1` for
scheduled jobs that must avoid network and update-cache writes.

### Recommended agent setup

Artshelf is agent-operated, so let your agent finish the job. Paste this one line
into your coding agent:

```text
Follow the instructions in https://github.com/calvinnwq/artshelf/blob/main/INSTALL.md to set up Artshelf in this workspace.
```

It will install the CLI, copy the portable skill (with its bundled review-report
renderer), register any existing project ledgers, and — only with your approval —
schedule a **read-only** daily review. Scheduled jobs review and report only;
cleanup, dispose, and purge execution always come back to you. See [INSTALL.md](INSTALL.md)
for the full steps.

## How it works

The whole lifecycle is five steps, and every step that touches files is gated on
a reviewed plan a human approved:

| Step | What happens | Command |
|------|--------------|---------|
| **1. Register** | Record an artifact the moment it is created, while the reason is fresh. Returns an id. | `artshelf put <path> --reason "…" --ttl 3d --kind scratch --cleanup trash` |
| **2. Monitor** | Read-only checks across all known ledgers — moves nothing. | `artshelf status --all --json` · `artshelf due --all` |
| **3. Review** | Preview a cleanup plan. A real plan id appears only once entries are due. | `artshelf review --all` · `artshelf cleanup --dry-run` |
| **4. Clean** | Execute exactly the reviewed plan id, after approval. Trashes, never deletes. | `artshelf cleanup --execute --plan-id <id>` |
| **5. Purge** | Permanently remove old trashed artifacts via a *separate* reviewed plan. | `artshelf trash purge --older-than 30d --dry-run` → `--execute --plan-id <id>` |

Trash is the holding area between steps 4 and 5: cleanup quarantines artifacts
into Artshelf's local trash (`artshelf trash list`), and only a separately
reviewed purge removes them for good — a second approval boundary before
destructive deletion.

## Safety model

- **Ledger-first**, not filesystem-scan-first — every artifact is a recorded decision.
- **Dry-run before mutation**, and execute only from a reviewed plan id.
- **No daemon, no auto-execute, no global execute** — `--all` is read-only or
  dry-run reporting; cleanup, dispose, and purge refuse it.
- **No fresh-plan-then-execute shortcut** — review the plan, then run that plan.
- **Trash before delete** — `cleanup=delete` stays refused; physical deletion
  needs its own reviewed trash purge. No silent deletion, ever.
- **Durable, resumable cleanup** — execution writes a started receipt before
  moving files, can replay the same plan id after interruption, and ledger and
  registry mutations take a cross-process lock so overlapping commands never
  lose records or leave a half-written ledger.
- **`--json` on every command**, so agents can act on structured output.
- **`--agent` on `review`/`status`/`doctor`, `ledgers prune --dry-run`,
  `dispose --dry-run`, and `get --inspect`**, a compact, token-efficient decision packet for agents,
  while the default render stays human-scannable.

## Reference

<details>
<summary>All commands</summary>

```bash
artshelf put <path> --reason "debug parser output" --ttl 3d --kind scratch
artshelf ledgers list [--plain] [--json]
artshelf ledgers add --ledger <path> [--name <project>] [--scope repo|user|other] [--json]
artshelf ledgers prune --dry-run [--registry <path>] [--json|--agent]
artshelf ledgers prune --execute --plan-id <id> [--registry <path>] [--json]
artshelf list [--all] [--status active]
artshelf find --path <path> --owner <agent-or-runtime> --label <task-or-run-id>
artshelf find --all --owner <agent-or-runtime>
artshelf get <id> [--all]
artshelf get <id> --inspect [--ledger <path>] [--json|--agent]
artshelf get <id> --inspect --all [--registry <path>] [--json|--agent]
artshelf due [--all]
artshelf validate [--all]
artshelf review [--all]
artshelf status [--all]
artshelf doctor
artshelf update [--json]
artshelf cleanup --dry-run [--all]
artshelf cleanup --execute --plan-id <id> [--ledger <path>] [--json]
artshelf dispose --id <id> --action trash-resolve|resolve-only|snooze|keep --dry-run [--reason <text>] [--ttl <ttl>|--retain-until <date>] [--ledger <path>] [--json|--agent]
artshelf dispose --execute --plan-id <id> [--ledger <path>] [--json]
artshelf reconcile --dry-run [--all] [--ledger <path>] [--json]
artshelf reconcile --execute --plan-id <id> --ledger <path> [--json]
artshelf trash list [--all] [--ledger <path>] [--json]
artshelf trash purge --older-than <ttl> --dry-run [--ledger <path>] [--json]
artshelf trash purge --execute --plan-id <id> [--ledger <path>] [--json]
artshelf resolve <id> --status resolved --reason "inspected and no longer needed" [--ledger <path>] [--json]
```

Use `artshelf help` for a grouped command list, then `artshelf <command> --help`
or `artshelf help <command>` for focused details. Nested commands such as
`artshelf trash purge --help`, `artshelf ledgers add --help`, and
`artshelf ledgers prune --help` show only that subcommand. All core commands
support `--json`; `review`, `status`, `doctor`, `ledgers prune --dry-run`,
`dispose --dry-run`, and `get --inspect` also take `--agent` for a compact
decision packet; `--ledger`,
`--registry`, and `--all` are scope flags only on commands that list them.
</details>

<details>
<summary>Explicit ledgers and <code>--all</code> discovery</summary>

By default, Artshelf writes repo-local `.artshelf/ledger.jsonl` inside a git repo
and `~/.artshelf/ledger.jsonl` outside one. Use `--ledger <path>` and an isolated
`--registry <path>` for tests, demos, and unusual workflows:

```bash
artshelf put /tmp/parser-output --reason "parser fixture" --ttl 1d --ledger /tmp/artshelf-ledger.jsonl --registry /tmp/artshelf-registry.json --json
artshelf list --ledger /tmp/artshelf-ledger.jsonl
```

Artshelf keeps a small global registry of known ledgers at
`~/.artshelf/ledgers.json` (override with `--registry <path>` or
`ARTSHELF_REGISTRY`). `put` registers its ledger automatically; register an
existing one with `artshelf ledgers add --ledger <path> --name <project> --json`.
`artshelf ledgers list` validates each registered ledger by default (ok/missing/invalid
status with counts, non-zero exit when broken), so it doubles as a stale-entry
check; add `--plain` to skip validation. When registered ledger files are
missing, use `artshelf ledgers prune --dry-run --registry <path>` to write a
reviewed registry-prune plan, approve `approve artshelf ledgers prune registry
<registry-path> plan <plan-id>`, then execute that exact plan id; duplicate paths
are blocked for manual repair and are never pruned automatically.

Use `--all` for one read-only discovery entry point across registered ledgers
(`review`, `status`, `due`, `trash list`, `find`). `artshelf cleanup --dry-run --all`
writes plans for ledgers with executable entries without moving files. Global
execution is intentionally refused: to mutate files, review a dry-run plan, then
execute it against the specific ledger that produced it.
</details>

<details>
<summary>Agent skill</summary>

The package includes an agent-facing skill at `skills/artshelf`. Agents that
support local skills can copy or reference this directory to learn when to call
`artshelf put`, how to report deterministic footnotes after JSON registration,
why `artshelf find` / `artshelf get` are the read-only idempotency lookup surface,
why `cleanup --execute` and `dispose --execute` require approved reviewed plan ids, how to render
dry-run cleanup and trash purge plans as review-report decision packets, how to use
`dispose --agent` for per-record approval packets, and when
`artshelf resolve <id> --status resolved --reason <text>` may mark a record handled
without moving or deleting files.

The skill ships in the npm package alongside `scripts/render-review-report.mjs`,
`schemas/artshelf-review-report.schema.json`, and the canonical
`examples/artshelf-review-report.json` packet. Copy the whole `skills/artshelf`
directory so the renderer, schema, and examples travel together.
</details>

<details>
<summary>Development</summary>

```bash
pnpm install
pnpm check          # build + test
pnpm docs:serve     # preview docs at http://127.0.0.1:8080/
```

Release Please owns version bumps, changelog, tags, and releases. When a Release
Please PR merges, the release workflow validates with `pnpm check` and publishes
`artshelf` to npm through npm Trusted Publishing — no long-lived npm token in
GitHub secrets. During tests or one-off runs, pass both `--ledger <path>` and
`--registry <path>` to keep entries out of default Artshelf storage.
</details>

## Learn more

- **[Docs site](https://calvinnwq.github.io/artshelf/)** — install, quickstart, agent usage, and CLI reference.
- **[v1 spec](SPEC.md)** — the full behavioral contract.
- **[Agent usage guide](docs/agent-usage.md)** — deeper agent integration notes.

## Contributing

Artshelf is small on purpose. Keep new behavior ledger-first, previewable, and
covered by tests. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Support and security

Use [GitHub issues](https://github.com/calvinnwq/artshelf/issues) for bugs and
feature ideas. See [SUPPORT.md](SUPPORT.md) and [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
