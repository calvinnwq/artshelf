import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { groupPurgeCandidates, purgeApprovalTargets, PURGE_APPROVAL_ACTION } from "../src/dashboard.js";
import type { DashboardTrashRow } from "../src/dashboard.js";
import { approvalSnapshotFingerprint, revalidateApprovalSnapshot, startOrResumeSession, writeApprovalSnapshot } from "../src/session.js";
import type { UiApprovalSnapshot } from "../src/types.js";
import { collectApprovalLiveFacts, executeApprovalBundle } from "../src/ui-execute.js";

// NGX-541 AC5/AC7: the agent's pre-execution safety gate must be purge-aware. A purge approval bundle
// (action "trash-purge") binds each target to the exact live trash facts via purgeCandidateDigest, so
// before the one-way-door deletion the gate must (a) accept the purge bundle instead of refusing it as
// an unsupported action, (b) keep a still-trashed candidate whose live trash facts still match the
// approval and revalidate it fresh, and (c) skip - never broadly fail - a candidate whose record
// vanished, was already purged, or whose trash facts drifted, each with a clear stale reason.

function freshHome(): string {
  return join(mkdtempSync(join(tmpdir(), "artshelf-ui-purge-")), "ui");
}

function writeLedgerFile(ledgerPath: string, records: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

// A trashed ledger record with intact cleanup trash provenance - exactly what a purge candidate is.
function trashedRecord(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    path: `/subjects/${id}`,
    kind: "backup",
    reason: "fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    retention: { mode: "manual-review" },
    cleanup: "review",
    owner: "manual",
    labels: [],
    status: "trashed",
    targetPath: `/trash/plan_x/${id}`,
    cleanedAt: "2026-02-01T00:00:00.000Z",
    cleanupPlanId: "plan_x",
    receiptPath: "/receipts/plan_x.json",
    ...over
  };
}

// A DashboardTrashRow whose exact purge facts match trashedRecord with the same id, so the approval
// digest equals the digest the gate reconstructs from the live record.
function purgeRow(id: string, ledgerPath: string): DashboardTrashRow {
  return {
    recordId: id,
    ledgerName: "primary",
    ledgerPath,
    targetPath: `/trash/plan_x/${id}`,
    cleanedAt: "2026-02-01T00:00:00.000Z",
    age: "30d",
    cleanupPlanId: "plan_x",
    receiptPath: "/receipts/plan_x.json"
  };
}

function ledgerWith(records: Array<Record<string, unknown>>): string {
  const repo = mkdtempSync(join(tmpdir(), "artshelf-purge-repo-"));
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  writeLedgerFile(ledger, records);
  return ledger;
}

function purgeBundle(home: string, rows: DashboardTrashRow[], selectedRecordIds: string[]): UiApprovalSnapshot {
  const session = startOrResumeSession({ home, scope: "user" });
  const targets = purgeApprovalTargets(groupPurgeCandidates(rows));
  const targetIds = selectedRecordIds.map((recordId) => {
    const target = targets.find((entry) => entry.recordId === recordId);
    if (!target) throw new Error(`missing purge target for ${recordId}`);
    return target.targetId;
  });
  return writeApprovalSnapshot(home, session.id, {
    actionType: PURGE_APPROVAL_ACTION,
    targets,
    selectedTargetIds: targetIds,
    reviewed: {}
  });
}

function approvedTargetId(snapshot: UiApprovalSnapshot, recordId: string): string {
  const target = snapshot.targets.find((entry) => entry.recordId === recordId);
  if (!target) throw new Error(`missing approved target for ${recordId}`);
  return target.targetId;
}

test("a selected purge candidate still trashed with matching trash facts revalidates fresh and executes", () => {
  const home = freshHome();
  const ledger = ledgerWith([trashedRecord("shf_a")]);
  const snapshot = purgeBundle(home, [purgeRow("shf_a", ledger)], ["shf_a"]);

  const live = collectApprovalLiveFacts(snapshot);
  assert.deepEqual(live.targets.map((entry) => entry.recordId), ["shf_a"]);
  // The approved subject is terminal (trashed) by design, yet the purge gate keeps it and revalidates
  // it fresh because its live trash facts still match the digest the approval was bound to.
  assert.equal(revalidateApprovalSnapshot(snapshot, live).status, "fresh");

  const purged: string[] = [];
  const result = executeApprovalBundle(snapshot, live, (target) => {
    purged.push(target.recordId ?? target.targetId);
    return { outcome: "executed", detail: `purged ${target.recordPath}` };
  });
  assert.deepEqual(purged, ["shf_a"]);
  assert.equal(result.status, "executed");
  assert.equal(result.receipts[0]?.outcome, "executed");
});

