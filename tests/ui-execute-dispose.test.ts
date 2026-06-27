import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Fix the clock so snooze horizons, generated plan ids, and audit timestamps are deterministic.
process.env.ARTSHELF_NOW = "2026-03-01T00:00:00Z";

import { createDisposePlan } from "../src/dispose.js";
import { readLedger } from "../src/ledger.js";
import { startOrResumeSession, writeApprovalSnapshot } from "../src/session.js";
import { disposeBackedTargetExecutor, executeApprovalBundle } from "../src/ui-execute.js";
import type { UiApprovalTarget } from "../src/types.js";

// The real dispose-backed executor (NGX-540 slice 2) binds an exactly-approved target to its
// reviewed dispose plan, runs the existing approval-gated `dispose --execute` path, and then
// INDEPENDENTLY re-reads the live ledger + filesystem to confirm the disposition took effect rather
// than trusting the command's own reported result.

function writeLedgerFile(ledgerPath: string, records: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function baseRecord(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "shf_backup",
    path: "/does/not/matter",
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

// A repo whose recorded backup still exists on disk: the common subject for any disposition.
function presentBackupFixture(): { ledger: string; subject: string } {
  const repo = mkdtempSync(join(tmpdir(), "artshelf-ui-exec-dispose-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const subject = join(repo, "backup.tar");
  writeFileSync(subject, "payload");
  writeLedgerFile(ledger, [baseRecord({ id: "shf_backup", path: subject, status: "active" })]);
  return { ledger, subject };
}

function approvalTarget(
  ledger: string,
  subject: string,
  planId: string | null,
  actionType: string,
  over: Partial<UiApprovalTarget> = {}
): UiApprovalTarget {
  return {
    targetId: "shf_backup",
    ledgerPath: ledger,
    registryPath: null,
    recordPath: subject,
    planId,
    actionType,
    label: `${actionType} backup.tar`,
    ...over
  };
}

function recordById(ledger: string, id: string) {
  return readLedger(ledger).find((record) => record.id === id);
}

function evidenceOf(execution: { evidence?: Record<string, unknown> }): Record<string, unknown> {
  return execution.evidence ?? {};
}

test("disposeBackedTargetExecutor executes a reviewed trash-resolve plan and verifies the subject moved to trash", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const trashTarget = plan.entry?.targetPath as string;
  const execution = disposeBackedTargetExecutor(approvalTarget(ledger, subject, plan.planId, "trash-resolve"));

  assert.equal(execution.outcome, "executed");
  // Independent live verification: the row is trashed and the file actually moved.
  assert.equal(recordById(ledger, "shf_backup")?.status, "trashed");
  assert.equal(existsSync(subject), false);
  assert.equal(existsSync(trashTarget), true);
  // Evidence carries the dispose receipt plus the independently re-queried live facts for audit.
  const evidence = evidenceOf(execution);
  assert.equal(typeof evidence.receiptPath, "string");
  const live = evidence.live as Record<string, unknown>;
  assert.equal(live.recordStatus, "trashed");
  assert.equal(live.subjectPresent, false);
  assert.equal(live.targetPresent, true);
});

test("disposeBackedTargetExecutor executes a reviewed resolve-only plan without moving the file", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "resolve-only", reason: "no longer needed" });
  const execution = disposeBackedTargetExecutor(approvalTarget(ledger, subject, plan.planId, "resolve-only"));

  assert.equal(execution.outcome, "executed");
  assert.equal(existsSync(subject), true);
  assert.equal(recordById(ledger, "shf_backup")?.status, "resolved");
});

test("disposeBackedTargetExecutor executes a reviewed snooze plan and verifies the extended retention", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "snooze", ttl: "7d" });
  const execution = disposeBackedTargetExecutor(approvalTarget(ledger, subject, plan.planId, "snooze"));

  assert.equal(execution.outcome, "executed");
  const record = recordById(ledger, "shf_backup");
  assert.equal(record?.status, "active");
  assert.equal(record?.retainUntil, "2026-03-08T00:00:00Z");
});

