import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Fix the clock so snooze horizons, generated ids, and audit timestamps are
// deterministic across calls.
process.env.ARTSHELF_NOW = "2026-03-01T00:00:00Z";

import { createDisposePlan, executeDisposePlan } from "../src/dispose.js";
import { readLedger, resolveRecord } from "../src/ledger.js";

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

test("executeDisposePlan moves the subject to trash and resolves the record for trash-resolve", () => {
  const { ledger, subject } = presentBackupFixture();
  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const target = plan.entry?.targetPath as string;

  const execution = executeDisposePlan(ledger, plan.planId);

  // The file moved from the recorded path into the plan-scoped trash target.
  assert.equal(existsSync(subject), false);
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(target, "utf8"), "payload");

  // The record is resolved (not trashed, so `trash purge` never sweeps it) with audit.
  const record = recordById(ledger, "shf_backup");
  assert.equal(record?.status, "resolved");
  assert.equal(record?.resolvedAt, "2026-03-01T00:00:00Z");
  assert.equal(record?.resolutionReason, "reviewed");
  assert.equal(record?.targetPath, target);
  assert.equal(record?.previousPath, subject);
  assert.equal(record?.disposePlanId, plan.planId);
  assert.equal(record?.disposeReceiptPath, execution.receiptPath);
  assert.equal(record?.disposeAction, "trash-resolve");

  // The execution result and verification describe the move.
  assert.equal(execution.result.action, "trash-resolve");
  assert.equal(execution.result.status, "resolved");
  assert.equal(execution.result.targetPath, target);
  assert.equal(execution.result.previousPath, subject);
  assert.equal(execution.result.verification.recordStatus, "resolved");
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
  assert.equal(second.result.status, "resolved");
  assert.equal(second.result.targetPath, target);

  const record = recordById(ledger, "shf_backup");
  assert.equal(record?.status, "resolved");
  assert.equal(record?.disposePlanId, plan.planId);
  // The idempotent rerun re-derives the outcome from the row without re-stamping it.
  assert.equal(record?.disposedAt, first.executedAt);
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
