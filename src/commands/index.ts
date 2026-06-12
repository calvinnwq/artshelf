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
} from "../ledger.js";
import {
  listRegisteredLedgers,
  normalizeRegistryPath,
  registerLedger
} from "../registry.js";
import type { LedgerRegistryEntry } from "../registry.js";
import type { CleanupPlan, DueEntry, ArtshelfRecord } from "../types.js";
import { PACKAGE_NAME, VERSION } from "../config/package.js";
import { updateCheckDisabled, updateDryRunEnabled } from "../config/env.js";
import { installGlobalNpmPackage } from "../adapters/process.js";
import {
  buildDoctorAgentPacket,
  printDoctor,
  type DoctorLedger,
  type DoctorReport
} from "../renderers/doctor.js";
import { printCompactJson, printJson } from "../renderers/json.js";
import {
  buildReviewAgentPacketAll,
  buildReviewAgentPacketSingle,
  printReview,
  printReviewAll,
  reviewNextAction,
  type ReviewResult,
  type ReviewSummary
} from "../renderers/review.js";
import {
  buildStatusAgentPacketAll,
  buildStatusAgentPacketSingle,
  emptyStatusCounts,
  printStatusAll,
  printStatusSingle,
  sumStatusCounts,
  type StatusCounts,
  type StatusLedger,
  type StatusReport
} from "../renderers/status.js";
import { arrayFlag, boolFlag, requiredStringFlag, stringFlag } from "../shared/flags.js";
import { LEDGERS_HELP, TRASH_HELP } from "../shared/help-text.js";
import { getUpdateInfo } from "../adapters/update.js";
import type { CommandRunResult, ParsedArgs } from "../shared/cli-types.js";



export async function runCommand(parsed: ParsedArgs): Promise<CommandRunResult> {
  let status = 0;
  let shouldCheckForUpdate = true;

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
    default:
      throw new Error(`Unknown command: ${parsed.command}`);
  }

  return { status, shouldCheckForUpdate };
}

function printHelp(command = ""): void {
  if (command === "ledgers") {
    process.stdout.write(LEDGERS_HELP);
    return;
  }
  if (command === "trash") {
    process.stdout.write(TRASH_HELP);
    return;
  }
  throw new Error(`Unknown help topic: ${command}`);
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
  const agent = boolFlag(parsed, "agent");
  if (boolFlag(parsed, "all")) {
    const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
    const results = registeredLedgersOrThrow(registryPath).map((ledger) => reviewLedger(ledger));
    const ok = results.every((entry) => entry.validate.ok);
    const summary = summarizeReview(results);
    if (agent) {
      printCompactJson(buildReviewAgentPacketAll(results, summary, { path: registryPath, exists: existsSync(registryPath) }));
      return ok ? 0 : 1;
    }
    const nextAction = reviewNextAction(summary, "all");
    if (json) {
      printJson({ ok, registryPath, summary, nextAction, ledgers: results.map(reviewJsonResult) });
      return ok ? 0 : 1;
    }
    printReviewAll(results, summary, nextAction, registryPath);
    return ok ? 0 : 1;
  }
  const result = reviewLedger({ name: "current", path: ledgerPath, scope: "other", createdAt: "", updatedAt: "" }, false);
  const summary = summarizeReview([result]);
  if (agent) {
    printCompactJson(buildReviewAgentPacketSingle(result, summary, ledgerPath));
    return result.validate.ok ? 0 : 1;
  }
  if (json) {
    printJson({ ok: result.validate.ok, ledger: reviewJsonResult(result) });
    return result.validate.ok ? 0 : 1;
  }
  printReview([result]);
  return result.validate.ok ? 0 : 1;
}

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

async function handleUpdate(parsed: ParsedArgs, json: boolean): Promise<number> {
  if (parsed.positionals.length > 0) throw new Error("update does not accept positional arguments");
  const info = await getUpdateInfo({ force: true });
  if (!info) throw new Error("Could not check npm for the latest Artshelf version");

  if (!info.updateAvailable) {
    if (json) return printJson({ ok: true, updated: false, current: info.current, latest: info.latest });
    process.stdout.write(`artshelf is already up to date: v${info.current}\n`);
    return 0;
  }

  if (updateDryRunEnabled()) {
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
  const result = installGlobalNpmPackage(`${PACKAGE_NAME}@latest`, json ? "pipe" : "inherit");
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

export async function maybeNotifyAvailableUpdate(parsed: ParsedArgs): Promise<void> {
  if (updateCheckDisabled()) return;
  if (parsed.command === "update") return;
  const info = await getUpdateInfo({ force: false });
  if (!info?.updateAvailable) return;
  process.stderr.write(`A new version of artshelf is available: v${info.current} -> v${info.latest}\n`);
  process.stderr.write(`Run "artshelf update" to update npm installs\n`);
}

// Agent/compact surface: a single minified JSON line. The default `--json`
// stays pretty-printed for audit/debug; agent packets optimize for tokens.

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

function reviewLedger(ledger: LedgerRegistryEntry, registered = true): ReviewResult {
  const validate = registered ? validateRegisteredLedger(ledger) : validateLedger(ledger.path);
  const ledgerExists = existsSync(ledger.path);
  if (!validate.ok) {
    return {
      ledger,
      ledgerExists,
      validate,
      due: [],
      plan: emptyReviewPlan(ledger.path)
    };
  }

  return {
    ledger,
    ledgerExists,
    validate,
    due: dueEntries(readLedger(ledger.path)),
    plan: previewCleanupPlan(ledger.path)
  };
}

function reviewJsonResult(result: ReviewResult): Omit<ReviewResult, "ledgerExists"> {
  const { ledgerExists: _ledgerExists, ...jsonResult } = result;
  return jsonResult;
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
    } else if (result.ledgerExists) {
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
