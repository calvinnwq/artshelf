#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
import type { CleanupPlan, DueEntry, ArtshelfRecord } from "./types.js";

const VERSION = readPackageVersion();
const PACKAGE_NAME = "artshelf";
const NPM_REGISTRY_URL = process.env.ARTSHELF_NPM_REGISTRY_URL ?? `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const BOOLEAN_FLAGS = new Set(["all", "json", "agent", "manual-review", "dry-run", "execute", "help", "version", "plain"]);
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

function readPackageVersion(): string {
  const packageJsonPath = decodeURIComponent(new URL("../../package.json", import.meta.url).pathname);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json version must be a string");
  }
  return packageJson.version;
}

type ParsedArgs = {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string | boolean | string[]>;
};

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

    switch (parsed.command) {
      case "put":
        status = handlePut(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
        break;
      case "ledgers":
        status = handleLedgers(parsed, boolFlag(parsed, "json"));
        break;
      case "list":
        status = handleList(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
        break;
      case "find":
        status = handleFind(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
        break;
      case "get":
        status = handleGet(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
        break;
      case "due":
        status = handleDue(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
        break;
      case "validate":
        status = handleValidate(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
        break;
      case "cleanup":
        status = handleCleanup(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
        break;
      case "trash":
        status = handleTrash(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
        break;
      case "review":
        status = handleReview(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
        break;
      case "doctor":
        status = handleDoctor(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
        break;
      case "status":
        status = handleStatus(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
        break;
      case "resolve":
        status = handleResolve(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
        break;
      case "update":
        shouldCheckForUpdate = false;
        status = await handleUpdate(parsed, boolFlag(parsed, "json"));
        break;
      case undefined:
        printHelp();
        status = 0;
        break;
      default:
        throw new Error(`Unknown command: ${parsed.command}`);
    }
    if (!shouldCheckForUpdate) return status;
    return maybeNotifyUpdateAndReturn(status, parsed);
  } catch (error) {
    process.stderr.write(`artshelf: ${(error as Error).message}\nRun \`artshelf help\` for usage.\n`);
    return 1;
  }
}

