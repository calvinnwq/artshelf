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
  dashboard.ts        read-only multi-ledger UI dashboard aggregation
  artifact-detail.ts  read-only single-record UI detail drawer
  provenance.ts       reconcile-safe path provenance capture for new records
  reconcile.ts        path-drift classification plus reconcile dry-run plan and execute layers
  dispose.ts          disposition classification plus approval-gated dispose dry-run plan and execute layers
  session.ts          Artshelf UI review session storage: metadata, capability token, event log, approval snapshots
  ui-server.ts        loopback browser server for dashboard/detail/bundle pages and handoff capture
  ui-execute.ts       agent-side approved-bundle execution: revalidate -> execute -> verify loop plus per-target receipts
  locks.ts            cross-process advisory file lock shared by ledger/registry writes
  time.ts             retention time parsing and clock helpers
  types.ts            ledger, cleanup, disposal, reconcile, registry, and UI contracts
  adapters/           npm/process/update infrastructure edges
  renderers/          human, --json, --agent, and browser HTML output helpers
  config/             env, package metadata, defaults, and path normalization
  shared/             small cross-cutting CLI types, errors, flags, and help routing/text
```

There is no `src/core/` folder in the current Artshelf tree. The root domain files
(`ledger.ts`, `registry.ts`, `provenance.ts`, `reconcile.ts`, `dispose.ts`, `dashboard.ts`, `artifact-detail.ts`, `session.ts`, `locks.ts`, `time.ts`, and `types.ts`) are
the existing core/domain modules for this closeout. `ui-server.ts` is a root support module for the
browser review surface and token-bound intent/approval capture. A future issue may move these under `src/core/`,
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
- `dispose`
- `reconcile`
- `trash`
- `ui`
- `ledgers`
- `doctor`
- `status`
- `update`

Each public command has a discoverable module named after the CLI surface:
`put.ts`, `list.ts`, `find.ts`, `get.ts`, `resolve.ts`, `due.ts`, `validate.ts`,
`review.ts`, `cleanup.ts`, `dispose.ts`, `reconcile.ts`, `trash.ts`, `ui.ts`,
`ledgers.ts`, `doctor.ts`, `status.ts`, and `update.ts`. Marker modules that merely export a command name are refused;
these files must contain real command-family implementation code.

The `ui` command family (`artshelf ui`, `ui dashboard`, `ui detail`, `ui serve`,
`ui poll`, `ui reply`, `ui bundle`, `ui execute`, `ui end`) is the agent-mediated AXI surface over
`session.ts` plus the read-only review data surface over `dashboard.ts`,
`artifact-detail.ts`, and `ui-server.ts`: it starts or resumes durable review
sessions, serves token-protected loopback dashboard/detail/bundle pages, returns
compact `--json` review and bundle snapshots, and runs the poll/reply/execute/end agent
loop. The browser captures human triage intents and approval bundles but never
mutates ledgers, files, trash, or plans directly - the agent executes an approved
bundle through `ui execute` (the one mutating `ui` subcommand), which revalidates
live state, requires exact target and reviewed dispose-plan entry matches, runs the
existing approval-gated paths for exact targets only, verifies live state after, and
replies per-target receipts.

### Domain files

Root domain and support files hold deterministic Artshelf behavior or focused local runtime
surfaces. They should be callable from tests without spawning the CLI and without relying on
process-global state except where legacy behavior already requires it.

Current root ownership:

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
- `dispose.ts`: disposition classification (trash-resolve/resolve-only/snooze/keep) plus the
  approval-gated dry-run plan layer that writes a reviewed dispose plan and the plan-id-bound
  execute layer that re-snapshots the live subject, refuses drift/target conflicts, moves the
  subject to plan-scoped trash for trash-resolve, and writes a receipt with verification (NGX-483)
- `dashboard.ts`: read-only multi-ledger UI dashboard aggregation (NGX-535/NGX-537) over
  registered ledgers, trash, purge candidates, registry/reconcile problems, recent receipts, and
  needs-context classification, plus the read-only approval-workbench view projection (NGX-539) that
  groups a persisted approval bundle's candidate rows by owning ledger. It must not mutate ledgers,
  registries, plans, or artifacts, and it must not preview file contents
- `artifact-detail.ts`: read-only single-record UI detail drawer (NGX-536/NGX-537) composing the
  inspect decision card, provenance, audit trail, last action, and needs-context badge without
  file content previews
- `inspect.ts`: deterministic inspect report builder for `get --inspect` (NGX-482)
- `session.ts`: durable Artshelf UI review session storage (NGX-531) - session metadata, the
  browser capability token, the append-only event log (events plus agent replies), immutable
  fingerprinted approval snapshots, and legacy active-session backfill for registry/repo scope
  metadata. This is the v1 handoff layer where the browser
  captures exact-target triage intents and approval bundles while the agent executes existing approval-gated paths, so
  it never runs a mutating workflow itself. User-level by default (`~/.artshelf/ui`); repo-scoped
  optionally
- `ui-server.ts`: token-protected loopback HTTP server for dashboard/detail browser pages, the
  approval-bundle workbench page (NGX-539 `GET /bundle/<id>`), human triage intent
  capture, and approval-bundle submission. It accepts safe browser reads, recomputes live state
  per request, appends exact-target intents through the token-bound `/intents` endpoint, records
  revised approval selections through token-bound `/approve`, refuses every other mutating method,
  and never embeds file contents or scripts
- `ui-execute.ts`: agent-side approved-bundle execution (NGX-540) - the one mutating UI path. It
  loads the immutable reviewed snapshot, re-reads live ledger/registry/trash state, revalidates the
  bundle (refusing whole-bundle drift, skipping per-target drift as `skipped_stale`), executes only
  exact valid targets through the existing approval-gated `dispose.ts` plan-id paths, binds those
  targets to the reviewed dispose-plan entry digest so missing or unreadable reviewed plans, subject
  content drift, or same-id plan rewrites cannot change reason, subject, target, or retention
  semantics after approval, verifies live state after each command instead of trusting the command
  exit, resumes matching `in_progress` approval-event claims, and records one of four per-target outcomes
  (`executed`/`skipped_stale`/`failed`/`needs_manual_review`) plus receipts back to the session by
  advancing the bundle's `approval_bundle_submitted` event
- `locks.ts`: cross-process advisory file lock (re-entrant within a process) used by
  ledger and registry writes so concurrent mutations stay atomic and durable
- `time.ts`: TTL/date parsing and current-time normalization
- `types.ts`: ledger, cleanup, trash, provenance, reconcile, dispose, UI session/event/approval,
  UI bundle execution outcome/receipt, and registry-adjacent domain contracts

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
- `--json`: full machine/audit payloads and compact UI packets
- `--agent`: terse decision packets for agents
- browser HTML: script-free dashboard/detail/bundle pages and token-bound intent/approval forms generated from read-only snapshots

### `config/`

Config modules normalize env vars, package metadata, defaults, and paths. They
keep compatibility behavior clear, especially for `ARTSHELF_*` env vars, repo-local storage, user-global storage, UI session storage, trusted UI URLs, update TTLs, and npm registry URLs.

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
commands -> ui-server
ui-server -> domain files/renderers/session
ledger/registry/time/types -> shared or narrower domain helpers
renderers -> shared and type-only domain imports
adapters -> config/shared
config -> shared
```

