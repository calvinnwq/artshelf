import { existsSync } from "node:fs";
import { dueEntries, listTrashedRecords, previewCleanupPlan, readLedger, validateLedger } from "../ledger.js";
import { listRegisteredLedgers } from "../registry.js";
import type { LedgerRegistryEntry } from "../registry.js";
import { matchingReconcilePlan, previewReconcilePlan } from "../reconcile.js";
import type { CleanupPlan, DueEntry, ReconcilePlan, ArtshelfRecord } from "../types.js";
import { printJson } from "../renderers/json.js";
import { type ReviewResult, type ReviewSummary } from "../renderers/review.js";

export type RegisteredLedgerValidation = { ledger: LedgerRegistryEntry; result: ReturnType<typeof validateLedger> };

export function registeredLedgersOrThrow(registryPath: string): LedgerRegistryEntry[] {
  const ledgers = listRegisteredLedgers(registryPath);
  if (ledgers.length === 0) throw new Error("No registered Artshelf ledgers. Run `artshelf ledgers add --ledger <path>` first.");
  return ledgers;
}

export function validateRegisteredLedgersOrThrow(registryPath: string): { ok: boolean; results: RegisteredLedgerValidation[] } {
  const results = registeredLedgersOrThrow(registryPath).map((ledger) => ({ ledger, result: validateRegisteredLedger(ledger) }));
  return { ok: results.every((entry) => entry.result.ok), results };
}

export function printRegisteredLedgerValidation(registryPath: string, results: RegisteredLedgerValidation[], json: boolean): number {
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

export function validateRegisteredLedger(ledger: LedgerRegistryEntry): ReturnType<typeof validateLedger> {
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

export function reviewLedger(ledger: LedgerRegistryEntry, registered = true): ReviewResult {
  const validate = registered ? validateRegisteredLedger(ledger) : validateLedger(ledger.path);
  const ledgerExists = existsSync(ledger.path);
  if (!validate.ok) {
    return {
      ledger,
      ledgerExists,
      validate,
      due: [],
      plan: emptyReviewPlan(ledger.path),
      reconcile: null
    };
  }

  const reconcilePlan = previewReconcilePlan(ledger.path);
  const reviewedReconcilePlan = reconcilePlan.entries.length > 0 || reconcilePlan.blocked.length > 0 ? matchingReconcilePlan(ledger.path, reconcilePlan) : null;

  return {
    ledger,
    ledgerExists,
    validate,
    due: dueEntries(readLedger(ledger.path)),
    plan: previewCleanupPlan(ledger.path),
    reconcile: { plan: reconcilePlan, reviewedPlan: reviewedReconcilePlan }
  };
}

export function reviewJsonResult(result: ReviewResult): Omit<ReviewResult, "ledgerExists"> {
  const { ledgerExists: _ledgerExists, ...jsonResult } = result;
  return jsonResult;
}

export function emptyReviewPlan(ledgerPath: string): CleanupPlan {
  return {
    planId: "not-created",
    generatedAt: "",
    ledgerPath,
    entries: [],
    skipped: [],
    planPath: null
  };
}

export function printLedgerEntries(results: Array<{ ledger: LedgerRegistryEntry; entries: ArtshelfRecord[] }>, status?: string): void {
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

export function printDueEntries(results: Array<{ ledger: LedgerRegistryEntry; entries: DueEntry[] }>): void {
  const visible = results.flatMap((result) => result.entries.filter((entry) => entry.dueStatus !== "kept").map((entry) => ({ ledger: result.ledger, entry })));
  if (visible.length === 0) {
    process.stdout.write("nothing due\n");
    return;
  }
  for (const item of visible) {
    process.stdout.write(`${item.entry.dueStatus} ${item.entry.id} ${item.entry.cleanup} ${item.entry.path} :: ${item.entry.reason}\nledger: ${item.ledger.path}\n`);
  }
}

export function printPlans(results: Array<{ ledger: LedgerRegistryEntry; plan: CleanupPlan }>): void {
  for (const result of results) {
    process.stdout.write(`plan ${result.plan.planId} [${result.ledger.name}]: ${result.plan.entries.length} entries, ${result.plan.skipped.length} skipped\n`);
    process.stdout.write(`plan: ${result.plan.planPath ?? "not created"}\nledger: ${result.ledger.path}\n`);
  }
}

export function printPlan(plan: CleanupPlan, ledgerPath: string): void {
  process.stdout.write(`plan ${plan.planId}: ${plan.entries.length} entries, ${plan.skipped.length} skipped\n`);
  process.stdout.write(`plan: ${plan.planPath ?? "not created"}\nledger: ${ledgerPath}\n`);
}

export function printReconcilePlan(plan: ReconcilePlan, ledgerPath: string): void {
  process.stdout.write(`plan ${plan.planId}: ${plan.entries.length} entries, ${plan.blocked.length} blocked\n`);
  for (const entry of plan.entries) {
    const target = entry.proposedPath ? `${entry.currentPath} -> ${entry.proposedPath}` : entry.currentPath;
    process.stdout.write(`${entry.category} ${entry.id} ${entry.field} ${target} :: ${entry.reason}\n`);
  }
  for (const blocked of plan.blocked) {
    process.stdout.write(`blocked ${blocked.id} ${blocked.field} ${blocked.currentPath} :: ${blocked.reason}\n`);
  }
  process.stdout.write(`plan: ${plan.planPath ?? "not created"}\nledger: ${ledgerPath}\n`);
}

export function printReconcilePlans(results: Array<{ ledger: LedgerRegistryEntry; plan: ReconcilePlan }>): void {
  for (const result of results) {
    process.stdout.write(`plan ${result.plan.planId} [${result.ledger.name}]: ${result.plan.entries.length} entries, ${result.plan.blocked.length} blocked\n`);
    process.stdout.write(`plan: ${result.plan.planPath ?? "not created"}\nledger: ${result.ledger.path}\n`);
  }
}

export function printTrashListEntries(results: Array<{ ledger: LedgerRegistryEntry; entries: ReturnType<typeof listTrashedRecords> }>): void {
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

export function summarizeReview(results: ReviewResult[]): ReviewSummary {
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
    reconcileEntries: 0,
    reconcileBlocked: 0,
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
    const reconcileEntries = result.reconcile?.plan.entries.length ?? 0;
    const reconcileBlocked = result.reconcile?.plan.blocked.length ?? 0;
    summary.due += due;
    summary.manualReview += manualReview;
    summary.missingPath += missingPath;
    summary.executable += result.plan.entries.length;
    summary.skipped += result.plan.skipped.length;
    summary.reconcileEntries += reconcileEntries;
    summary.reconcileBlocked += reconcileBlocked;
    if (result.plan.planId !== "not-created") summary.previewPlanIds.push(result.plan.planId);
    if (!result.validate.ok || due + manualReview + missingPath + reconcileEntries + reconcileBlocked > 0 || result.plan.entries.length > 0) {
      summary.affected += 1;
    }
  }

  return summary;
}
