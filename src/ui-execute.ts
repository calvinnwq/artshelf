import { revalidateApprovalSnapshot, selectedApprovalTargets } from "./session.js";
import type {
  UiApprovalLiveFacts,
  UiApprovalRevalidation,
  UiApprovalSnapshot,
  UiApprovalTarget,
  UiBundleExecutionResult,
  UiBundleTargetOutcome,
  UiBundleTargetReceipt
} from "./types.js";

// Agent-side execution of an approved approval bundle with a per-target post-execute verification
// loop (NGX-540). This is the first mutating UI milestone slice, so it is deliberately
// conservative: approval is not execution. Before anything runs, the bundle is revalidated against
// the live ledger/registry/record/plan facts the agent re-read, and only targets that are still
// exactly what the human approved are executed. Every selected target receives a visible per-target
// receipt - executed, skipped_stale, failed, or needs_manual_review - so a partial run can never
// hide a skipped, failed, or needs-review target behind the successes.
//
// This module owns the orchestration and safety gate only; it never executes a command itself.
// One eligible target at a time is delegated to an injected executor that runs the existing
// approval-gated Artshelf CLI path and verifies live state, returning the executable outcome. That
// keeps the safety gate (revalidate -> classify -> aggregate) pure and independently testable, and
// keeps the mutating execution behind the same approval-gated workflows the rest of Artshelf uses.

// What an eligible target's execution + live-state verification produced. The executor returns one
// of the executable outcomes - it never returns skipped_stale, because staleness is decided by the
// pre-execution revalidation gate, not by the executor.
export type UiBundleTargetExecution = {
  outcome: "executed" | "failed" | "needs_manual_review";
  detail: string;
  evidence?: Record<string, unknown>;
};

// Runs one fresh, exactly-approved target through the existing approval-gated CLI path and re-reads
// live state to verify the result. Injected so the orchestration core stays pure and the real
// dispose-backed executor (with its own live-state verification) is wired in at the command layer.
export type UiBundleTargetExecutor = (target: UiApprovalTarget) => UiBundleTargetExecution;

export function executeApprovalBundle(
  snapshot: UiApprovalSnapshot,
  live: UiApprovalLiveFacts,
  executeTarget: UiBundleTargetExecutor
): UiBundleExecutionResult {
  const revalidation = revalidateApprovalSnapshot(snapshot, live);
  const selected = selectedApprovalTargets(snapshot);
  const missing = new Set(revalidation.missingTargetIds);
  const changed = new Set(revalidation.changedTargetIds);

  // Refuse the entire bundle - executing nothing - when the *shared* basis the human approved
  // against can no longer be trusted: a reviewed fact drifted, or the persisted fingerprint no
  // longer matches the bundle's own selected targets (a tampered or corrupt approval record). Both
  // are ambiguity at the bundle level, and the v1 safety posture is refusal on ambiguity. Per-target
  // drift (a single missing or changed target) does not poison the others: those are skipped while
  // the still-exact targets execute, so a partial run stays honest.
  const bundleRefused = revalidation.reviewedKeysDrifted.length > 0 || hasUnexplainedFingerprintMismatch(revalidation);

  const receipts: UiBundleTargetReceipt[] = selected.map((target) => {
    if (bundleRefused) {
      return staleReceipt(target, "approval bundle refused: the reviewed basis or bundle fingerprint no longer matches live state; re-review");
    }
    if (missing.has(target.targetId)) {
      return staleReceipt(target, "skipped_stale: the approved subject is no longer present in live state");
    }
    if (changed.has(target.targetId)) {
      return staleReceipt(target, "skipped_stale: the approved subject drifted from the reviewed snapshot");
    }
    return executeOneTarget(target, executeTarget);
  });

  const counts = tally(receipts);
  return {
    bundleId: snapshot.id,
    sessionId: snapshot.sessionId,
    revalidation,
    receipts,
    counts,
    status: aggregateStatus(counts)
  };
}

// A live fingerprint that disagrees with the persisted one without any per-target or reviewed-fact
// drift to explain it means the snapshot's own integrity is broken (tampered or corrupt), so no
// target in it can be trusted.
function hasUnexplainedFingerprintMismatch(revalidation: UiApprovalRevalidation): boolean {
  return (
    revalidation.liveFingerprint !== revalidation.expectedFingerprint &&
    revalidation.missingTargetIds.length === 0 &&
    revalidation.changedTargetIds.length === 0 &&
    revalidation.reviewedKeysDrifted.length === 0
  );
}

// Execute one eligible target, never letting a single target's failure abort the loop: a thrown
// error becomes a failed receipt so the remaining approved targets still get their turn and a
// visible result.
function executeOneTarget(target: UiApprovalTarget, executeTarget: UiBundleTargetExecutor): UiBundleTargetReceipt {
  try {
    const execution = executeTarget(target);
    return {
      ...receiptBase(target),
      outcome: execution.outcome,
      detail: execution.detail,
      evidence: execution.evidence ?? null
    };
  } catch (error) {
    return {
      ...receiptBase(target),
      outcome: "failed",
      detail: `failed: target execution threw: ${(error as Error).message}`,
      evidence: null
    };
  }
}

function staleReceipt(target: UiApprovalTarget, detail: string): UiBundleTargetReceipt {
  return { ...receiptBase(target), outcome: "skipped_stale", detail, evidence: null };
}

function receiptBase(target: UiApprovalTarget): Omit<UiBundleTargetReceipt, "outcome" | "detail" | "evidence"> {
  return {
    targetId: target.targetId,
    label: target.label,
    actionType: target.actionType,
    ledgerPath: target.ledgerPath
  };
}

function tally(receipts: UiBundleTargetReceipt[]): Record<UiBundleTargetOutcome, number> {
  const counts: Record<UiBundleTargetOutcome, number> = { executed: 0, skipped_stale: 0, failed: 0, needs_manual_review: 0 };
  for (const receipt of receipts) counts[receipt.outcome] += 1;
  return counts;
}

// "executed" only when every selected target executed; "refused" when nothing executed because the
// gate skipped them all; "partial" for any mix (some executed, plus skipped/failed/needs-review).
function aggregateStatus(counts: Record<UiBundleTargetOutcome, number>): UiBundleExecutionResult["status"] {
  const total = counts.executed + counts.skipped_stale + counts.failed + counts.needs_manual_review;
  if (counts.executed === total) return "executed";
  if (counts.executed === 0 && counts.failed === 0 && counts.needs_manual_review === 0) return "refused";
  return "partial";
}
