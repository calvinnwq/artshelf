import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Fix the clock so generated dispose plan ids and audit timestamps are deterministic for the
// real-executor end-to-end path.
process.env.ARTSHELF_NOW = "2026-03-01T00:00:00Z";

import { createDisposePlan } from "../src/dispose.js";
import { readLedger } from "../src/ledger.js";
import { appendEvent, endSession, readSessionHistory, replyToEvent, startOrResumeSession, writeApprovalSnapshot } from "../src/session.js";
import type { UiApprovalSnapshot, UiApprovalTarget } from "../src/types.js";
import { disposeBackedTargetExecutor, executeApprovedBundle } from "../src/ui-execute.js";

// NGX-540 session-level execute orchestration. executeApprovedBundle is the agent's full handling of
// one approved bundle: it loads the immutable snapshot, re-reads live state, runs the revalidate ->
// execute -> verify loop, then writes the per-target receipts + aggregate state back to the session
// by replying to the bundle's own approval_bundle_submitted event. These tests inject a fake executor
// to focus on the orchestration + reply mapping (the real dispose path is covered elsewhere), plus
// one end-to-end test that exercises the default dispose-backed executor against a temp ledger.

function freshHome(): string {
  return join(mkdtempSync(join(tmpdir(), "artshelf-ui-exec-session-")), "ui");
}

function writeLedgerFile(ledgerPath: string, records: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function record(id: string, path: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    path,
    kind: "backup",
    reason: "fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    retention: { mode: "manual-review" },
    cleanup: "review",
    owner: "manual",
    labels: [],
    status: "active",
    ...over
  };
}

function ledgerWith(records: Array<Record<string, unknown>>): string {
  const repo = mkdtempSync(join(tmpdir(), "artshelf-exec-session-repo-"));
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  writeLedgerFile(ledger, records);
  return ledger;
}

