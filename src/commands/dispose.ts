import { createDisposePlan, executeDisposePlan } from "../dispose.js";
import type { DisposeAction, DisposeExecution, DisposePlan } from "../types.js";
import { printCompactJson, printJson } from "../renderers/json.js";
import { boolFlag, requiredStringFlag, stringFlag } from "../shared/flags.js";
import type { ParsedArgs } from "../shared/cli-types.js";

export function handleDispose(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  const dryRun = boolFlag(parsed, "dry-run");
  const execute = boolFlag(parsed, "execute");
  if (dryRun && execute) throw new Error("dispose accepts either --dry-run or --execute, not both");
  if (boolFlag(parsed, "all")) throw new Error("dispose is scoped to one --ledger and one reviewed plan; --all is not supported");

  if (execute) {
    const planId = requiredStringFlag(parsed, "plan-id");
    const execution = executeDisposePlan(ledgerPath, planId);
    if (json) {
      printJson({ ok: execution.result.status !== "skipped", ledgerPath, execution });
      return execution.result.status === "skipped" ? 1 : 0;
    }
    printDisposeExecution(execution, ledgerPath);
    return execution.result.status === "skipped" ? 1 : 0;
  }

  if (!dryRun) throw new Error("dispose requires --dry-run or --execute");

  const id = requiredStringFlag(parsed, "id");
  const action = requiredStringFlag(parsed, "action") as DisposeAction;
  const plan = createDisposePlan(ledgerPath, {
    id,
    action,
    reason: stringFlag(parsed, "reason"),
    ttl: stringFlag(parsed, "ttl"),
    retainUntil: stringFlag(parsed, "retain-until")
  });
  const approve = disposeApprovalTarget(ledgerPath, plan.planId);

  if (boolFlag(parsed, "agent")) {
    printCompactJson({
      ok: plan.entry !== null,
      command: "dispose",
      ledgerPath,
      id,
      action,
      status: plan.entry ? "ready-for-approval" : "blocked",
      planId: plan.entry ? plan.planId : null,
      approve,
      blocked: plan.blocked
    });
    return plan.entry ? 0 : 1;
  }
  if (json) {
    printJson({ ok: plan.entry !== null, ledgerPath, plan, approve });
    return plan.entry ? 0 : 1;
  }

  printDisposePlan(plan, ledgerPath, approve);
  return plan.entry ? 0 : 1;
}

function disposeApprovalTarget(ledgerPath: string, planId: string): string | null {
  if (planId === "not-created") return null;
  return `approve artshelf dispose ledger ${ledgerPath} plan ${planId}`;
}

function printDisposePlan(plan: DisposePlan, ledgerPath: string, approve: string | null): void {
  if (!plan.entry) {
    process.stdout.write(`dispose plan not-created: blocked ${plan.request.id} ${plan.request.action}\n`);
    if (plan.blocked) process.stdout.write(`blocked: ${plan.blocked.reason} — ${plan.blocked.detail}\n`);
    process.stdout.write(`ledger: ${ledgerPath}\n`);
    return;
  }

  process.stdout.write(`dispose plan ${plan.planId}: ${plan.entry.action} ${plan.entry.id}\n`);
  process.stdout.write(`reason: ${plan.entry.reason}\n`);
  if (plan.entry.targetPath) process.stdout.write(`target: ${plan.entry.targetPath}\n`);
  if (plan.entry.retainUntil) process.stdout.write(`retain-until: ${plan.entry.retainUntil}\n`);
  process.stdout.write(`plan: ${plan.planPath ?? "not created"}\n`);
  process.stdout.write(`ledger: ${ledgerPath}\n`);
  if (approve) process.stdout.write(`approve: ${approve}\n`);
}

function printDisposeExecution(execution: DisposeExecution, ledgerPath: string): void {
  process.stdout.write(`dispose receipt ${execution.planId}: ${execution.result.status} ${execution.result.action} ${execution.result.id}\n`);
  if (execution.result.reason) process.stdout.write(`reason: ${execution.result.reason}\n`);
  if (execution.result.targetPath) process.stdout.write(`target: ${execution.result.targetPath}\n`);
  if (execution.result.retainUntil) process.stdout.write(`retain-until: ${execution.result.retainUntil}\n`);
  process.stdout.write(`receipt: ${execution.receiptPath}\n`);
  process.stdout.write(`ledger: ${ledgerPath}\n`);
}
