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

export function handleGet(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
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
