import { existsSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { PURGE_APPROVAL_ACTION, purgeCandidateDigest } from "./dashboard.js";
import type { PurgeCandidateFacts } from "./dashboard.js";
import { disposePlanEntryDigest, disposePlanEntrySubjectStaleForExecute, executeDisposePlanEntry, readDisposePlanEntry } from "./dispose.js";
import { approvedTrashPurgePlanId, executeApprovedTrashPurge, readLedger, trashProvenance } from "./ledger.js";
import { resolveRepoRoot } from "./provenance.js";
import { listRegisteredLedgers, normalizeRegistryPath } from "./registry.js";
import {
  approvalSnapshotFingerprint,
  readApprovalSnapshot,
  readSession,
  readSessionHistory,
  replyToEvent,
  revalidateApprovalSnapshot,
  selectedApprovalTargets
} from "./session.js";
import type {
  ArtshelfRecord,
  ArtshelfStatus,
  DisposeAction,
  DisposeExecution,
  DisposePlanEntry,
  UiApprovalLiveFacts,
  UiApprovalRevalidation,
  UiApprovalSnapshot,
  UiApprovalTarget,
  UiBundleExecutionResult,
  UiBundleTargetOutcome,
  UiBundleTargetReceipt,
  UiEvent,
  UiReply,
  UiReplyStatus,
  UiSession
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

  const binding = bindApprovedDisposeTarget(target);
  if (!binding.ok) return binding.execution;

  let execution: DisposeExecution;
  try {
    execution = executeDisposePlanEntry(target.ledgerPath, target.planId, binding.entry);
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
  const verified = verifyDisposeLive(target.ledgerPath, execution, binding.entry);
  const evidence = { ...disposeEvidence(execution), live: verified.live };
  if (!verified.ok) {
    return { outcome: "failed", detail: `failed: live state did not reflect the executed ${result.action}: ${verified.detail}`, evidence };
  }
  return { outcome: "executed", detail: `executed ${result.action}: ${verified.detail}`, evidence };
}

// The real purge-backed target executor (NGX-541 execute slice). Purge is the one-way-door action: a
// fresh, exactly-approved purge target was bound to its live trash facts via purgeCandidateDigest, so
// this RE-READS the live ledger row and re-binds those exact facts (defense-in-depth against any drift
// between the gate's revalidation and this execution) before deleting anything. It then runs the
// exact-target, approval-gated deletion through executeApprovedTrashPurge - never a broad `--all` path -
// and INDEPENDENTLY re-reads the live ledger + filesystem to confirm the trashed artifact is actually
// gone and the row is stamped purged, rather than trusting the command's reported result.
// Outcome mapping:
//   needs_manual_review - not a purge target, missing the reviewed trash-fact digest, or the live row
//                         drifted from the approval (no longer trashed, provenance gone, digest/path
//                         mismatch) or the purge engine refused (skipped) the entry; a human decides.
//   failed              - the purge errored, produced no result, did not complete, or the independent
//                         live re-query did not confirm the deletion + purge stamp.
//   executed            - the trashed artifact was permanently deleted (no recovery path) and the live
//                         ledger row confirms this purge's stamp.
export function purgeBackedTargetExecutor(target: UiApprovalTarget): UiBundleTargetExecution {
  if (!isPurgeAction(target.actionType)) {
    return purgeManualReview(target, `unsupported approved purge action ${target.actionType}; re-review the target`);
  }
  if (!isNonEmptyString(target.planEntryDigest)) {
    return purgeManualReview(target, "approved purge target lacks the reviewed trash-fact digest; re-run the dry-run and re-approve");
  }
  if (!isNonEmptyString(target.recordPath)) {
    return purgeManualReview(target, "approved purge target has no trashed artifact path to delete; re-review the target");
  }

  const completed = completedApprovedPurgeExecution(target);
  if (completed !== null) return completed;

  const binding = bindApprovedPurgeTarget(target);
  if (!binding.ok) return binding.execution;
  const facts = binding.facts;

  let outcome: ReturnType<typeof executeApprovedTrashPurge>;
  try {
    outcome = executeApprovedTrashPurge(target.ledgerPath, {
      id: facts.recordId,
      targetPath: facts.targetPath,
      cleanedAt: facts.cleanedAt,
      receiptPath: facts.receiptPath,
      cleanupPlanId: facts.cleanupPlanId
    });
  } catch (error) {
    return { outcome: "failed", detail: `failed: trash purge --execute errored: ${(error as Error).message}`, evidence: purgeTargetEvidence(target) };
  }

  const result = outcome.result;
  const evidence: Record<string, unknown> = {
    ...purgeTargetEvidence(target),
    purgePlanId: outcome.purgePlanId,
    purgeReceiptPath: outcome.receiptPath,
    purgeResult: result
  };
  if (result === null) {
    return { outcome: "failed", detail: "failed: trash purge produced no result for the approved target", evidence };
  }
  // The purge loop refuses (skips) a drifted/conflicting/out-of-trash entry rather than deleting it, so
  // a human decides - mirroring the dispose path's skipped -> needs_manual_review.
  if (result.status === "skipped") {
    return { outcome: "needs_manual_review", detail: `needs_manual_review: trash purge refused the approved target: ${result.reason ?? "no reason given"}`, evidence };
  }
  if (result.status !== "purged") {
    return { outcome: "failed", detail: `failed: trash purge did not complete (status ${result.status}${result.reason ? `: ${result.reason}` : ""})`, evidence };
  }

  // Verify live state, not the command's word alone: the trashed artifact must be gone and the live row
  // stamped with THIS purge.
  const verified = verifyPurgeLive(target.ledgerPath, facts.recordId, facts.targetPath, outcome.purgePlanId, outcome.receiptPath);
  const verifiedEvidence = { ...evidence, live: verified.live };
  if (!verified.ok) {
    return { outcome: "failed", detail: `failed: live state did not reflect the purge: ${verified.detail}`, evidence: verifiedEvidence };
  }
  return {
    outcome: "executed",
    detail: `executed trash-purge: ${facts.targetPath} permanently deleted with no recovery path`,
    evidence: verifiedEvidence
  };
}

// The default per-target executor: routes a one-way-door purge target to the purge executor and every
// dispose triage target to the dispose executor. A bundle's gate (bundleActionRefusal) already
// guarantees every selected target shares the bundle's action, so this per-target dispatch is exact.
export function defaultBundleTargetExecutor(target: UiApprovalTarget): UiBundleTargetExecution {
  if (isPurgeAction(target.actionType)) return purgeBackedTargetExecutor(target);
  return disposeBackedTargetExecutor(target);
}

type PurgeTargetBinding =
  | { ok: true; facts: PurgeCandidateFacts }
  | { ok: false; execution: UiBundleTargetExecution };

// Re-bind one approved purge target to its EXACT live trash facts immediately before the one-way-door
// deletion. The approval gate already revalidated, but this is the defense-in-depth re-read at the
// moment of execution: it resolves the live ledger row, requires it to still be trashed with intact
// provenance, recomputes the trash-fact digest, and refuses unless that digest and the trashed artifact
// path both still match exactly what the human approved. Any drift -> needs_manual_review, never a
// deletion of something other than the reviewed artifact.
function bindApprovedPurgeTarget(target: UiApprovalTarget): PurgeTargetBinding {
  let record: ArtshelfRecord | undefined;
  const recordId = approvalRecordId(target);
  try {
    record = readLedger(target.ledgerPath).find((entry) => entry.id === recordId);
  } catch (error) {
    return {
      ok: false,
      execution: { outcome: "failed", detail: `failed: could not re-read the live ledger before purge: ${(error as Error).message}`, evidence: purgeTargetEvidence(target) }
    };
  }
  if (record === undefined) {
    return { ok: false, execution: purgeManualReview(target, "the approved purge subject is no longer in the live ledger; re-review the target") };
  }
  if (record.status !== "trashed") {
    return { ok: false, execution: purgeManualReview(target, `the approved purge subject is ${record.status}, not trashed (already purged or restored); re-review the target`) };
  }
  const provenance = trashProvenance(record);
  const facts = approvedPurgeFacts(target, record, provenance);
  if (facts === null) {
    return { ok: false, execution: purgeManualReview(target, "the approved purge subject lost its trash provenance; re-review the target") };
  }
  if (purgeCandidateDigest(facts) !== target.planEntryDigest) {
    return { ok: false, execution: purgeManualReview(target, "the approved purge target drifted from its reviewed trash facts; re-run the dry-run and re-approve") };
  }
  if (record.targetPath !== target.recordPath) {
    return { ok: false, execution: purgeManualReview(target, "the approved purge target path drifted from the reviewed trashed artifact; re-review the target") };
  }
  return { ok: true, facts };
}

function completedApprovedPurgeExecution(target: UiApprovalTarget): UiBundleTargetExecution | null {
  let record: ArtshelfRecord | undefined;
  const recordId = approvalRecordId(target);
  try {
    record = readLedger(target.ledgerPath).find((entry) => entry.id === recordId);
  } catch (error) {
    return { outcome: "failed", detail: `failed: could not re-read the live ledger before purge: ${(error as Error).message}`, evidence: purgeTargetEvidence(target) };
  }
  if (record === undefined) return null;
  const completed = approvedCompletedPurge(target, record);
  if (completed === null) return null;
  const verified = verifyPurgeLive(target.ledgerPath, completed.facts.recordId, completed.facts.targetPath, completed.purgePlanId, completed.receiptPath);
  const evidence = {
    ...purgeTargetEvidence(target),
    purgePlanId: completed.purgePlanId,
    purgeReceiptPath: completed.receiptPath,
    live: verified.live
  };
  if (!verified.ok) {
    return { outcome: "failed", detail: `failed: live state did not reflect the purge: ${verified.detail}`, evidence };
  }
  return {
    outcome: "executed",
    detail: `executed trash-purge: ${completed.facts.targetPath} permanently deleted with no recovery path`,
    evidence
  };
}

// Live purge facts re-derived straight from the on-disk ledger row and filesystem, independent of
// whatever the purge command reported.
type LivePurgeFacts = {
  recordStatus: ArtshelfStatus | "absent";
  targetPresent: boolean;
  purgePlanId: string | null;
  purgeReceiptPath: string | null;
  purgedAt: string | null;
};

type LivePurgeVerification = { ok: boolean; detail: string; live: LivePurgeFacts };

// The post-purge verification loop: re-read the live ledger + filesystem and confirm the one-way-door
// deletion actually took effect - the trashed artifact is physically gone AND the live row carries THIS
// purge's stamp (status resolved, this plan id, this receipt, a purgedAt). A mismatch means the
// command's reported success cannot be trusted, so the target is failed rather than executed.
function verifyPurgeLive(
  ledgerPath: string,
  recordId: string,
  targetPath: string,
  purgePlanId: string,
  receiptPath: string
): LivePurgeVerification {
  let record: ArtshelfRecord | undefined;
  try {
    record = readLedger(ledgerPath).find((entry) => entry.id === recordId);
  } catch (error) {
    return { ok: false, detail: `could not re-read the live ledger: ${(error as Error).message}`, live: absentPurgeLive(targetPath) };
  }
  const targetPresent = existsSync(targetPath);
  if (record === undefined) {
    return { ok: false, detail: `record ${recordId} is no longer in the live ledger`, live: { recordStatus: "absent", targetPresent, purgePlanId: null, purgeReceiptPath: null, purgedAt: null } };
  }
  const live: LivePurgeFacts = {
    recordStatus: record.status,
    targetPresent,
    purgePlanId: record.purgePlanId ?? null,
    purgeReceiptPath: record.purgeReceiptPath ?? null,
    purgedAt: record.purgedAt ?? null
  };
  if (targetPresent) return { ok: false, detail: `trashed artifact ${targetPath} still exists after purge`, live };
  if (record.status !== "resolved") return { ok: false, detail: `live status is ${record.status}, expected resolved`, live };
  if (record.purgePlanId !== purgePlanId) return { ok: false, detail: `live row is not stamped with this purge plan (found ${record.purgePlanId ?? "none"})`, live };
  if (record.purgeReceiptPath !== receiptPath) return { ok: false, detail: `live row purge receipt is ${record.purgeReceiptPath ?? "none"}, expected ${receiptPath}`, live };
  if (!isNonEmptyString(record.purgedAt)) return { ok: false, detail: "live row has no purgedAt stamp", live };
  return { ok: true, detail: "trashed artifact deleted and row stamped purged", live };
}

function absentPurgeLive(targetPath: string): LivePurgeFacts {
  return { recordStatus: "absent", targetPresent: existsSync(targetPath), purgePlanId: null, purgeReceiptPath: null, purgedAt: null };
}

function purgeManualReview(target: UiApprovalTarget, reason: string): UiBundleTargetExecution {
  return { outcome: "needs_manual_review", detail: `needs_manual_review: ${reason}`, evidence: purgeTargetEvidence(target) };
}

function purgeTargetEvidence(target: UiApprovalTarget): Record<string, unknown> {
  return {
    ledgerPath: target.ledgerPath,
    targetId: target.targetId,
    recordId: approvalRecordId(target),
    recordPath: target.recordPath,
    approvedPurgeDigest: target.planEntryDigest ?? null,
    actionType: target.actionType
  };
}

const APPROVED_DISPOSE_ACTIONS: ReadonlyMap<string, DisposeAction> = new Map([
  ["trash-resolve", "trash-resolve"],
  ["trash", "trash-resolve"],
  ["resolve-only", "resolve-only"],
  ["resolve", "resolve-only"],
  ["snooze", "snooze"],
  ["defer", "snooze"],
  ["keep", "keep"]
]);

type DisposeTargetBinding =
  | { ok: true; entry: DisposePlanEntry; action: DisposeAction }
  | { ok: false; execution: UiBundleTargetExecution };

function bindApprovedDisposeTarget(target: UiApprovalTarget): DisposeTargetBinding {
  const action = approvedDisposeAction(target.actionType);
  if (action === null) {
    return {
      ok: false,
      execution: {
        outcome: "needs_manual_review",
        detail: `needs_manual_review: unsupported approved dispose action ${target.actionType}; re-review the target`,
        evidence: targetBindingEvidence(target)
      }
    };
  }
  if (!isNonEmptyString(target.recordPath)) {
    return {
      ok: false,
      execution: {
        outcome: "needs_manual_review",
        detail: "needs_manual_review: approved dispose target has no record path to bind against the reviewed plan; re-review the target",
        evidence: targetBindingEvidence(target)
      }
    };
  }

  let entry: DisposePlanEntry;
  try {
    entry = readDisposePlanEntry(target.ledgerPath, target.planId as string);
  } catch (error) {
    return {
      ok: false,
      execution: {
        outcome: "failed",
        detail: `failed: dispose plan validation errored: ${(error as Error).message}`,
        evidence: targetBindingEvidence(target)
      }
    };
  }

  const digest = disposePlanEntryDigest(entry);
  if (!isNonEmptyString(target.planEntryDigest)) {
    return {
      ok: false,
      execution: {
        outcome: "needs_manual_review",
        detail: "needs_manual_review: approved target lacks the reviewed dispose-plan entry digest; re-run the dry-run and re-approve",
        evidence: { ...targetBindingEvidence(target), livePlanEntryDigest: digest }
      }
    };
  }
  if (target.planEntryDigest !== digest) {
    return {
      ok: false,
      execution: targetPlanMismatch(target, entry, "reviewed dispose-plan entry digest changed after approval")
    };
  }

  if (entry.id !== target.targetId) {
    return { ok: false, execution: targetPlanMismatch(target, entry, `plan targets ${entry.id}, approved ${target.targetId}`) };
  }
  if (entry.subjectPath !== target.recordPath || entry.path !== target.recordPath) {
    return { ok: false, execution: targetPlanMismatch(target, entry, `plan path ${entry.subjectPath}, approved ${target.recordPath}`) };
  }
  if (entry.action !== action) {
    return { ok: false, execution: targetPlanMismatch(target, entry, `plan action ${entry.action}, approved ${action}`) };
  }
  return { ok: true, entry, action };
}

function approvedDisposeAction(value: string): DisposeAction | null {
  return APPROVED_DISPOSE_ACTIONS.get(value) ?? null;
}

function targetPlanMismatch(target: UiApprovalTarget, entry: DisposePlanEntry, reason: string): UiBundleTargetExecution {
  return {
    outcome: "needs_manual_review",
    detail: `needs_manual_review: approved target and reviewed dispose plan mismatch (${reason}); re-run the dry-run and re-approve`,
    evidence: { ...targetBindingEvidence(target), planTargetId: entry.id, planRecordPath: entry.subjectPath, planAction: entry.action }
  };
}

function targetBindingEvidence(target: UiApprovalTarget): Record<string, unknown> {
  return {
    ledgerPath: target.ledgerPath,
    targetId: target.targetId,
    recordPath: target.recordPath,
    planId: target.planId,
    approvedPlanEntryDigest: target.planEntryDigest ?? null,
    actionType: target.actionType
  };
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
  recordPath: string | null;
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
function verifyDisposeLive(ledgerPath: string, execution: DisposeExecution, entry: DisposePlanEntry): LiveVerification {
  const result = execution.result;
  let record: ArtshelfRecord | undefined;
  try {
    record = readLedger(ledgerPath).find((entry) => entry.id === result.id);
  } catch (error) {
    return liveFail(`could not re-read the live ledger: ${(error as Error).message}`, absentLive());
  }
  if (!record) return liveFail(`record ${result.id} is no longer in the live ledger`, absentLive());

  const subjectPresent = result.previousPath ? existsSync(result.previousPath) : existsSync(record.path);
  const targetPresent = result.targetPath ? existsSync(result.targetPath) : null;
  const live: LiveDisposeFacts = {
    recordStatus: record.status,
    recordPath: record.path,
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
  if (record.path !== entry.path || record.path !== entry.subjectPath) {
    return liveFail(`live row path is ${record.path}, expected ${entry.subjectPath}`, live);
  }
  if (record.disposeReason !== entry.reason) {
    return liveFail("live row dispose reason does not match the reviewed plan entry", live);
  }

  if (result.action === "trash-resolve") {
    if (record.status !== "trashed") return liveFail(`live status is ${record.status}, expected trashed`, live);
    if (result.reason !== entry.reason) return liveFail("receipt reason does not match the reviewed plan entry", live);
    if (record.previousPath !== entry.subjectPath) return liveFail(`live previousPath is ${record.previousPath ?? "unset"}, expected ${entry.subjectPath}`, live);
    if (record.targetPath !== entry.targetPath) return liveFail(`live targetPath is ${record.targetPath ?? "unset"}, expected ${entry.targetPath ?? "unset"}`, live);
    if (result.previousPath !== entry.subjectPath) return liveFail(`receipt previousPath is ${result.previousPath ?? "unset"}, expected ${entry.subjectPath}`, live);
    if (result.targetPath !== entry.targetPath) return liveFail(`receipt targetPath is ${result.targetPath ?? "unset"}, expected ${entry.targetPath ?? "unset"}`, live);
    if (targetPresent !== true) return liveFail(`trash target ${result.targetPath} is no longer present`, live);
    if (subjectPresent !== false) return liveFail(`subject is still present at ${result.previousPath}`, live);
    return liveOk(`row trashed and subject moved to ${result.targetPath}`, live);
  }
  if (result.action === "resolve-only") {
    if (record.status !== "resolved") return liveFail(`live status is ${record.status}, expected resolved`, live);
    if (record.resolutionReason !== entry.reason) return liveFail("live resolution reason does not match the reviewed plan entry", live);
    if (result.reason !== entry.reason) return liveFail("receipt reason does not match the reviewed plan entry", live);
    if (subjectPresent !== result.verification.subjectPresent) {
      return liveFail(`subject presence is ${subjectPresent}, expected ${result.verification.subjectPresent}`, live);
    }
    return liveOk("row resolved without moving the subject", live);
  }
  if (result.action === "snooze") {
    if (record.status !== entry.status) return liveFail(`live status is ${record.status}, expected ${entry.status}`, live);
    if (result.reason !== entry.reason) return liveFail("receipt reason does not match the reviewed plan entry", live);
    if (!sameJson(record.retention, entry.retention)) return liveFail("live retention does not match the reviewed plan entry", live);
    if (record.retainUntil !== entry.retainUntil) return liveFail(`live retainUntil is ${record.retainUntil ?? "unset"}, expected ${entry.retainUntil}`, live);
    if (!sameJson(result.retention, entry.retention)) return liveFail("receipt retention does not match the reviewed plan entry", live);
    if (result.retainUntil !== entry.retainUntil) return liveFail(`receipt retainUntil is ${result.retainUntil ?? "unset"}, expected ${entry.retainUntil}`, live);
    if (subjectPresent !== result.verification.subjectPresent) {
      return liveFail(`subject presence is ${subjectPresent}, expected ${result.verification.subjectPresent}`, live);
    }
    return liveOk(`retention horizon extended to ${result.retainUntil}`, live);
  }
  // keep
  if (record.status !== entry.status) return liveFail(`live status is ${record.status}, expected ${entry.status}`, live);
  if (result.reason !== entry.reason) return liveFail("receipt reason does not match the reviewed plan entry", live);
  if (subjectPresent !== result.verification.subjectPresent) {
    return liveFail(`subject presence is ${subjectPresent}, expected ${result.verification.subjectPresent}`, live);
  }
  return liveOk("row marked reviewed-and-kept", live);
}

function liveOk(detail: string, live: LiveDisposeFacts): LiveVerification {
  return { ok: true, detail, live };
}

function liveFail(detail: string, live: LiveDisposeFacts): LiveVerification {
  return { ok: false, detail, live };
}

function absentLive(): LiveDisposeFacts {
  return { recordStatus: "absent", recordPath: null, subjectPresent: null, targetPresent: null, retainUntil: null, disposePlanId: null, disposeAction: null };
}

function isTerminalStatus(status: ArtshelfStatus): boolean {
  return status === "trashed" || status === "resolved";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function approvalRecordId(target: UiApprovalTarget): string {
  return target.recordId ?? target.targetId;
}

// Re-read the live ledger/record facts an executor revalidates an approved bundle against before
// running anything (NGX-540). Approval persisted an immutable snapshot; revalidateApprovalSnapshot
// then compares the *selected* per-target context (and reviewed basis) the human approved against
// what live state now reports. This produces that live re-read: for each selected target it resolves
// the live ledger row straight from disk and
// reflects the SPEC drift signals so a drifted target never executes:
//   - record gone, or its ledger unreadable/absent: omitted, so revalidation marks it missing.
//   - a purge target (one-way-door, NGX-541): handled by reReadLivePurgeTarget, which - unlike the
//     dispose rules below - KEEPS a still-trashed candidate and revalidates it against its live trash
//     facts, since a purge subject is expected to be terminal (already trashed).
//   - status already terminal (trashed/resolved): the target is dropped unless it is already stamped
//     with the approved dispose plan, which lets an in-progress resume replay verification.
//   - subject remapped (the live row's path no longer matches the reviewed recordPath): echoed with
//     the live path so exactly one field diverges and revalidation marks it changed.
//   - otherwise present and active: echoed verbatim so it revalidates as unchanged.
// Reviewed facts capture the shared basis the human approved against. No production path populates
// them with re-derivable content yet (NGX-539 built the fingerprint/drift mechanism ahead of a
// producer), so this re-confirms none of them: any captured reviewed fact therefore surfaces as
// drift and the whole bundle is conservatively refused - the deliberate refuse-on-ambiguity posture
// for the first mutating UI slice - while the common empty-reviewed bundle is gated purely on its
// exact targets' liveness. A future reviewed-fact producer adds its matching live re-derivation here.
export function collectApprovalLiveFacts(snapshot: UiApprovalSnapshot): UiApprovalLiveFacts {
  const ledgerCache = new Map<string, Map<string, ArtshelfRecord>>();
  const targets: UiApprovalTarget[] = [];
  for (const target of selectedApprovalTargets(snapshot)) {
    const liveTarget = reReadLiveTarget(target, ledgerCache);
    if (liveTarget !== null) targets.push(liveTarget);
  }
  return { targets, reviewed: {} };
}

// Resolve one approved target's live ledger row and map it to its live target context, or null when
// the approved subject is gone or no longer actionable (see collectApprovalLiveFacts for the rules).
function reReadLiveTarget(
  target: UiApprovalTarget,
  ledgerCache: Map<string, Map<string, ArtshelfRecord>>
): UiApprovalTarget | null {
  const recordId = isPurgeAction(target.actionType) ? approvalRecordId(target) : target.targetId;
  const record = liveRecordById(target.ledgerPath, recordId, ledgerCache);
  if (record === undefined) return null; // subject gone, or the ledger could not be re-read
  if (isPurgeAction(target.actionType)) return reReadLivePurgeTarget(target, record);
  if (isTerminalStatus(record.status)) return recordMatchesApprovedDispose(target, record) ? target : null;
  if (isNonEmptyString(target.planId) && liveDisposeStampChanged(target, record)) {
    return { ...target, planEntryDigest: `${target.planEntryDigest ?? "missing"}:live-dispose-stamp-mismatch` };
  }
  if (isNonEmptyString(target.planId) && record.disposePlanId === target.planId && !recordMatchesApprovedDispose(target, record)) {
    return { ...target, planEntryDigest: `${target.planEntryDigest ?? "missing"}:live-record-mismatch` };
  }
  // A remapped subject is present but changed: echo the live path so revalidation flags it changed.
  if (isNonEmptyString(target.recordPath) && record.path !== target.recordPath) {
    return { ...target, recordPath: record.path };
  }
  if (isNonEmptyString(target.planId)) {
    const planEntry = liveDisposePlanEntryState(target);
    if (planEntry === null) {
      return { ...target, planEntryDigest: `${target.planEntryDigest ?? "missing"}:missing-reviewed-plan` };
    }
    if (isNonEmptyString(target.planEntryDigest)) {
      if (planEntry.digest !== target.planEntryDigest) {
        return { ...target, planEntryDigest: planEntry.digest };
      }
      if (planEntry.subjectStale) {
        return { ...target, planEntryDigest: `${target.planEntryDigest}:subject-drifted` };
      }
    }
  }
  return target;
}

// Re-read one approved purge target against its live ledger row (NGX-541 AC5/AC7). Purge is the one
// case where the approved subject is *expected* to be terminal (already trashed), so unlike the
// dispose path this keeps a still-trashed candidate instead of dropping it. The approval is bound to
// the exact trash facts via purgeCandidateDigest; this recomputes that digest from the live row so the
// revalidation gate decides whether the one-way-door deletion is still exactly what the human approved:
//   - record no longer trashed (already purged -> resolved, or restored to active): no longer a purge
//     candidate, so omitted -> revalidation marks it missing and it is skipped_stale. This also makes
//     re-running an already-purged target a safe no-op, never a double deletion.
//   - still trashed but its trash provenance/targetPath is gone or drifted: echo the recomputed
//     (mismatching) digest so exactly one field diverges and revalidation marks it changed -> skipped.
//   - still trashed with the exact approved trash facts: echoed verbatim -> revalidates unchanged.
function reReadLivePurgeTarget(target: UiApprovalTarget, record: ArtshelfRecord): UiApprovalTarget | null {
  if (record.status === "resolved" && approvedCompletedPurge(target, record) !== null) return target;
  if (record.status !== "trashed") return null;
  const provenance = trashProvenance(record);
  const facts = approvedPurgeFacts(target, record, provenance);
  if (facts === null) {
    // Still trashed, but no longer a valid purge candidate (provenance gone): flag drift, never purge.
    return { ...target, planEntryDigest: `${target.planEntryDigest ?? "missing"}:trash-provenance-missing` };
  }
  const liveDigest = purgeCandidateDigest(facts);
  if (liveDigest !== target.planEntryDigest) return { ...target, planEntryDigest: liveDigest };
  return target;
}

function approvedPurgeFacts(target: UiApprovalTarget, record: ArtshelfRecord, provenance: ReturnType<typeof trashProvenance>): PurgeCandidateFacts | null {
  if (provenance === null || !isNonEmptyString(record.targetPath)) return null;
  const facts: PurgeCandidateFacts = {
    recordId: record.id,
    ledgerPath: target.ledgerPath,
    targetPath: record.targetPath,
    cleanedAt: provenance.cleanedAt,
    cleanupPlanId: provenance.cleanupPlanId,
    receiptPath: provenance.receiptPath
  };
  return facts;
}

function approvedCompletedPurge(
  target: UiApprovalTarget,
  record: ArtshelfRecord
): { facts: PurgeCandidateFacts; purgePlanId: string; receiptPath: string } | null {
  if (record.status !== "resolved" || record.resolutionReason !== "trash purge completed") return null;
  const facts = approvedPurgeFacts(target, record, trashProvenance(record));
  if (facts === null) return null;
  if (purgeCandidateDigest(facts) !== target.planEntryDigest) return null;
  if (record.targetPath !== target.recordPath) return null;
  const purgePlanId = approvedTrashPurgePlanId(target.ledgerPath, {
    id: facts.recordId,
    targetPath: facts.targetPath,
    cleanedAt: facts.cleanedAt,
    receiptPath: facts.receiptPath,
    cleanupPlanId: facts.cleanupPlanId
  });
  if (record.purgePlanId !== purgePlanId) return null;
  if (!isNonEmptyString(record.purgeReceiptPath) || !existsSync(record.purgeReceiptPath)) return null;
  return { facts, purgePlanId, receiptPath: record.purgeReceiptPath };
}

function liveDisposeStampChanged(target: UiApprovalTarget, record: ArtshelfRecord): boolean {
  if (record.disposePlanId === undefined && record.disposeAction === undefined) return false;
  return record.disposePlanId !== target.planId || record.disposeAction !== approvedDisposeAction(target.actionType);
}

function liveDisposePlanEntryState(target: UiApprovalTarget): { digest: string; subjectStale: boolean } | null {
  try {
    const entry = readDisposePlanEntry(target.ledgerPath, target.planId as string);
    return {
      digest: disposePlanEntryDigest(entry),
      subjectStale: disposePlanEntrySubjectStaleForExecute(entry)
    };
  } catch {
    return null;
  }
}

function recordMatchesApprovedDispose(target: UiApprovalTarget, record: ArtshelfRecord): boolean {
  const action = approvedDisposeAction(target.actionType);
  if (action === null || !isNonEmptyString(target.planId) || record.disposePlanId !== target.planId || record.disposeAction !== action) {
    return false;
  }
  let entry: DisposePlanEntry;
  try {
    entry = readDisposePlanEntry(target.ledgerPath, target.planId);
  } catch {
    return false;
  }
  if (isNonEmptyString(target.planEntryDigest) && disposePlanEntryDigest(entry) !== target.planEntryDigest) {
    return false;
  }
  return recordMatchesDisposeEntry(record, entry);
}

function recordMatchesDisposeEntry(record: ArtshelfRecord, entry: DisposePlanEntry): boolean {
  if (record.disposeAction !== entry.action) return false;
  if (record.disposeReason !== entry.reason) return false;
  if (record.path !== entry.path || record.path !== entry.subjectPath) return false;
  if (entry.action === "trash-resolve") {
    return record.status === "trashed" && record.previousPath === entry.subjectPath && record.targetPath === entry.targetPath;
  }
  if (entry.action === "resolve-only") {
    return record.status === "resolved" && record.resolutionReason === entry.reason;
  }
  if (entry.action === "snooze") {
    return record.status === entry.status && sameJson(record.retention, entry.retention) && record.retainUntil === entry.retainUntil;
  }
  return record.status === entry.status;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

// Index a ledger by record id once per ledger path, treating an unreadable or absent ledger as empty
// so a re-read failure safely reads as "subject gone" rather than throwing mid-revalidation.
function liveRecordById(
  ledgerPath: string,
  recordId: string,
  cache: Map<string, Map<string, ArtshelfRecord>>
): ArtshelfRecord | undefined {
  let byId = cache.get(ledgerPath);
  if (byId === undefined) {
    byId = new Map<string, ArtshelfRecord>();
    try {
      for (const record of readLedger(ledgerPath)) byId.set(record.id, record);
    } catch {
      // An unreadable ledger means we cannot confirm any subject on it: leave the index empty so
      // every target there reads as missing and is safely skipped/refused rather than executed.
    }
    cache.set(ledgerPath, byId);
  }
  return byId.get(recordId);
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
  const snapshotFingerprintMatches = approvalSnapshotFingerprint(selected, snapshot.reviewed) === snapshot.fingerprint;
  const actionRefusal = bundleActionRefusal(snapshot, selected);

  // Refuse the entire bundle - executing nothing - when the *shared* basis the human approved
  // against can no longer be trusted: a reviewed fact drifted, or the persisted fingerprint no
  // longer matches the bundle's own selected targets (a tampered or corrupt approval record). Both
  // are ambiguity at the bundle level, and the v1 safety posture is refusal on ambiguity. Per-target
  // drift (a single missing or changed target) does not poison the others: those are skipped while
  // the still-exact targets execute, so a partial run stays honest.
  const bundleRefused =
    actionRefusal !== null ||
    revalidation.reviewedKeysDrifted.length > 0 ||
    !snapshotFingerprintMatches ||
    hasUnexplainedFingerprintMismatch(revalidation);

  const receipts: UiBundleTargetReceipt[] = selected.map((target) => {
    if (bundleRefused) {
      return staleReceipt(target, actionRefusal ?? "approval bundle refused: the reviewed basis or bundle fingerprint no longer matches live state; re-review");
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

function bundleActionRefusal(snapshot: UiApprovalSnapshot, selected: UiApprovalTarget[]): string | null {
  // Purge is a distinct one-way-door action (NGX-541) routed through the purge executor, not the
  // dispose path. A purge bundle is accepted only when every selected target is itself a purge target,
  // so a destructive bundle can never smuggle a non-purge action past the gate.
  if (isPurgeAction(snapshot.actionType)) {
    const mismatch = selected.find((target) => !isPurgeAction(target.actionType));
    if (mismatch) {
      return `approval bundle refused: bundle action ${PURGE_APPROVAL_ACTION} does not match selected target ${mismatch.targetId} action ${mismatch.actionType}; re-review`;
    }
    return null;
  }
  const action = approvedDisposeAction(snapshot.actionType);
  if (action === null) {
    return `approval bundle refused: unsupported bundle action ${snapshot.actionType}; re-review`;
  }
  const mismatch = selected.find((target) => approvedDisposeAction(target.actionType) !== action);
  if (mismatch) {
    return `approval bundle refused: bundle action ${action} does not match selected target ${mismatch.targetId} action ${mismatch.actionType}; re-review`;
  }
  return null;
}

// NGX-541: whether an approved action routes through the one-way-door purge executor. Purge is the
// established `trash-purge` operation; any other value is a dispose triage action (or unsupported).
function isPurgeAction(value: string): boolean {
  return value === PURGE_APPROVAL_ACTION;
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
  if (total === 0) return "refused";
  if (counts.executed === total) return "executed";
  if (counts.executed === 0 && counts.failed === 0 && counts.needs_manual_review === 0) return "refused";
  return "partial";
}

// The result of the agent's full handling of one approved bundle (NGX-540): the execution result
// itself, plus the durable session reply the agent wrote back so the human sees per-target receipts
// and the aggregate state. The reply is appended to the session log against the bundle's own
// approval_bundle_submitted event, so the receipt trail survives reload, restart, and resume.
export type UiBundleExecutionReply = {
  execution: UiBundleExecutionResult;
  event: UiEvent;
  reply: UiReply;
};

// The agent's end-to-end handling of one approved bundle for a session (NGX-540): load the immutable
// reviewed snapshot, re-read live state, run the revalidate -> execute -> verify loop, then write the
// per-target receipts and aggregate state back to the session. This is the session-scoped, I/O-bound
// orchestration wrapper around the pure executeApprovalBundle core: it owns loading the bundle,
// resolving the event to reply to, and persisting the receipts, while the safety gate and per-target
// classification stay in the pure core. The default executor routes each target by action - purge
// targets to the one-way-door purge executor, dispose targets to the dispose executor; tests inject a
// fake one to exercise the orchestration without the real mutating path.
export function executeApprovedBundle(
  home: string,
  sessionId: string,
  bundleId: string,
  executeTarget: UiBundleTargetExecutor = defaultBundleTargetExecutor
): UiBundleExecutionReply {
  // Validate the session exists and load the immutable reviewed bundle. readSession throws on a
  // missing session; readApprovalSnapshot throws on a missing or malformed bundle id.
  const session = readSession(home, sessionId);
  if (session.status !== "active") {
    throw new Error(`Artshelf UI session ${session.id} has ended; ui execute requires an active session`);
  }
  const snapshot = readApprovalSnapshot(home, session.id, bundleId);

  // Resolve the bundle's own approval_bundle_submitted event BEFORE executing anything: the agent
  // must reply receipts to it, so if it is missing we refuse the whole operation rather than mutate
  // live state and then have nowhere to record the result.
  const claim = findApprovalBundleEvent(home, session.id, bundleId);
  validateApprovalEventWitness(claim.event, snapshot);
  validateApprovalEventClaim(claim, snapshot);
  validateApprovalSnapshotScope(home, session, claim.event, snapshot);
  if (claim.status === "pending") {
    replyToEvent(home, session.id, claim.event.id, {
      status: "in_progress",
      payload: { bundleId: snapshot.id, fingerprint: snapshot.fingerprint },
      expectedStatus: "pending"
    });
  }

  // Re-read live state and run the revalidate -> execute -> verify loop. The pure core decides which
  // targets are still exactly what the human approved and produces one receipt per selected target.
  const live = collectApprovalLiveFacts(snapshot);
  const execution = executeApprovalBundle(snapshot, live, executeTarget);

  // Write the per-target receipts and aggregate state back to the session by advancing the bundle's
  // submitted event, so every approved target ends with a visible, durable result in the UI session.
  const { event: repliedEvent, reply } = replyToEvent(home, session.id, claim.event.id, {
    status: bundleReplyStatus(execution.status),
    payload: bundleReplyPayload(execution)
  });
  return { execution, event: repliedEvent, reply };
}

type ApprovalBundleEventClaim =
  | { status: "pending"; event: UiEvent }
  | { status: "in_progress"; event: UiEvent; reply: UiReply };

// Find the approval_bundle_submitted event that introduced this bundle - its target carries the
// bundleId, per the loopback server's write path. Refuse when absent: a bundle the agent can execute
// always has a submitted event to reply receipts against, so a missing one is an integrity problem,
// not a silent no-op.
function findApprovalBundleEvent(home: string, sessionId: string, bundleId: string): ApprovalBundleEventClaim {
  const history = readSessionHistory(home, sessionId).find(
    (entry) => entry.event.type === "approval_bundle_submitted" && entry.event.target.bundleId === bundleId
  );
  if (!history) {
    throw new Error(`Artshelf UI bundle ${bundleId} has no approval_bundle_submitted event to reply to`);
  }
  const event = history.event;
  if (event.status !== "pending") {
    if (event.status === "in_progress") {
      const reply = history.replies.at(-1);
      if (!reply || reply.status !== "in_progress") {
        throw new Error(`Artshelf UI bundle ${bundleId} approval_bundle_submitted event has no matching in_progress claim`);
      }
      return { status: "in_progress", event, reply };
    }
    throw new Error(
      `Artshelf UI bundle ${bundleId} approval_bundle_submitted event is ${event.status}; ui execute requires a pending or in_progress event`
    );
  }
  return { status: "pending", event };
}

function validateApprovalEventWitness(event: UiEvent, snapshot: UiApprovalSnapshot): void {
  const payload = event.payload;
  if (event.sessionId !== snapshot.sessionId) {
    throw new Error(`Artshelf UI bundle ${snapshot.id} approval event session does not match the loaded bundle session`);
  }
  if (event.target.bundleId !== snapshot.id) {
    throw new Error(`Artshelf UI bundle ${snapshot.id} approval event target does not match the loaded bundle id`);
  }
  if (payload.bundleId !== snapshot.id) {
    throw new Error(`Artshelf UI bundle ${snapshot.id} approval event payload does not match the loaded bundle id`);
  }
  if (payload.fingerprint !== snapshot.fingerprint) {
    throw new Error(`Artshelf UI bundle ${snapshot.id} approval event fingerprint does not match the loaded bundle`);
  }
  if (payload.actionType !== snapshot.actionType) {
    throw new Error(`Artshelf UI bundle ${snapshot.id} approval event actionType does not match the loaded bundle`);
  }
  if (!sameStringArray(payload.selectedTargetIds, snapshot.selectedTargetIds)) {
    throw new Error(`Artshelf UI bundle ${snapshot.id} approval event selection does not match the loaded bundle`);
  }
  if (payload.selectedCount !== snapshot.selectedTargetIds.length || payload.targetCount !== snapshot.targets.length) {
    throw new Error(`Artshelf UI bundle ${snapshot.id} approval event counts do not match the loaded bundle`);
  }
}

function validateApprovalEventClaim(claim: ApprovalBundleEventClaim, snapshot: UiApprovalSnapshot): void {
  if (claim.status === "pending") return;
  const payload = claim.reply.payload;
  if (payload.bundleId !== snapshot.id) {
    throw new Error(`Artshelf UI bundle ${snapshot.id} in_progress claim does not match the loaded bundle id`);
  }
  if (payload.fingerprint !== snapshot.fingerprint) {
    throw new Error(`Artshelf UI bundle ${snapshot.id} in_progress claim fingerprint does not match the loaded bundle`);
  }
}

function validateApprovalSnapshotScope(home: string, session: UiSession, event: UiEvent, snapshot: UiApprovalSnapshot): void {
  const selected = selectedApprovalTargets(snapshot);
  if (session.ledgerPath) {
    const allowedLedger = resolve(session.ledgerPath);
    for (const target of selected) {
      if (resolve(target.ledgerPath) !== allowedLedger) {
        throw new Error(
          `Artshelf UI bundle ${snapshot.id} target ${target.targetId} is outside the session scope: expected ledger ${allowedLedger}, found ${resolve(target.ledgerPath)}`
        );
      }
    }
    return;
  }

  if (session.scope === "repo") {
    const sessionRepoRoot = session.repoRoot ? resolve(session.repoRoot) : repoRootFromUiHome(home);
    if (sessionRepoRoot === null) {
      throw new Error(`Artshelf UI session ${session.id} repo scope cannot be resolved from UI home ${resolve(home)}`);
    }
    for (const target of selected) {
      const targetRepoRoot = resolveRepoRoot(target.ledgerPath);
      if (targetRepoRoot === null || !samePath(targetRepoRoot, sessionRepoRoot)) {
        throw new Error(
          `Artshelf UI bundle ${snapshot.id} target ${target.targetId} is outside the session scope: expected repo ${sessionRepoRoot}, found ${targetRepoRoot ?? "unresolved"}`
        );
      }
    }
  }

  const registryPath = approvalRegistryPath(session, event);
  if (registryPath !== null) validateApprovalTargetsRegistryScope(snapshot, selected, registryPath);
}

function approvalRegistryPath(session: UiSession, event: UiEvent): string | null {
  const sessionRegistryPath = session.registryPath ? resolve(session.registryPath) : null;
  const eventRegistryPath = event.payload.registryPath;
  if (sessionRegistryPath !== null) {
    if (isNonEmptyString(eventRegistryPath) && !samePath(eventRegistryPath, sessionRegistryPath)) {
      throw new Error(
        `Artshelf UI session ${session.id} approval event registry does not match the session registry scope: expected ${sessionRegistryPath}, found ${resolve(eventRegistryPath)}`
      );
    }
    return sessionRegistryPath;
  }
  if (isNonEmptyString(eventRegistryPath)) {
    const defaultRegistryPath = normalizeRegistryPath();
    if (!samePath(eventRegistryPath, defaultRegistryPath)) {
      throw new Error(
        `Artshelf UI session ${session.id} approval event registry does not match the session registry scope: expected ${defaultRegistryPath}, found ${resolve(eventRegistryPath)}`
      );
    }
    return defaultRegistryPath;
  }
  if (session.scope === "user") return normalizeRegistryPath();
  return null;
}

function validateApprovalTargetsRegistryScope(snapshot: UiApprovalSnapshot, selected: UiApprovalTarget[], registryPath: string): void {
  let allowedLedgers: Set<string>;
  try {
    allowedLedgers = new Set(listRegisteredLedgers(registryPath).map((entry) => resolve(entry.path)));
  } catch (error) {
    throw new Error(`Artshelf UI bundle ${snapshot.id} registry scope ${registryPath} could not be read: ${(error as Error).message}`);
  }

  for (const target of selected) {
    const targetLedger = resolve(target.ledgerPath);
    if (!allowedLedgers.has(targetLedger)) {
      throw new Error(
        `Artshelf UI bundle ${snapshot.id} target ${target.targetId} is outside the served registry scope: expected a ledger registered in ${registryPath}, found ${targetLedger}`
      );
    }
  }
}

function repoRootFromUiHome(home: string): string | null {
  const absolute = resolve(home);
  const artshelfDir = dirname(absolute);
  if (basename(absolute) === "ui" && (basename(artshelfDir) === ".artshelf" || basename(artshelfDir) === ".shelf")) {
    return dirname(artshelfDir);
  }
  return findGitRoot(absolute);
}

function findGitRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (existsSync(`${current}/.git`)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function samePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === "";
}

function sameStringArray(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}

// Roll the aggregate execution state up to the single session reply status that advances the event.
// The event status enum has no "partial", so the rolled-up signal is deliberately conservative: only
// a fully-clean run is "completed"; a wholly-refused stale bundle is "stale" so the human re-reviews;
// anything in between is "failed" so a partial run is never silently presented as done. The full
// per-target truth always rides along in the reply payload, so this never hides a target's state.
function bundleReplyStatus(status: UiBundleExecutionResult["status"]): UiReplyStatus {
  if (status === "executed") return "completed";
  if (status === "refused") return "stale";
  return "failed";
}

// The audit-facing reply body: the bundle identity, the aggregate execution state, the per-outcome
// tally, every per-target receipt (in selection order), and a compact revalidation summary - enough
// for the human to see exactly what happened to each approved target and why anything was skipped.
function bundleReplyPayload(execution: UiBundleExecutionResult): Record<string, unknown> {
  const revalidation = execution.revalidation;
  return {
    bundleId: execution.bundleId,
    executionStatus: execution.status,
    counts: execution.counts,
    receipts: execution.receipts,
    revalidation: {
      status: revalidation.status,
      expectedFingerprint: revalidation.expectedFingerprint,
      liveFingerprint: revalidation.liveFingerprint,
      missingTargetIds: revalidation.missingTargetIds,
      changedTargetIds: revalidation.changedTargetIds,
      reviewedKeysDrifted: revalidation.reviewedKeysDrifted
    }
  };
}
