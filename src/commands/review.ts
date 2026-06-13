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

export function handleReview(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
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
