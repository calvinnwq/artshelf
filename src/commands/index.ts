import { spawnSync } from "node:child_process";
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
import { attentionGlyph } from "../renderers/attention.js";
import { printCompactJson, printJson } from "../renderers/json.js";
import { arrayFlag, boolFlag, requiredStringFlag, stringFlag } from "../shared/flags.js";
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
      printCompactJson(buildReviewAgentPacketAll(results, summary, registryPath));
      return ok ? 0 : 1;
    }
    const nextAction = reviewNextAction(summary, "all");
    if (json) {
      printJson({ ok, registryPath, summary, nextAction, ledgers: results });
      return ok ? 0 : 1;
    }
    printReviewAll(results, summary, nextAction, registryPath);
    return ok ? 0 : 1;
  }
  const result = reviewLedger({ name: "current", path: ledgerPath, scope: "other", createdAt: "", updatedAt: "" }, false);
  if (agent) {
    printCompactJson(buildReviewAgentPacketSingle(result, ledgerPath));
    return result.validate.ok ? 0 : 1;
  }
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
    verification: `artshelf doctor --agent --registry ${report.registryPath}`
  };
}

// Human render (NGX-396): a scannable left-column glyph so attention state is
// obvious at a glance — ✓ clear, ⚠ needs attention. Plain Unicode (no ANSI
// color) keeps redirected/piped human output clean, and the `--agent`/`--json`
// renders never carry glyphs (those stay machine contracts).
const HUMAN_ATTENTION_GLYPH = "⚠";


