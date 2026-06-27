import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startOrResumeSession, writeApprovalSnapshot } from "../src/session.js";
import { executeApprovalBundle } from "../src/ui-execute.js";
import type { UiApprovalSnapshot, UiApprovalTarget } from "../src/types.js";

function freshHome(): string {
  return join(mkdtempSync(join(tmpdir(), "artshelf-ui-exec-")), "ui");
}

function startUserSession(home: string): ReturnType<typeof startOrResumeSession> {
  return startOrResumeSession({ home, scope: "user" });
}

function sampleTargets(): UiApprovalTarget[] {
  return [
    {
      targetId: "shf_a",
      ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl",
      registryPath: null,
      recordPath: "/tmp/a",
      planId: "plan_a",
      actionType: "trash-resolve",
      label: "trash scratch a"
    },
    {
      targetId: "shf_b",
      ledgerPath: "/ledgers/b/.artshelf/ledger.jsonl",
      registryPath: null,
      recordPath: "/tmp/b",
      planId: "plan_b",
      actionType: "trash-resolve",
      label: "trash scratch b"
    }
  ];
}

function bundleSelecting(home: string, selectedTargetIds: string[], reviewed: Record<string, unknown> = {}): {
  sessionId: string;
  snapshot: UiApprovalSnapshot;
} {
  const session = startUserSession(home);
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: sampleTargets(),
    selectedTargetIds,
    reviewed
  });
  return { sessionId: session.id, snapshot };
}

test("executeApprovalBundle runs every fresh selected target through the executor and reports executed", () => {
  const home = freshHome();
  const { sessionId, snapshot } = bundleSelecting(home, ["shf_a", "shf_b"], { total: 2 });

  const calls: string[] = [];
  const result = executeApprovalBundle(snapshot, { targets: sampleTargets(), reviewed: { total: 2 } }, (target) => {
    calls.push(target.targetId);
    return { outcome: "executed", detail: `disposed ${target.targetId}`, evidence: { receiptPath: `/r/${target.targetId}` } };
  });

  assert.deepEqual(calls, ["shf_a", "shf_b"]);
  assert.equal(result.status, "executed");
  assert.equal(result.bundleId, snapshot.id);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.revalidation.status, "fresh");
  assert.equal(result.receipts.length, 2);
  assert.equal(result.receipts[0]!.targetId, "shf_a");
  assert.equal(result.receipts[0]!.outcome, "executed");
  assert.equal(result.receipts[0]!.detail, "disposed shf_a");
  assert.equal(result.receipts[0]!.label, "trash scratch a");
  assert.equal(result.receipts[0]!.actionType, "trash-resolve");
  assert.equal(result.receipts[0]!.ledgerPath, "/ledgers/a/.artshelf/ledger.jsonl");
  assert.deepEqual(result.receipts[0]!.evidence, { receiptPath: "/r/shf_a" });
  assert.deepEqual(result.counts, { executed: 2, skipped_stale: 0, failed: 0, needs_manual_review: 0 });
});

test("executeApprovalBundle skips a vanished selected target as stale and still executes the rest", () => {
  const home = freshHome();
  const { snapshot } = bundleSelecting(home, ["shf_a", "shf_b"], { total: 2 });

  const calls: string[] = [];
  // The agent re-reads live state and shf_b's subject is gone (resolved out-of-band).
  const result = executeApprovalBundle(snapshot, { targets: [sampleTargets()[0]!], reviewed: { total: 2 } }, (target) => {
    calls.push(target.targetId);
    return { outcome: "executed", detail: "ok" };
  });

  assert.deepEqual(calls, ["shf_a"]);
  assert.equal(result.status, "partial");
  const a = result.receipts.find((receipt) => receipt.targetId === "shf_a")!;
  const b = result.receipts.find((receipt) => receipt.targetId === "shf_b")!;
  assert.equal(a.outcome, "executed");
  assert.equal(b.outcome, "skipped_stale");
  assert.match(b.detail, /stale|missing|drift/i);
  assert.deepEqual(result.counts, { executed: 1, skipped_stale: 1, failed: 0, needs_manual_review: 0 });
});

test("executeApprovalBundle skips a drifted selected target as stale without executing it", () => {
  const home = freshHome();
  const { snapshot } = bundleSelecting(home, ["shf_a", "shf_b"]);

  // shf_a now points at a different record path than the human reviewed.
  const live = sampleTargets();
  live[0]!.recordPath = "/tmp/a-moved";

  const calls: string[] = [];
  const result = executeApprovalBundle(snapshot, { targets: live, reviewed: {} }, (target) => {
    calls.push(target.targetId);
    return { outcome: "executed", detail: "ok" };
  });

  assert.deepEqual(calls, ["shf_b"]);
  assert.equal(result.status, "partial");
  assert.equal(result.receipts.find((receipt) => receipt.targetId === "shf_a")!.outcome, "skipped_stale");
  assert.equal(result.receipts.find((receipt) => receipt.targetId === "shf_b")!.outcome, "executed");
});

