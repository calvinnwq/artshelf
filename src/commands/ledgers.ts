import { existsSync } from "node:fs";
import { normalizeLedgerPath } from "../ledger.js";
import {
  listRegisteredLedgers,
  normalizeRegistryPath,
  registerLedger
} from "../registry.js";
import type { LedgerRegistryEntry } from "../registry.js";
import { createRegistryPrunePlan, executeRegistryPrunePlan } from "../registry-prune.js";
import type { RegistryPrunePlan, RegistryPruneReceipt } from "../registry-prune.js";
import { printCompactJson, printJson } from "../renderers/json.js";
import { boolFlag, requiredStringFlag, stringFlag } from "../shared/flags.js";
import { LEDGERS_HELP } from "../shared/help-text.js";
import type { ParsedArgs } from "../shared/cli-types.js";
import { validateRegisteredLedger } from "./shared.js";

export function handleLedgers(parsed: ParsedArgs, json: boolean): number {
  const action = parsed.positionals[0] ?? "list";
  const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
  if (action === "help") {
    process.stdout.write(LEDGERS_HELP);
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
  if (action === "prune") {
    return handleLedgersPrune(parsed, registryPath, json);
  }
  throw new Error(`Unknown ledgers action: ${action}`);
}

// Approval-gated registry prune (NGX-481). Dry-run is read-only except for writing a
// reviewed plan when missing registrations are detected; it never mutates the registry.
// Execute binds to one exact registry path and reviewed plan id, copies a rollback
// snapshot before mutating, and writes a receipt after.
function handleLedgersPrune(parsed: ParsedArgs, registryPath: string, json: boolean): number {
  const dryRun = boolFlag(parsed, "dry-run");
  const execute = boolFlag(parsed, "execute");
  if (dryRun && execute) throw new Error("ledgers prune accepts either --dry-run or --execute, not both");
  if (execute) return handleLedgersPruneExecute(parsed, registryPath, json);
  if (!dryRun) throw new Error("ledgers prune requires --dry-run or --execute");

  const plan = createRegistryPrunePlan(registryPath);
  const approve = plan.planId === "not-created" ? null : pruneApprovalTarget(registryPath, plan.planId);

  if (boolFlag(parsed, "agent")) {
    return printCompactJson({
      ok: true,
      command: "ledgers-prune",
      registryPath,
      prunable: plan.entries.length,
      blocked: plan.skipped.length,
      planId: plan.planId === "not-created" ? null : plan.planId,
      approve
    });
  }
  if (json) return printJson({ ok: true, registryPath, plan, approve });

  printRegistryPrunePlan(plan, registryPath, approve);
  return 0;
}

// Execute one reviewed registry-prune plan. The plan id is required up front (refusing
// `--execute` without it), then the domain layer re-checks the live registry, takes a
// rollback copy, removes only entries still classified as prunable, and writes a
// receipt. Exit is non-zero when post-mutation verification fails.
function handleLedgersPruneExecute(parsed: ParsedArgs, registryPath: string, json: boolean): number {
  const planId = stringFlag(parsed, "plan-id");
  if (!planId) {
    throw new Error("ledgers prune --execute requires --plan-id <id>; run `artshelf ledgers prune --dry-run` first to review a plan");
  }
  const receipt = executeRegistryPrunePlan(registryPath, planId);
  if (json) {
    printJson({ ok: receipt.verification.ok, registryPath, receipt });
    return receipt.verification.ok ? 0 : 1;
  }
  printRegistryPruneReceipt(receipt);
  return receipt.verification.ok ? 0 : 1;
}

function pruneApprovalTarget(registryPath: string, planId: string): string {
  return `approve artshelf ledgers prune registry ${registryPath} plan ${planId}`;
}

function printRegistryPruneReceipt(receipt: RegistryPruneReceipt): void {
  process.stdout.write(`artshelf ledgers prune --execute: removed ${receipt.removed.length}, skipped ${receipt.skipped.length}\nregistry: ${receipt.registryPath}\n`);
  for (const entry of receipt.removed) {
    process.stdout.write(`[${entry.name}] removed ${entry.scope} — ${entry.path}\n`);
  }
  for (const entry of receipt.skipped) {
    process.stdout.write(`[${entry.name}] skipped ${entry.scope}: live registry no longer matches the reviewed plan — ${entry.path}\n`);
  }
  if (receipt.rollbackPath) process.stdout.write(`rollback: ${receipt.rollbackPath}\n`);
  process.stdout.write(`receipt: ${receipt.receiptPath}\n`);
  process.stdout.write(`verification: ${receipt.verification.ok ? "ok" : "failed"} — ${receipt.verification.detail}\n`);
}

function printRegistryPrunePlan(plan: RegistryPrunePlan, registryPath: string, approve: string | null): void {
  if (plan.entries.length === 0) {
    process.stdout.write(`artshelf ledgers prune: nothing to prune\nregistry: ${registryPath}\n`);
    for (const entry of plan.skipped) {
      process.stdout.write(`[${entry.name}] blocked ${entry.scope}: ${entry.reason} — ${entry.path}\n`);
    }
    return;
  }
  process.stdout.write(`artshelf ledgers prune: ${plan.entries.length} prunable, ${plan.skipped.length} blocked\nregistry: ${registryPath}\n`);
  for (const entry of plan.entries) {
    process.stdout.write(`[${entry.name}] prune ${entry.scope}: ${entry.reason} — ${entry.path}\n`);
  }
  for (const entry of plan.skipped) {
    process.stdout.write(`[${entry.name}] blocked ${entry.scope}: ${entry.reason} — ${entry.path}\n`);
  }
  process.stdout.write(`plan: ${plan.planPath ?? "not created"}\n`);
  if (approve) process.stdout.write(`approve: ${approve}\n`);
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
