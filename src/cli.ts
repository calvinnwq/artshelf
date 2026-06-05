#!/usr/bin/env node
import { existsSync } from "node:fs";
import {
  appendPreparedRecord,
  createCleanupPlan,
  createTrashPurgePlan,
  dueEntries,
  executeCleanupPlan,
  executeTrashPurgePlan,
  filterRecordsByStatus,
  findRecords,
  getRecord,
  listTrashedRecords,
  normalizeLedgerPath,
  prepareRecord,
  previewCleanupPlan,
  readLedger,
  resolveRecord,
  validateLedger
} from "./ledger.js";
import {
  listRegisteredLedgers,
  normalizeRegistryPath,
  registerLedger
} from "./registry.js";
import type { LedgerRegistryEntry } from "./registry.js";
import type { CleanupPlan, DueEntry, ShelfRecord } from "./types.js";

const VERSION = "0.1.0";
const BOOLEAN_FLAGS = new Set(["all", "json", "manual-review", "dry-run", "execute", "help", "version", "plain"]);
const VALUE_FLAGS = new Set([
  "cleanup",
  "kind",
  "label",
  "ledger",
  "name",
  "owner",
  "path",
  "plan-id",
  "older-than",
  "registry",
  "reason",
  "retain-until",
  "scope",
  "status",
  "ttl"
]);

type ParsedArgs = {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string | boolean | string[]>;
};

