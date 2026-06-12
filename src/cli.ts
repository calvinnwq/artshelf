#!/usr/bin/env node
import { maybeNotifyAvailableUpdate, runCommand } from "./commands/index.js";
import { VERSION } from "./config/package.js";
import { formatCliError } from "./shared/errors.js";
import { BOOLEAN_FLAGS, boolFlag, VALUE_FLAGS } from "./shared/flags.js";
import { LEDGERS_HELP, TRASH_HELP } from "./shared/help-text.js";
import type { ParsedArgs } from "./shared/cli-types.js";


async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    let status = 0;
    let shouldCheckForUpdate = true;

    if (parsed.command === "--version" || parsed.command === "-v" || boolFlag(parsed, "version")) {
      process.stdout.write(`artshelf ${VERSION}\n`);
      return maybeNotifyUpdateAndReturn(0, parsed);
    }

    if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h" || boolFlag(parsed, "help")) {
      printHelp(resolveHelpKey(parsed));
      return maybeNotifyUpdateAndReturn(0, parsed);
    }

    if (parsed.command === undefined) {
      printHelp();
      status = 0;
    } else {
      const result = await runCommand(parsed);
      status = result.status;
      shouldCheckForUpdate = result.shouldCheckForUpdate;
    }
    if (!shouldCheckForUpdate) return status;
    return maybeNotifyUpdateAndReturn(status, parsed);
  } catch (error) {
    process.stderr.write(formatCliError(error));
    return 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean | string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) continue;
    if (token === "-h") {
      flags.set("help", true);
      continue;
    }
    if (token === "-v") {
      flags.set("version", true);
      continue;
    }
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, true);
        continue;
      }
      if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown flag: --${name}`);
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
      index += 1;
      if (name === "label") {
        const previous = flags.get(name);
        flags.set(name, [...(Array.isArray(previous) ? previous : []), value]);
      } else {
        flags.set(name, value);
      }
      continue;
    }
    positionals.push(token);
  }
  return { command, positionals, flags };
}


async function maybeNotifyUpdateAndReturn(status: number, parsed: ParsedArgs): Promise<number> {
  await maybeNotifyAvailableUpdate(parsed);
  return status;
}

// grouped command list, summaries, and the `artshelf <command> --help` pointer
// stay in one place instead of drifting across hand-written usage strings.
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
      { name: "review", summary: "Preview validate, due, and cleanup plans (read-only)" }
    ]
  },
  {
    group: "Clean",
    commands: [
      { name: "cleanup", summary: "Plan and execute approved cleanups" },
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

// Commands with subcommands that carry their own focused help. Used to route
// `artshelf <command> <subcommand> --help` to a nested help key.
const NESTED_HELP = new Map<string, Set<string>>([
  ["trash", new Set(["list", "purge"])],
  ["ledgers", new Set(["list", "add"])]
]);

function resolveHelpKey(parsed: ParsedArgs): string {
  // `artshelf help [command [subcommand]]`
  if (parsed.command === "help") {
    return joinHelpKey(parsed.positionals[0], parsed.positionals[1]);
  }
  // `artshelf [--help|-h]` with no command resolves to the top-level help.
  if (!parsed.command || parsed.command === "--help" || parsed.command === "-h") {
    return "";
  }
  // `artshelf <command> [subcommand] --help`
  return joinHelpKey(parsed.command, parsed.positionals[0]);
}

function joinHelpKey(command?: string, subcommand?: string): string {
  if (!command) return "";
  const subcommands = NESTED_HELP.get(command);
  if (subcommands && subcommand && subcommands.has(subcommand)) {
    return `${command} ${subcommand}`;
  }
  return command;
}

function renderTopLevelHelp(): string {
  const names = COMMAND_GROUPS.flatMap((entry) => entry.commands.map((command) => command.name));
  const width = Math.max(...names.map((name) => name.length)) + 2;
  const lines: string[] = [
    `Artshelf ${VERSION} — approval-first retention for the temporary files agents leave behind.`,
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

function printHelp(command = ""): void {
  if (command === "put") {
    process.stdout.write(`Usage:
  artshelf put <path> --reason <text> (--ttl <ttl>|--retain-until <date>|--manual-review) [options]

Options:
  --kind scratch|backup|run-artifact|evidence|cache|quarantine|other
  --cleanup trash|review|delete  (cleanup=delete is refused; trash purge needs a reviewed plan)
  --owner <name>
  --label <label>        Repeatable
  --ledger <path>
  --registry <path>
  --json
`);
    return;
  }

  if (command === "cleanup") {
    process.stdout.write(`Usage:
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
`);
    return;
  }

  if (command === "trash") {
    process.stdout.write(TRASH_HELP);
    return;
  }

  if (command === "ledgers") {
    process.stdout.write(LEDGERS_HELP);
    return;
  }

  if (command === "list") {
    process.stdout.write(`Usage:
  artshelf list [--status <status>] [--ledger <path>] [--json]
  artshelf list --all [--status <status>] [--registry <path>] [--json]