function printDoctor(report: DoctorReport): void {
  process.stdout.write(`artshelf ${report.version} (node ${report.node})\n`);
  process.stdout.write(`${attentionGlyph(!report.ok)} health: ${report.ok ? "ok" : "needs attention"}\n`);
  process.stdout.write(`ledger: ${report.ledgerPath}${report.ledgerExists ? "" : " (absent)"}\n`);
  process.stdout.write(`registry: ${report.registryPath}${report.registryExists ? "" : " (absent)"}\n`);
  if (report.registryError) process.stdout.write(`registry error: ${report.registryError}\n`);
  process.stdout.write(`registered ledgers: ${report.summary.ledgers} (${report.summary.ok} ok, ${report.summary.stale} stale, ${report.summary.invalid} invalid)\n`);
  for (const ledger of report.ledgers) {
    process.stdout.write(`  ${attentionGlyph(ledger.status !== "ok")} ${ledger.status} ${ledger.name} ${ledger.path}\n`);
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

function statusCommand(scope: "all" | "single", command: "status" | "review", ledgerPath?: string): string {
  if (scope === "all") return `artshelf ${command} --all`;
  return ledgerPath ? `artshelf ${command} --ledger ${ledgerPath}` : `artshelf ${command}`;
}

function statusNextAction(blockers: string[], counts: StatusCounts, scope: "all" | "single", ledgerPath?: string): string {
  if (blockers.length > 0) {
    const verify = statusCommand(scope, "status", ledgerPath);
    return `repair ${blockers.length} broken ledger(s) above, then re-run \`${verify}\``;
  }
  const review = statusCommand(scope, "review", ledgerPath);
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
    verification: `artshelf status --all --agent --registry ${report.registryPath}`
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
    nextAction: statusNextAction(blockers, ledger.counts, "single", ledgerPath),
    verification: `artshelf status --agent --ledger ${ledgerPath}`
  };
}

function printStatusAll(report: StatusReport): void {
  const anyActionable = report.ledgers.some((ledger) => statusAttention(ledger.counts).length > 0);
  process.stdout.write(`${attentionGlyph(!report.ok || anyActionable)} artshelf status: ${report.ok ? "ok" : "needs attention"}\n`);
  process.stdout.write(`registry: ${report.registryPath}${report.registryExists ? "" : " (absent)"} — ${report.totals.ledgers} ledgers (${report.totals.ok} ok, ${report.totals.stale} stale, ${report.totals.invalid} invalid)\n`);
  if (report.registryError) process.stdout.write(`registry error: ${report.registryError}\n`);
  for (const ledger of report.ledgers) {
    if (ledger.status === "ok") {
      process.stdout.write(`${attentionGlyph(statusAttention(ledger.counts).length > 0)} [${ledger.name}] ${formatStatusCounts(ledger.counts)}\n`);
    } else {
      process.stdout.write(`${HUMAN_ATTENTION_GLYPH} [${ledger.name}] ${ledger.status}: ${ledger.errors.join("; ")}\n`);
    }
  }
  process.stdout.write(`total: ${formatStatusCounts(report.totals)}\n`);
}

function printStatusSingle(ledger: StatusLedger): void {
  const needsAttention = !ledger.ok || statusAttention(ledger.counts).length > 0;
  process.stdout.write(`${attentionGlyph(needsAttention)} artshelf status: ${ledger.ok ? "ok" : ledger.status}\n`);
  process.stdout.write(`ledger: ${ledger.path}\n`);
  if (ledger.ok) {
    process.stdout.write(`${formatStatusCounts(ledger.counts)}\n`);
  } else {
    for (const message of ledger.errors) process.stdout.write(`error: ${message}\n`);
  }
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

export async function maybeNotifyAvailableUpdate(parsed: ParsedArgs): Promise<void> {
  if (process.env.ARTSHELF_NO_UPDATE_CHECK === "1") return;
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

function reviewNextAction(summary: ReviewSummary, scope: "all" | "single", ledgerPath?: string): string {
  const broken = summary.invalid + summary.stale;
  const review = statusCommand(scope, "review", ledgerPath);
  if (broken > 0) {
    const repair = scope === "all" ? "re-register or fix the file" : "fix the file";
    return `repair ${broken} broken ledger(s) above (${repair}), then re-run \`${review}\``;
  }
  if (summary.executable > 0) {
    const dryRun = scope === "all" ? "artshelf cleanup --dry-run --all" : `artshelf cleanup --dry-run${ledgerPath ? ` --ledger ${ledgerPath}` : ""}`;
    return `run \`${dryRun}\` to generate plans, then \`artshelf cleanup --execute --plan-id <id> --ledger <path>\` for each reviewed plan`;
  }
  if (summary.missingPath > 0) {
    return "inspect missing-path entries and `artshelf resolve` the ones no longer needed; nothing is auto-executable";
  }
  return "nothing to do — no broken ledgers and no due, manual-review, missing-path, or executable cleanup entries";
}

function printReviewAll(results: ReviewResult[], summary: ReviewSummary, nextAction: string, registryPath: string): void {
  const needsAttention = summary.invalid + summary.stale + summary.executable + summary.due + summary.manualReview + summary.missingPath > 0;
  process.stdout.write(`${attentionGlyph(needsAttention)} artshelf review --all: ${needsAttention ? "needs attention" : "all clear"}\n`);
  process.stdout.write(`registry: ${registryPath} — ${summary.ledgers} ledgers (${summary.ok} ok, ${summary.invalid} invalid, ${summary.stale} stale)\n`);
  printReview(results);
  process.stdout.write(`triage: due ${summary.due} · manual-review ${summary.manualReview} · missing ${summary.missingPath} · executable ${summary.executable} · skipped ${summary.skipped}\n`);
  process.stdout.write(`next: ${nextAction}\n`);
}

function printReview(results: ReviewResult[]): void {
  for (const result of results) {
    const visibleDue = result.due.filter((entry) => entry.dueStatus !== "kept");
    const needsAttention = !result.validate.ok || visibleDue.length > 0 || result.plan.entries.length > 0;
    process.stdout.write(`${attentionGlyph(needsAttention)} [${result.ledger.name}] ${result.validate.ok ? "ok" : "invalid"}: ${result.validate.entries} entries, ${result.validate.errors.length} errors, ${result.validate.warnings.length} warnings\n`);
    process.stdout.write(`due/manual/missing: ${visibleDue.length}; plan ${result.plan.planId}: ${result.plan.entries.length} entries, ${result.plan.skipped.length} skipped\n`);
    process.stdout.write(`ledger: ${result.ledger.path}\n`);
  }
}

// Agent render: a compact, deterministic decision packet for `review`. It reuses
// the `ArtshelfReviewReport` vocabulary (classification → readyForApproval /
// needsReviewFirst / blocked decision groups, safety flags) without binding to
// that full schema, mirroring how status/doctor each carry a command-specific
// shape under the shared convention (single compact line, `--agent` precedence
// over `--json`, no agent-only fields leaking into `--json`).
//
// Safety is the design constraint: `review` is read-only. It never mints or
// writes a cleanup plan, and its preview plan id is timestamp+random (see
// makePlanId) and must never be executed from. So the only exact, plan-less
// approval target review can safely emit is `resolve missing` (ledger-only, ids
// known). Cleanup-eligible records stay needs-review-first and point at the
// `cleanup --dry-run` that mints a reviewed plan; the exact cleanup approval
// target is produced there, never leaked from a preview here.
type ReviewDecision = {
  label: string;
  itemIds: string[];
  actionType: "cleanup" | "resolve-missing" | "inspect" | "fix-registry";
  approvalTarget: string | null;
  reason: string;
  nextStep: string;
};

type ReviewAgentGroups = {
  readyForApproval: ReviewDecision[];
  needsReviewFirst: ReviewDecision[];
  blocked: ReviewDecision[];
};

type ReviewAgentPacket = {
  schemaVersion: 1;
  command: "review";
  scope: "all" | "single";
  health: "ok" | "attention";
  ledgerPath?: string;
  registry?: { path: string; exists: boolean };
  ledgers?: { total: number; ok: number; stale: number; invalid: number };
  counts: { due: number; manualReview: number; missingPath: number; executable: number; skipped: number };
  decisionSummary: { readyForApproval: number; needsReviewFirst: number; blocked: number };
  readyForApproval: ReviewDecision[];
  needsReviewFirst: ReviewDecision[];
  blocked: ReviewDecision[];
  safety: { dryRunOnly: boolean; executeAllRefused: boolean; noExecuteRan: boolean; noResolveRan: boolean; noDeleteRan: boolean };
  nextAction: string;
  verification: string;
};

// review is read-only, so every safety guarantee holds unconditionally.
const REVIEW_SAFETY = {
  dryRunOnly: true,
  executeAllRefused: true,
  noExecuteRan: true,
  noResolveRan: true,
  noDeleteRan: true
} as const;

// Classify each registered ledger's records into decision groups. Order is
// fixed (registry order, then a stable per-ledger sub-order) so the packet is
// byte-for-byte deterministic.
function buildReviewDecisions(results: ReviewResult[], scope: "all" | "single"): ReviewAgentGroups {
  const readyForApproval: ReviewDecision[] = [];
  const needsReviewFirst: ReviewDecision[] = [];
  const blocked: ReviewDecision[] = [];
  const review = scope === "all" ? "artshelf review --all" : "artshelf review";

  for (const result of results) {
    const { ledger, validate, due } = result;
    if (!validate.ok) {
      const status = existsSync(ledger.path) ? "invalid" : "missing";
      const repair = scope === "all" ? `re-register or fix ${ledger.path}` : `fix ${ledger.path}`;
      blocked.push({
        label: `Repair ${ledger.name} ledger (${status})`,
        itemIds: [],
        actionType: "fix-registry",
        approvalTarget: null,
        reason: validate.errors[0] ?? `${scope === "all" ? "registered ledger" : "ledger"} is ${status}`,
        nextStep: `${repair}, then re-run \`${review}\``
      });
      continue;
    }

    const missingPath = due.filter((entry) => entry.dueStatus === "missing-path");
    const trashSafe = due.filter((entry) => entry.dueStatus === "due" && entry.cleanup === "trash");
    const inspectItems = due.filter(
      (entry) =>
        entry.dueStatus === "manual-review" ||
        (entry.dueStatus === "due" && (entry.cleanup === "review" || entry.cleanup === "delete"))
    );

    // Ready for approval: missing-path records resolve ledger-only with an exact,
    // plan-less approval target. Resolution updates the ledger and never touches
    // files, so it is the one action review can hand an agent directly.
    if (missingPath.length > 0) {
      const ids = missingPath.map((entry) => entry.id).sort();
      readyForApproval.push({
        label: `Resolve ${ids.length} missing-path record(s) in ${ledger.name}`,
        itemIds: ids,
        actionType: "resolve-missing",
        approvalTarget: `approve artshelf resolve missing ledger ${ledger.path} ids ${ids.join(" ")}`,
        reason: "the recorded path is already missing",
        nextStep: "confirm the artifact is no longer needed, then approve the ledger-only resolve"
      });
    }

    // Trash-safe records are cleanup-eligible, but review never mints a plan, so
    // they carry no approval target: the next step is the dry-run that produces
    // the reviewed plan id to approve.
    if (trashSafe.length > 0) {
      const ids = trashSafe.map((entry) => entry.id).sort();
      needsReviewFirst.push({
        label: `Plan cleanup for ${ids.length} trash-eligible artifact(s) in ${ledger.name}`,
        itemIds: ids,
        actionType: "cleanup",
        approvalTarget: null,
        reason: "disposable artifacts are due but no reviewed cleanup plan exists yet",
        nextStep: `run \`artshelf cleanup --dry-run --ledger ${ledger.path} --json\`, then approve \`approve artshelf cleanup ledger ${ledger.path} plan <plan-id>\``
      });
    }

    // manual-review and cleanup=review records need a human decision before any
    // cleanup; cleanup=delete is refused outright. None carry an approval target.
    if (inspectItems.length > 0) {
      const ids = inspectItems.map((entry) => entry.id).sort();
      const hasDelete = inspectItems.some((entry) => entry.cleanup === "delete");
      needsReviewFirst.push({
        label: `Inspect ${ids.length} record(s) in ${ledger.name} before cleanup`,
        itemIds: ids,
        actionType: "inspect",
        approvalTarget: null,
        reason: hasDelete
          ? "records need manual review; cleanup=delete is refused and never deletes files"
          : "records are held for manual review before any cleanup",
        nextStep: "inspect each path, then keep, change retention, resolve, or set cleanup=trash and plan a cleanup"
      });
    }
  }

  return { readyForApproval, needsReviewFirst, blocked };
}

function reviewCounts(summary: ReviewSummary): ReviewAgentPacket["counts"] {
  return {
    due: summary.due,
    manualReview: summary.manualReview,
    missingPath: summary.missingPath,
    executable: summary.executable,
    skipped: summary.skipped
  };
}

function buildReviewAgentPacketAll(results: ReviewResult[], summary: ReviewSummary, registryPath: string): ReviewAgentPacket {
  const groups = buildReviewDecisions(results, "all");
  return {
    schemaVersion: 1,
    command: "review",
    scope: "all",
    health: summary.invalid + summary.stale > 0 ? "attention" : "ok",
    registry: { path: registryPath, exists: existsSync(registryPath) },
    ledgers: { total: summary.ledgers, ok: summary.ok, stale: summary.stale, invalid: summary.invalid },
    counts: reviewCounts(summary),
    decisionSummary: {
      readyForApproval: groups.readyForApproval.length,
      needsReviewFirst: groups.needsReviewFirst.length,
      blocked: groups.blocked.length
    },
    readyForApproval: groups.readyForApproval,
    needsReviewFirst: groups.needsReviewFirst,
    blocked: groups.blocked,
    safety: REVIEW_SAFETY,
    nextAction: reviewNextAction(summary, "all"),
    verification: `artshelf review --all --agent --registry ${registryPath}`
  };
}

function buildReviewAgentPacketSingle(result: ReviewResult, ledgerPath: string): ReviewAgentPacket {
  const summary = summarizeReview([result]);
  const groups = buildReviewDecisions([result], "single");
  return {
    schemaVersion: 1,
    command: "review",
    scope: "single",
    health: summary.invalid + summary.stale > 0 ? "attention" : "ok",
    ledgerPath,
    counts: reviewCounts(summary),
    decisionSummary: {
      readyForApproval: groups.readyForApproval.length,
      needsReviewFirst: groups.needsReviewFirst.length,
      blocked: groups.blocked.length
    },
    readyForApproval: groups.readyForApproval,
    needsReviewFirst: groups.needsReviewFirst,
    blocked: groups.blocked,
    safety: REVIEW_SAFETY,
    nextAction: reviewNextAction(summary, "single", ledgerPath),
    verification: `artshelf review --agent --ledger ${ledgerPath}`
  };
}
