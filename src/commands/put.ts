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

export function handlePut(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
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
