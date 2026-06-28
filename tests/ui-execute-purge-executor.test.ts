import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { groupPurgeCandidates, purgeApprovalTargets, PURGE_APPROVAL_ACTION } from "../src/dashboard.js";
import type { DashboardTrashRow } from "../src/dashboard.js";
import { executeApprovedTrashPurge, readLedger } from "../src/ledger.js";
import { appendEvent, readSessionHistory, replyToEvent, revalidateApprovalSnapshot, startOrResumeSession, writeApprovalSnapshot } from "../src/session.js";
import type { UiApprovalSnapshot } from "../src/types.js";
import { collectApprovalLiveFacts, defaultBundleTargetExecutor, executeApprovalBundle, executeApprovedBundle, purgeBackedTargetExecutor } from "../src/ui-execute.js";

// NGX-541 execute slice: the REAL one-way-door purge executor. The gate (NGX-541 AC5/AC7, covered by
// ui-execute-purge.test.ts) decides which approved purge targets are still exactly what the human
// approved; this exercises what actually happens to a fresh target - the agent-mediated, exact-target,
// approval-gated deletion that physically removes the trashed artifact, stamps the ledger row, and
// writes a per-target receipt that explicitly states there is no recovery path (AC6). Tests use temp
// trash fixtures only and never touch a real user artifact.

function freshHome(): string {
  return join(mkdtempSync(join(tmpdir(), "artshelf-ui-purge-exec-")), "ui");
}

function writeLedgerFile(ledgerPath: string, records: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

type PurgeFixture = {
  home: string;
  ledger: string;
  targetPath: string;
  cleanedAt: string;
  cleanupPlanId: string;
  receiptPath: string;
  recordId: string;
};

function trashedFixtureRecord(fx: PurgeFixture, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: fx.recordId,
    path: "/subjects/shf_a",
    kind: "backup",
    reason: "fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    retention: { mode: "manual-review" },
    cleanup: "review",
    owner: "manual",
    labels: [],
    status: "trashed",
    previousPath: "/subjects/shf_a",
    targetPath: fx.targetPath,
    cleanedAt: fx.cleanedAt,
    cleanupPlanId: fx.cleanupPlanId,
    receiptPath: fx.receiptPath,
    ...over
  };
}

// A repo whose ledger holds one trashed purge candidate whose trash artifact really exists on disk,
// inside the ledger's own trash/<cleanupPlanId>/ root (the only place the purge executor will delete
// from). `over` overrides ledger-record fields to model drift between approval and execution.
function purgeFixture(over: Record<string, unknown> = {}): PurgeFixture {
  const home = freshHome();
  const repo = mkdtempSync(join(tmpdir(), "artshelf-purge-exec-repo-"));
  const ledgerDir = join(repo, ".artshelf");
  const ledger = join(ledgerDir, "ledger.jsonl");
  const recordId = "shf_a";
  const cleanupPlanId = "plan_x";
  const cleanedAt = "2026-02-01T00:00:00.000Z";
  const receiptPath = join(ledgerDir, "receipts", `${cleanupPlanId}.json`);
  const targetPath = join(ledgerDir, "trash", cleanupPlanId, "backup.tar");
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, "trashed payload");
  const fx = { home, ledger, targetPath, cleanedAt, cleanupPlanId, receiptPath, recordId };
  writeLedgerFile(ledger, [trashedFixtureRecord(fx, over)]);
  return fx;
}

// A DashboardTrashRow whose exact purge facts match the fixture record, so the approval digest equals
// the digest the executor reconstructs from the live record.
function purgeRow(fx: PurgeFixture): DashboardTrashRow {
  return {
    recordId: fx.recordId,
    ledgerName: "primary",
    ledgerPath: fx.ledger,
    targetPath: fx.targetPath,
    cleanedAt: fx.cleanedAt,
    age: "30d",
    cleanupPlanId: fx.cleanupPlanId,
    receiptPath: fx.receiptPath
  };
}

function purgeBundle(fx: PurgeFixture): UiApprovalSnapshot {
  const session = startOrResumeSession({ home: fx.home, scope: "user", ledgerPath: fx.ledger });
  const targets = purgeApprovalTargets(groupPurgeCandidates([purgeRow(fx)]));
  return writeApprovalSnapshot(fx.home, session.id, {
    actionType: PURGE_APPROVAL_ACTION,
    targets,
    selectedTargetIds: [targets[0]!.targetId],
    reviewed: {}
  });
}

