import type { ParsedArgs } from "./cli-types.js";

export const LEDGERS_HELP = `Manage the ledger registry.

Usage:
  artshelf ledgers [command]

Available Commands:
  list      List and validate registered ledgers
  add       Register an existing ledger file
  prune     Review and remove registrations whose ledger files are missing

Flags:
  -h, --help   help for ledgers

Use "artshelf ledgers <command> --help" for more information about a command.
`;

export const TRASH_HELP = `Inspect and purge Artshelf trash.

Usage:
  artshelf trash [command]

Available Commands:
  list      List records currently held in Artshelf trash
  purge     Plan or execute approved permanent trash deletion

Flags:
  -h, --help   help for trash

Use "artshelf trash <command> --help" for more information about a command.
`;

export const UI_HELP = `Start sessions and read Artshelf UI review views.

Usage:
  artshelf ui [command]

Available Commands:
  (start)     Start or resume a browser review session (default, no subcommand)
  dashboard   Show the read-only multi-ledger review dashboard
  detail      Show the read-only artifact detail drawer for one record
  serve       Serve the read-only dashboard and drawers in a local browser
  poll        Return pending actionable events for the agent
  reply       Append an agent receipt/result/note and advance one event
  end         End the session and revoke browser event writes

Flags:
  -h, --help   help for ui

The browser records review decisions; the agent polls them, executes existing
approval-gated paths, and replies with receipts. The dashboard and detail
surfaces are read-only: they never mutate state and never read file contents.
There is no browser-direct mutation path. Defaults to user-level, multi-ledger
review.

Use "artshelf ui <command> --help" for more information about a command.
`;

type HelpGroupName = "Create" | "Inspect" | "Review" | "Clean" | "System";

const COMMAND_GROUPS: ReadonlyArray<{
  group: HelpGroupName;
  commands: ReadonlyArray<{ name: string; summary: string }>;
}> = [
  {
    group: "Create",
    commands: [{ name: "put", summary: "Record an artifact with a reason and retention" }]
  },
  {
    group: "Inspect",
    commands: [
      { name: "list", summary: "List ledger records" },
      { name: "find", summary: "Find records by path, owner, label, or status" },
      { name: "get", summary: "Show one record by id" },
      { name: "due", summary: "Show due, manual-review, and missing-path records" },
      { name: "status", summary: "Summarize ledger and registry counts" }
    ]
  },
  {
    group: "Review",
    commands: [
      { name: "validate", summary: "Check ledger shape and report warnings" },
      { name: "review", summary: "Preview validate, due, and cleanup plans (read-only)" },
      { name: "ui", summary: "Start review sessions and read UI review views" }
    ]
  },
  {
    group: "Clean",
    commands: [
      { name: "cleanup", summary: "Plan and execute approved cleanups" },
      { name: "dispose", summary: "Plan and execute reviewed artifact decisions" },
      { name: "reconcile", summary: "Reconcile drifted ledger paths via approval-gated plans" },
      { name: "trash", summary: "Inspect and purge Artshelf trash" },
      { name: "resolve", summary: "Mark a record manually resolved" }
    ]
  },
  {
    group: "System",
    commands: [
      { name: "ledgers", summary: "Manage the ledger registry" },
      { name: "doctor", summary: "Report Artshelf health on this machine" },
      { name: "update", summary: "Update the Artshelf CLI" }
    ]
  }
];

const NESTED_HELP = new Map<string, Set<string>>([
  ["trash", new Set(["list", "purge"])],
  ["ledgers", new Set(["list", "add", "prune"])],
  ["ui", new Set(["dashboard", "detail", "serve", "poll", "reply", "end"])]
]);

export function resolveHelpKey(parsed: ParsedArgs): string {
  if (parsed.command === "help") {
    return joinHelpKey(parsed.positionals[0], parsed.positionals[1]);
  }
  if (!parsed.command || parsed.command === "--help" || parsed.command === "-h") {
    return "";
  }
  return joinHelpKey(parsed.command, parsed.positionals[0]);
}

