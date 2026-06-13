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
import type { ParsedArgs } from "../shared/cli-types.js";
import {
  emptyReviewPlan,
  printDueEntries,
  printLedgerEntries,
  printPlan,
  printPlans,
  printRegisteredLedgerValidation,
  printTrashListEntries,
  registeredLedgersOrThrow,
  reviewJsonResult,
  reviewLedger,
  summarizeReview,
  validateRegisteredLedger,
  validateRegisteredLedgersOrThrow
} from "./shared.js";

export function handleTrash(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  const action = parsed.positionals[0];
  if (!action) throw new Error("trash requires a subcommand: list or purge");

  if (action === "list") {
    return handleTrashList(parsed, ledgerPath, json);
  }
  if (action === "purge") {
    return handleTrashPurge(parsed, ledgerPath, json);
  }
  if (action === "help") {
    process.stdout.write(TRASH_HELP);
    return 0;
  }
  throw new Error(`Unknown trash subcommand: ${action}`);
}

export function handleTrashList(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
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

export function handleTrashPurge(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
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
