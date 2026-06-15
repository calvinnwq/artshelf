import type { LedgerRegistryEntry } from "../registry.js";
import type { CleanupPlan, DueEntry, ReconcilePlan, ReconcileFinding, ReconcileCategory } from "../types.js";
import { attentionGlyph } from "./attention.js";
import { statusCommand } from "./status.js";

export type ReviewResult = {
  ledger: LedgerRegistryEntry;
  ledgerExists: boolean;
  validate: {
    ok: boolean;
    errors: string[];
    warnings: string[];
    entries: number;
  };
  due: DueEntry[];
  plan: CleanupPlan;
  reconcile: {
    plan: ReconcilePlan;
    reviewedPlan: ReconcilePlan | null;
  } | null;
};

export type ReviewSummary = {
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
  reconcileEntries: number;
  reconcileBlocked: number;
  previewPlanIds: string[];
};

export type ReviewDecision = {
  label: string;
  itemIds: string[];
  actionType: "cleanup" | "resolve-missing" | "inspect" | "fix-registry" | "reconcile";
  approvalTarget: string | null;
  reason: string;
  nextStep: string;
};

export type ReviewAgentGroups = {
  readyForApproval: ReviewDecision[];
  needsReviewFirst: ReviewDecision[];
  blocked: ReviewDecision[];
};