async function maybeNotifyUpdateAndReturn(status: number, parsed: ParsedArgs): Promise<number> {
  await maybeNotifyAvailableUpdate(parsed);
  return status;
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
  if (action === "help") {
    printHelp("ledgers");
    return 0;
  }
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
        process.stdout.write(`no registered Artshelf ledgers\nregistry: ${registryPath}\n`);
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
  process.stdout.write(`artshelf ledgers: ${report.ok ? "ok" : "needs attention"}\n`);
  process.stdout.write(`registry: ${report.registryPath}${report.registryExists ? "" : " (absent)"} — ${report.summary.ledgers} ledgers (${report.summary.ok} ok, ${report.summary.stale} stale, ${report.summary.invalid} invalid)\n`);
  if (report.registryError) process.stdout.write(`registry error: ${report.registryError}\n`);
  if (report.ledgers.length === 0) {
    process.stdout.write("no registered Artshelf ledgers\n");
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
    process.stdout.write(`no artshelf entries${status ? ` with status ${status}` : ""}\nledger: ${ledgerPath}\n`);
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
    process.stdout.write(`no matching artshelf entries\nledger: ${ledgerPath}\n`);
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
    throw new Error(`Artshelf record not found: ${id}`);
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
  if (boolFlag(parsed, "agent")) {
    printCompactJson(buildDoctorAgentPacket(report));
    return report.ok ? 0 : 1;
  }
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

// Agent render: a compact, deterministic decision packet for `doctor`. It keeps
// the audited registry/ledger health intact while naming the actionable
// categories, the exact blockers, the cleanup-safety posture, the next safe
// action, and the command an agent can re-run to verify. Existing `--json` stays
// the full audit report; this is a separate, token-efficient surface.
type DoctorAgentPacket = {
  schemaVersion: 1;
  command: "doctor";
  health: "ok" | "attention";
  version: string;
  node: string;
  ledgerPath: string;
  registry: { path: string; exists: boolean; ok: boolean; error: string | null };
  ledgers: { total: number; ok: number; stale: number; invalid: number; warnings: number };
  attention: string[];
  blockers: string[];
  cleanupSafety: DoctorReport["cleanupSafety"];
  nextAction: string;
  verification: string;
};

// Actionable categories only — ok ledgers are healthy states, never attention.
// Order is fixed so the packet is byte-for-byte deterministic. Warnings surface
// even when health is ok (they never fail the machine), mirroring status attention.
const DOCTOR_ATTENTION_CATEGORIES: ReadonlyArray<keyof DoctorReport["summary"]> = ["stale", "invalid", "warnings"];

function doctorAttention(summary: DoctorReport["summary"]): string[] {
  return DOCTOR_ATTENTION_CATEGORIES.filter((key) => summary[key] > 0);
}

function doctorNextAction(blockers: string[], summary: DoctorReport["summary"]): string {
  if (blockers.length > 0) {
    return `repair ${blockers.length} registry/ledger issue(s) above, then re-run \`artshelf doctor\``;
  }
  if (summary.warnings > 0) {
    return `healthy, but ${summary.warnings} warning(s) noted — run \`artshelf validate --all\` to inspect; nothing is auto-executed`;
  }
  return "artshelf is healthy on this machine — cleanup safety enforced; no action needed";
}

function buildDoctorAgentPacket(report: DoctorReport): DoctorAgentPacket {
  const blockers: string[] = [];
  if (report.registryError) blockers.push(`registry unreadable: ${report.registryError}`);
  for (const ledger of report.ledgers) {
    if (ledger.status !== "ok") {
      blockers.push(`${ledger.name} ${ledger.status}${ledger.errors.length ? `: ${ledger.errors[0]}` : ""}`);
    }
  }
  return {
    schemaVersion: 1,
    command: "doctor",
    health: report.ok ? "ok" : "attention",
    version: report.version,
    node: report.node,
    ledgerPath: report.ledgerPath,
    registry: { path: report.registryPath, exists: report.registryExists, ok: report.registryOk, error: report.registryError },
    ledgers: {
      total: report.summary.ledgers,
      ok: report.summary.ok,
      stale: report.summary.stale,
      invalid: report.summary.invalid,
      warnings: report.summary.warnings
    },
    attention: doctorAttention(report.summary),
    blockers,
    cleanupSafety: report.cleanupSafety,
    nextAction: doctorNextAction(blockers, report.summary),
    verification: "artshelf doctor --agent"
  };
}

function printDoctor(report: DoctorReport): void {
  process.stdout.write(`artshelf ${report.version} (node ${report.node})\n`);
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
  const agent = boolFlag(parsed, "agent");
  if (boolFlag(parsed, "all")) {
    const report = buildStatusReport(normalizeRegistryPath(stringFlag(parsed, "registry")));
    if (agent) {
      printCompactJson(buildStatusAgentPacketAll(report));
      return report.ok ? 0 : 1;
    }
    if (json) {
      printJson(report);
      return report.ok ? 0 : 1;
    }
    printStatusAll(report);
    return report.ok ? 0 : 1;
  }
  const ledger = statusLedger({ name: "current", path: ledgerPath, scope: "other", createdAt: "", updatedAt: "" }, false);
  if (agent) {
    printCompactJson(buildStatusAgentPacketSingle(ledger, ledgerPath));
    return ledger.ok ? 0 : 1;
  }
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

// Agent render: a compact, deterministic decision packet for `status`. It keeps
// the audited counts intact while naming the actionable categories, the exact
// blockers, the next safe action, and the command an agent can re-run to verify.
// Existing `--json` stays the full audit report; this is a separate surface.
type StatusAgentPacket = {
  schemaVersion: 1;
  command: "status";
  scope: "all" | "single";
  health: "ok" | "attention";
  ledgerPath?: string;
  registry?: { path: string; exists: boolean; ok: boolean; error: string | null };
  ledgers?: { total: number; ok: number; stale: number; invalid: number };
  counts: StatusCounts;
  attention: string[];
  blockers: string[];
  nextAction: string;
  verification: string;
};

// Actionable categories only — active and kept are healthy states, never
// attention. Order is fixed so the packet is byte-for-byte deterministic.
const STATUS_ATTENTION_CATEGORIES: ReadonlyArray<keyof StatusCounts> = ["due", "manualReview", "missingPath", "pendingCleanup"];

function statusAttention(counts: StatusCounts): string[] {
  return STATUS_ATTENTION_CATEGORIES.filter((key) => counts[key] > 0);
}

function statusNextAction(blockers: string[], counts: StatusCounts, scope: "all" | "single"): string {
  if (blockers.length > 0) {
    const verify = scope === "all" ? "artshelf status --all" : "artshelf status";
    return `repair ${blockers.length} broken ledger(s) above, then re-run \`${verify}\``;
  }
  const review = scope === "all" ? "artshelf review --all" : "artshelf review";
  if (counts.pendingCleanup > 0 || counts.due > 0) {
    return `run \`${review}\` to preview cleanup plans; nothing is auto-executed`;
  }
  if (counts.manualReview > 0) {
    return `run \`${review}\` to inspect manual-review records; nothing is auto-executed`;
  }
  if (counts.missingPath > 0) {
    return "inspect missing-path records and `artshelf resolve` the ones no longer needed; nothing is auto-executable";
  }
  return "nothing due — no broken ledgers and no due, manual-review, missing-path, or pending cleanup entries";
}

function buildStatusAgentPacketAll(report: StatusReport): StatusAgentPacket {
  const blockers: string[] = [];
  if (report.registryError) blockers.push(`registry unreadable: ${report.registryError}`);
  for (const ledger of report.ledgers) {
    if (ledger.status !== "ok") {
      blockers.push(`${ledger.name} ${ledger.status}${ledger.errors.length ? `: ${ledger.errors[0]}` : ""}`);
    }
  }
  const counts: StatusCounts = {
    active: report.totals.active,
    due: report.totals.due,
    manualReview: report.totals.manualReview,
    missingPath: report.totals.missingPath,
    kept: report.totals.kept,
    pendingCleanup: report.totals.pendingCleanup
  };
  return {
    schemaVersion: 1,
    command: "status",
    scope: "all",
    health: report.ok ? "ok" : "attention",
    registry: { path: report.registryPath, exists: report.registryExists, ok: report.registryOk, error: report.registryError },
    ledgers: { total: report.totals.ledgers, ok: report.totals.ok, stale: report.totals.stale, invalid: report.totals.invalid },
    counts,
    attention: statusAttention(counts),
    blockers,
    nextAction: statusNextAction(blockers, counts, "all"),
    verification: "artshelf status --all --agent"
  };
}

function buildStatusAgentPacketSingle(ledger: StatusLedger, ledgerPath: string): StatusAgentPacket {
  const blockers: string[] = ledger.ok
    ? []
    : [`${ledger.status}${ledger.errors.length ? `: ${ledger.errors[0]}` : ""}`];
  return {
    schemaVersion: 1,
    command: "status",
    scope: "single",
    health: ledger.ok ? "ok" : "attention",
    ledgerPath,
    counts: ledger.counts,
    attention: statusAttention(ledger.counts),
    blockers,
    nextAction: statusNextAction(blockers, ledger.counts, "single"),
    verification: `artshelf status --agent --ledger ${ledgerPath}`
  };
}

function printStatusAll(report: StatusReport): void {
  process.stdout.write(`artshelf status: ${report.ok ? "ok" : "needs attention"}\n`);
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
  process.stdout.write(`artshelf status: ${ledger.ok ? "ok" : ledger.status}\n`);
  process.stdout.write(`ledger: ${ledger.path}\n`);
  if (ledger.ok) {
    process.stdout.write(`${formatStatusCounts(ledger.counts)}\n`);
  } else {
    for (const message of ledger.errors) process.stdout.write(`error: ${message}\n`);
  }
}

type UpdateInfo = {
  current: string;
  latest: string;
  updateAvailable: boolean;
};

async function handleUpdate(parsed: ParsedArgs, json: boolean): Promise<number> {
  if (parsed.positionals.length > 0) throw new Error("update does not accept positional arguments");
  const info = await getUpdateInfo({ force: true });
  if (!info) throw new Error("Could not check npm for the latest Artshelf version");

  if (!info.updateAvailable) {
    if (json) return printJson({ ok: true, updated: false, current: info.current, latest: info.latest });
    process.stdout.write(`artshelf is already up to date: v${info.current}\n`);
    return 0;
  }

  if (process.env.ARTSHELF_UPDATE_DRY_RUN === "1") {
    if (json) {
      return printJson({
        ok: true,
        updated: false,
        dryRun: true,
        current: info.current,
        latest: info.latest,
        command: ["npm", "install", "-g", `${PACKAGE_NAME}@latest`]
      });
    }
    process.stdout.write(`A new version of artshelf is available: v${info.current} -> v${info.latest}\n`);
    process.stdout.write(`Dry run: would run "npm install -g ${PACKAGE_NAME}@latest"\n`);
    return 0;
  }

  if (!json) {
    process.stdout.write(`A new version of artshelf is available: v${info.current} -> v${info.latest}\n`);
    process.stdout.write(`Updating with "npm install -g ${PACKAGE_NAME}@latest"...\n`);
  }
  const result = json
    ? spawnSync("npm", ["install", "-g", `${PACKAGE_NAME}@latest`], { encoding: "utf8" })
    : spawnSync("npm", ["install", "-g", `${PACKAGE_NAME}@latest`], { stdio: "inherit" });
  const status = result.status ?? 1;
  const spawnError = result.error instanceof Error ? result.error.message : "";
  if (json) {
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    printJson({
      ok: status === 0,
      updated: status === 0,
      current: info.current,
      latest: info.latest,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: appendOutputMessage(stderr, spawnError)
    });
    return status;
  }
  if (spawnError) process.stderr.write(`Update failed: ${spawnError}\n`);
  if (status === 0) process.stdout.write(`artshelf updated to v${info.latest}\n`);
  return status;
}

function appendOutputMessage(output: string, message: string): string {
  if (!message) return output;
  if (!output) return message;
  return `${output}${output.endsWith("\n") ? "" : "\n"}${message}`;
}

async function maybeNotifyAvailableUpdate(parsed: ParsedArgs): Promise<void> {
  if (process.env.ARTSHELF_NO_UPDATE_CHECK === "1") return;
  if (parsed.command === "update") return;
  const info = await getUpdateInfo({ force: false });
  if (!info?.updateAvailable) return;
  process.stderr.write(`A new version of artshelf is available: v${info.current} -> v${info.latest}\n`);
  process.stderr.write(`Run "artshelf update" to update npm installs\n`);
}

async function getUpdateInfo(options: { force: boolean }): Promise<UpdateInfo | null> {
  const latest = await getLatestVersion(options);
  if (!latest) return null;
  return {
    current: VERSION,
    latest,
    updateAvailable: compareVersions(latest, VERSION) > 0
  };
}

async function getLatestVersion(options: { force: boolean }): Promise<string | null> {
  const override = process.env.ARTSHELF_LATEST_VERSION;
  if (override) return normalizeVersion(override);
  if (!options.force) {
    const cached = readUpdateCache();
    if (cached) return cached.latest;
  }
  const latest = await fetchLatestNpmVersion();
  writeUpdateCache(latest);
  return latest;
}

function readUpdateCache(): { latest: string | null } | null {
  const ttl = Number(process.env.ARTSHELF_UPDATE_CHECK_TTL_MS ?? UPDATE_CHECK_TTL_MS);
  if (ttl < 0) return null;
  const cachePath = updateCachePath();
  if (!existsSync(cachePath)) return null;
  try {
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    if (cache.latest !== null && typeof cache.latest !== "string") return null;
    if (typeof cache.checkedAt !== "number") return null;
    if (Date.now() - cache.checkedAt > ttl) return null;
    return { latest: cache.latest === null ? null : normalizeVersion(cache.latest) };
  } catch {
    return null;
  }
}

function writeUpdateCache(latest: string | null): void {
  try {
    const cachePath = updateCachePath();
    const dir = dirname(cachePath);
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(cachePath, `${JSON.stringify({ latest, checkedAt: Date.now() }, null, 2)}\n`);
    }
  } catch {
    // Update checks should never affect normal CLI behavior.
  }
}

async function fetchLatestNpmVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": `artshelf/${VERSION}` }
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body || typeof body !== "object" || typeof (body as { version?: unknown }).version !== "string") return null;
    return normalizeVersion((body as { version: string }).version);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function updateCachePath(): string {
  return process.env.ARTSHELF_UPDATE_CACHE ?? join(homedir(), ".artshelf", "update-check.json");
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const diff = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function parseVersion(version: string): { numbers: number[]; prerelease: string } {
  const [main = "", prerelease = ""] = normalizeVersion(version).split("-", 2);
  return {
    numbers: main.split(".").map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }),
    prerelease
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags = new Map<string, string | boolean | string[]>();
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg) continue;
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (arg === "-v") {
      flags.set("version", true);
      continue;
    }
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

// Agent/compact surface: a single minified JSON line. The default `--json`
// stays pretty-printed for audit/debug; agent packets optimize for tokens.
function printCompactJson(value: unknown): number {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  return 0;
}

function registeredLedgersOrThrow(registryPath: string): LedgerRegistryEntry[] {
  const ledgers = listRegisteredLedgers(registryPath);
  if (ledgers.length === 0) throw new Error("No registered Artshelf ledgers. Run `artshelf ledgers add --ledger <path>` first.");
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

function printLedgerEntries(results: Array<{ ledger: LedgerRegistryEntry; entries: ArtshelfRecord[] }>, status?: string): void {
  const total = results.reduce((count, result) => count + result.entries.length, 0);
  if (total === 0) {
    process.stdout.write(`no artshelf entries${status ? ` with status ${status}` : ""}\n`);
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
    return `repair ${broken} broken ledger(s) above (re-register or fix the file), then re-run \`artshelf review --all\``;
  }
  if (summary.executable > 0) {
    return "run `artshelf cleanup --dry-run --all` to generate plans, then `artshelf cleanup --execute --plan-id <id> --ledger <path>` for each reviewed plan";
  }
  if (summary.missingPath > 0) {
    return "inspect missing-path entries and `artshelf resolve` the ones no longer needed; nothing is auto-executable";
  }
  return "nothing to do — no broken ledgers and no due, manual-review, missing-path, or executable cleanup entries";
}

function printReviewAll(results: ReviewResult[], summary: ReviewSummary, nextAction: string, registryPath: string): void {
  const needsAttention = summary.invalid + summary.stale + summary.executable + summary.due + summary.manualReview + summary.missingPath > 0;
  process.stdout.write(`artshelf review --all: ${needsAttention ? "needs attention" : "all clear"}\n`);
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

// Static help metadata. Keep the top-level help generated from this table so the
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
    process.stdout.write(`Inspect and purge Artshelf trash.

Usage:
  artshelf trash [command]

Available Commands:
  list      List records currently held in Artshelf trash
  purge     Plan or execute approved permanent trash deletion

Flags:
  -h, --help   help for trash

Use "artshelf trash <command> --help" for more information about a command.
`);
    return;
  }

  if (command === "ledgers") {
    process.stdout.write(`Manage the ledger registry.

Usage:
  artshelf ledgers [command]

Available Commands:
  list      List and validate registered ledgers
  add       Register an existing ledger file

Flags:
  -h, --help   help for ledgers

Use "artshelf ledgers <command> --help" for more information about a command.
`);
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
  artshelf review [--ledger <path>] [--json]
  artshelf review --all [--registry <path>] [--json]

Review runs validate, due, and cleanup plan preview without moving files or writing a plan.
With --all, review adds aggregate triage counts and the next safe action.
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
    process.stderr.write(`artshelf: ${(error as Error).message}\nRun \`artshelf help\` for usage.\n`);
    process.exitCode = 1;
  });