function approvalEventPayload(snapshot: UiApprovalSnapshot): Record<string, unknown> {
  return {
    bundleId: snapshot.id,
    actionType: snapshot.actionType,
    fingerprint: snapshot.fingerprint,
    selectedTargetIds: snapshot.selectedTargetIds,
    selectedCount: snapshot.selectedTargetIds.length,
    targetCount: snapshot.targets.length
  };
}

test("purgeBackedTargetExecutor permanently deletes the approved trashed artifact, stamps the ledger, and writes a no-recovery receipt", () => {
  const fx = purgeFixture();
  const snapshot = purgeBundle(fx);
  const live = collectApprovalLiveFacts(snapshot);
  assert.equal(revalidateApprovalSnapshot(snapshot, live).status, "fresh");
  assert.equal(existsSync(fx.targetPath), true);

  const result = executeApprovalBundle(snapshot, live, purgeBackedTargetExecutor);

  assert.equal(result.status, "executed");
  const receipt = result.receipts[0];
  assert.equal(receipt?.outcome, "executed");
  // AC6: the per-target receipt explicitly states there is no recovery path.
  assert.match(receipt!.detail, /no recovery path/i);
  // The one-way-door deletion actually happened on disk.
  assert.equal(existsSync(fx.targetPath), false);

  // The live ledger row is stamped as purged - independent of whatever the command reported.
  const record = readLedger(fx.ledger).find((entry) => entry.id === fx.recordId);
  assert.equal(record?.status, "resolved");
  assert.equal(record?.resolutionReason, "trash purge completed");
  assert.ok(record?.purgedAt, "expected a purgedAt stamp");
  assert.ok(record?.purgePlanId, "expected a purgePlanId stamp");
  assert.ok(record?.purgeReceiptPath && existsSync(record.purgeReceiptPath), "expected a written purge receipt");
});

test("executeApprovedBundle resumes an in-progress purge bundle after the target was already purged", () => {
  const fx = purgeFixture();
  const snapshot = purgeBundle(fx);
  appendEvent(fx.home, snapshot.sessionId, {
    type: "approval_bundle_submitted",
    target: { bundleId: snapshot.id },
    payload: approvalEventPayload(snapshot)
  });
  const submitted = readSessionHistory(fx.home, snapshot.sessionId).find((history) => history.event.type === "approval_bundle_submitted");
  if (!submitted) throw new Error("expected approval_bundle_submitted event");
  replyToEvent(fx.home, snapshot.sessionId, submitted.event.id, {
    status: "in_progress",
    payload: { bundleId: snapshot.id, fingerprint: snapshot.fingerprint },
    expectedStatus: "pending"
  });
  const entry = {
    id: fx.recordId,
    targetPath: fx.targetPath,
    cleanedAt: fx.cleanedAt,
    receiptPath: fx.receiptPath,
    cleanupPlanId: fx.cleanupPlanId
  };
  const first = executeApprovedTrashPurge(fx.ledger, entry);
  assert.equal(first.result?.status, "purged");
  assert.equal(existsSync(fx.targetPath), false);

  const result = executeApprovedBundle(fx.home, snapshot.sessionId, snapshot.id);

  assert.equal(result.execution.status, "executed");
  assert.equal(result.reply.status, "completed");
  assert.equal(result.execution.receipts[0]?.outcome, "executed");
  assert.match(result.execution.receipts[0]!.detail, /no recovery path/i);
  assert.equal(readLedger(fx.ledger).find((record) => record.id === fx.recordId)?.purgePlanId, first.purgePlanId);
});

test("executeApprovedTrashPurge resumes an interrupted exact-target purge receipt", () => {
  const fx = purgeFixture();
  const entry = {
    id: fx.recordId,
    targetPath: fx.targetPath,
    cleanedAt: fx.cleanedAt,
    receiptPath: fx.receiptPath,
    cleanupPlanId: fx.cleanupPlanId
  };
  const first = executeApprovedTrashPurge(fx.ledger, entry);
  writeLedgerFile(fx.ledger, [trashedFixtureRecord(fx)]);
  writeFileSync(first.receiptPath, `${JSON.stringify({
    purgePlanId: first.purgePlanId,
    executedAt: "2026-03-01T00:00:00.000Z",
    status: "started",
    results: [{ id: fx.recordId, status: "deleting", targetPath: fx.targetPath }]
  }, null, 2)}\n`);

  const resumed = executeApprovedTrashPurge(fx.ledger, entry);

  assert.equal(resumed.purgePlanId, first.purgePlanId);
  assert.equal(resumed.result?.status, "purged");
  const record = readLedger(fx.ledger).find((entry) => entry.id === fx.recordId);
  assert.equal(record?.status, "resolved");
  assert.equal(record?.purgePlanId, first.purgePlanId);
});

