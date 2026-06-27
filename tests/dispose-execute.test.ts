import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Fix the clock so snooze horizons, generated ids, and audit timestamps are
// deterministic across calls.
process.env.ARTSHELF_NOW = "2026-03-01T00:00:00Z";

import { createDisposePlan, executeDisposePlan } from "../src/dispose.js";
import { dueEntries, readLedger, resolveRecord } from "../src/ledger.js";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "artshelf-dispose-exec-"));
}

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

// A repo whose recorded backup still exists on disk: the common subject for any
// disposition execute.
function presentBackupFixture(): { repo: string; ledger: string; subject: string } {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const subject = join(repo, "backup.tar");
  writeFileSync(subject, "payload");
  writeLedgerFile(ledger, [baseRecord({ id: "shf_backup", path: subject, status: "active" })]);
  return { repo, ledger, subject };
}

function recordById(ledger: string, id: string) {
  return readLedger(ledger).find((record) => record.id === id);
}

test("executeDisposePlan moves the subject to trash and leaves the record purge-visible for trash-resolve", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const target = plan.entry?.targetPath as string;

  const execution = executeDisposePlan(ledger, plan.planId);

  // The file moved from the recorded path into the plan-scoped trash target.
  assert.equal(existsSync(subject), false);
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(target, "utf8"), "payload");

  // The record is trashed so `trash list` and the separate purge workflow can sweep it.
  const record = recordById(ledger, "shf_backup");
  assert.equal(record?.status, "trashed");
  assert.equal(record?.resolvedAt, undefined);
  assert.equal(record?.resolutionReason, undefined);
  assert.equal(record?.targetPath, target);
  assert.equal(record?.previousPath, subject);
  assert.equal(record?.disposePlanId, plan.planId);
  assert.equal(record?.disposeReceiptPath, execution.receiptPath);
  assert.equal(record?.disposeAction, "trash-resolve");

  // The execution result and verification describe the move.
  assert.equal(execution.result.action, "trash-resolve");
  assert.equal(execution.result.status, "trashed");
  assert.equal(execution.result.targetPath, target);
  assert.equal(execution.result.previousPath, subject);
  assert.equal(execution.result.verification.recordStatus, "trashed");
  assert.equal(execution.result.verification.subjectPresent, false);
  assert.equal(execution.result.verification.targetPresent, true);
});

test("executeDisposePlan resolves the ledger record without moving files for resolve-only", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "resolve-only", reason: "no longer needed" });

  const execution = executeDisposePlan(ledger, plan.planId);

  // resolve-only never touches the filesystem.
  assert.equal(existsSync(subject), true);
  assert.equal(readFileSync(subject, "utf8"), "payload");

  const record = recordById(ledger, "shf_backup");
  assert.equal(record?.status, "resolved");
  assert.equal(record?.resolutionReason, "no longer needed");
  assert.equal(record?.targetPath, undefined);

  assert.equal(execution.result.status, "resolved");
  assert.equal(execution.result.targetPath, null);
  assert.equal(execution.result.verification.subjectPresent, true);
  assert.equal(execution.result.verification.targetPresent, null);
});

test("executeDisposePlan extends retention and keeps the record active for snooze", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "snooze", ttl: "7d" });

  const execution = executeDisposePlan(ledger, plan.planId);

  // The file is untouched; only the retention horizon changes.
  assert.equal(existsSync(subject), true);

  const record = recordById(ledger, "shf_backup");
  assert.equal(record?.status, "active");
  assert.deepEqual(record?.retention, { mode: "ttl", ttl: "7d" });
  assert.equal(record?.retainUntil, "2026-03-08T00:00:00Z");
  assert.equal(record?.disposeAction, "snooze");
  assert.equal(record?.disposedAt, "2026-03-01T00:00:00Z");

  assert.equal(execution.result.status, "snoozed");
  assert.deepEqual(execution.result.retention, { mode: "ttl", ttl: "7d" });
  assert.equal(execution.result.retainUntil, "2026-03-08T00:00:00Z");
  assert.equal(execution.result.verification.recordStatus, "active");
});