export type ReviewAgentPacket = {
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

const REVIEW_SAFETY = {
  dryRunOnly: true,
  executeAllRefused: true,
  noExecuteRan: true,
  noResolveRan: true,
  noDeleteRan: true
} as const;

export function reviewNextAction(summary: ReviewSummary, scope: "all" | "single", ledgerPath?: string, registryPath?: string): string {
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
  if (summary.missingPath > 0 || summary.reconcileEntries > 0 || summary.reconcileBlocked > 0) {
    const reconcile = scope === "all" ? `artshelf reconcile --dry-run --all${registryPath ? ` --registry ${registryPath}` : ""}` : `artshelf reconcile --dry-run --ledger ${ledgerPath}`;
    return `run \`${reconcile} --json\` and then \`${review}\` to surface reconcile-ready approvals; nothing is auto-executable`;
  }
  return "nothing to do — no broken ledgers and no due, manual-review, missing-path, or executable cleanup entries";
}

export function printReviewAll(results: ReviewResult[], summary: ReviewSummary, nextAction: string, registryPath: string): void {
  const needsAttention = summary.invalid + summary.stale + summary.executable + summary.due + summary.manualReview + summary.missingPath + summary.reconcileEntries + summary.reconcileBlocked > 0;
  process.stdout.write(`${attentionGlyph(needsAttention)} artshelf review --all: ${needsAttention ? "needs attention" : "all clear"}\n`);
  process.stdout.write(`registry: ${registryPath} — ${summary.ledgers} ledgers (${summary.ok} ok, ${summary.invalid} invalid, ${summary.stale} stale)\n`);
  printReview(results);
  process.stdout.write(`triage: due ${summary.due} · manual-review ${summary.manualReview} · missing ${summary.missingPath} · executable ${summary.executable} · skipped ${summary.skipped}\n`);
  process.stdout.write(`next: ${nextAction}\n`);
}

export function printReview(results: ReviewResult[]): void {
  for (const result of results) {
    const visibleDue = result.due.filter((entry) => entry.dueStatus !== "kept");
    const reconcileDrift = (result.reconcile?.plan.entries.length ?? 0) + (result.reconcile?.plan.blocked.length ?? 0);
    const needsAttention = !result.validate.ok || visibleDue.length > 0 || result.plan.entries.length > 0 || reconcileDrift > 0;
    process.stdout.write(`${attentionGlyph(needsAttention)} [${result.ledger.name}] ${result.validate.ok ? "ok" : "invalid"}: ${result.validate.entries} entries, ${result.validate.errors.length} errors, ${result.validate.warnings.length} warnings\n`);
    process.stdout.write(`due/manual/missing: ${visibleDue.length}; plan ${result.plan.planId}: ${result.plan.entries.length} entries, ${result.plan.skipped.length} skipped\n`);
    process.stdout.write(`ledger: ${result.ledger.path}\n`);
  }
}

function buildReviewDecisions(results: ReviewResult[], scope: "all" | "single"): ReviewAgentGroups {
  const readyForApproval: ReviewDecision[] = [];
  const needsReviewFirst: ReviewDecision[] = [];
  const blocked: ReviewDecision[] = [];
  const review = scope === "all" ? "artshelf review --all" : "artshelf review";

  for (const result of results) {
    const { ledger, validate, due } = result;
    if (!validate.ok) {
      const status = result.ledgerExists ? "invalid" : "missing";
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

    const handledReconcileIds = new Set([
      ...(result.reconcile?.plan.entries.map((entry) => entry.id) ?? []),
      ...(result.reconcile?.plan.blocked.map((entry) => entry.id) ?? [])
    ]);
    const reconcileActions = buildReconcileDecisions(result, scope);
    readyForApproval.push(...reconcileActions.readyForApproval);
    needsReviewFirst.push(...reconcileActions.needsReviewFirst);
    blocked.push(...reconcileActions.blocked);

    const missingPath = due.filter((entry) => entry.dueStatus === "missing-path" && !handledReconcileIds.has(entry.id));
    const trashSafe = due.filter((entry) => entry.dueStatus === "due" && entry.cleanup === "trash");
    const inspectItems = due.filter(
      (entry) =>
        entry.dueStatus === "manual-review" ||
        (entry.dueStatus === "due" && (entry.cleanup === "review" || entry.cleanup === "delete"))
    );

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

function buildReconcileDecisions(result: ReviewResult, _scope: "all" | "single"): ReviewAgentGroups {
  if (!result.reconcile) return { readyForApproval: [], needsReviewFirst: [], blocked: [] };

  const readyForApproval: ReviewDecision[] = [];
  const needsReviewFirst: ReviewDecision[] = [];
  const blocked: ReviewDecision[] = [];
  const hasReviewedPlan = Boolean(result.reconcile.reviewedPlan && result.reconcile.reviewedPlan.planId !== "not-created");
  const reviewedPlanId = result.reconcile.reviewedPlan?.planId ?? null;

  const byCategory: Record<ReconcileCategory, ReconcileFinding[]> = {
    remap: [],
    "resolve-missing": [],
    "resolve-stale-trash": [],
    "registry-remap": [],
    blocked: []
  };
  for (const finding of result.reconcile.plan.entries.concat(result.reconcile.plan.blocked)) {
    byCategory[finding.category].push(finding);
  }

  const reconcileActionCategories = ["remap", "resolve-missing", "resolve-stale-trash", "registry-remap"] as const;
  for (const category of reconcileActionCategories) {
    const entries = byCategory[category];
    if (entries.length === 0) continue;
    const ids = entries.map((entry) => entry.id).sort();
    const label = `Review ${entries.length} reconcile ${category} finding(s) in ${result.ledger.name}`;
    const reason = `recorded paths are ${category === "remap" ? "safe to remap" : "stale and require manual review before execution"}`;
    const decision: ReviewDecision = {
      label,
      itemIds: ids,
      actionType: "reconcile",
      approvalTarget: hasReviewedPlan ? `approve artshelf reconcile ledger ${result.ledger.path} plan ${reviewedPlanId}` : null,
      reason,
      nextStep: hasReviewedPlan
        ? `run \`artshelf reconcile --execute --plan-id ${reviewedPlanId} --ledger ${result.ledger.path}\``
        : `run \`artshelf reconcile --dry-run --ledger ${result.ledger.path} --json\`, then approve with \`approve artshelf reconcile ledger ${result.ledger.path} plan <plan-id>\``
    };
    (hasReviewedPlan ? readyForApproval : needsReviewFirst).push(decision);
  }

  if (byCategory.blocked.length > 0) {
    const entries = byCategory.blocked;
    blocked.push({
      label: `Review ${entries.length} blocked reconcile finding(s) in ${result.ledger.name}`,
      itemIds: entries.map((entry) => entry.id).sort(),
      actionType: "reconcile",
      approvalTarget: null,
      reason: "path drift is ambiguous or unsafe and needs manual investigation",
      nextStep: `run \`artshelf reconcile --dry-run --ledger ${result.ledger.path} --json\`, then handle each item manually`
    });
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

export function buildReviewAgentPacketAll(results: ReviewResult[], summary: ReviewSummary, registry: { path: string; exists: boolean }): ReviewAgentPacket {
  const groups = buildReviewDecisions(results, "all");
  return {
    schemaVersion: 1,
    command: "review",
    scope: "all",
    health: summary.invalid + summary.stale > 0 ? "attention" : "ok",
    registry,
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
    nextAction: reviewNextAction(summary, "all", undefined, registry.path),
    verification: `artshelf review --all --agent --registry ${registry.path}`
  };
}

export function buildReviewAgentPacketSingle(result: ReviewResult, summary: ReviewSummary, ledgerPath: string): ReviewAgentPacket {
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
