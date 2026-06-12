# Artshelf Architecture

This file is the source of truth for Artshelf's TypeScript CLI structure. Read
it before changing CLI routing, command behavior, output rendering, storage, or
update-check logic.

Artshelf is intentionally small. `src/cli.ts` once did too much: argument parsing,
command routing, command behavior, output rendering, update checks, and process
I/O. The refactor slices below moved that ownership into dedicated folders without
changing command behavior, leaving the entrypoint thin.

## Current Boundary

`src/cli.ts` is the executable entrypoint and command registry glue. Command
implementations, output helpers, update adapters, and shared CLI contracts live
outside the entrypoint. New command behavior must not be added to `src/cli.ts`.

Allowed in `src/cli.ts`:

- process entrypoint and exit handling
- argument parsing and help dispatch
- command registry wiring
- process stdout/stderr calls at the outer edge

Avoid adding to `src/cli.ts`:

- new command behavior
- ledger or registry business rules
- large renderers
- adapters for npm, filesystem, network, clock, or process state
- long helper clusters that belong to a command or feature

## Target Shape

Use these folders when moving code. Create only the folders needed for the slice
in front of you; do not perform a broad reshuffle in one change.

```text
src/
  cli.ts              executable entrypoint and command registry
  commands/           one module per user-visible command or command family
  core/               ledger, retention, cleanup, review, status domain logic
  adapters/           filesystem, npm registry, clock, process, and OS edges
  renderers/          human, --json, and --agent output formatting
  config/             path, env, defaults, and option normalization
  shared/             small cross-cutting types, errors, and utilities
```

### `commands/`

Command modules translate parsed CLI input into core calls and renderer calls.
They own command-specific option validation and orchestration, but not ledger
rules or output formatting details.

The folder has a module per command family, with dispatch and shared command
logic in `commands/index.ts`:

- `commands/put.ts`
- `commands/list.ts`
- `commands/find.ts`
- `commands/get.ts`
- `commands/resolve.ts`
- `commands/due.ts`
- `commands/review.ts`
- `commands/cleanup.ts`
- `commands/trash.ts`
- `commands/ledgers.ts`
- `commands/doctor.ts`
- `commands/status.ts`
- `commands/update.ts`

### `core/`

Core modules hold deterministic Artshelf behavior. They should be callable from
tests without spawning the CLI and without relying on process-global state.

Good candidates:

- ledger record lifecycle and validation
- registry-backed all-ledger reads
- due/review classification
- cleanup plan and receipt rules
- trash listing and purge planning
- doctor/status report construction
- update-check cache policy decisions

### `adapters/`

Adapters isolate real-world edges. Code here may touch the filesystem, npm,
environment, time, process state, or the network. Core code should receive
adapter results as explicit inputs.

Good candidates:

- filesystem reads/writes
- npm latest-version lookup
- current time
- homedir/path resolution
- process spawning for `artshelf update`

### `renderers/`

Renderers format already-built reports. They should not discover ledger state or
decide cleanup safety. Keep renderers deterministic and easy to snapshot or
assert against.

Render modes:

- human output: compact terminal text for people
- `--json`: full machine/audit payloads
- `--agent`: terse decision packets for agents

### `config/`

Config modules normalize env vars, defaults, and paths. They should keep
compatibility behavior clear, especially for `ARTSHELF_*` env vars and
repo-local versus user-global storage paths.

### `shared/`

Shared modules are for small, boring pieces used by multiple layers: typed
errors, result helpers, version comparison, and tiny string/path utilities. Do
not hide feature logic here.

## Import Direction

Keep dependencies moving inward:

```text
cli -> commands -> core
cli -> commands -> renderers
commands -> adapters
core -> shared
renderers -> shared
config -> shared
```

Rules:

- `core/` must not import `commands/`, `renderers/`, or `cli.ts`.
- `renderers/` must not read or write ledgers, registries, or files.
- `commands/` may import core, adapters, config, renderers, and shared helpers.
- `adapters/` may import shared/config helpers, but should not own domain rules.
- `cli.ts` may import commands/config/shared, but should stay thin.
- Avoid import cycles. If a cycle appears, move the shared type or helper into
  `shared/` or the narrower owning feature.

## Output And Safety Rules

Artshelf's public contract is safety-first:

- `--json` output must stay clean on stdout.
- update notices and non-blocking warnings go to stderr.
- `--agent` output should be compact, deterministic, and approval-target aware.
- cleanup execution stays approval-only and plan-id bound.
- `cleanup --execute --all` remains refused.
- `review`, `status`, `doctor`, `due`, `validate`, `find`, `get`, and `list`
  remain read-only surfaces.
- Do not introduce daemon, auto-execute, or fresh-plan-then-execute behavior.

## Migration Order

Use these issues as the intended order. Each slice should leave the repo valid
and preserve existing behavior. Shelves 17 through 20 established the current
folder split; future work should extend the split rather than moving behavior
back into the entrypoint.

1. `NGX-406` / Shelf-16: create this architecture contract, link it from agent
   and contributor docs, and add the structural guardrail.
2. `NGX-407` / Shelf-17: create a thin command module pattern and move one
   low-risk command family first.
3. Shelf-18: extract renderers for human, JSON, and agent output where the shape
   is already stable.
4. Shelf-19: extract adapters/config around update checks, paths, env vars, and
   process edges.
5. Shelf-20: reduce `src/cli.ts` to entrypoint, parser, registry, and
   compatibility glue.

Do not move command behavior in NGX-406. This document is the contract that
makes the later moves boring.

## Structural Guardrail

`tests/architecture-contract.test.ts` enforces the first guardrail:

- root `ARCHITECTURE.md` exists and names the intended folder ownership
- root `AGENTS.md` points agents here before CLI work
- `CONTRIBUTING.md` links this contract
- `src/cli.ts` stays within the temporary line/function budget

The budget now enforces `src/cli.ts` as a thin entrypoint. Do not raise it to fit
new command behavior. Add command modules, renderers, adapters, config, or shared
contracts in the folders above instead.