Statuses:
  active, review-required, trashed, cleanup-refused, resolved
`);
    return;
  }

  if (command === "find") {
    process.stdout.write(`Usage:
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
`);
    return;
  }

  if (command === "get") {
    process.stdout.write(`Usage:
  artshelf get <id> [--ledger <path>] [--json]
  artshelf get <id> --all [--registry <path>] [--json]

Get is read-only and returns one ledger record by Artshelf id.
`);
    return;
  }

  if (command === "resolve") {
    process.stdout.write(`Usage:
  artshelf resolve <id> --status resolved --reason <text> [--ledger <path>] [--json]

Resolve marks a handled, missing, or no-longer-needed record as manually resolved.
Resolved records stay in the audit trail but no longer participate in due or cleanup planning.
`);
    return;
  }

  if (command === "review") {
    process.stdout.write(`Usage:
  artshelf review [--ledger <path>] [--json|--agent]
  artshelf review --all [--registry <path>] [--json|--agent]

Review runs validate, due, and cleanup plan preview without moving files or
writing a plan. With --all, review adds aggregate triage counts and the next
safe action.

Render modes:
  (default)  Human summary of validation, triage counts, and the next safe action.
  --json     Full read-only audit report (backward-compatible).
  --agent    Compact single-line JSON decision packet for agents: health, triage
             counts, and classified decision groups (ready for approval, needs
             review first, blocked) with exact approval targets where they are
             safe. Review is read-only, so cleanup approval targets are minted by
             \`cleanup --dry-run\`, never leaked from a preview plan id.
             Token-efficient; --agent takes precedence over --json.
`);
    return;
  }

  if (command === "doctor") {
    process.stdout.write(`Usage:
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
`);
    return;
  }

  if (command === "status") {
    process.stdout.write(`Usage:
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
`);
    return;
  }

  if (command === "update") {
    process.stdout.write(`Usage:
  artshelf update [--json]

Update checks compare the current CLI version with the latest published npm
version. Normal commands may print a non-blocking update notice to stderr when a
newer version is available. Run update to upgrade npm global installs only:

  npm install -g artshelf@latest

pnpm global installs should update with pnpm add -g artshelf@latest; source
installs should update by pulling, rebuilding, and linking the checkout.
`);
    return;
  }

  if (command === "due") {
    process.stdout.write(`Usage:
  artshelf due [--ledger <path>] [--json]
  artshelf due --all [--registry <path>] [--json]

Due lists records whose retention has elapsed or that need attention: due,
manual-review, and missing-path entries. Kept entries are hidden in human output.
Due is read-only and never moves files or writes plans.
`);
    return;
  }

  if (command === "validate") {
    process.stdout.write(`Usage:
  artshelf validate [--ledger <path>] [--json]
  artshelf validate --all [--registry <path>] [--json]

Validate checks ledger shape and reports errors and warnings, such as records
that point at missing artifact paths, without changing anything. A clean ledger
exits 0; shape errors exit non-zero. With --all it validates every registered
ledger.
`);
    return;
  }

  if (command === "trash list") {
    process.stdout.write(`Usage:
  artshelf trash list [--ledger <path>] [--all] [--registry <path>] [--json]

Options:
  --ledger <path>          Use a specific ledger file
  --all                     Include records from all registered ledgers
  --registry <path>         Registry path used with --all
  --json                    Emit machine-readable output

Trash list shows records currently held in Artshelf trash without deleting anything.
With --all it reports trashed records across every registered ledger.
`);
    return;
  }

  if (command === "trash purge") {
    process.stdout.write(`Usage:
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
`);
    return;
  }

  if (command === "ledgers list") {
    process.stdout.write(`Usage:
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
`);
    return;
  }

  if (command === "ledgers add") {
    process.stdout.write(`Usage:
  artshelf ledgers add --ledger <path> [--name <name>] [--scope repo|user|other] [--registry <path>] [--json]

Options:
  --ledger <path>          Register this ledger file
  --name <name>            Override the ledger display name
  --scope <scope>          Registry scope: repo, user, or other
  --registry <path>        Registry path to update
  --json                   Emit machine-readable output

Ledgers add registers an existing ledger file in the global registry so --all
commands and the registry index can find it. The ledger file must already exist.
`);
    return;
  }

  process.stdout.write(renderTopLevelHelp());
}

main(process.argv.slice(2))
  .then((status) => {
    process.exitCode = status;
  })
  .catch((error) => {
    process.stderr.write(formatCliError(error));
    process.exitCode = 1;
  });