test("executeApprovalBundle refuses the whole bundle and executes nothing when reviewed facts drifted", () => {
  const home = freshHome();
  const { snapshot } = bundleSelecting(home, ["shf_a", "shf_b"], { planId: "plan_a", total: 2 });

  // The live plan now reports a different total than what the human reviewed: the shared basis moved.
  const result = executeApprovalBundle(snapshot, { targets: sampleTargets(), reviewed: { planId: "plan_a", total: 5 } }, () => {
    throw new Error("executor must not run when the reviewed basis drifted");
  });

  assert.equal(result.status, "refused");
  assert.equal(result.revalidation.status, "stale");
  assert.ok(result.receipts.every((receipt) => receipt.outcome === "skipped_stale"));
  assert.deepEqual(result.counts, { executed: 0, skipped_stale: 2, failed: 0, needs_manual_review: 0 });
});

test("executeApprovalBundle refuses a bundle whose stored fingerprint does not match its own targets", () => {
  const home = freshHome();
  const { snapshot } = bundleSelecting(home, ["shf_a"], { total: 1 });
  const tampered: UiApprovalSnapshot = { ...snapshot, fingerprint: "0".repeat(64) };

  const result = executeApprovalBundle(tampered, { targets: sampleTargets(), reviewed: { total: 1 } }, () => {
    throw new Error("executor must not run for a tampered/corrupt bundle");
  });

  assert.equal(result.status, "refused");
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0]!.outcome, "skipped_stale");
});

test("executeApprovalBundle refuses a tampered fingerprint even when live drift exists", () => {
  const home = freshHome();
  const { snapshot } = bundleSelecting(home, ["shf_a", "shf_b"], { total: 2 });
  const tampered: UiApprovalSnapshot = { ...snapshot, fingerprint: "0".repeat(64) };

  const calls: string[] = [];
  const result = executeApprovalBundle(tampered, { targets: [sampleTargets()[0]!], reviewed: { total: 2 } }, (target) => {
    calls.push(target.targetId);
    return { outcome: "executed", detail: "should not execute" };
  });

  assert.deepEqual(calls, []);
  assert.equal(result.status, "refused");
  assert.deepEqual(result.receipts.map((receipt) => `${receipt.targetId}:${receipt.outcome}`), [
    "shf_a:skipped_stale",
    "shf_b:skipped_stale"
  ]);
});

test("executeApprovalBundle isolates a failing target so a partial run shows both the failure and the success", () => {
  const home = freshHome();
  const { snapshot } = bundleSelecting(home, ["shf_a", "shf_b"], { total: 2 });

  const result = executeApprovalBundle(snapshot, { targets: sampleTargets(), reviewed: { total: 2 } }, (target) => {
    if (target.targetId === "shf_a") throw new Error("disk full");
    return { outcome: "executed", detail: "ok" };
  });

  assert.equal(result.status, "partial");
  const a = result.receipts.find((receipt) => receipt.targetId === "shf_a")!;
  const b = result.receipts.find((receipt) => receipt.targetId === "shf_b")!;
  assert.equal(a.outcome, "failed");
  assert.match(a.detail, /disk full/);
  assert.equal(b.outcome, "executed");
  assert.deepEqual(result.counts, { executed: 1, skipped_stale: 0, failed: 1, needs_manual_review: 0 });
});

test("executeApprovalBundle records an executor needs_manual_review verdict verbatim", () => {
  const home = freshHome();
  const { snapshot } = bundleSelecting(home, ["shf_a", "shf_b"], { total: 2 });

  const result = executeApprovalBundle(snapshot, { targets: sampleTargets(), reviewed: { total: 2 } }, (target) => {
    if (target.targetId === "shf_a") return { outcome: "needs_manual_review", detail: "target conflict on disk" };
    return { outcome: "executed", detail: "ok" };
  });

  assert.equal(result.status, "partial");
  const a = result.receipts.find((receipt) => receipt.targetId === "shf_a")!;
  assert.equal(a.outcome, "needs_manual_review");
  assert.equal(a.detail, "target conflict on disk");
  assert.deepEqual(result.counts, { executed: 1, skipped_stale: 0, failed: 0, needs_manual_review: 1 });
});

test("executeApprovalBundle executes only the approved selection and ignores drift in unselected rows", () => {
  const home = freshHome();
  // Only shf_a is approved; shf_b is an unselected candidate that was merely shown.
  const { snapshot } = bundleSelecting(home, ["shf_a"]);

  // shf_b drifts in live state, but it was never part of the approved action.
  const live = [sampleTargets()[0]!, { ...sampleTargets()[1]!, recordPath: "/tmp/b-moved" }];

  const seen: UiApprovalTarget[] = [];
  const result = executeApprovalBundle(snapshot, { targets: live, reviewed: {} }, (target) => {
    seen.push(target);
    return { outcome: "executed", detail: "ok" };
  });

  assert.equal(result.revalidation.status, "fresh");
  assert.equal(result.status, "executed");
  assert.equal(result.receipts.length, 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], sampleTargets()[0]);
});
