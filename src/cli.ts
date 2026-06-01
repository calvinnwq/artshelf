#!/usr/bin/env node
import {
  createCleanupPlan,
  dueEntries,
  executeCleanupPlan,
  normalizeLedgerPath,
  putRecord,
  readLedger,
  validateLedger
} from "./ledger.js";

type ParsedArgs = {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string | boolean | string[]>;
};

function main(argv: string[]): number {
  try {
    const parsed = parseArgs(argv);
    const ledgerPath = normalizeLedgerPath(stringFlag(parsed, "ledger"));
    const json = boolFlag(parsed, "json");

    switch (parsed.command) {
      case "put":
        return handlePut(parsed, ledgerPath, json);
      case "list":
        return handleList(ledgerPath, json);
      case "due":
        return handleDue(ledgerPath, json);
      case "validate":
        return handleValidate(ledgerPath, json);
      case "cleanup":
        return handleCleanup(parsed, ledgerPath, json);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return 0;
      default:
        throw new Error(`Unknown command: ${parsed.command}`);
    }
  } catch (error) {
    process.stderr.write(`shelf: ${(error as Error).message}\n`);
    return 1;
  }
}

function handlePut(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  const path = parsed.positionals[0];
  if (!path) throw new Error("put requires <path>");

  const record = putRecord(ledgerPath, {
    path,
    reason: requiredStringFlag(parsed, "reason"),
    ttl: stringFlag(parsed, "ttl"),
    retainUntil: stringFlag(parsed, "retain-until"),
    manualReview: boolFlag(parsed, "manual-review"),
    kind: stringFlag(parsed, "kind"),
    cleanup: stringFlag(parsed, "cleanup"),
    owner: stringFlag(parsed, "owner"),
    labels: arrayFlag(parsed, "label")
  });

  if (json) return printJson({ ok: true, record, ledgerPath });
  process.stdout.write(`recorded ${record.id} ${record.path}\n`);
  return 0;
}

function handleList(ledgerPath: string, json: boolean): number {
  const records = readLedger(ledgerPath);
  if (json) return printJson({ ok: true, ledgerPath, entries: records });
  if (records.length === 0) {
    process.stdout.write("no shelf entries\n");
    return 0;
  }
  for (const record of records) {
    process.stdout.write(`${record.id} ${record.kind} ${record.cleanup} ${record.path} :: ${record.reason}\n`);
  }
  return 0;
}

function handleDue(ledgerPath: string, json: boolean): number {
  const entries = dueEntries(readLedger(ledgerPath));
  const visible = entries.filter((entry) => entry.dueStatus !== "kept");
  if (json) return printJson({ ok: true, ledgerPath, entries });
  if (visible.length === 0) {
    process.stdout.write("nothing due\n");
    return 0;
  }
  for (const entry of visible) {
    process.stdout.write(`${entry.dueStatus} ${entry.id} ${entry.cleanup} ${entry.path} :: ${entry.reason}\n`);
  }
  return 0;
}

function handleValidate(ledgerPath: string, json: boolean): number {
  const result = validateLedger(ledgerPath);
  if (json) return printJson({ ledgerPath, ...result });
  process.stdout.write(`${result.ok ? "ok" : "invalid"}: ${result.entries} entries, ${result.errors.length} errors, ${result.warnings.length} warnings\n`);
  for (const error of result.errors) process.stdout.write(`error: ${error}\n`);
  for (const warning of result.warnings) process.stdout.write(`warning: ${warning}\n`);
  return result.ok ? 0 : 1;
}

function handleCleanup(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  if (boolFlag(parsed, "dry-run")) {
    const plan = createCleanupPlan(ledgerPath);
    if (json) return printJson({ ok: true, plan });
    process.stdout.write(`plan ${plan.planId}: ${plan.entries.length} entries, ${plan.skipped.length} skipped\n${plan.planPath}\n`);
    return 0;
  }

  if (boolFlag(parsed, "execute")) {
    const planId = requiredStringFlag(parsed, "plan-id");
    const receipt = executeCleanupPlan(ledgerPath, planId);
    if (json) return printJson({ ok: true, receipt });
    process.stdout.write(`receipt ${receipt.planId}: ${receipt.results.length} results\n${receipt.receiptPath}\n`);
    return 0;
  }

  throw new Error("cleanup requires --dry-run or --execute");
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags = new Map<string, string | boolean | string[]>();
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const name = arg.slice(2);
    if (["json", "manual-review", "dry-run", "execute"].includes(name)) {
      flags.set(name, true);
      continue;
    }

    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    index += 1;

    if (name === "label") {
      const current = flags.get(name);
      flags.set(name, [...(Array.isArray(current) ? current : []), value]);
    } else {
      flags.set(name, value);
    }
  }

  return { command, positionals, flags };
}

function requiredStringFlag(parsed: ParsedArgs, name: string): string {
  const value = stringFlag(parsed, name);
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function boolFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

function arrayFlag(parsed: ParsedArgs, name: string): string[] {
  const value = parsed.flags.get(name);
  return Array.isArray(value) ? value : [];
}

function printJson(value: unknown): number {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

function printHelp(): void {
  process.stdout.write(`shelf put <path> --reason <text> (--ttl <ttl>|--retain-until <date>|--manual-review)
shelf list [--json]
shelf due [--json]
shelf validate [--json]
shelf cleanup --dry-run [--json]
shelf cleanup --execute --plan-id <id> [--json]
`);
}

process.exitCode = main(process.argv.slice(2));