export function renderHelp(command: string, version: string): string {
  if (command === "put") {
    return `Usage:
  artshelf put <path> --reason <text> (--ttl <ttl>|--retain-until <date>|--manual-review) [options]

Options:
  --kind scratch|backup|run-artifact|evidence|cache|quarantine|other
  --cleanup trash|review|delete  (cleanup=delete is refused; trash purge needs a reviewed plan)
  --owner <name>
  --label <label>        Repeatable
  --ledger <path>
  --registry <path>
  --json
`;
  }

  if (command === "cleanup") {
    return `Usage:
  artshelf cleanup --dry-run [--ledger <path>] [--json]
  artshelf cleanup --dry-run --all [--registry <path>] [--json]
  artshelf cleanup --execute --plan-id <id> [--ledger <path>] [--json]

Cleanup execution is approval-only. There is no daemon, no auto-execute, and no
global execute path: review a dry-run plan, then execute that one reviewed plan id.
Cleanup is ledger-first. Execute never computes a fresh live set; it only uses a reviewed plan id.
cleanup=delete records cleanup-refused instead of deleting files; physical trash purge needs a separate reviewed plan.
Dry-run writes and registers a plan only when executable cleanup entries exist; no-op dry-runs report not-created.
Matching dry-runs reuse the existing plan id and refresh its Artshelf-owned plan artifact.
Execute writes and registers an Artshelf-owned receipt artifact.
Global --all mode is dry-run only.
`;
  }

  if (command === "dispose") {
    return `Usage:
  artshelf dispose --id <id> --action trash-resolve --dry-run [--reason <text>] [--ledger <path>] [--json|--agent]
  artshelf dispose --id <id> --action resolve-only --dry-run --reason <text> [--ledger <path>] [--json|--agent]
  artshelf dispose --id <id> --action snooze --dry-run (--ttl <ttl>|--retain-until <date>) [--reason <text>] [--ledger <path>] [--json|--agent]
  artshelf dispose --id <id> --action keep --dry-run [--reason <text>] [--ledger <path>] [--json|--agent]
  artshelf dispose --execute --plan-id <id> [--ledger <path>] [--json]

Dispose is for records after human review, usually from \`get --inspect\`.
Dry-run classifies exactly one record/action, writes a reviewed dispose plan when
actionable, and prints the exact approval target:
  approve artshelf dispose ledger <ledger-path> plan <plan-id>

Actions:
  trash-resolve   Move the recorded path into plan-scoped Artshelf trash and resolve the row
  resolve-only    Resolve the ledger row only; requires --reason
  snooze          Extend retention; requires --ttl or --retain-until
  keep            Stamp that the record was reviewed and kept

Execute applies exactly one reviewed plan id against one ledger. There is no
dispose --all, no fresh-plan-then-execute, no daemon, and no physical delete.
`;
  }

  if (command === "reconcile") {
    return `Usage:
  artshelf reconcile --dry-run [--ledger <path>] [--json]
  artshelf reconcile --dry-run --all [--registry <path>] [--json]
  artshelf reconcile --execute --plan-id <id> --ledger <path> [--json]

Reconcile is approval-gated ledger/registry housekeeping, not cleanup: it never
creates, moves, or deletes files. It rewrites drifted ledger paths and resolves
rows that can no longer be acted on, always through one reviewed plan id.

Dry-run classifies path drift into a reviewed plan:
  remap                a safe moved/renamed path is rewritten to its current location
  resolve-missing      an active path is gone with no safe target; resolve after review
  resolve-stale-trash  a trashed target is gone; resolve the ledger row, files untouched
  blocked              ambiguous or unsafe findings surfaced for review, never auto-applied

Execute applies one reviewed plan id against one explicit --ledger and refuses
missing, unknown, or mismatched plan ids and entries whose live ledger state has
drifted since review. There is no reconcile --execute --all and no fresh-plan-then-execute.
Dry-run writes and registers a plan only when actionable entries exist; no-op dry-runs report not-created.
Matching dry-runs reuse the existing plan id and refresh its Artshelf-owned plan artifact.
Execute writes and registers an Artshelf-owned reconcile receipt artifact.
Global --all mode is dry-run only.
`;
  }

  if (command === "trash") return TRASH_HELP;
  if (command === "ledgers") return LEDGERS_HELP;
  if (command === "ui") return UI_HELP;

  if (command === "list") {
    return `Usage:
  artshelf list [--status <status>] [--ledger <path>] [--json]
  artshelf list --all [--status <status>] [--registry <path>] [--json]

Statuses:
  active, review-required, trashed, cleanup-refused, resolved
`;
  }

  if (command === "find") {
    return `Usage:
  artshelf find (--path <path>|--owner <name>|--label <label>|--status <status>) [options]
  artshelf find --all (--path <path>|--owner <name>|--label <label>|--status <status>) [options]

Options:
  --path <path>          Match an exact artifact path after path normalization
  --owner <name>
  --label <label>        Repeatable; all labels must match
  --status <status>
  --ledger <path>
  --registry <path>
  --json

Find is read-only. Use it before put when an integration needs idempotent artifact registration.
`;
  }

  if (command === "get") {
    return `Usage:
  artshelf get <id> [--ledger <path>] [--json]
  artshelf get <id> --all [--registry <path>] [--json]
  artshelf get <id> --inspect [--ledger <path>] [--json|--agent]
  artshelf get <id> --inspect --all [--registry <path>] [--json|--agent]

Get is read-only and returns one ledger record by Artshelf id.

--inspect adds a read-only review decision card for one record: existence,
size, age, retention/due state, a recommendation bucket (keep, snooze,
trash-safe, resolve-only, blocked), and the exact next-safe action. It never
moves files or touches the ledger. It does not read or preview arbitrary
file contents; agents can inspect contents separately when appropriate.
With --all, the registry is only used to find the id; the card reports the
concrete ledger that owns the record.

Render modes:
  (default)  Human record line, or a decision card with --inspect.
  --json     Full read-only report (record, or { inspect } with --inspect).
  --agent    Compact single-line JSON decision packet (requires --inspect);
             takes precedence over --json.
`;
  }

  if (command === "resolve") {
    return `Usage:
  artshelf resolve <id> --status resolved --reason <text> [--ledger <path>] [--json]

Resolve marks a handled, missing, or no-longer-needed record as manually resolved.
Resolved records stay in the audit trail but no longer participate in due or cleanup planning.
`;
  }

  if (command === "review") {
    return `Usage:
  artshelf review [--ledger <path>] [--json|--agent]
  artshelf review --all [--registry <path>] [--json|--agent]

Review runs validate, due, and cleanup plan preview without moving files or
writing a plan. With --all, review adds aggregate triage counts and the next
safe action, including reconcile entry and blocked counts when path drift is
detected.

Render modes:
  (default)  Human summary of validation, triage counts, and the next safe action.
  --json     Full read-only audit report (backward-compatible).
  --agent    Compact single-line JSON decision packet for agents: health, triage
             counts, and classified decision groups (ready for approval, needs
             review first, blocked) with exact approval targets where they are
             safe. Review is read-only, so cleanup approval targets are minted by
             \`cleanup --dry-run\`, never leaked from a preview plan id.
             Token-efficient; --agent takes precedence over --json.
`;
  }

  if (command === "doctor") {
    return `Usage:
  artshelf doctor [--registry <path>] [--ledger <path>] [--json|--agent]

Doctor reports whether Artshelf is healthy on this machine: CLI version, selected
or default ledger path, selected or global registry path, registered ledger health
(stale/missing/invalid), and the cleanup safety posture. Execute is scoped to one
selected or default ledger and still requires a reviewed plan id; --all execute
and cleanup=delete are refused, while physical trash purge requires a separate
reviewed purge plan.

Render modes:
  (default)  Human summary of machine health and cleanup safety.
  --json     Full audit report (backward-compatible; suitable for cron/reporting).
  --agent    Compact single-line JSON decision packet for agents: health, registry
             and registered-ledger health, blockers, cleanup-safety posture, next
             action, and a verify command. Token-efficient; --agent takes
             precedence over --json.

Run it after install, when --all commands behave unexpectedly, or on a schedule to
catch stale registry entries. Doctor is read-only. A healthy machine exits 0; a
broken registry or registered ledger exits non-zero with actionable errors.
`;
  }

  if (command === "status") {
    return `Usage:
  artshelf status [--ledger <path>] [--json|--agent]
  artshelf status --all [--registry <path>] [--json|--agent]

Status is the lightweight daily "what is going on?" view. Without --all, it
reports counts for the selected or default ledger only. With --all, it adds
registry health, total ledgers, and aggregated counts across registered ledgers.
Counts include active artifacts, kept, due, manual-review, missing-path, and
pending cleanup entries.

Render modes:
  (default)  Human summary, short enough to paste into a chat.
  --json     Full audit report (backward-compatible; suitable for cron/reporting).
  --agent    Compact single-line JSON decision packet for agents: health, counts,
             attention categories, blockers, next action, and a verify command.
             Token-efficient; --agent takes precedence over --json.

Status is read-only: it never creates plans or receipts and never mutates
records. A healthy selected ledger exits 0; with --all, a broken registry or any
stale or invalid registered ledger exits non-zero.
`;
  }

  if (command === "update") {
    return `Usage:
  artshelf update [--json]

Update checks compare the current CLI version with the latest published npm
version. Normal commands may print a non-blocking update notice to stderr when a
newer version is available. Run update to upgrade npm global installs only:

  npm install -g artshelf@latest

pnpm global installs should update with pnpm add -g artshelf@latest; source
installs should update by pulling, rebuilding, and linking the checkout.
`;
  }

  if (command === "due") {
    return `Usage:
  artshelf due [--ledger <path>] [--json]
  artshelf due --all [--registry <path>] [--json]

Due lists records whose retention has elapsed or that need attention: due,
manual-review, and missing-path entries. Kept entries are hidden in human output.
Due is read-only and never moves files or writes plans.
`;
  }

  if (command === "validate") {
    return `Usage:
  artshelf validate [--ledger <path>] [--json]
  artshelf validate --all [--registry <path>] [--json]

Validate checks ledger shape and reports errors and warnings, such as records
that point at missing artifact paths, without changing anything. A clean ledger
exits 0; shape errors exit non-zero. With --all it validates every registered
ledger.
`;
  }

  if (command === "trash list") {
    return `Usage:
  artshelf trash list [--ledger <path>] [--all] [--registry <path>] [--json]

Options:
  --ledger <path>          Use a specific ledger file
  --all                     Include records from all registered ledgers
  --registry <path>         Registry path used with --all
  --json                    Emit machine-readable output

Trash list shows records currently held in Artshelf trash without deleting anything.
With --all it reports trashed records across every registered ledger.
`;
  }

  if (command === "trash purge") {
    return `Usage:
  artshelf trash purge --older-than <ttl> --dry-run [--ledger <path>] [--json]
  artshelf trash purge --execute --plan-id <id> [--ledger <path>] [--json]

Options:
  --older-than <ttl>        Purge trashed records older than this duration
  --dry-run                 Build a reviewed purge plan and output a plan id
  --execute                 Execute a reviewed purge plan
  --plan-id <id>            Execute only this reviewed purge plan
  --ledger <path>           Target one specific ledger
  --json                    Emit machine-readable output

Trash purge permanently deletes aged trash from a reviewed plan. --dry-run turns
--older-than into a reviewed purge plan id; --execute deletes only that one reviewed
plan id. Purge is always scoped to one --ledger; --all is not supported for purge.
Completed receipts are refused on repeat execute; an interrupted purge may be resumed
and reconciled.
`;
  }

  if (command === "ledgers list") {
    return `Usage:
  artshelf ledgers list [--plain] [--registry <path>] [--json]

Options:
  --plain                  Skip ledger validation and list registrations directly
  --registry <path>        Registry path to use
  --json                   Emit machine-readable output

Ledgers list validates every registered ledger and reports ok/missing/invalid
status, entry counts, and warnings so agents can spot stale registry entries
without a separate validate pass. Use --plain for the fast path that lists
registered ledgers without reading them. It exits non-zero when the registry or
any registered ledger is broken.
`;
  }

  if (command === "ledgers add") {
    return `Usage:
  artshelf ledgers add --ledger <path> [--name <name>] [--scope repo|user|other] [--registry <path>] [--json]

Options:
  --ledger <path>          Register this ledger file
  --name <name>            Override the ledger display name
  --scope <scope>          Registry scope: repo, user, or other
  --registry <path>        Registry path to update
  --json                   Emit machine-readable output

Ledgers add registers an existing ledger file in the global registry so --all
commands and the registry index can find it. The ledger file must already exist.
`;
  }

  if (command === "ledgers prune") {
    return `Usage:
  artshelf ledgers prune --dry-run [--registry <path>] [--json|--agent]
  artshelf ledgers prune --execute --plan-id <id> [--registry <path>] [--json]

Options:
  --dry-run                Review prunable registrations and write a reviewed plan
  --execute                Apply a reviewed plan, removing the missing registrations
  --plan-id <id>           Reviewed plan id to execute (required with --execute)
  --registry <path>        Registry path to inspect or prune
  --json                   Emit machine-readable output
  --agent                  Emit a compact single-line decision packet (dry-run)

Ledgers prune is the approval-gated way to remove registry entries whose ledger
files are missing, so missing temp ledgers no longer need hand-edited registry
JSON. Dry-run is read-only except for writing a reviewed plan when action is
needed; it never mutates the registry. Registrations sharing a duplicate path are
surfaced as blocked, never pruned. Dry-run prints the exact approval target:
  approve artshelf ledgers prune registry <registry-path> plan <plan-id>

Execute binds to one exact registry path and reviewed plan id. It re-checks the
live registry and only removes entries still classified as prunable (entries
whose ledger file reappeared or whose path became an ambiguous duplicate are
skipped). It writes a rollback copy of the registry before mutating and a receipt
after, both discoverable next to the registry under registry-prune-rollbacks/ and
registry-prune-receipts/.
`;
  }

  if (command === "ui dashboard") {
    return `Usage:
  artshelf ui dashboard [--registry <path>] [--json]

Options:
  --registry <path>        Aggregate the ledgers registered in this registry
  --json                   Emit a compact single-line dashboard snapshot

Dashboard is the read-only multi-ledger review surface. It recomputes live state
across registered ledgers into the eight UI v1 lanes - needs-review, needs-context,
cleanup, resolve, trash, purge-candidates, registry/reconcile, and recent-receipts -
by composing the existing read-only domain surfaces. It never mutates a ledger,
registry, plan, or file, and never reads or previews file contents. Records with a
missing or vague reason are bucketed as needs-context rather than treated as
reviewable.
`;
  }

  if (command === "ui detail") {
    return `Usage:
  artshelf ui detail <record-id> [--ledger <path>] [--registry <path>] [--json]

Options:
  --ledger <path>          Ledger that holds the record (defaults to the working ledger)
  --registry <path>        Registry used to resolve the ledger's friendly name
  --json                   Emit a compact single-line detail drawer

Detail is the read-only artifact detail drawer a dashboard row opens into. It shows
the contract's Minimum Human-Judgment Fields for one record: id, ledger/source,
status, path label, original reason, created age and review due reason, retention
and cleanup policy, provenance, audit trail, existence facts, the get --inspect
decision card, the needs-context badge, and the last action with its receipt. It is
read-only and never reads or previews file contents.
`;
  }

  if (command === "ui serve") {
    return `Usage:
  artshelf ui serve [--scope user|repo] [--port <port>] [--registry <path>] [--ledger <path>] [--json]

Options:
  --scope <scope>          Locate or create the guarding UI session in user (default) or repo scope
  --port <port>            Loopback port to bind (default: an ephemeral free port)
  --registry <path>        Registry whose ledgers the dashboard aggregates
  --ledger <path>          Fallback ledger for detail drawers opened without a target
  --json                   Emit a compact launch packet before waiting in the foreground

Serve hosts the read-only review dashboard and artifact detail drawers as a local
browser surface. It binds to loopback (127.0.0.1) only, never a wildcard interface,
and recomputes live state on every request. Dashboard and detail pages require the
active UI session capability token printed in the serve URL; ending that session
revokes browser access. The pages carry no script, embed no file contents, and expose
no mutation path - the browser only displays state. Safe GET/HEAD reads are accepted;
mutating methods are refused. The process runs in the foreground; press Ctrl-C to stop it.
`;
  }

  if (command === "ui poll") {
    return `Usage:
  artshelf ui poll <session-id> [--scope user|repo] [--json]

Options:
  --scope <scope>          Locate the session in user (default) or repo scope
  --json                   Emit a compact single-line agent packet

Poll returns the session's pending actionable events for the agent without
dumping the full dashboard. It is read-only; an ended session still polls (with
nothing pending) so the receipt and decision trail survive restart and resume.
`;
  }

  if (command === "ui reply") {
    return `Usage:
  artshelf ui reply <session-id> --event <event-id> --status <status> [--payload <json>] [--scope user|repo] [--json]

Options:
  --event <event-id>       The pending event this reply advances
  --status <status>        New event status: acknowledged, in_progress,
                           completed, rejected, stale, failed, or cancelled
  --payload <json>         Optional JSON object body (receipt, result, or note)
  --scope <scope>          Locate the session in user (default) or repo scope
  --json                   Emit a compact single-line agent packet

Reply appends an agent receipt, result, validation failure, question, or status
note and advances exactly one event. The browser records decisions; the agent
replies after running existing approval-gated paths. There is no browser-direct
execution path.
`;
  }

  if (command === "ui end") {
    return `Usage:
  artshelf ui end <session-id> [--scope user|repo] [--json]

Options:
  --scope <scope>          Locate the session in user (default) or repo scope
  --json                   Emit a compact single-line agent packet

End closes the session and revokes browser event writes for it. The session
stays readable so its receipt and decision trail survive for audit and resume.
`;
  }

  return renderTopLevelHelp(version);
}