test("executeDisposePlan marks the record reviewed and kept without changing retention for keep", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "keep", reason: "still investigating" });

  const execution = executeDisposePlan(ledger, plan.planId);

  assert.equal(existsSync(subject), true);

  const record = recordById(ledger, "shf_backup");
  assert.equal(record?.status, "active");
  // keep is reviewed-and-kept: retention is preserved verbatim, never recomputed.
  assert.deepEqual(record?.retention, { mode: "manual-review" });
  assert.equal(record?.retainUntil, undefined);
  assert.equal(record?.disposeAction, "keep");
  assert.equal(record?.disposeReason, "still investigating");
  assert.equal(record?.disposedAt, "2026-03-01T00:00:00Z");

  assert.equal(execution.result.status, "kept");
  assert.equal(execution.result.retention, null);
  assert.equal(execution.result.verification.subjectPresent, true);
});

test("executeDisposePlan makes a kept manual-review record quiet in due output", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "keep", reason: "still investigating" });

  executeDisposePlan(ledger, plan.planId);

  assert.equal(existsSync(subject), true);
  assert.equal(readLedger(ledger).find((record) => record.id === "shf_backup")?.disposeAction, "keep");
  assert.equal(readLedger(ledger).find((record) => record.id === "shf_backup")?.status, "active");
  assert.equal(dueEntries(readLedger(ledger)).find((entry) => entry.id === "shf_backup")?.dueStatus, "kept");
});

test("executeDisposePlan writes a receipt registered as an artshelf-owned artifact", () => {
  const { ledger } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });

  const execution = executeDisposePlan(ledger, plan.planId);

  assert.equal(existsSync(execution.receiptPath), true);
  const receipt = JSON.parse(readFileSync(execution.receiptPath, "utf8"));
  assert.equal(receipt.planId, plan.planId);
  assert.equal(receipt.status, "completed");
  assert.deepEqual(receipt.result, execution.result);

  const artifact = readLedger(ledger).find((record) => record.path === execution.receiptPath);
  assert.ok(artifact, "the dispose receipt should be tracked in the ledger");
  assert.equal(artifact?.owner, "artshelf");
  assert.equal(artifact?.labels.includes("dispose-receipt"), true);
  assert.equal(artifact?.labels.includes(plan.planId), true);
});

test("executeDisposePlan is idempotent when the same trash-resolve plan is re-run", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const target = plan.entry?.targetPath as string;

  const first = executeDisposePlan(ledger, plan.planId);
  const second = executeDisposePlan(ledger, plan.planId);

  // The rerun neither errors, re-moves the (already-absent) subject, nor duplicates.
  assert.equal(existsSync(subject), false);
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(target, "utf8"), "payload");
  assert.equal(second.result.status, "trashed");
  assert.equal(second.result.targetPath, target);

  const record = recordById(ledger, "shf_backup");
  assert.equal(record?.status, "trashed");
  assert.equal(record?.disposePlanId, plan.planId);
  // The idempotent rerun re-derives the outcome from the row without re-stamping it.
  assert.equal(record?.disposedAt, first.executedAt);
});

test("executeDisposePlan returns the original receipt without rewriting it on replay", () => {
  const { ledger } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "resolve-only", reason: "reviewed" });

  process.env.ARTSHELF_NOW = "2026-03-01T00:00:00Z";
  const first = executeDisposePlan(ledger, plan.planId);
  const receiptBefore = readFileSync(first.receiptPath, "utf8");
  const receiptRecordBefore = readLedger(ledger).find((record) => record.path === first.receiptPath);
  process.env.ARTSHELF_NOW = "2026-03-02T00:00:00Z";

  const second = executeDisposePlan(ledger, plan.planId);

  assert.equal(second.executedAt, first.executedAt);
  assert.equal(second.receiptPath, first.receiptPath);
  assert.equal(readFileSync(first.receiptPath, "utf8"), receiptBefore);
  assert.deepEqual(readLedger(ledger).find((record) => record.path === first.receiptPath), receiptRecordBefore);
  process.env.ARTSHELF_NOW = "2026-03-01T00:00:00Z";
});