test("purgeBackedTargetExecutor deletes only the approved artifact and never touches another trashed artifact", () => {
  const fx = purgeFixture();
  // A second, unrelated trashed artifact sits in the same trash root but is NOT in the approval bundle.
  const otherTrash = join(dirname(fx.targetPath), "other-backup.tar");
  writeFileSync(otherTrash, "innocent bystander payload");
  const snapshot = purgeBundle(fx);

  const result = executeApprovalBundle(snapshot, collectApprovalLiveFacts(snapshot), purgeBackedTargetExecutor);

  assert.equal(result.status, "executed");
  assert.equal(existsSync(fx.targetPath), false);
  // No broad `--all`: the approved deletion stays exact-target, so the bystander artifact is untouched.
  assert.equal(existsSync(otherTrash), true);
});

test("purgeBackedTargetExecutor refuses a target whose live trash facts drifted after approval and deletes nothing", () => {
  const fx = purgeFixture();
  const snapshot = purgeBundle(fx);
  const approved = snapshot.targets[0]!;
  // Between approval and execution the live row is re-cleaned under a different cleanup plan, so the
  // digest the executor reconstructs from live state no longer matches the approved trash-fact digest.
  writeLedgerFile(fx.ledger, [
    {
      id: fx.recordId,
      path: "/subjects/shf_a",
      kind: "backup",
      reason: "fixture",
      createdAt: "2026-01-01T00:00:00.000Z",
      retention: { mode: "manual-review" },
      cleanup: "review",
      owner: "manual",
      labels: [],
      status: "trashed",
      previousPath: "/subjects/shf_a",
      targetPath: fx.targetPath,
      cleanedAt: fx.cleanedAt,
      cleanupPlanId: "plan_y",
      receiptPath: fx.receiptPath
    }
  ]);

  const execution = purgeBackedTargetExecutor(approved);

  assert.equal(execution.outcome, "needs_manual_review");
  assert.match(execution.detail, /drifted from its reviewed trash facts/i);
  // The one-way-door deletion must NOT happen for a drifted target.
  assert.equal(existsSync(fx.targetPath), true);
});

test("the default bundle executor routes a one-way-door purge target through the purge executor", () => {
  // This is the production wiring: executeApprovedBundle defaults to defaultBundleTargetExecutor, so a
  // real "trash-purge" bundle must reach the purge executor and actually delete - not silently fall to
  // the dispose path (which carries no plan id and would only ever return needs_manual_review).
  const fx = purgeFixture();
  const snapshot = purgeBundle(fx);

  const result = executeApprovalBundle(snapshot, collectApprovalLiveFacts(snapshot), defaultBundleTargetExecutor);

  assert.equal(result.status, "executed");
  assert.equal(result.receipts[0]?.outcome, "executed");
  assert.match(result.receipts[0]!.detail, /no recovery path/i);
  assert.equal(existsSync(fx.targetPath), false);
});

test("purgeBackedTargetExecutor refuses a target already resolved out-of-band and never deletes its artifact", () => {
  const fx = purgeFixture();
  const snapshot = purgeBundle(fx);
  const approved = snapshot.targets[0]!;
  // The live row was already resolved/purged out-of-band, so it is no longer a trashed purge candidate.
  // Even handed the stale approved target directly, the executor must refuse rather than double-delete.
  writeLedgerFile(fx.ledger, [
    {
      id: fx.recordId,
      path: "/subjects/shf_a",
      kind: "backup",
      reason: "fixture",
      createdAt: "2026-01-01T00:00:00.000Z",
      retention: { mode: "manual-review" },
      cleanup: "review",
      owner: "manual",
      labels: [],
      status: "resolved",
      resolutionReason: "trash purge completed",
      previousPath: "/subjects/shf_a",
      targetPath: fx.targetPath,
      cleanedAt: fx.cleanedAt,
      cleanupPlanId: fx.cleanupPlanId,
      receiptPath: fx.receiptPath
    }
  ]);

  const execution = purgeBackedTargetExecutor(approved);

  assert.equal(execution.outcome, "needs_manual_review");
  assert.match(execution.detail, /not trashed/i);
  assert.equal(existsSync(fx.targetPath), true);
});