function joinHelpKey(command?: string, subcommand?: string): string {
  if (!command) return "";
  const subcommands = NESTED_HELP.get(command);
  if (subcommands && subcommand && subcommands.has(subcommand)) {
    return `${command} ${subcommand}`;
  }
  return command;
}

function renderTopLevelHelp(version: string): string {
  const names = COMMAND_GROUPS.flatMap((entry) => entry.commands.map((command) => command.name));
  const width = Math.max(...names.map((name) => name.length)) + 2;
  const lines: string[] = [
    `Artshelf ${version} — approval-first retention for the temporary files agents leave behind.`,
    "",
    "Usage:",
    "  artshelf <command> [options]",
    "",
    "Available Commands:"
  ];
  for (const { group, commands } of COMMAND_GROUPS) {
    lines.push(`  ${group}`);
    for (const command of commands) {
      lines.push(`    ${command.name.padEnd(width)}${command.summary}`);
    }
  }
  lines.push(
    "",
    "Global Options:",
    "  -h, --help     Show help for artshelf or a specific command",
    "  -v, --version  Show the Artshelf version",
    "",
    "Output:",
    "  --json       Emit machine-readable JSON on commands that return data",
    "",
    "Scope (command-specific):",
    "  --ledger <path>     Target an explicit JSONL ledger",
    "  --registry <path>   Target an explicit ledger registry",
    "  --all               Read every registered ledger (on commands that support it)",
    "",
    `Use "artshelf <command> --help" for more information about a command.`,
    ""
  );
  return lines.join("\n");
}