test("executeDisposePlan refuses a completed receipt for a different plan entry", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "resolve-only", reason: "reviewed" });
  const receiptPath = join(dirname(ledger), "dispose-receipts", `${plan.planId}.json`);
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify({
    planId: plan.planId,
    ledgerPath: ledger,
    executedAt: "2026-03-01T00:00:00Z",
    status: "completed",
    result: {
      id: "shf_other",
      action: "keep",
      status: "kept",
      reason: "foreign receipt",
      previousPath: null,
      targetPath: null,
      retention: null,
      retainUntil: null,
      verification: {
        recordStatus: "active",
        subjectPresent: true,
        targetPresent: null
      }
    }
  }, null, 2)}\n`);

  assert.throws(() => executeDisposePlan(ledger, plan.planId), /receipt result mismatch/i);
  assert.equal(recordById(ledger, "shf_backup")?.status, "active");
  assert.equal(recordById(ledger, "shf_backup")?.disposePlanId, undefined);
  assert.equal(existsSync(subject), true);
});

test("executeDisposePlan replays a completed skipped receipt without applying later", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "resolve-only", reason: "reviewed" });

  writeFileSync(subject, "payload changed after review");
  process.env.ARTSHELF_NOW = "2026-03-01T00:00:00Z";
  const first = executeDisposePlan(ledger, plan.planId);
  const receiptBefore = readFileSync(first.receiptPath, "utf8");
  writeFileSync(subject, "payload");
  process.env.ARTSHELF_NOW = "2026-03-02T00:00:00Z";

  const second = executeDisposePlan(ledger, plan.planId);

  assert.equal(first.result.status, "skipped");
  assert.equal(second.result.status, "skipped");
  assert.equal(second.executedAt, first.executedAt);
  assert.equal(readFileSync(first.receiptPath, "utf8"), receiptBefore);
  assert.equal(recordById(ledger, "shf_backup")?.status, "active");
  assert.equal(recordById(ledger, "shf_backup")?.disposePlanId, undefined);
  process.env.ARTSHELF_NOW = "2026-03-01T00:00:00Z";
});

test("executeDisposePlan resumes a trash-resolve after the move reached trash", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const target = plan.entry?.targetPath as string;
  const receiptPath = join(dirname(ledger), "dispose-receipts", `${plan.planId}.json`);
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(dirname(receiptPath), { recursive: true });
  renameSync(subject, target);
  writeFileSync(receiptPath, `${JSON.stringify({
    planId: plan.planId,
    ledgerPath: ledger,
    executedAt: "2026-03-01T00:00:00Z",
    status: "started",
    action: "trash-resolve",
    target
  }, null, 2)}\n`);

  const execution = executeDisposePlan(ledger, plan.planId);

  assert.equal(execution.result.status, "trashed");
  assert.equal(execution.result.targetPath, target);
  assert.equal(existsSync(subject), false);
  assert.equal(existsSync(target), true);
  const record = recordById(ledger, "shf_backup");
  assert.equal(record?.status, "trashed");
  assert.equal(record?.disposePlanId, plan.planId);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.result.status, "trashed");
});

test("executeDisposePlan refuses trash-resolve resume when the live status changed", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const target = plan.entry?.targetPath as string;
  const receiptPath = join(dirname(ledger), "dispose-receipts", `${plan.planId}.json`);
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(dirname(receiptPath), { recursive: true });
  renameSync(subject, target);
  writeLedgerFile(ledger, readLedger(ledger).map((record) => record.id === "shf_backup" ? {
    ...record,
    status: "resolved",
    resolvedAt: "2026-03-01T00:00:00Z",
    resolutionReason: "handled elsewhere"
  } : record));
  writeFileSync(receiptPath, `${JSON.stringify({
    planId: plan.planId,
    ledgerPath: ledger,
    executedAt: "2026-03-01T00:00:00Z",
    status: "started",
    action: "trash-resolve",
    target
  }, null, 2)}\n`);

  const execution = executeDisposePlan(ledger, plan.planId);

  assert.equal(execution.result.status, "skipped");
  assert.match(execution.result.reason, /live ledger state no longer matches/);
  const record = recordById(ledger, "shf_backup");
  assert.equal(record?.status, "resolved");
  assert.equal(record?.resolutionReason, "handled elsewhere");
  assert.equal(record?.disposePlanId, undefined);
  assert.equal(existsSync(subject), false);
  assert.equal(existsSync(target), true);
});

test("executeDisposePlan repairs a completed ledger stamp with a started receipt", () => {
  const { ledger } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "resolve-only", reason: "reviewed" });
  const receiptPath = join(dirname(ledger), "dispose-receipts", `${plan.planId}.json`);
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeLedgerFile(ledger, readLedger(ledger).map((record) => record.id === "shf_backup" ? {
    ...record,
    status: "resolved",
    resolvedAt: "2026-03-01T00:00:00Z",
    resolutionReason: "reviewed",
    disposePlanId: plan.planId,
    disposeReceiptPath: receiptPath,
    disposedAt: "2026-03-01T00:00:00Z",
    disposeAction: "resolve-only",
    disposeReason: "reviewed"
  } : record));
  writeFileSync(receiptPath, `${JSON.stringify({
    planId: plan.planId,
    ledgerPath: ledger,
    executedAt: "2026-03-01T00:00:00Z",
    status: "started",
    action: "resolve-only",
    target: null
  }, null, 2)}\n`);

  const execution = executeDisposePlan(ledger, plan.planId);

  assert.equal(execution.result.status, "resolved");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.executedAt, "2026-03-01T00:00:00Z");
  assert.ok(readLedger(ledger).find((record) => record.path === receiptPath && record.labels.includes("dispose-receipt")));
});

test("executeDisposePlan refuses when no plan id is supplied", () => {
  const { ledger } = presentBackupFixture();
  assert.throws(() => executeDisposePlan(ledger, ""), /requires --plan-id/);
});

test("executeDisposePlan refuses an unknown plan id", () => {
  const { ledger } = presentBackupFixture();
  assert.throws(() => executeDisposePlan(ledger, "dispose_19990101_000000_dead"), /not found/i);
});

test("executeDisposePlan refuses a plan whose declared id does not match the requested one", () => {
  const { ledger } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "resolve-only", reason: "reviewed" });
  const tampered = { ...JSON.parse(readFileSync(plan.planPath as string, "utf8")), planId: "dispose_19990101_000000_beef" };
  writeFileSync(plan.planPath as string, `${JSON.stringify(tampered, null, 2)}\n`);

  assert.throws(() => executeDisposePlan(ledger, plan.planId), /mismatch/i);
});

test("executeDisposePlan refuses a plan whose declared ledger does not match the executing ledger", () => {
  const { ledger } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "resolve-only", reason: "reviewed" });
  const tampered = { ...JSON.parse(readFileSync(plan.planPath as string, "utf8")), ledgerPath: "/foreign/ledger.jsonl" };
  writeFileSync(plan.planPath as string, `${JSON.stringify(tampered, null, 2)}\n`);

  assert.throws(() => executeDisposePlan(ledger, plan.planId), /ledger mismatch/i);
});

test("executeDisposePlan refuses a plan whose entry is malformed before mutating", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const tampered = JSON.parse(readFileSync(plan.planPath as string, "utf8"));
  tampered.entry = null;
  writeFileSync(plan.planPath as string, `${JSON.stringify(tampered, null, 2)}\n`);

  assert.throws(() => executeDisposePlan(ledger, plan.planId), /malformed/i);
  // No mutation: the subject stays put and the row is untouched.
  assert.equal(existsSync(subject), true);
  assert.equal(recordById(ledger, "shf_backup")?.disposePlanId, undefined);
});

test("executeDisposePlan refuses malformed entry fields before writing a receipt", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "resolve-only", reason: "reviewed" });
  const tampered = JSON.parse(readFileSync(plan.planPath as string, "utf8"));
  tampered.entry.reason = 42;
  writeFileSync(plan.planPath as string, `${JSON.stringify(tampered, null, 2)}\n`);
  const receiptPath = join(dirname(ledger), "dispose-receipts", `${plan.planId}.json`);

  assert.throws(() => executeDisposePlan(ledger, plan.planId), /malformed/i);
  assert.equal(existsSync(receiptPath), false);
  assert.equal(existsSync(subject), true);
  assert.equal(recordById(ledger, "shf_backup")?.disposePlanId, undefined);
});

test("executeDisposePlan refuses malformed snooze fields before writing a receipt", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "snooze", ttl: "7d" });
  const tampered = JSON.parse(readFileSync(plan.planPath as string, "utf8"));
  delete tampered.entry.retention;
  writeFileSync(plan.planPath as string, `${JSON.stringify(tampered, null, 2)}\n`);
  const receiptPath = join(dirname(ledger), "dispose-receipts", `${plan.planId}.json`);

  assert.throws(() => executeDisposePlan(ledger, plan.planId), /malformed/i);
  assert.equal(existsSync(receiptPath), false);
  assert.equal(existsSync(subject), true);
  assert.equal(recordById(ledger, "shf_backup")?.disposePlanId, undefined);
});

test("executeDisposePlan refuses a trash-resolve plan with a tampered target path", () => {
  const { repo, ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const tampered = JSON.parse(readFileSync(plan.planPath as string, "utf8"));
  tampered.entry.targetPath = join(repo, ".artshelf", "foreign-trash", "shf_backup-backup.tar");
  writeFileSync(plan.planPath as string, `${JSON.stringify(tampered, null, 2)}\n`);

  assert.throws(() => executeDisposePlan(ledger, plan.planId), /target path mismatch/i);
  assert.equal(existsSync(subject), true);
  assert.equal(recordById(ledger, "shf_backup")?.disposePlanId, undefined);
});

test("executeDisposePlan refuses an unsafe trash-resolve record id before moving", () => {
  const { repo, ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const unsafeId = "../../escaped";
  const escapedTarget = join(repo, ".artshelf", "escaped-backup.tar");
  const tampered = JSON.parse(readFileSync(plan.planPath as string, "utf8"));
  tampered.entry.id = unsafeId;
  tampered.entry.targetPath = join(repo, ".artshelf", "trash", plan.planId, `${unsafeId}-backup.tar`);
  writeFileSync(plan.planPath as string, `${JSON.stringify(tampered, null, 2)}\n`);
  writeLedgerFile(ledger, readLedger(ledger).map((record) => record.id === "shf_backup" ? { ...record, id: unsafeId } : record));
  const receiptPath = join(dirname(ledger), "dispose-receipts", `${plan.planId}.json`);

  assert.throws(() => executeDisposePlan(ledger, plan.planId), /Invalid dispose record id/);
  assert.equal(existsSync(receiptPath), false);
  assert.equal(existsSync(subject), true);
  assert.equal(existsSync(escapedTarget), false);
  assert.equal(recordById(ledger, unsafeId)?.disposePlanId, undefined);
});

test("executeDisposePlan skips a trash-resolve whose subject drifted since dry-run", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const target = plan.entry?.targetPath as string;
  // The reviewed plan snapshotted a 7-byte file; the subject changed before execute.
  writeFileSync(subject, "payload-changed-since-review");

  const execution = executeDisposePlan(ledger, plan.planId);

  assert.equal(execution.result.status, "skipped");
  assert.match(execution.result.reason, /no longer matches|drift|stale/i);
  // No mutation: the subject stays put, no trash target is written, the row is untouched.
  assert.equal(existsSync(subject), true);
  assert.equal(existsSync(target), false);
  const record = recordById(ledger, "shf_backup");
  assert.equal(record?.status, "active");
  assert.equal(record?.disposePlanId, undefined);
});

test("executeDisposePlan skips same-size file edits since dry-run", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const target = plan.entry?.targetPath as string;
  writeFileSync(subject, "PAYLOAD");

  const execution = executeDisposePlan(ledger, plan.planId);

  assert.equal(execution.result.status, "skipped");
  assert.equal(existsSync(subject), true);
  assert.equal(existsSync(target), false);
  assert.equal(recordById(ledger, "shf_backup")?.disposePlanId, undefined);
});

test("executeDisposePlan skips directory content changes since dry-run", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const subject = join(repo, "bundle");
  mkdirSync(subject);
  writeFileSync(join(subject, "entry.txt"), "payload");
  writeLedgerFile(ledger, [baseRecord({ id: "shf_backup", path: subject, status: "active" })]);
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const target = plan.entry?.targetPath as string;
  writeFileSync(join(subject, "other.txt"), "changed");

  const execution = executeDisposePlan(ledger, plan.planId);

  assert.equal(execution.result.status, "skipped");
  assert.equal(existsSync(subject), true);
  assert.equal(existsSync(target), false);
  assert.equal(recordById(ledger, "shf_backup")?.disposePlanId, undefined);
});

test("executeDisposePlan skips when the live record path moved on since dry-run", () => {
  const { repo, ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const target = plan.entry?.targetPath as string;
  const newSubject = join(repo, "new-backup.tar");
  writeFileSync(newSubject, "new payload");
  writeLedgerFile(ledger, readLedger(ledger).map((record) => record.id === "shf_backup" ? { ...record, path: newSubject } : record));

  const execution = executeDisposePlan(ledger, plan.planId);

  assert.equal(execution.result.status, "skipped");
  assert.match(execution.result.reason, /path|reviewed plan|stale/i);
  assert.equal(existsSync(subject), true);
  assert.equal(existsSync(newSubject), true);
  assert.equal(existsSync(target), false);
  const record = recordById(ledger, "shf_backup");
  assert.equal(record?.status, "active");
  assert.equal(record?.path, newSubject);
  assert.equal(record?.disposePlanId, undefined);
});

test("executeDisposePlan refuses a trash-resolve whose target path is already occupied", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const target = plan.entry?.targetPath as string;
  // A foreign artifact already occupies the plan-scoped target before any execute.
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "someone-else");

  const execution = executeDisposePlan(ledger, plan.planId);

  assert.equal(execution.result.status, "skipped");
  assert.match(execution.result.reason, /target|conflict/i);
  // The original subject is never moved over the conflicting target.
  assert.equal(existsSync(subject), true);
  assert.equal(readFileSync(target, "utf8"), "someone-else");
  assert.equal(recordById(ledger, "shf_backup")?.status, "active");
});

test("executeDisposePlan skips when the live record status moved on since dry-run", () => {
  const { ledger } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "resolve-only", reason: "reviewed" });
  // The record was resolved out-of-band after the plan was reviewed.
  resolveRecord(ledger, { id: "shf_backup", status: "resolved", reason: "handled elsewhere" });

  const execution = executeDisposePlan(ledger, plan.planId);

  assert.equal(execution.result.status, "skipped");
  // The out-of-band resolution is preserved, not overwritten by the stale plan.
  assert.equal(recordById(ledger, "shf_backup")?.resolutionReason, "handled elsewhere");
});