test("a selected purge candidate whose record vanished is skipped_stale, not broadly failed", () => {
  const home = freshHome();
  // shf_a is gone from the live ledger; shf_b is still a present, matching purge candidate.
  const ledger = ledgerWith([trashedRecord("shf_b")]);
  const snapshot = purgeBundle(home, [purgeRow("shf_a", ledger), purgeRow("shf_b", ledger)], ["shf_a", "shf_b"]);

  const live = collectApprovalLiveFacts(snapshot);
  assert.deepEqual(live.targets.map((entry) => entry.recordId), ["shf_b"]);
  const verdict = revalidateApprovalSnapshot(snapshot, live);
  assert.equal(verdict.status, "stale");
  assert.deepEqual(verdict.missingTargetIds, [approvedTargetId(snapshot, "shf_a")]);

  const purged: string[] = [];
  const result = executeApprovalBundle(snapshot, live, (target) => {
    purged.push(target.recordId ?? target.targetId);
    return { outcome: "executed", detail: `purged ${target.recordPath}` };
  });
  // The vanished target is skipped with a clear reason while the still-exact one executes.
  assert.deepEqual(purged, ["shf_b"]);
  assert.equal(result.status, "partial");
  assert.equal(result.receipts.find((entry) => entry.targetId === approvedTargetId(snapshot, "shf_a"))?.outcome, "skipped_stale");
  assert.equal(result.receipts.find((entry) => entry.targetId === approvedTargetId(snapshot, "shf_b"))?.outcome, "executed");
});

test("a selected purge candidate already purged out-of-band is skipped_stale, never purged twice", () => {
  const home = freshHome();
  // shf_a was already purged (status resolved + purge stamp), so it is no longer a purge candidate.
  const ledger = ledgerWith([
    trashedRecord("shf_a", { status: "resolved", purgedAt: "2026-03-01T00:00:00.000Z", purgePlanId: "purge_p", purgeReceiptPath: "/r.json", resolutionReason: "trash purge completed" })
  ]);
  const snapshot = purgeBundle(home, [purgeRow("shf_a", ledger)], ["shf_a"]);

  const live = collectApprovalLiveFacts(snapshot);
  assert.deepEqual(live.targets.map((entry) => entry.targetId), []);

  const result = executeApprovalBundle(snapshot, live, () => {
    throw new Error("an already-purged target must never be purged again");
  });
  assert.equal(result.status, "refused");
  assert.equal(result.receipts[0]?.outcome, "skipped_stale");
});

test("a selected purge candidate whose trash facts drifted is skipped_stale as changed", () => {
  const home = freshHome();
  // The live row is still trashed but its cleanup provenance changed since approval (re-cleaned under a
  // different plan), so the reconstructed digest no longer matches the approved one.
  const ledger = ledgerWith([trashedRecord("shf_a", { cleanupPlanId: "plan_y" })]);
  const snapshot = purgeBundle(home, [purgeRow("shf_a", ledger)], ["shf_a"]);

  const live = collectApprovalLiveFacts(snapshot);
  const verdict = revalidateApprovalSnapshot(snapshot, live);
  assert.equal(verdict.status, "stale");
  assert.deepEqual(verdict.changedTargetIds, [approvedTargetId(snapshot, "shf_a")]);

  const result = executeApprovalBundle(snapshot, live, () => {
    throw new Error("a drifted purge target must not be purged");
  });
  assert.equal(result.status, "refused");
  assert.equal(result.receipts[0]?.outcome, "skipped_stale");
});

test("a selected purge candidate whose trash provenance was stripped is flagged drifted, never purged", () => {
  const home = freshHome();
  // The live row is still trashed but lost its cleanup provenance (no cleanedAt), so it is no longer a
  // valid purge candidate - the gate must flag drift rather than attempt a one-way-door deletion.
  const ledger = ledgerWith([trashedRecord("shf_a", { cleanedAt: undefined })]);
  const snapshot = purgeBundle(home, [purgeRow("shf_a", ledger)], ["shf_a"]);

  const live = collectApprovalLiveFacts(snapshot);
  assert.deepEqual(revalidateApprovalSnapshot(snapshot, live).changedTargetIds, [approvedTargetId(snapshot, "shf_a")]);

  const result = executeApprovalBundle(snapshot, live, () => {
    throw new Error("a purge candidate without intact trash provenance must not be purged");
  });
  assert.equal(result.status, "refused");
  assert.equal(result.receipts[0]?.outcome, "skipped_stale");
});

test("a purge bundle with a selected non-purge target is refused before any deletion", () => {
  const home = freshHome();
  const ledger = ledgerWith([trashedRecord("shf_a")]);
  const snapshot = purgeBundle(home, [purgeRow("shf_a", ledger)], ["shf_a"]);
  // Tamper one selected target to a non-purge action and re-fingerprint, so only the action-vs-target
  // mismatch (not a fingerprint break) gates the bundle - a destructive bundle must stay action-exact.
  const tamperedTargets = snapshot.targets.map((target) => ({ ...target, actionType: "trash-resolve" }));
  const tampered: UiApprovalSnapshot = {
    ...snapshot,
    targets: tamperedTargets,
    fingerprint: approvalSnapshotFingerprint(tamperedTargets, {})
  };

  const result = executeApprovalBundle(tampered, collectApprovalLiveFacts(tampered), () => {
    throw new Error("a refused purge bundle must not execute any target");
  });
  assert.equal(result.status, "refused");
  assert.match(result.receipts[0]!.detail, /does not match selected target/i);
});