function repoWithSubject(recordId: string): { ledger: string; subject: string } {
  const repo = mkdtempSync(join(tmpdir(), "artshelf-exec-session-repo-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const subject = join(repo, `${recordId}.tar`);
  writeFileSync(subject, "payload");
  writeLedgerFile(ledger, [record(recordId, subject)]);
  return { ledger, subject };
}

function target(targetId: string, ledgerPath: string, recordPath: string, over: Partial<UiApprovalTarget> = {}): UiApprovalTarget {
  return {
    targetId,
    ledgerPath,
    registryPath: null,
    recordPath,
    planId: `plan_${targetId}`,
    actionType: "trash-resolve",
    label: `trash ${targetId}`,
    ...over
  };
}

// A session with one persisted approval bundle plus the approval_bundle_submitted event the browser
// would have appended for it (mirroring the loopback server's write path in ui-server.ts), so the
// executor has a real event to reply against.
function sessionWithBundle(
  home: string,
  targets: UiApprovalTarget[],
  selectedTargetIds: string[],
  reviewed: Record<string, unknown> = {},
  scope: "user" | "repo" = "user",
  ledgerPath: string | null = null
): { sessionId: string; snapshot: UiApprovalSnapshot } {
  const session = startOrResumeSession({ home, scope, ledgerPath });
  const snapshot = writeApprovalSnapshot(home, session.id, { actionType: "trash-resolve", targets, selectedTargetIds, reviewed });
  appendEvent(home, session.id, {
    type: "approval_bundle_submitted",
    target: { bundleId: snapshot.id },
    payload: approvalEventPayload(snapshot)
  });
  return { sessionId: session.id, snapshot };
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

function receiptsOf(payload: Record<string, unknown>): Array<{ targetId: string; outcome: string }> {
  return payload.receipts as Array<{ targetId: string; outcome: string }>;
}

test("executeApprovedBundle executes every fresh selected target and replies completed with per-target receipts", () => {
  const home = freshHome();
  const ledger = ledgerWith([record("shf_a", "/subjects/a"), record("shf_b", "/subjects/b")]);
  const targets = [target("shf_a", ledger, "/subjects/a"), target("shf_b", ledger, "/subjects/b")];
  const { sessionId, snapshot } = sessionWithBundle(home, targets, ["shf_a", "shf_b"]);

  const executed: string[] = [];
  const outcome = executeApprovedBundle(home, sessionId, snapshot.id, (entry) => {
    executed.push(entry.targetId);
    return { outcome: "executed", detail: `disposed ${entry.targetId}` };
  });

  assert.deepEqual(executed, ["shf_a", "shf_b"]);
  assert.equal(outcome.execution.status, "executed");
  assert.equal(outcome.reply.status, "completed");
  // Every selected target gets a visible receipt in the reply payload, in selection order.
  assert.deepEqual(receiptsOf(outcome.reply.payload).map((r) => `${r.targetId}:${r.outcome}`), ["shf_a:executed", "shf_b:executed"]);
  // The reply advanced the bundle's own submitted event to completed.
  assert.equal(outcome.event.type, "approval_bundle_submitted");
  assert.equal(outcome.event.status, "completed");
  assert.equal(outcome.reply.payload.bundleId, snapshot.id);
});

test("executeApprovedBundle replies failed for a partial run and never hides the skipped_stale target", () => {
  const home = freshHome();
  // shf_b vanished from the ledger out-of-band, so only shf_a is still actionable.
  const ledger = ledgerWith([record("shf_a", "/subjects/a")]);
  const targets = [target("shf_a", ledger, "/subjects/a"), target("shf_b", ledger, "/subjects/b")];
  const { sessionId, snapshot } = sessionWithBundle(home, targets, ["shf_a", "shf_b"]);

  const outcome = executeApprovedBundle(home, sessionId, snapshot.id, () => ({ outcome: "executed", detail: "ok" }));

  assert.equal(outcome.execution.status, "partial");
  assert.equal(outcome.reply.status, "failed");
  const receipts = receiptsOf(outcome.reply.payload);
  assert.equal(receipts.find((r) => r.targetId === "shf_a")?.outcome, "executed");
  assert.equal(receipts.find((r) => r.targetId === "shf_b")?.outcome, "skipped_stale");
  assert.deepEqual(outcome.reply.payload.counts, { executed: 1, skipped_stale: 1, failed: 0, needs_manual_review: 0 });
});

test("executeApprovedBundle refuses an all-stale bundle, executes nothing, and replies stale", () => {
  const home = freshHome();
  // Both approved subjects are gone from the live ledger: the whole bundle is stale.
  const ledger = ledgerWith([record("shf_keep", "/subjects/keep")]);
  const targets = [target("shf_a", ledger, "/subjects/a"), target("shf_b", ledger, "/subjects/b")];
  const { sessionId, snapshot } = sessionWithBundle(home, targets, ["shf_a", "shf_b"]);

  let executions = 0;
  const outcome = executeApprovedBundle(home, sessionId, snapshot.id, () => {
    executions += 1;
    return { outcome: "executed", detail: "should not run" };
  });

  assert.equal(executions, 0);
  assert.equal(outcome.execution.status, "refused");
  assert.equal(outcome.reply.status, "stale");
  assert.deepEqual(receiptsOf(outcome.reply.payload).map((r) => r.outcome), ["skipped_stale", "skipped_stale"]);
});

test("executeApprovedBundle refuses a bundle with no approval_bundle_submitted event before executing anything", () => {
  const home = freshHome();
  const ledger = ledgerWith([record("shf_a", "/subjects/a")]);
  // Persist a bundle WITHOUT appending its approval_bundle_submitted event.
  const session = startOrResumeSession({ home, scope: "user" });
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: [target("shf_a", ledger, "/subjects/a")],
    selectedTargetIds: ["shf_a"],
    reviewed: {}
  });

  let executions = 0;
  assert.throws(
    () =>
      executeApprovedBundle(home, session.id, snapshot.id, () => {
        executions += 1;
        return { outcome: "executed", detail: "x" };
      }),
    /approval_bundle_submitted/
  );
  // Fail-fast: the missing event refuses the operation before any target is executed (no mutation).
  assert.equal(executions, 0);
});

test("executeApprovedBundle refuses ended sessions before resolving the bundle event or executing targets", () => {
  const home = freshHome();
  const ledger = ledgerWith([record("shf_a", "/subjects/a")]);
  const { sessionId, snapshot } = sessionWithBundle(home, [target("shf_a", ledger, "/subjects/a")], ["shf_a"]);
  endSession(home, sessionId);

  let executions = 0;
  assert.throws(
    () =>
      executeApprovedBundle(home, sessionId, snapshot.id, () => {
        executions += 1;
        return { outcome: "executed", detail: "x" };
      }),
    /ended|active/i
  );
  assert.equal(executions, 0);
  const submitted = readSessionHistory(home, sessionId).find((h) => h.event.type === "approval_bundle_submitted");
  assert.equal(submitted?.event.status, "pending");
  assert.equal(submitted?.replies.length, 0);
});

test("executeApprovedBundle refuses non-pending approval bundle events before executing targets", () => {
  const home = freshHome();
  const ledger = ledgerWith([record("shf_a", "/subjects/a")]);
  const { sessionId, snapshot } = sessionWithBundle(home, [target("shf_a", ledger, "/subjects/a")], ["shf_a"]);
  const submitted = readSessionHistory(home, sessionId).find((h) => h.event.type === "approval_bundle_submitted");
  if (!submitted) throw new Error("expected approval_bundle_submitted event");
  replyToEvent(home, sessionId, submitted.event.id, { status: "cancelled", payload: { reason: "human cancelled" } });

  let executions = 0;
  assert.throws(
    () =>
      executeApprovedBundle(home, sessionId, snapshot.id, () => {
        executions += 1;
        return { outcome: "executed", detail: "x" };
      }),
    /pending|cancelled/i
  );
  assert.equal(executions, 0);
  const after = readSessionHistory(home, sessionId).find((h) => h.event.type === "approval_bundle_submitted");
  assert.equal(after?.event.status, "cancelled");
  assert.equal(after?.replies.length, 1);
});

test("executeApprovedBundle refuses when the approval event witness does not match the loaded bundle", () => {
  const home = freshHome();
  const ledger = ledgerWith([record("shf_a", "/subjects/a")]);
  const session = startOrResumeSession({ home, scope: "user" });
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: [target("shf_a", ledger, "/subjects/a")],
    selectedTargetIds: ["shf_a"],
    reviewed: {}
  });
  appendEvent(home, session.id, {
    type: "approval_bundle_submitted",
    target: { bundleId: snapshot.id },
    payload: { ...approvalEventPayload(snapshot), fingerprint: "0".repeat(64) }
  });

  let executions = 0;
  assert.throws(
    () =>
      executeApprovedBundle(home, session.id, snapshot.id, () => {
        executions += 1;
        return { outcome: "executed", detail: "x" };
      }),
    /fingerprint/i
  );
  assert.equal(executions, 0);
  const submitted = readSessionHistory(home, session.id).find((h) => h.event.type === "approval_bundle_submitted");
  assert.equal(submitted?.event.status, "pending");
  assert.equal(submitted?.replies.length, 0);
});

