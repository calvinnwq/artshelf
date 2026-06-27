import { existsSync } from "node:fs";
import { executeDisposePlan } from "./dispose.js";
import { readLedger } from "./ledger.js";
import { revalidateApprovalSnapshot, selectedApprovalTargets } from "./session.js";
import type {
  ArtshelfRecord,
  ArtshelfStatus,
  DisposeExecution,
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

// The real dispose-backed target executor (NGX-540 slice 2). It binds one exactly-approved target to
// the reviewed dispose plan the human approved - never minting a fresh plan - runs the existing
// approval-gated `dispose --execute` path, then INDEPENDENTLY re-reads the live ledger and filesystem
// to confirm the disposition actually took effect rather than trusting the command's reported result.
// Outcome mapping:
//   needs_manual_review - the target carries no reviewed plan id, or the dispose engine refused the
//                         plan (drift/conflict) rather than mutating; a human must decide.
//   failed              - `dispose --execute` errored, or the independent live re-query did not match
//                         the executed action's promised end-state.
//   executed            - the action ran and the live ledger/filesystem confirm the expected change.
// The keep/trash/resolve/defer triage intents map to keep/trash-resolve/resolve-only/snooze dispose
// actions upstream; here the reviewed plan already encodes the exact action, so this binds by plan id.
export function disposeBackedTargetExecutor(target: UiApprovalTarget): UiBundleTargetExecution {
  if (!isNonEmptyString(target.planId)) {
    return {
      outcome: "needs_manual_review",
      detail: "needs_manual_review: approved target carries no reviewed dispose plan id; re-run the dry-run and re-approve",
      evidence: { ledgerPath: target.ledgerPath, recordPath: target.recordPath }
    };
  }

  let execution: DisposeExecution;
  try {
    execution = executeDisposePlan(target.ledgerPath, target.planId);
  } catch (error) {
    return {
      outcome: "failed",
      detail: `failed: dispose --execute errored: ${(error as Error).message}`,
      evidence: { ledgerPath: target.ledgerPath, planId: target.planId }
    };
  }

  const result = execution.result;
  // The dispose engine refuses (skips) a drifted or conflicting entry rather than mutating it: the
  // underlying CLI path refused it, so a human must decide - not a hard failure.
  if (result.status === "skipped") {
    return {
      outcome: "needs_manual_review",
      detail: `needs_manual_review: dispose refused the reviewed plan: ${result.reason}`,
      evidence: disposeEvidence(execution)
    };
  }

  // Verify live state, not the command's word alone (NGX-540): re-read the ledger + filesystem and
  // confirm they reflect the executed action's promised end-state.
  const verified = verifyDisposeLive(target.ledgerPath, execution);
  const evidence = { ...disposeEvidence(execution), live: verified.live };
  if (!verified.ok) {
    return { outcome: "failed", detail: `failed: live state did not reflect the executed ${result.action}: ${verified.detail}`, evidence };
  }
  return { outcome: "executed", detail: `executed ${result.action}: ${verified.detail}`, evidence };
}

// Audit-facing evidence for one dispose execution: the receipt, when it ran, the action, and the
// command's own reported verification - enough for follow-up review alongside the agent's independent
// live re-query (added by the caller as `live`).
function disposeEvidence(execution: DisposeExecution): Record<string, unknown> {
  return {
    planId: execution.planId,
    receiptPath: execution.receiptPath,
    executedAt: execution.executedAt,
    action: execution.result.action,
    status: execution.result.status,
    commandVerification: execution.result.verification
  };
}

// Live disposition facts re-derived straight from the on-disk ledger row and filesystem, independent
// of whatever the dispose command reported.
type LiveDisposeFacts = {
  recordStatus: ArtshelfStatus | "absent";
  subjectPresent: boolean | null;
  targetPresent: boolean | null;
  retainUntil: string | null;
  disposePlanId: string | null;
  disposeAction: string | null;
};

type LiveVerification = { ok: boolean; detail: string; live: LiveDisposeFacts };

// The post-execute verification loop: re-read the live ledger + filesystem and confirm they match the
// end-state the executed action promises. Every applied action must carry THIS plan's audit stamp on
// the live row (proof this execution mutated it, surviving idempotent reruns), plus the
// action-specific status and filesystem end-state. A mismatch means the command's reported success
// cannot be trusted, so the target is failed rather than executed.
function verifyDisposeLive(ledgerPath: string, execution: DisposeExecution): LiveVerification {
  const result = execution.result;
  let record: ArtshelfRecord | undefined;
  try {
    record = readLedger(ledgerPath).find((entry) => entry.id === result.id);
  } catch (error) {
    return liveFail(`could not re-read the live ledger: ${(error as Error).message}`, absentLive());
  }
  if (!record) return liveFail(`record ${result.id} is no longer in the live ledger`, absentLive());

  const subjectPresent = result.previousPath ? existsSync(result.previousPath) : null;
  const targetPresent = result.targetPath ? existsSync(result.targetPath) : null;
  const live: LiveDisposeFacts = {
    recordStatus: record.status,
    subjectPresent,
    targetPresent,
    retainUntil: record.retainUntil ?? null,
    disposePlanId: record.disposePlanId ?? null,
    disposeAction: record.disposeAction ?? null
  };

  if (record.disposePlanId !== execution.planId) {
    return liveFail(`live row is not stamped with this dispose plan (found ${record.disposePlanId ?? "none"})`, live);
  }
  if (record.disposeAction !== result.action) {
    return liveFail(`live row dispose action is ${record.disposeAction ?? "none"}, expected ${result.action}`, live);
  }

  if (result.action === "trash-resolve") {
    if (record.status !== "trashed") return liveFail(`live status is ${record.status}, expected trashed`, live);
    if (targetPresent !== true) return liveFail(`trash target ${result.targetPath} is no longer present`, live);
    if (subjectPresent !== false) return liveFail(`subject is still present at ${result.previousPath}`, live);
    return liveOk(`row trashed and subject moved to ${result.targetPath}`, live);
  }
  if (result.action === "resolve-only") {
    if (record.status !== "resolved") return liveFail(`live status is ${record.status}, expected resolved`, live);
    return liveOk("row resolved without moving the subject", live);
  }
  if (result.action === "snooze") {
    if (isTerminalStatus(record.status)) return liveFail(`live status is terminal (${record.status}); snooze must keep the row active`, live);
    if (record.retainUntil !== result.retainUntil) return liveFail(`live retainUntil is ${record.retainUntil ?? "unset"}, expected ${result.retainUntil}`, live);
    return liveOk(`retention horizon extended to ${result.retainUntil}`, live);
  }
  // keep
  if (isTerminalStatus(record.status)) return liveFail(`live status is terminal (${record.status}); keep must leave the row active`, live);
  return liveOk("row marked reviewed-and-kept", live);
}

function liveOk(detail: string, live: LiveDisposeFacts): LiveVerification {
  return { ok: true, detail, live };
}

function liveFail(detail: string, live: LiveDisposeFacts): LiveVerification {
  return { ok: false, detail, live };
}

function absentLive(): LiveDisposeFacts {
  return { recordStatus: "absent", subjectPresent: null, targetPresent: null, retainUntil: null, disposePlanId: null, disposeAction: null };
}

function isTerminalStatus(status: ArtshelfStatus): boolean {
  return status === "trashed" || status === "resolved";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

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
