# Artshelf Architecture

This file is the source of truth for Artshelf's TypeScript CLI structure. Read
it before changing CLI routing, command behavior, output rendering, storage,
update checks, or cleanup safety rules.

Artshelf is intentionally small. The CLI refactor moved command behavior,
update/config/output boundaries, and shared contracts out of the executable
entrypoint without changing public command behavior. The closeout stance is
conservative but explicit: `src/commands/index.ts` dispatches to real
per-command modules, and each `src/commands/<command>.ts` file owns that command
or command-family implementation code.

## Current Boundary

`src/cli.ts` is the executable entrypoint. It parses argv, handles top-level
help/version dispatch through shared help helpers, calls the command boundary,
maps top-level errors, and sets the process exit code. New command behavior must
not be added to `src/cli.ts`.

Allowed in `src/cli.ts`:

- process entrypoint and exit handling
- argument parsing and top-level help/version dispatch
- calls to shared help routing/rendering helpers
- process stdout/stderr calls at the outer edge

Avoid adding to `src/cli.ts`:

- new command behavior
- ledger or registry business rules
- help text renderers or command summary registries
- adapters for npm, filesystem, network, clock, or process state
- long helper clusters that belong to a command, renderer, adapter, config, or
  domain module

## Current Source Tree

```text
src/
  cli.ts              executable entrypoint, parser, help/version dispatch, exit mapping
  commands/index.ts   command dispatch boundary
  commands/*.ts      one real module per user-visible command/family
  commands/shared.ts shared command helpers for registry validation and common output
  ledger.ts           ledger domain rules, cleanup planning/execution, validation
  registry.ts         ledger registry domain and persistence helpers
  registry-prune.ts   registry-prune classification plus approval-gated prune plan and execute layers
  provenance.ts       reconcile-safe path provenance capture for new records
  reconcile.ts        path-drift classification plus reconcile dry-run plan and execute layers
  locks.ts            cross-process advisory file lock shared by ledger/registry writes
  time.ts             retention time parsing and clock helpers
  types.ts            ledger and cleanup domain contracts
  adapters/           npm/process/update infrastructure edges
  renderers/          human, --json, and --agent output formatting helpers
  config/             env, package metadata, defaults, and path normalization
  shared/             small cross-cutting CLI types, errors, flags, and help routing/text
```

There is no `src/core/` folder in the current Artshelf tree. The root domain files
(`ledger.ts`, `registry.ts`, `provenance.ts`, `reconcile.ts`, `locks.ts`, `time.ts`, and `types.ts`) are
the existing core/domain modules for this closeout. A future issue may move them under `src/core/`,
but NGX-410 should not perform that broad domain reshuffle.

### `commands/`

`commands/index.ts` is the dispatch boundary. It maps parsed command names to
real command modules and does not own command-specific handlers. Command modules
translate parsed CLI input into domain calls and renderer calls. They own
command-specific option validation and orchestration, but not durable ledger
rules or reusable output formatting details.

Public commands currently routed through real command modules:

- `put`
- `list`
- `find`
- `get`
- `resolve`
- `due`
- `validate`
- `review`
- `cleanup`
- `reconcile`
- `trash`
- `ledgers`
- `doctor`
- `status`
- `update`

Each public command has a discoverable module named after the CLI surface:
`put.ts`, `list.ts`, `find.ts`, `get.ts`, `resolve.ts`, `due.ts`, `validate.ts`,
`review.ts`, `cleanup.ts`, `reconcile.ts`, `trash.ts`, `ledgers.ts`, `doctor.ts`,
`status.ts`, and `update.ts`. Marker modules that merely export a command name are refused;
these files must contain real command-family implementation code.

### Domain files

Root domain files hold deterministic Artshelf behavior. They should be callable
from tests without spawning the CLI and without relying on process-global state
except where legacy behavior already requires it.

Current domain ownership:

- `ledger.ts`: ledger record lifecycle and validation, due classification,
  cleanup and trash plan/receipt rules
- `registry.ts`: registry-backed all-ledger reads and registrations
- `registry-prune.ts`: read-only registry-prune classification (missing/duplicate
  registrations), the approval-gated dry-run plan layer that writes a reviewed
  registry-prune plan without mutating the registry, and the plan-id-bound execute
  layer that re-checks the live registry, copies a rollback snapshot before removing
  the missing registrations, and writes a receipt with the verification result
- `provenance.ts`: reconcile-safe path provenance capture for new records
- `reconcile.ts`: path-drift classification plus reconcile dry-run plan and execute layers
- `locks.ts`: cross-process advisory file lock (re-entrant within a process) used by
  ledger and registry writes so concurrent mutations stay atomic and durable
- `time.ts`: TTL/date parsing and current-time normalization
- `types.ts`: ledger, cleanup, trash, provenance, reconcile, and registry-adjacent
  domain contracts

### `adapters/`

