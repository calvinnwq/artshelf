import { createReconcilePlan, executeReconcilePlan } from "../reconcile.js";
import { normalizeRegistryPath } from "../registry.js";
import { printJson } from "../renderers/json.js";
import { boolFlag, requiredStringFlag, stringFlag } from "../shared/flags.js";
import type { ParsedArgs } from "../shared/cli-types.js";
import { printReconcilePlan, printReconcilePlans, printRegisteredLedgerValidation, validateRegisteredLedgersOrThrow } from "./shared.js";

// `artshelf reconcile` (NGX-437): approval-gated ledger/registry housekeeping that
// converts path drift into a reviewed plan, then applies one reviewed plan id. This
// command layer enforces the safety envelope around the reconcile domain functions:
// dry-run and execute are mutually exclusive, `--all` is dry-run only (no global
// execute), and execute always binds to one explicit `--ledger` plus `--plan-id`.
// Reconcile never touches the filesystem; it is ledger bookkeeping, not cleanup.
export function handleReconcile(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  const dryRun = boolFlag(parsed, "dry-run");
  const execute = boolFlag(parsed, "execute");
  if (dryRun && execute) throw new Error("reconcile accepts either --dry-run or --execute, not both");
  if (boolFlag(parsed, "all") && execute) {
    throw new Error("reconcile --all is dry-run only; execute requires an explicit --ledger and reviewed --plan-id");
  }

  if (dryRun) {
    if (boolFlag(parsed, "all")) {
      const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
      const { ok, results } = validateRegisteredLedgersOrThrow(registryPath);
      if (!ok) return printRegisteredLedgerValidation(registryPath, results, json);
      const plans = results.map(({ ledger }) => ({ ledger, plan: createReconcilePlan(ledger.path) }));
      if (json) return printJson({ ok: true, registryPath, plans });
      printReconcilePlans(plans);
      process.stdout.write(`registry: ${registryPath}\n`);
      return 0;
    }
    const plan = createReconcilePlan(ledgerPath);
    if (json) return printJson({ ok: true, plan });
    printReconcilePlan(plan, ledgerPath);
    return 0;
  }

  if (execute) {
    const planId = requiredStringFlag(parsed, "plan-id");
    const receipt = executeReconcilePlan(ledgerPath, planId);
    if (json) return printJson({ ok: true, receipt });
    process.stdout.write(`receipt ${receipt.planId}: ${receipt.results.length} results\nreceipt: ${receipt.receiptPath}\nledger: ${ledgerPath}\n`);
    return 0;
  }

  throw new Error("reconcile requires --dry-run or --execute");
}