function main(argv: string[]): number {
  try {
    const parsed = parseArgs(argv);

    if (parsed.command === "--version" || parsed.command === "-v" || boolFlag(parsed, "version")) {
      process.stdout.write(`shelf ${VERSION}\n`);
      return 0;
    }

    if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h" || boolFlag(parsed, "help")) {
      printHelp(parsed.command === "help" ? parsed.positionals[0] : parsed.command);
      return 0;
    }

    switch (parsed.command) {
      case "put":
        return handlePut(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      case "ledgers":
        return handleLedgers(parsed, boolFlag(parsed, "json"));
      case "list":
        return handleList(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      case "find":
        return handleFind(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      case "get":
        return handleGet(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      case "due":
        return handleDue(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      case "validate":
        return handleValidate(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      case "cleanup":
        return handleCleanup(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      case "trash":
        return handleTrash(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      case "review":
        return handleReview(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      case "doctor":
        return handleDoctor(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      case "status":
        return handleStatus(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      case "resolve":
        return handleResolve(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      case undefined:
        printHelp();
        return 0;
      default:
        throw new Error(`Unknown command: ${parsed.command}`);
    }
  } catch (error) {
    process.stderr.write(`shelf: ${(error as Error).message}\nRun \`shelf help\` for usage.\n`);
    return 1;
  }
}

function handlePut(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  const path = parsed.positionals[0];
  if (!path) throw new Error("put requires <path>");

  const record = prepareRecord({
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
  const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
  appendPreparedRecord(ledgerPath, record);
  let ledger: LedgerRegistryEntry | undefined;
  let registryError: string | undefined;
  try {
    ledger = registerLedger({ ledgerPath, registryPath });
  } catch (error) {
    registryError = (error as Error).message;
  }

  if (json) return printJson({ ok: true, record, ledgerPath, registryPath, ...(ledger ? { ledger } : {}), ...(registryError ? { registryError } : {}) });
  process.stdout.write(`recorded ${record.id}\npath: ${record.path}\nretains until: ${record.retainUntil ?? "manual review"}\nledger: ${ledgerPath}\n`);
  if (registryError) process.stdout.write(`registry warning: ${registryError}\n`);
  return 0;
}

function handleLedgers(parsed: ParsedArgs, json: boolean): number {
  const action = parsed.positionals[0] ?? "list";
  const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
  if (action === "add") {
    const ledgerPath = normalizeLedgerPath(requiredStringFlag(parsed, "ledger"));
    if (!existsSync(ledgerPath)) throw new Error(`Ledger does not exist: ${ledgerPath}`);
    const entry = registerLedger({
      ledgerPath,
      name: stringFlag(parsed, "name"),
      scope: stringFlag(parsed, "scope"),
      registryPath
    });
    if (json) return printJson({ ok: true, registryPath, ledger: entry });
    process.stdout.write(`registered ${entry.name}\nledger: ${entry.path}\nregistry: ${registryPath}\n`);
    return 0;
  }
  if (action === "list") {
    if (boolFlag(parsed, "plain")) {
      const ledgers = listRegisteredLedgers(registryPath);
      if (json) return printJson({ ok: true, registryPath, ledgers });
      if (ledgers.length === 0) {
        process.stdout.write(`no registered Shelf ledgers\nregistry: ${registryPath}\n`);
        return 0;
      }
      for (const ledger of ledgers) process.stdout.write(`${ledger.name} ${ledger.scope} ${ledger.path}\n`);
      process.stdout.write(`registry: ${registryPath}\n`);
      return 0;
    }

    const report = buildLedgersReport(registryPath);
    if (json) {
      printJson(report);
      return report.ok ? 0 : 1;
    }
    printLedgersList(report);
    return report.ok ? 0 : 1;
  }
  throw new Error(`Unknown ledgers action: ${action}`);
}

type LedgerListing = LedgerRegistryEntry & {
  status: "ok" | "missing" | "invalid";
  ok: boolean;
  entries: number;
  errors: string[];
  warnings: string[];
};

type LedgersReport = {
  ok: boolean;
  registryPath: string;
  registryExists: boolean;
  registryOk: boolean;
  registryError: string | null;
  ledgers: LedgerListing[];
  summary: { ledgers: number; ok: number; stale: number; invalid: number; warnings: number };
};

function buildLedgersReport(registryPath: string): LedgersReport {
  let registryOk = true;
  let registryError: string | null = null;
  let entries: LedgerRegistryEntry[] = [];
  try {
    entries = listRegisteredLedgers(registryPath);
  } catch (error) {
    registryOk = false;
    registryError = (error as Error).message;
  }

  const ledgers: LedgerListing[] = entries.map((entry) => {
    const result = validateRegisteredLedger(entry);
    const status: LedgerListing["status"] = result.ok ? "ok" : existsSync(entry.path) ? "invalid" : "missing";
    return {
      ...entry,
      status,
      ok: result.ok,
      entries: result.entries,
      errors: result.errors,
      warnings: result.warnings
    };
  });

  const summary = {
    ledgers: ledgers.length,
    ok: ledgers.filter((ledger) => ledger.status === "ok").length,
    stale: ledgers.filter((ledger) => ledger.status === "missing").length,
    invalid: ledgers.filter((ledger) => ledger.status === "invalid").length,
    warnings: ledgers.reduce((count, ledger) => count + ledger.warnings.length, 0)
  };

  return {
    ok: registryOk && summary.stale === 0 && summary.invalid === 0,
    registryPath,
    registryExists: existsSync(registryPath),
    registryOk,
    registryError,
    ledgers,
    summary
  };
}

function printLedgersList(report: LedgersReport): void {
  process.stdout.write(`shelf ledgers: ${report.ok ? "ok" : "needs attention"}\n`);
  process.stdout.write(`registry: ${report.registryPath}${report.registryExists ? "" : " (absent)"} — ${report.summary.ledgers} ledgers (${report.summary.ok} ok, ${report.summary.stale} stale, ${report.summary.invalid} invalid)\n`);
  if (report.registryError) process.stdout.write(`registry error: ${report.registryError}\n`);
  if (report.ledgers.length === 0) {
    process.stdout.write("no registered Shelf ledgers\n");
    return;
  }
  for (const ledger of report.ledgers) {
    if (ledger.status === "ok") {
      process.stdout.write(`[${ledger.name}] ok ${ledger.scope}: ${ledger.entries} entries, ${ledger.warnings.length} warnings — ${ledger.path}\n`);
    } else {
      process.stdout.write(`[${ledger.name}] ${ledger.status} ${ledger.scope}: ${ledger.errors.join("; ")} — ${ledger.path}\n`);
    }
  }
}

function handleList(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  if (boolFlag(parsed, "all")) {
    const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
    const status = stringFlag(parsed, "status");
    const validation = validateRegisteredLedgersOrThrow(registryPath);
    if (!validation.ok) return printRegisteredLedgerValidation(registryPath, validation.results, json);
    const results = validation.results.map(({ ledger }) => ({
      ledger,
      entries: filterRecordsByStatus(readLedger(ledger.path), status)
    }));
    if (json) return printJson({ ok: true, registryPath, ...(status ? { status } : {}), ledgers: results });
    printLedgerEntries(results, status);
    process.stdout.write(`registry: ${registryPath}\n`);
    return 0;
  }

  const status = stringFlag(parsed, "status");
  const records = filterRecordsByStatus(readLedger(ledgerPath), status);
  if (json) return printJson({ ok: true, ledgerPath, ...(status ? { status } : {}), entries: records });
  if (records.length === 0) {
    process.stdout.write(`no shelf entries${status ? ` with status ${status}` : ""}\nledger: ${ledgerPath}\n`);
    return 0;
  }
  for (const record of records) {
    process.stdout.write(`${record.id} ${record.kind} ${record.status} ${record.cleanup} ${record.path} :: ${record.reason}\n`);
  }
  process.stdout.write(`ledger: ${ledgerPath}\n`);
  return 0;
}

function handleFind(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  if (boolFlag(parsed, "all")) {
    const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
    const validation = validateRegisteredLedgersOrThrow(registryPath);
    if (!validation.ok) return printRegisteredLedgerValidation(registryPath, validation.results, json);
    const results = validation.results.map(({ ledger }) => ({
      ledger,
      entries: findRecords(readLedger(ledger.path), {
        path: stringFlag(parsed, "path"),
        owner: stringFlag(parsed, "owner"),
        labels: arrayFlag(parsed, "label"),
        status: stringFlag(parsed, "status")
      })
    }));
    if (json) return printJson({ ok: true, registryPath, ledgers: results });
    printLedgerEntries(results);
    process.stdout.write(`registry: ${registryPath}\n`);
    return 0;
  }

  const records = findRecords(readLedger(ledgerPath), {
    path: stringFlag(parsed, "path"),
    owner: stringFlag(parsed, "owner"),
    labels: arrayFlag(parsed, "label"),
    status: stringFlag(parsed, "status")
  });
  if (json) return printJson({ ok: true, ledgerPath, entries: records });
  if (records.length === 0) {
    process.stdout.write(`no matching shelf entries\nledger: ${ledgerPath}\n`);
    return 0;
  }
  for (const record of records) {
    process.stdout.write(`${record.id} ${record.kind} ${record.status} ${record.cleanup} ${record.path} :: ${record.reason}\n`);
  }
  process.stdout.write(`ledger: ${ledgerPath}\n`);
  return 0;
}

function handleGet(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  const id = parsed.positionals[0];
  if (!id) throw new Error("get requires <id>");
  if (boolFlag(parsed, "all")) {
    const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
    const validation = validateRegisteredLedgersOrThrow(registryPath);
    if (!validation.ok) return printRegisteredLedgerValidation(registryPath, validation.results, json);
    for (const { ledger } of validation.results) {
      const record = readLedger(ledger.path).find((entry) => entry.id === id);
      if (record) {
        if (json) return printJson({ ok: true, registryPath, ledger, record });
        process.stdout.write(`${record.id} ${record.kind} ${record.status} ${record.cleanup} ${record.path}\nreason: ${record.reason}\nledger: ${ledger.path}\nregistry: ${registryPath}\n`);
        return 0;
      }
    }
    throw new Error(`Shelf record not found: ${id}`);
  }
  const record = getRecord(readLedger(ledgerPath), id);
  if (json) return printJson({ ok: true, ledgerPath, record });
  process.stdout.write(`${record.id} ${record.kind} ${record.status} ${record.cleanup} ${record.path}\nreason: ${record.reason}\nledger: ${ledgerPath}\n`);
  return 0;
}

function handleResolve(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  const id = parsed.positionals[0];
  if (!id) throw new Error("resolve requires <id>");
  const record = resolveRecord(ledgerPath, {
    id,
    status: requiredStringFlag(parsed, "status"),
    reason: requiredStringFlag(parsed, "reason")
  });
  if (json) return printJson({ ok: true, record, ledgerPath });
  process.stdout.write(`resolved ${record.id}\nstatus: ${record.status}\nledger: ${ledgerPath}\n`);
  return 0;
}

function handleDue(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  if (boolFlag(parsed, "all")) {
    const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
    const validation = validateRegisteredLedgersOrThrow(registryPath);
    if (!validation.ok) return printRegisteredLedgerValidation(registryPath, validation.results, json);
    const results = validation.results.map(({ ledger }) => ({ ledger, entries: dueEntries(readLedger(ledger.path)) }));
    if (json) return printJson({ ok: true, registryPath, ledgers: results });
    printDueEntries(results);
    process.stdout.write(`registry: ${registryPath}\n`);
    return 0;
  }
  const entries = dueEntries(readLedger(ledgerPath));
  const visible = entries.filter((entry) => entry.dueStatus !== "kept");
  if (json) return printJson({ ok: true, ledgerPath, entries });
  if (visible.length === 0) {
    process.stdout.write(`nothing due\nledger: ${ledgerPath}\n`);
    return 0;
  }
  for (const entry of visible) {
    process.stdout.write(`${entry.dueStatus} ${entry.id} ${entry.cleanup} ${entry.path} :: ${entry.reason}\n`);
  }
  process.stdout.write(`ledger: ${ledgerPath}\n`);
  return 0;
}

function handleValidate(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  if (boolFlag(parsed, "all")) {
    const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
    const results = registeredLedgersOrThrow(registryPath).map((ledger) => ({ ledger, result: validateRegisteredLedger(ledger) }));
    const ok = results.every((entry) => entry.result.ok);
    if (json) {
      printJson({ ok, registryPath, ledgers: results });
      return ok ? 0 : 1;
    }
    for (const entry of results) {
      process.stdout.write(`${entry.result.ok ? "ok" : "invalid"} ${entry.ledger.name}: ${entry.result.entries} entries, ${entry.result.errors.length} errors, ${entry.result.warnings.length} warnings\nledger: ${entry.ledger.path}\n`);
      for (const error of entry.result.errors) process.stdout.write(`error: ${error}\n`);
      for (const warning of entry.result.warnings) process.stdout.write(`warning: ${warning}\n`);
    }
    process.stdout.write(`registry: ${registryPath}\n`);
    return ok ? 0 : 1;
  }
  const result = validateLedger(ledgerPath);
  if (json) return printJson({ ledgerPath, ...result });
  process.stdout.write(`${result.ok ? "ok" : "invalid"}: ${result.entries} entries, ${result.errors.length} errors, ${result.warnings.length} warnings\n`);
  for (const error of result.errors) process.stdout.write(`error: ${error}\n`);
  for (const warning of result.warnings) process.stdout.write(`warning: ${warning}\n`);
  process.stdout.write(`ledger: ${ledgerPath}\n`);
  return result.ok ? 0 : 1;
}

function handleCleanup(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  const dryRun = boolFlag(parsed, "dry-run");
  const execute = boolFlag(parsed, "execute");
  if (dryRun && execute) throw new Error("cleanup accepts either --dry-run or --execute, not both");
  if (boolFlag(parsed, "all") && execute) throw new Error("cleanup --all is dry-run only; execute requires an explicit --ledger and reviewed --plan-id");

  if (dryRun) {
    if (boolFlag(parsed, "all")) {
      const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
      const ledgers = registeredLedgersOrThrow(registryPath);
      const validations = ledgers.map((ledger) => ({ ledger, result: validateRegisteredLedger(ledger) }));
      const ok = validations.every((entry) => entry.result.ok);
      if (!ok) {
        if (json) {
          printJson({ ok, registryPath, ledgers: validations });
          return 1;
        }
        for (const entry of validations.filter((item) => !item.result.ok)) {
          process.stdout.write(`invalid ${entry.ledger.name}: ${entry.result.errors.join("; ")}\nledger: ${entry.ledger.path}\n`);
        }
        process.stdout.write(`registry: ${registryPath}\n`);
        return 1;
      }
      const plans = ledgers.map((ledger) => ({ ledger, plan: createCleanupPlan(ledger.path) }));
      if (json) return printJson({ ok: true, registryPath, plans });
      printPlans(plans);
      process.stdout.write(`registry: ${registryPath}\n`);
      return 0;
    }
    const plan = createCleanupPlan(ledgerPath);
    if (json) return printJson({ ok: true, plan });
    printPlan(plan, ledgerPath);
    return 0;
  }

  if (execute) {
    const planId = requiredStringFlag(parsed, "plan-id");
    const receipt = executeCleanupPlan(ledgerPath, planId);
    if (json) return printJson({ ok: true, receipt });
    process.stdout.write(`receipt ${receipt.planId}: ${receipt.results.length} results\nreceipt: ${receipt.receiptPath}\nledger: ${ledgerPath}\n`);
    return 0;
  }

  throw new Error("cleanup requires --dry-run or --execute");
}

function handleTrash(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  const action = parsed.positionals[0];
  if (!action) throw new Error("trash requires a subcommand: list or purge");

  if (action === "list") {
    return handleTrashList(parsed, ledgerPath, json);
  }
  if (action === "purge") {
    return handleTrashPurge(parsed, ledgerPath, json);
  }
  if (action === "help") {
    printHelp("trash");
    return 0;
  }
  throw new Error(`Unknown trash subcommand: ${action}`);
}

function handleTrashList(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  if (boolFlag(parsed, "all")) {
    const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
    const validation = validateRegisteredLedgersOrThrow(registryPath);
    if (!validation.ok) return printRegisteredLedgerValidation(registryPath, validation.results, json);
    const results = validation.results.map(({ ledger }) => ({ ledger, entries: listTrashedRecords(ledger.path) }));
    if (json) return printJson({ ok: true, registryPath, ledgers: results });
    printTrashListEntries(results);
    process.stdout.write(`registry: ${registryPath}\n`);
    return 0;
  }

  const entries = listTrashedRecords(ledgerPath);
  if (json) return printJson({ ok: true, ledgerPath, entries });
  if (entries.length === 0) {
    process.stdout.write(`no trashed records\nledger: ${ledgerPath}\n`);
    return 0;
  }
  for (const entry of entries) {
    process.stdout.write(`${entry.id} age ${entry.age} target ${entry.targetPath} cleaned ${entry.cleanedAt} receipt ${entry.receiptPath} plan ${entry.cleanupPlanId}\n`);
  }
  process.stdout.write(`ledger: ${ledgerPath}\n`);
  return 0;
}

function handleTrashPurge(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  const execute = boolFlag(parsed, "execute");
  const dryRun = boolFlag(parsed, "dry-run");
  if (dryRun && execute) throw new Error("trash purge accepts either --dry-run or --execute, not both");
  if (boolFlag(parsed, "all")) {
    throw new Error("trash purge --all is not supported; scope the purge to one --ledger and review the plan id before execute");
  }
  if (!dryRun && !execute) throw new Error("trash purge requires either --dry-run or --execute");

  if (execute) {
    const planId = requiredStringFlag(parsed, "plan-id");
    const receipt = executeTrashPurgePlan(ledgerPath, planId);
    if (json) return printJson({ ok: true, receipt });
    process.stdout.write(`trash receipt ${receipt.purgePlanId}: ${receipt.results.length} results\nreceipt: ${receipt.receiptPath}\nledger: ${ledgerPath}\n`);
    return 0;
  }

  const olderThan = requiredStringFlag(parsed, "older-than");
  const plan = createTrashPurgePlan(ledgerPath, olderThan);
  if (json) return printJson({ ok: true, plan });
  if (plan.entries.length === 0) {
    process.stdout.write(`trash purge plan ${plan.purgePlanId}: no matching trashed records\nledger: ${ledgerPath}\n`);
    return 0;
  }
  process.stdout.write(`trash purge plan ${plan.purgePlanId}: ${plan.entries.length} entries, ${plan.skipped.length} skipped\n`);
  process.stdout.write(`plan: ${plan.planPath ?? "not-created"}\nledger: ${ledgerPath}\n`);
  return 0;
}

function handleReview(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  if (boolFlag(parsed, "all")) {
    const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
    const results = registeredLedgersOrThrow(registryPath).map((ledger) => reviewLedger(ledger));
    const ok = results.every((entry) => entry.validate.ok);
    const summary = summarizeReview(results);
    const nextAction = reviewNextAction(summary);
    if (json) {
      printJson({ ok, registryPath, summary, nextAction, ledgers: results });
      return ok ? 0 : 1;
    }
    printReviewAll(results, summary, nextAction, registryPath);
    return ok ? 0 : 1;
  }
  const result = reviewLedger({ name: "current", path: ledgerPath, scope: "other", createdAt: "", updatedAt: "" }, false);
  if (json) {
    printJson({ ok: result.validate.ok, ledger: result });
    return result.validate.ok ? 0 : 1;
  }
  printReview([result]);
  return result.validate.ok ? 0 : 1;
}

type DoctorLedger = {
  name: string;
  path: string;
  scope: LedgerRegistryEntry["scope"];
  status: "ok" | "missing" | "invalid";
  ok: boolean;
  entries: number;
  errors: string[];
  warnings: string[];
};

type DoctorReport = {
  ok: boolean;
  version: string;
  node: string;
  ledgerPath: string;
  ledgerExists: boolean;
  registryPath: string;
  registryExists: boolean;
  registryOk: boolean;
  registryError: string | null;
  ledgers: DoctorLedger[];
  summary: { ledgers: number; ok: number; stale: number; invalid: number; warnings: number };
  cleanupSafety: {
    executeRequiresLedgerAndPlanId: boolean;
    globalExecuteRefused: boolean;
    deleteRefusedInV1: boolean;
    dryRunBeforeMutation: boolean;
  };
  errors: string[];
};

function handleDoctor(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  const report = buildDoctorReport(ledgerPath, normalizeRegistryPath(stringFlag(parsed, "registry")));
  if (json) {
    printJson(report);
    return report.ok ? 0 : 1;
  }
  printDoctor(report);
  return report.ok ? 0 : 1;
}

function buildDoctorReport(ledgerPath: string, registryPath: string): DoctorReport {
  const errors: string[] = [];
  let registryOk = true;
  let registryError: string | null = null;
  let entries: LedgerRegistryEntry[] = [];
  try {
    entries = listRegisteredLedgers(registryPath);
  } catch (error) {
    registryOk = false;
    registryError = (error as Error).message;
    errors.push(`registry could not be read: ${registryPath} (${registryError})`);
  }

  const ledgers: DoctorLedger[] = entries.map((entry) => {
    const result = validateRegisteredLedger(entry);
    const status: DoctorLedger["status"] = result.ok ? "ok" : existsSync(entry.path) ? "invalid" : "missing";
    if (!result.ok) {
      for (const message of result.errors) errors.push(`${entry.name}: ${message}`);
    }
    return {
      name: entry.name,
      path: entry.path,
      scope: entry.scope,
      status,
      ok: result.ok,
      entries: result.entries,
      errors: result.errors,
      warnings: result.warnings
    };
  });

  const summary = {
    ledgers: ledgers.length,
    ok: ledgers.filter((ledger) => ledger.status === "ok").length,
    stale: ledgers.filter((ledger) => ledger.status === "missing").length,
    invalid: ledgers.filter((ledger) => ledger.status === "invalid").length,
    warnings: ledgers.reduce((count, ledger) => count + ledger.warnings.length, 0)
  };

  return {
    ok: registryOk && summary.stale === 0 && summary.invalid === 0,
    version: VERSION,
    node: process.version,
    ledgerPath,
    ledgerExists: existsSync(ledgerPath),
    registryPath,
    registryExists: existsSync(registryPath),
    registryOk,
    registryError,
    ledgers,
    summary,
    cleanupSafety: {
      executeRequiresLedgerAndPlanId: true,
      globalExecuteRefused: true,
      deleteRefusedInV1: true,
      dryRunBeforeMutation: true
    },
    errors
  };
}

function printDoctor(report: DoctorReport): void {
  process.stdout.write(`shelf ${report.version} (node ${report.node})\n`);
  process.stdout.write(`health: ${report.ok ? "ok" : "needs attention"}\n`);
  process.stdout.write(`ledger: ${report.ledgerPath}${report.ledgerExists ? "" : " (absent)"}\n`);
  process.stdout.write(`registry: ${report.registryPath}${report.registryExists ? "" : " (absent)"}\n`);
  if (report.registryError) process.stdout.write(`registry error: ${report.registryError}\n`);
  process.stdout.write(`registered ledgers: ${report.summary.ledgers} (${report.summary.ok} ok, ${report.summary.stale} stale, ${report.summary.invalid} invalid)\n`);
  for (const ledger of report.ledgers) {
    process.stdout.write(`  ${ledger.status} ${ledger.name} ${ledger.path}\n`);
    for (const message of ledger.errors) process.stdout.write(`    error: ${message}\n`);
  }
  process.stdout.write("cleanup safety: execute requires a reviewed plan id against a single ledger; --all execute is refused; cleanup=delete is refused; physical trash purge requires a separate reviewed plan\n");
  if (!report.ok) {
    for (const message of report.errors) process.stdout.write(`error: ${message}\n`);
  }
}

type StatusCounts = {
  active: number;
  due: number;
  manualReview: number;
  missingPath: number;
  kept: number;
  pendingCleanup: number;
};

type StatusLedger = {
  name: string;
  path: string;
  scope: LedgerRegistryEntry["scope"];
  status: "ok" | "missing" | "invalid";
  ok: boolean;
  counts: StatusCounts;
  errors: string[];
};

type StatusReport = {
  ok: boolean;
  registryPath: string;
  registryExists: boolean;
  registryOk: boolean;
  registryError: string | null;
  ledgers: StatusLedger[];
  totals: StatusCounts & { ledgers: number; ok: number; stale: number; invalid: number };
};

function handleStatus(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  if (boolFlag(parsed, "all")) {
    const report = buildStatusReport(normalizeRegistryPath(stringFlag(parsed, "registry")));
    if (json) {
      printJson(report);
      return report.ok ? 0 : 1;
    }
    printStatusAll(report);
    return report.ok ? 0 : 1;
  }
  const ledger = statusLedger({ name: "current", path: ledgerPath, scope: "other", createdAt: "", updatedAt: "" }, false);
  if (json) {
    printJson({ ok: ledger.ok, ledger });
    return ledger.ok ? 0 : 1;
  }
  printStatusSingle(ledger);
  return ledger.ok ? 0 : 1;
}

function buildStatusReport(registryPath: string): StatusReport {
  let registryOk = true;
  let registryError: string | null = null;
  let entries: LedgerRegistryEntry[] = [];
  try {
    entries = listRegisteredLedgers(registryPath);
  } catch (error) {
    registryOk = false;
    registryError = (error as Error).message;
  }

  const ledgers = entries.map((entry) => statusLedger(entry));
  const totals = {
    ledgers: ledgers.length,
    ok: ledgers.filter((ledger) => ledger.status === "ok").length,
    stale: ledgers.filter((ledger) => ledger.status === "missing").length,
    invalid: ledgers.filter((ledger) => ledger.status === "invalid").length,
    active: sumStatusCounts(ledgers, "active"),
    due: sumStatusCounts(ledgers, "due"),
    manualReview: sumStatusCounts(ledgers, "manualReview"),
    missingPath: sumStatusCounts(ledgers, "missingPath"),
    kept: sumStatusCounts(ledgers, "kept"),
    pendingCleanup: sumStatusCounts(ledgers, "pendingCleanup")
  };

  return {
    ok: registryOk && totals.stale === 0 && totals.invalid === 0,
    registryPath,
    registryExists: existsSync(registryPath),
    registryOk,
    registryError,
    ledgers,
    totals
  };
}

function statusLedger(ledger: LedgerRegistryEntry, registered = true): StatusLedger {
  const validate = registered ? validateRegisteredLedger(ledger) : validateLedger(ledger.path);
  if (!validate.ok) {
    return {
      name: ledger.name,
      path: ledger.path,
      scope: ledger.scope,
      status: existsSync(ledger.path) ? "invalid" : "missing",
      ok: false,
      counts: emptyStatusCounts(),
      errors: validate.errors
    };
  }

  const records = readLedger(ledger.path);
  const due = dueEntries(records);
  const counts: StatusCounts = {
    active: records.filter((record) => record.status === "active").length,
    due: due.filter((entry) => entry.dueStatus === "due").length,
    manualReview: due.filter((entry) => entry.dueStatus === "manual-review").length,
    missingPath: due.filter((entry) => entry.dueStatus === "missing-path").length,
    kept: due.filter((entry) => entry.dueStatus === "kept").length,
    pendingCleanup: previewCleanupPlan(ledger.path).entries.length
  };

  return {
    name: ledger.name,
    path: ledger.path,
    scope: ledger.scope,
    status: "ok",
    ok: true,
    counts,
    errors: []
  };
}

function emptyStatusCounts(): StatusCounts {
  return { active: 0, due: 0, manualReview: 0, missingPath: 0, kept: 0, pendingCleanup: 0 };
}

function sumStatusCounts(ledgers: StatusLedger[], key: keyof StatusCounts): number {
  return ledgers.reduce((total, ledger) => total + ledger.counts[key], 0);
}

function formatStatusCounts(counts: StatusCounts): string {
  return `active ${counts.active} · due ${counts.due} · manual-review ${counts.manualReview} · missing ${counts.missingPath} · kept ${counts.kept} · pending ${counts.pendingCleanup}`;
}

function printStatusAll(report: StatusReport): void {
  process.stdout.write(`shelf status: ${report.ok ? "ok" : "needs attention"}\n`);
  process.stdout.write(`registry: ${report.registryPath}${report.registryExists ? "" : " (absent)"} — ${report.totals.ledgers} ledgers (${report.totals.ok} ok, ${report.totals.stale} stale, ${report.totals.invalid} invalid)\n`);
  if (report.registryError) process.stdout.write(`registry error: ${report.registryError}\n`);
  for (const ledger of report.ledgers) {
    if (ledger.status === "ok") {
      process.stdout.write(`[${ledger.name}] ${formatStatusCounts(ledger.counts)}\n`);
    } else {
      process.stdout.write(`[${ledger.name}] ${ledger.status}: ${ledger.errors.join("; ")}\n`);
    }
  }
  process.stdout.write(`total: ${formatStatusCounts(report.totals)}\n`);
}

function printStatusSingle(ledger: StatusLedger): void {
  process.stdout.write(`shelf status: ${ledger.ok ? "ok" : ledger.status}\n`);
  process.stdout.write(`ledger: ${ledger.path}\n`);
  if (ledger.ok) {
    process.stdout.write(`${formatStatusCounts(ledger.counts)}\n`);
  } else {
    for (const message of ledger.errors) process.stdout.write(`error: ${message}\n`);
  }
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
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }

    if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown flag: --${name}`);

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

function registeredLedgersOrThrow(registryPath: string): LedgerRegistryEntry[] {
  const ledgers = listRegisteredLedgers(registryPath);
  if (ledgers.length === 0) throw new Error("No registered Shelf ledgers. Run `shelf ledgers add --ledger <path>` first.");
  return ledgers;
}

type RegisteredLedgerValidation = { ledger: LedgerRegistryEntry; result: ReturnType<typeof validateLedger> };

function validateRegisteredLedgersOrThrow(registryPath: string): { ok: boolean; results: RegisteredLedgerValidation[] } {
  const results = registeredLedgersOrThrow(registryPath).map((ledger) => ({ ledger, result: validateRegisteredLedger(ledger) }));
  return { ok: results.every((entry) => entry.result.ok), results };
}

function printRegisteredLedgerValidation(registryPath: string, results: RegisteredLedgerValidation[], json: boolean): number {
  if (json) {
    printJson({ ok: false, registryPath, ledgers: results });
    return 1;
  }
  for (const entry of results.filter((item) => !item.result.ok)) {
    process.stdout.write(`invalid ${entry.ledger.name}: ${entry.result.errors.join("; ")}\nledger: ${entry.ledger.path}\n`);
  }
  process.stdout.write(`registry: ${registryPath}\n`);
  return 1;
}

function validateRegisteredLedger(ledger: LedgerRegistryEntry): ReturnType<typeof validateLedger> {
  if (!existsSync(ledger.path)) {
    return {
      ok: false,
      errors: [`registered ledger is missing: ${ledger.path}`],
      warnings: [],
      entries: 0
    };
  }
  return validateLedger(ledger.path);
}

type ReviewResult = {
  ledger: LedgerRegistryEntry;
  validate: ReturnType<typeof validateLedger>;
  due: DueEntry[];
  plan: CleanupPlan;
};

type ReviewSummary = {
  ledgers: number;
  ok: number;
  invalid: number;
  stale: number;
  affected: number;
  due: number;
  manualReview: number;
  missingPath: number;
  executable: number;
  skipped: number;
  previewPlanIds: string[];
};

function reviewLedger(ledger: LedgerRegistryEntry, registered = true): ReviewResult {
  const validate = registered ? validateRegisteredLedger(ledger) : validateLedger(ledger.path);
  if (!validate.ok) {
    return {
      ledger,
      validate,
      due: [],
      plan: emptyReviewPlan(ledger.path)
    };
  }

  return {
    ledger,
    validate,
    due: dueEntries(readLedger(ledger.path)),
    plan: previewCleanupPlan(ledger.path)
  };
}

function emptyReviewPlan(ledgerPath: string): CleanupPlan {
  return {
    planId: "not-created",
    generatedAt: "",
    ledgerPath,
    entries: [],
    skipped: [],
    planPath: null
  };
}

function printLedgerEntries(results: Array<{ ledger: LedgerRegistryEntry; entries: ShelfRecord[] }>, status?: string): void {
  const total = results.reduce((count, result) => count + result.entries.length, 0);
  if (total === 0) {
    process.stdout.write(`no shelf entries${status ? ` with status ${status}` : ""}\n`);
    return;
  }
  for (const result of results) {
    if (result.entries.length === 0) continue;
    process.stdout.write(`\n[${result.ledger.name}] ${result.ledger.path}\n`);
    for (const record of result.entries) {
      process.stdout.write(`${record.id} ${record.kind} ${record.status} ${record.cleanup} ${record.path} :: ${record.reason}\n`);
    }
  }
}

function printDueEntries(results: Array<{ ledger: LedgerRegistryEntry; entries: DueEntry[] }>): void {
  const visible = results.flatMap((result) => result.entries.filter((entry) => entry.dueStatus !== "kept").map((entry) => ({ ledger: result.ledger, entry })));
  if (visible.length === 0) {
    process.stdout.write("nothing due\n");
    return;
  }
  for (const item of visible) {
    process.stdout.write(`${item.entry.dueStatus} ${item.entry.id} ${item.entry.cleanup} ${item.entry.path} :: ${item.entry.reason}\nledger: ${item.ledger.path}\n`);
  }
}

function printPlans(results: Array<{ ledger: LedgerRegistryEntry; plan: CleanupPlan }>): void {
  for (const result of results) {
    process.stdout.write(`plan ${result.plan.planId} [${result.ledger.name}]: ${result.plan.entries.length} entries, ${result.plan.skipped.length} skipped\n`);
    process.stdout.write(`plan: ${result.plan.planPath ?? "not created"}\nledger: ${result.ledger.path}\n`);
  }
}

function printPlan(plan: CleanupPlan, ledgerPath: string): void {
  process.stdout.write(`plan ${plan.planId}: ${plan.entries.length} entries, ${plan.skipped.length} skipped\n`);
  process.stdout.write(`plan: ${plan.planPath ?? "not created"}\nledger: ${ledgerPath}\n`);
}

function printTrashListEntries(results: Array<{ ledger: LedgerRegistryEntry; entries: ReturnType<typeof listTrashedRecords> }>): void {
  const total = results.reduce((count, result) => count + result.entries.length, 0);
  if (total === 0) {
    process.stdout.write("no trashed records\n");
    return;
  }
  for (const result of results) {
    if (result.entries.length === 0) continue;
    process.stdout.write(`\n[${result.ledger.name}] ${result.ledger.path}\n`);
    for (const entry of result.entries) {
      process.stdout.write(`trash ${entry.id} ${entry.age} ${entry.cleanedAt} ${entry.targetPath} -> ${entry.receiptPath} (${entry.cleanupPlanId})\n`);
    }
  }
}

function summarizeReview(results: ReviewResult[]): ReviewSummary {
  const summary: ReviewSummary = {
    ledgers: results.length,
    ok: 0,
    invalid: 0,
    stale: 0,
    affected: 0,
    due: 0,
    manualReview: 0,
    missingPath: 0,
    executable: 0,
    skipped: 0,
    previewPlanIds: []
  };

  for (const result of results) {
    if (result.validate.ok) {
      summary.ok += 1;
    } else if (existsSync(result.ledger.path)) {
      summary.invalid += 1;
    } else {
      summary.stale += 1;
    }

    const due = result.due.filter((entry) => entry.dueStatus === "due").length;
    const manualReview = result.due.filter((entry) => entry.dueStatus === "manual-review").length;
    const missingPath = result.due.filter((entry) => entry.dueStatus === "missing-path").length;
    summary.due += due;
    summary.manualReview += manualReview;
    summary.missingPath += missingPath;
    summary.executable += result.plan.entries.length;
    summary.skipped += result.plan.skipped.length;
    if (result.plan.planId !== "not-created") summary.previewPlanIds.push(result.plan.planId);
    if (!result.validate.ok || due + manualReview + missingPath > 0 || result.plan.entries.length > 0) {
      summary.affected += 1;
    }
  }

  return summary;
}

function reviewNextAction(summary: ReviewSummary): string {
  const broken = summary.invalid + summary.stale;
  if (broken > 0) {
    return `repair ${broken} broken ledger(s) above (re-register or fix the file), then re-run \`shelf review --all\``;
  }
  if (summary.executable > 0) {
    return "run `shelf cleanup --dry-run --all` to generate plans, then `shelf cleanup --execute --plan-id <id> --ledger <path>` for each reviewed plan";
  }
  if (summary.missingPath > 0) {
    return "inspect missing-path entries and `shelf resolve` the ones no longer needed; nothing is auto-executable";
  }
  return "nothing to do — no broken ledgers and no due, manual-review, missing-path, or executable cleanup entries";
}

function printReviewAll(results: ReviewResult[], summary: ReviewSummary, nextAction: string, registryPath: string): void {
  const needsAttention = summary.invalid + summary.stale + summary.executable + summary.due + summary.manualReview + summary.missingPath > 0;
  process.stdout.write(`shelf review --all: ${needsAttention ? "needs attention" : "all clear"}\n`);
  process.stdout.write(`registry: ${registryPath} — ${summary.ledgers} ledgers (${summary.ok} ok, ${summary.invalid} invalid, ${summary.stale} stale)\n`);
  printReview(results);
  process.stdout.write(`triage: due ${summary.due} · manual-review ${summary.manualReview} · missing ${summary.missingPath} · executable ${summary.executable} · skipped ${summary.skipped}\n`);
  process.stdout.write(`next: ${nextAction}\n`);
}

function printReview(results: ReviewResult[]): void {
  for (const result of results) {
    const visibleDue = result.due.filter((entry) => entry.dueStatus !== "kept");
    process.stdout.write(`[${result.ledger.name}] ${result.validate.ok ? "ok" : "invalid"}: ${result.validate.entries} entries, ${result.validate.errors.length} errors, ${result.validate.warnings.length} warnings\n`);
    process.stdout.write(`due/manual/missing: ${visibleDue.length}; plan ${result.plan.planId}: ${result.plan.entries.length} entries, ${result.plan.skipped.length} skipped\n`);
    process.stdout.write(`ledger: ${result.ledger.path}\n`);
  }
}

function printHelp(command?: string): void {
  if (command === "put") {
    process.stdout.write(`Usage:
  shelf put <path> --reason <text> (--ttl <ttl>|--retain-until <date>|--manual-review) [options]

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
  shelf cleanup --dry-run [--ledger <path>] [--json]
  shelf cleanup --dry-run --all [--registry <path>] [--json]
  shelf cleanup --execute --plan-id <id> [--ledger <path>] [--json]

Cleanup execution is approval-only. There is no daemon, no auto-execute, and no
global execute path: review a dry-run plan, then execute that one reviewed plan id.
Cleanup is ledger-first. Execute never computes a fresh live set; it only uses a reviewed plan id.
cleanup=delete records cleanup-refused instead of deleting files; physical trash purge needs a separate reviewed plan.
Dry-run writes and registers a plan only when executable cleanup entries exist; no-op dry-runs report not-created.
Matching dry-runs reuse the existing plan id and refresh its Shelf-owned plan artifact.
Execute writes and registers a Shelf-owned receipt artifact.
Global --all mode is dry-run only.
`);
    return;
  }

  if (command === "trash") {
    process.stdout.write(`Usage:
  shelf trash list [--ledger <path>] [--all] [--json]
  shelf trash purge --older-than <ttl> --dry-run [--ledger <path>] [--json]
  shelf trash purge --execute --plan-id <id> [--ledger <path>] [--json]

Trash is approval-first. Use list to inspect what is currently in Shelf trash and
dry-run purge to generate a reviewed plan id for age-based deletion. Purge
requires either --dry-run or --execute. Execute requires a reviewed plan id, and
trash purge is always scoped to one --ledger; --all is not supported for purge
(only for trash list).
Trash receipt artifacts are registered when purge executes. Purged records are
resolved and no longer reappear as trashed.
`);
    return;
  }

  if (command === "ledgers") {
    process.stdout.write(`Usage:
  shelf ledgers list [--plain] [--registry <path>] [--json]
  shelf ledgers add --ledger <path> [--name <name>] [--scope repo|user|other] [--registry <path>] [--json]

The ledger registry is a global index of known ledgers. It gives Shelf one read-only entry point without moving project records into one global ledger.
By default \`list\` validates each registered ledger and reports ok/missing/invalid status, entry counts, and warning/error counts so agents can spot stale registry entries without a separate validate pass; it exits non-zero when the registry or any registered ledger is broken.
Use \`--plain\` for the fast path that lists registered ledgers without reading them.
`);
    return;
  }

  if (command === "list") {
    process.stdout.write(`Usage:
  shelf list [--status <status>] [--ledger <path>] [--json]
  shelf list --all [--status <status>] [--registry <path>] [--json]

Statuses:
  active, review-required, trashed, cleanup-refused, resolved
`);
    return;
  }

  if (command === "find") {
    process.stdout.write(`Usage:
  shelf find (--path <path>|--owner <name>|--label <label>|--status <status>) [options]
  shelf find --all (--path <path>|--owner <name>|--label <label>|--status <status>) [options]

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
  shelf get <id> [--ledger <path>] [--json]
  shelf get <id> --all [--registry <path>] [--json]

Get is read-only and returns one ledger record by Shelf id.
`);
    return;
  }

  if (command === "resolve") {
    process.stdout.write(`Usage:
  shelf resolve <id> --status resolved --reason <text> [--ledger <path>] [--json]

Resolve marks a handled, missing, or no-longer-needed record as manually resolved.
Resolved records stay in the audit trail but no longer participate in due or cleanup planning.
`);
    return;
  }

  if (command === "review") {
    process.stdout.write(`Usage:
  shelf review [--ledger <path>] [--json]
  shelf review --all [--registry <path>] [--json]

Review runs validate, due, and cleanup plan preview without moving files or writing a plan.
With --all, review adds aggregate triage counts and the next safe action.
`);
    return;
  }

  if (command === "doctor") {
    process.stdout.write(`Usage:
  shelf doctor [--registry <path>] [--ledger <path>] [--json]

Doctor reports whether Shelf is healthy on this machine: CLI version, selected
or default ledger path, selected or global registry path, registered ledger health
(stale/missing/invalid), and the cleanup safety posture. Execute is scoped to one
selected or default ledger and still requires a reviewed plan id; --all execute
and physical delete are refused in v1.

Run it after install, when --all commands behave unexpectedly, or on a schedule to
catch stale registry entries. Doctor is read-only. A healthy machine exits 0; a
broken registry or registered ledger exits non-zero with actionable errors.
`);
    return;
  }

  if (command === "status") {
    process.stdout.write(`Usage:
  shelf status [--ledger <path>] [--json]
  shelf status --all [--registry <path>] [--json]

Status is the lightweight daily "what is going on?" view. Without --all, it
reports counts for the selected or default ledger only. With --all, it adds
registry health, total ledgers, and aggregated counts across registered ledgers.
Counts include active artifacts, kept, due, manual-review, missing-path, and
pending cleanup entries.

Human output is short enough to paste into a chat; \`shelf status --all --json\`
is suitable for cron and reporting. Status is read-only: it never creates plans
or receipts and never mutates records. A healthy selected ledger exits 0; with
--all, a broken registry or any stale or invalid registered ledger exits non-zero.
`);
    return;
  }

  process.stdout.write(`Shelf ${VERSION}

Usage:
  shelf put <path> --reason <text> (--ttl <ttl>|--retain-until <date>|--manual-review)
  shelf ledgers list [--plain] [--json]
  shelf ledgers add --ledger <path> [--name <name>] [--json]
  shelf list [--json]
  shelf list --all [--json]
  shelf list --status active [--json]
  shelf find --path <path> [--json]
  shelf find --all --owner <name> [--json]
  shelf get <id> [--json]
  shelf get <id> --all [--json]
  shelf due [--json]
  shelf due --all [--json]
  shelf validate [--json]
  shelf validate --all [--json]
  shelf review [--json]
  shelf review --all [--json]
  shelf doctor [--json]
  shelf status [--json]
  shelf status --all [--json]
  shelf cleanup --dry-run [--json]
  shelf cleanup --dry-run --all [--json]
  shelf cleanup --execute --plan-id <id> [--json]
  shelf trash list [--all] [--ledger <path>] [--json]
  shelf trash purge --older-than <ttl> --dry-run [--ledger <path>] [--json]
  shelf trash purge --execute --plan-id <id> [--ledger <path>] [--json]
  shelf resolve <id> --status resolved --reason <text> [--json]

Global options:
  --ledger <path>        Use an explicit JSONL ledger
  --registry <path>      Use an explicit ledger registry
  --all                  Read all registered ledgers for supported commands
  --json                 Emit machine-readable JSON
  --help                 Show help
  --version              Show version

Examples:
  shelf put tmp/run-output --reason "debug parser output" --ttl 3d --kind scratch
  shelf cleanup --dry-run --json
  shelf cleanup --execute --plan-id plan_20260601_120000_ab12
`);
}

process.exitCode = main(process.argv.slice(2));