test("executeApprovedBundle refuses selected targets outside a ledger-scoped session before claiming the event", () => {
  const home = freshHome();
  const scopedLedger = ledgerWith([record("shf_scope", "/subjects/scoped")]);
  const outsideLedger = ledgerWith([record("shf_outside", "/subjects/outside")]);
  const { sessionId, snapshot } = sessionWithBundle(
    home,
    [target("shf_outside", outsideLedger, "/subjects/outside")],
    ["shf_outside"],
    {},
    "user",
    scopedLedger
  );

  let executions = 0;
  assert.throws(
    () =>
      executeApprovedBundle(home, sessionId, snapshot.id, () => {
        executions += 1;
        return { outcome: "executed", detail: "x" };
      }),
    /outside.*session scope/i
  );
  assert.equal(executions, 0);
  const submitted = readSessionHistory(home, sessionId).find((h) => h.event.type === "approval_bundle_submitted");
  assert.equal(submitted?.event.status, "pending");
  assert.equal(submitted?.replies.length, 0);
});

test("executeApprovedBundle refuses selected targets outside a repo-scoped session before claiming the event", () => {
  const repo = mkdtempSync(join(tmpdir(), "artshelf-exec-session-repo-scope-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const home = join(repo, ".artshelf", "ui");
  const outsideLedger = ledgerWith([record("shf_outside", "/subjects/outside")]);
  const { sessionId, snapshot } = sessionWithBundle(
    home,
    [target("shf_outside", outsideLedger, "/subjects/outside")],
    ["shf_outside"],
    {},
    "repo"
  );

  let executions = 0;
  assert.throws(
    () =>
      executeApprovedBundle(home, sessionId, snapshot.id, () => {
        executions += 1;
        return { outcome: "executed", detail: "x" };
      }),
    /outside.*session scope/i
  );
  assert.equal(executions, 0);
  const submitted = readSessionHistory(home, sessionId).find((h) => h.event.type === "approval_bundle_submitted");
  assert.equal(submitted?.event.status, "pending");
  assert.equal(submitted?.replies.length, 0);
});

test("executeApprovedBundle accepts repo-scoped sessions stored in a custom UI home", () => {
  const repo = mkdtempSync(join(tmpdir(), "artshelf-exec-custom-home-repo-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const home = join(mkdtempSync(join(tmpdir(), "artshelf-exec-custom-home-")), "ui-home");
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const subject = join(repo, "backup.tar");
  writeFileSync(subject, "payload");
  writeLedgerFile(ledger, [record("shf_a", subject)]);
  const startInput = { home, scope: "repo" as const, cwd: repo };
  const session = startOrResumeSession(startInput);
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: [target("shf_a", ledger, subject)],
    selectedTargetIds: ["shf_a"],
    reviewed: {}
  });
  appendEvent(home, session.id, {
    type: "approval_bundle_submitted",
    target: { bundleId: snapshot.id },
    payload: approvalEventPayload(snapshot)
  });

  const outcome = executeApprovedBundle(home, session.id, snapshot.id, () => ({ outcome: "executed", detail: "ok" }));

  assert.equal(outcome.execution.status, "executed");
  assert.equal(outcome.reply.status, "completed");
});

test("executeApprovedBundle resumes a matching in_progress approval bundle event", () => {
  const home = freshHome();
  const ledger = ledgerWith([record("shf_a", "/subjects/a")]);
  const { sessionId, snapshot } = sessionWithBundle(home, [target("shf_a", ledger, "/subjects/a")], ["shf_a"]);
  const submitted = readSessionHistory(home, sessionId).find((h) => h.event.type === "approval_bundle_submitted");
  if (!submitted) throw new Error("expected approval_bundle_submitted event");
  replyToEvent(home, sessionId, submitted.event.id, {
    status: "in_progress",
    payload: { bundleId: snapshot.id, fingerprint: snapshot.fingerprint },
    expectedStatus: "pending"
  });

  const outcome = executeApprovedBundle(home, sessionId, snapshot.id, () => ({ outcome: "executed", detail: "ok" }));

  assert.equal(outcome.execution.status, "executed");
  assert.equal(outcome.reply.status, "completed");
  const after = readSessionHistory(home, sessionId).find((h) => h.event.type === "approval_bundle_submitted");
  assert.equal(after?.event.status, "completed");
  assert.deepEqual(after?.replies.map((reply) => reply.status), ["in_progress", "completed"]);
});

test("executeApprovedBundle resumes in_progress execution after a terminal target was already disposed", () => {
  const home = freshHome();
  const { ledger, subject } = repoWithSubject("shf_a");
  const plan = createDisposePlan(ledger, { id: "shf_a", action: "trash-resolve", reason: "reviewed" });
  const approvedTarget = target("shf_a", ledger, subject, { planId: plan.planId });
  const { sessionId, snapshot } = sessionWithBundle(home, [approvedTarget], ["shf_a"]);
  const submitted = readSessionHistory(home, sessionId).find((h) => h.event.type === "approval_bundle_submitted");
  if (!submitted) throw new Error("expected approval_bundle_submitted event");
  replyToEvent(home, sessionId, submitted.event.id, {
    status: "in_progress",
    payload: { bundleId: snapshot.id, fingerprint: snapshot.fingerprint },
    expectedStatus: "pending"
  });
  assert.equal(disposeBackedTargetExecutor(approvedTarget).outcome, "executed");
  assert.equal(readLedger(ledger).find((entry) => entry.id === "shf_a")?.status, "trashed");

  const outcome = executeApprovedBundle(home, sessionId, snapshot.id);

  assert.equal(outcome.execution.status, "executed");
  assert.equal(outcome.reply.status, "completed");
  assert.equal(receiptsOf(outcome.reply.payload)[0]?.outcome, "executed");
  const after = readSessionHistory(home, sessionId).find((h) => h.event.type === "approval_bundle_submitted");
  assert.equal(after?.event.status, "completed");
  assert.deepEqual(after?.replies.map((reply) => reply.status), ["in_progress", "completed"]);
});

test("executeApprovedBundle appends final receipts when a claimed event is cancelled mid-execution", () => {
  const home = freshHome();
  const ledger = ledgerWith([record("shf_a", "/subjects/a")]);
  const { sessionId, snapshot } = sessionWithBundle(home, [target("shf_a", ledger, "/subjects/a")], ["shf_a"]);
  const submitted = readSessionHistory(home, sessionId).find((h) => h.event.type === "approval_bundle_submitted");
  if (!submitted) throw new Error("expected approval_bundle_submitted event");

  const outcome = executeApprovedBundle(home, sessionId, snapshot.id, () => {
    replyToEvent(home, sessionId, submitted.event.id, { status: "cancelled", payload: { reason: "competing executor" } });
    return { outcome: "executed", detail: "x" };
  });

  assert.equal(outcome.reply.status, "completed");
  const after = readSessionHistory(home, sessionId).find((h) => h.event.type === "approval_bundle_submitted");
  assert.equal(after?.event.status, "completed");
  assert.deepEqual(after?.replies.map((reply) => reply.status), ["in_progress", "cancelled", "completed"]);
  assert.equal(receiptsOf(after!.replies[2]!.payload)[0]?.outcome, "executed");
});

test("executeApprovedBundle replies failed when a target execution fails", () => {
  const home = freshHome();
  const ledger = ledgerWith([record("shf_a", "/subjects/a")]);
  const { sessionId, snapshot } = sessionWithBundle(home, [target("shf_a", ledger, "/subjects/a")], ["shf_a"]);

  const outcome = executeApprovedBundle(home, sessionId, snapshot.id, () => ({ outcome: "failed", detail: "dispose --execute errored" }));

  assert.equal(outcome.execution.status, "partial");
  assert.equal(outcome.reply.status, "failed");
  assert.equal(receiptsOf(outcome.reply.payload)[0]?.outcome, "failed");
});

test("executeApprovedBundle appends the receipt reply to the durable session history", () => {
  const home = freshHome();
  const ledger = ledgerWith([record("shf_a", "/subjects/a")]);
  const { sessionId, snapshot } = sessionWithBundle(home, [target("shf_a", ledger, "/subjects/a")], ["shf_a"]);

  executeApprovedBundle(home, sessionId, snapshot.id, () => ({ outcome: "executed", detail: "ok" }));

  const entry = readSessionHistory(home, sessionId).find((h) => h.event.type === "approval_bundle_submitted");
  assert.ok(entry, "approval_bundle_submitted event is present in history");
  assert.equal(entry!.event.status, "completed");
  assert.equal(entry!.replies.length, 2);
  assert.equal(entry!.replies[0]?.status, "in_progress");
  assert.equal(entry!.replies[1]?.status, "completed");
  assert.deepEqual(receiptsOf(entry!.replies[1]!.payload).map((r) => r.targetId), ["shf_a"]);
});

test("executeApprovedBundle replies to the matching bundle's event, not another bundle's", () => {
  const home = freshHome();
  const ledger = ledgerWith([record("shf_a", "/subjects/a"), record("shf_b", "/subjects/b")]);
  const session = startOrResumeSession({ home, scope: "user" });
  // Two distinct approved bundles, each with its own submitted event.
  const snapA = writeApprovalSnapshot(home, session.id, { actionType: "trash-resolve", targets: [target("shf_a", ledger, "/subjects/a")], selectedTargetIds: ["shf_a"], reviewed: {} });
  appendEvent(home, session.id, { type: "approval_bundle_submitted", target: { bundleId: snapA.id }, payload: approvalEventPayload(snapA) });
  const snapB = writeApprovalSnapshot(home, session.id, { actionType: "trash-resolve", targets: [target("shf_b", ledger, "/subjects/b")], selectedTargetIds: ["shf_b"], reviewed: {} });
  appendEvent(home, session.id, { type: "approval_bundle_submitted", target: { bundleId: snapB.id }, payload: approvalEventPayload(snapB) });

  const outcome = executeApprovedBundle(home, session.id, snapA.id, () => ({ outcome: "executed", detail: "ok" }));

  assert.equal(outcome.event.payload.bundleId, snapA.id);
  // B's event is untouched: still pending with no reply.
  const bEntry = readSessionHistory(home, session.id).find((h) => h.event.payload.bundleId === snapB.id);
  assert.equal(bEntry?.event.status, "pending");
  assert.equal(bEntry?.replies.length, 0);
});

test("executeApprovedBundle drives the real dispose-backed executor end-to-end and replies completed", () => {
  const home = freshHome();
  // A repo whose recorded backup exists on disk, with a reviewed trash-resolve plan.
  const repo = mkdtempSync(join(tmpdir(), "artshelf-exec-session-e2e-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const subject = join(repo, "backup.tar");
  writeFileSync(subject, "payload");
  writeLedgerFile(ledger, [record("shf_backup", subject)]);
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const trashTarget = plan.entry?.targetPath as string;
  const approved = target("shf_backup", ledger, subject, { planId: plan.planId, actionType: "trash-resolve" });
  const { sessionId, snapshot } = sessionWithBundle(home, [approved], ["shf_backup"]);

  // No injected executor: this exercises the default disposeBackedTargetExecutor wiring.
  const outcome = executeApprovedBundle(home, sessionId, snapshot.id);

  assert.equal(outcome.execution.status, "executed");
  assert.equal(outcome.reply.status, "completed");
  // Live state really changed: the subject moved to trash and the row is trashed.
  assert.equal(readLedger(ledger).find((r) => r.id === "shf_backup")?.status, "trashed");
  assert.equal(existsSync(subject), false);
  assert.equal(existsSync(trashTarget), true);
});