test("disposeBackedTargetExecutor executes a reviewed keep plan and verifies the reviewed-and-kept stamp", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "keep", reason: "still needed" });
  const execution = disposeBackedTargetExecutor(approvalTarget(ledger, subject, plan.planId, "keep"));

  assert.equal(execution.outcome, "executed");
  const record = recordById(ledger, "shf_backup");
  assert.equal(record?.disposePlanId, plan.planId);
  assert.equal(record?.disposeAction, "keep");
  assert.equal(record?.status, "active");
});

test("disposeBackedTargetExecutor refuses a target with no reviewed dispose plan id as needs_manual_review", () => {
  const { ledger, subject } = presentBackupFixture();
  const execution = disposeBackedTargetExecutor(approvalTarget(ledger, subject, null, "trash-resolve"));

  assert.equal(execution.outcome, "needs_manual_review");
  // Nothing executed: the record and file are untouched.
  assert.equal(recordById(ledger, "shf_backup")?.status, "active");
  assert.equal(existsSync(subject), true);
});

test("disposeBackedTargetExecutor surfaces a dispose refusal of a drifted plan as needs_manual_review", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  // The subject drifts after the dry-run: dispose --execute re-snapshots and refuses (skips) it.
  writeFileSync(subject, "different payload");

  const execution = disposeBackedTargetExecutor(approvalTarget(ledger, subject, plan.planId, "trash-resolve"));

  assert.equal(execution.outcome, "needs_manual_review");
  // Refused, not mutated: the row is still active and the file is still in place.
  assert.equal(recordById(ledger, "shf_backup")?.status, "active");
  assert.equal(existsSync(subject), true);
});

test("disposeBackedTargetExecutor reports a missing reviewed plan as failed", () => {
  const { ledger, subject } = presentBackupFixture();
  // A well-formed but nonexistent plan id: dispose --execute throws "plan not found".
  const execution = disposeBackedTargetExecutor(approvalTarget(ledger, subject, "dispose_20260301_000000_dead", "trash-resolve"));

  assert.equal(execution.outcome, "failed");
  assert.equal(recordById(ledger, "shf_backup")?.status, "active");
});

test("disposeBackedTargetExecutor fails when independent live re-query contradicts the command's reported success", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const target = approvalTarget(ledger, subject, plan.planId, "trash-resolve");
  const trashTarget = plan.entry?.targetPath as string;

  // First run genuinely trashes the subject.
  assert.equal(disposeBackedTargetExecutor(target).outcome, "executed");
  assert.equal(existsSync(trashTarget), true);

  // The trash target then vanishes (lost/purged out-of-band). dispose --execute is idempotent and
  // replays its recorded "trashed" result from the completed receipt, but the agent's independent
  // live re-query sees the target is gone - so it must NOT report executed on the command's word.
  rmSync(trashTarget);
  const execution = disposeBackedTargetExecutor(target);

  assert.equal(execution.outcome, "failed");
  const live = evidenceOf(execution).live as Record<string, unknown>;
  assert.equal(live.targetPresent, false);
});

test("executeApprovalBundle drives the real dispose executor end-to-end for a fresh approved bundle", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const target = approvalTarget(ledger, subject, plan.planId, "trash-resolve");

  const home = join(mkdtempSync(join(tmpdir(), "artshelf-ui-exec-bundle-")), "ui");
  const session = startOrResumeSession({ home, scope: "user" });
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: [target],
    selectedTargetIds: [target.targetId],
    reviewed: {}
  });

  // The agent re-reads live facts (here they still match the reviewed snapshot), revalidates fresh,
  // and executes through the real dispose-backed path.
  const result = executeApprovalBundle(snapshot, { targets: [target], reviewed: {} }, disposeBackedTargetExecutor);

  assert.equal(result.revalidation.status, "fresh");
  assert.equal(result.status, "executed");
  assert.equal(result.receipts[0]?.outcome, "executed");
  assert.equal(recordById(ledger, "shf_backup")?.status, "trashed");
  assert.equal(existsSync(subject), false);
});