Adapters isolate real-world edges. Code here may touch npm, process spawning,
update-check cache files, environment-derived update configuration, time, or the
network. Domain code should receive adapter results as explicit inputs when new
code is added.

Current adapters:

- `adapters/process.ts`: process spawning for `artshelf update`
- `adapters/update.ts`: npm latest-version lookup, update-cache reads/writes,
  update TTL policy application

### `renderers/`

Renderers format already-built reports. They should not discover ledger state,
read or write ledgers, or decide cleanup safety. Keep renderers deterministic and
easy to snapshot or assert against.

Render modes:

- human output: compact terminal text for people
- `--json`: full machine/audit payloads
- `--agent`: terse decision packets for agents

### `config/`

Config modules normalize env vars, package metadata, defaults, and paths. They
keep compatibility behavior clear, especially for `ARTSHELF_*` env vars,
repo-local storage, user-global storage, update TTLs, and npm registry URLs.

### `shared/`

Shared modules are for small, boring pieces used by multiple layers: typed CLI
contracts, error formatting, flag definitions, flag accessors, and shared help
routing/text. Do not hide feature logic here.

## Import Direction

Keep dependencies moving inward:

```text
cli -> commands -> domain files
cli -> commands -> renderers
cli -> commands -> adapters/config/shared
commands -> adapters/config/renderers/shared
ledger/registry/time/types -> shared or narrower domain helpers
renderers -> shared and type-only domain imports
adapters -> config/shared
config -> shared
```

Rules:

- `src/cli.ts` may import `commands/`, `config/`, and `shared/`; it must not
  import `ledger.ts`, `registry.ts`, `adapters/`, or `renderers/` directly.
- Domain files (`ledger.ts`, `registry.ts`, `locks.ts`, `time.ts`, `types.ts`)
  must not import `commands/`, `renderers/`, `adapters/`, or `cli.ts`.
- `renderers/` must not read or write ledgers, registries, or files. Runtime
  imports should stay renderer-local or shared; type-only domain imports are
  acceptable where they document report shapes.
- `commands/` may import domain files, adapters, config, renderers, and shared
  helpers.
- `adapters/` may import shared/config helpers, but should not import command
  modules, renderers, ledger, or registry domain modules.
- Avoid import cycles. If a cycle appears, move the shared type or helper into
  `shared/` or the narrower owning feature.

## Output And Safety Rules

Artshelf's public contract is safety-first:

- `--json` output must stay clean on stdout.
- update notices and non-blocking warnings go to stderr.
- `--agent` output should be compact, deterministic, and approval-target aware.
- cleanup execution stays approval-only and plan-id bound.
- `cleanup --execute --all` remains refused.
- reconcile is approval-gated ledger/registry housekeeping, not cleanup: it never
  creates, moves, or deletes files. Execution stays plan-id bound and scoped to one
  explicit `--ledger`; `reconcile --execute --all` is refused and `--all` is dry-run only.
- `review`, `status`, `doctor`, `due`, `validate`, `find`, `get`, and `list`
  remain read-only surfaces.
- `ARTSHELF_NO_UPDATE_CHECK`, `ARTSHELF_UPDATE_DRY_RUN`, update cache paths, and
  update TTL behavior must remain compatible.
- Do not introduce daemon, auto-execute, or fresh-plan-then-execute behavior.

## Closeout Guardrails

`tests/architecture-contract.test.ts` enforces the NGX-410 closeout guardrails:

- root `ARCHITECTURE.md` exists and names the current folder/file ownership
- root `AGENTS.md` points agents here before CLI work
- `CONTRIBUTING.md` links this contract for humans
- `src/cli.ts` stays within a thin-entrypoint line/function budget and does not
  import ledger/registry, adapters, or renderers directly
- the public command surface, including `validate`, is documented in this file,
  appears in `src/shared/help-text.ts` top-level help, and is dispatched by
  `src/commands/index.ts`
- help text routing/rendering stays in `src/shared/help-text.ts`, not in
  `src/cli.ts`
- every public command has a discoverable `src/commands/<command>.ts` module with
  a real exported handler; marker command modules are refused
- renderers, adapters, config, and shared modules cannot import across forbidden
  boundaries
- temporary migration comments and obsolete compatibility-shim text stay out of
  source files

Representative CLI smoke commands for this architecture contract:

```bash
node dist/src/cli.js --help
node dist/src/cli.js status --agent
node dist/src/cli.js doctor --agent
node dist/src/cli.js review --agent
node dist/src/cli.js validate --json
ARTSHELF_NO_UPDATE_CHECK=1 node dist/src/cli.js status --agent
ARTSHELF_UPDATE_DRY_RUN=1 node dist/src/cli.js update --json
```

The budget enforces `src/cli.ts` as a thin entrypoint. Do not raise it to fit new
command behavior or help rendering. Add real command modules, renderers,
adapters, config, shared contracts, shared help text, or focused domain helpers
in the folders above instead.