Rules:

- `src/cli.ts` may import `commands/`, `config/`, and `shared/`; it must not
  import `ledger.ts`, `registry.ts`, `adapters/`, or `renderers/` directly.
- Domain files (`ledger.ts`, `registry.ts`, `locks.ts`, `time.ts`, `types.ts`)
  must not import `commands/`, `renderers/`, `adapters/`, `ui-server.ts`, or `cli.ts`.
- `renderers/` must not read or write ledgers, registries, or files. Runtime
  imports should stay renderer-local or shared; type-only domain imports are
  acceptable where they document report shapes.
- `commands/` may import domain files, adapters, config, renderers, `ui-server.ts`, and shared
  helpers.
- `ui-server.ts` may import domain files, renderers, and session helpers, but it must not import
  command modules, adapters, or `cli.ts`.
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
- dispose execution stays approval-only, plan-id bound, scoped to one reviewed
  record, and physically delete-free.
- `cleanup --execute --all`, `dispose --all`, and `ui execute --all` remain refused.
- reconcile is approval-gated ledger/registry housekeeping, not cleanup: it never
  creates, moves, or deletes files. Execution stays plan-id bound and scoped to one
  explicit `--ledger`; `reconcile --execute --all` is refused and `--all` is dry-run only.
- registry prune (`ledgers prune`) is the approval-gated path for removing
  registrations whose ledger files are missing/stale: dry-run writes a reviewed plan,
  execute is plan-id bound to one registry path with a pre-mutation rollback copy and a
  receipt. `doctor`, `status --all`, and `review --all` point users at this flow (never
  a manual registry edit) when stale registrations are detected; invalid-but-present
  ledgers still route to a manual re-register/fix.
- `review`, `status`, `doctor`, `due`, `validate`, `find`, `get`, `list`,
  `ui dashboard`, and `ui detail` remain read-only surfaces.
- `ui` is non-mutating except for `ui execute`: session subcommands may create session metadata, append browser events
  or agent replies, write approval snapshots, and end sessions; dashboard/detail/bundle may read
  live ledger, registry, trash, inspect, and approval state. `ui execute` may run only an approved
  bundle through existing approval-gated exact-target paths; the command family must not execute
  cleanup, reconcile, registry-prune, resolve, purge, browser-direct, or broad `--all` actions itself.
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
- the public command surface, including `validate` and `ui`, is documented in this file,
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
node dist/src/cli.js dispose --help
node dist/src/cli.js validate --json
ARTSHELF_NO_UPDATE_CHECK=1 node dist/src/cli.js status --agent
ARTSHELF_UPDATE_DRY_RUN=1 node dist/src/cli.js update --json
```

The budget enforces `src/cli.ts` as a thin entrypoint. Do not raise it to fit new
command behavior or help rendering. Add real command modules, renderers,
adapters, config, shared contracts, shared help text, or focused domain helpers
in the folders above instead.
