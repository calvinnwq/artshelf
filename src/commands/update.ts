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

export async function handleUpdate(parsed: ParsedArgs, json: boolean): Promise<number> {
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
