import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Fix the clock so snooze horizons and generated ids are deterministic across calls.
process.env.ARTSHELF_NOW = "2026-03-01T00:00:00Z";

import { classifyDisposition, createDisposePlan, previewDisposePlan } from "../src/dispose.js";
import { readLedger } from "../src/ledger.js";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "artshelf-dispose-"));
}

// Author a ledger file directly so fixtures can carry arbitrary status/path state
// without the existence checks prepareRecord enforces.
function writeLedgerFile(ledgerPath: string, records: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function baseRecord(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "shf_test_1",
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

// A repo whose recorded backup still exists on disk: the common subject for a
// trash-resolve or resolve-only disposition.
function presentBackupFixture(): { repo: string; ledger: string; subject: string } {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const subject = join(repo, "backup.tar");
  writeFileSync(subject, "payload");
  writeLedgerFile(ledger, [baseRecord({ id: "shf_backup", path: subject, status: "active" })]);
  return { repo, ledger, subject };
}

test("classifyDisposition treats trash-resolve on an active present path as actionable", () => {
  const { ledger, subject } = presentBackupFixture();

  const finding = classifyDisposition(ledger, { id: "shf_backup", action: "trash-resolve", reason: "done reviewing" });

  assert.equal(finding.ok, true);
  if (!finding.ok) return;
  assert.equal(finding.entry.id, "shf_backup");
  assert.equal(finding.entry.action, "trash-resolve");
  assert.equal(finding.entry.subjectPath, subject);
  assert.equal(finding.entry.subject.existence, "present");
  assert.equal(finding.entry.subject.nodeKind, "file");
  assert.equal(finding.entry.subject.byteSize, "payload".length);
  assert.equal(finding.entry.reason, "done reviewing");
});

test("classifyDisposition blocks trash-resolve when the subject path is missing", () => {
  const repo = fixture();
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  writeLedgerFile(ledger, [baseRecord({ id: "shf_gone", path: join(repo, "gone.tar"), status: "active" })]);

  const finding = classifyDisposition(ledger, { id: "shf_gone", action: "trash-resolve" });

  assert.equal(finding.ok, false);
  if (finding.ok) return;
  assert.equal(finding.reason, "missing-subject-path");
});

test("classifyDisposition blocks trash-resolve on an already-resolved record", () => {
  const repo = fixture();
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  writeLedgerFile(ledger, [
    baseRecord({ id: "shf_done", status: "resolved", resolvedAt: "2026-02-01T00:00:00.000Z", resolutionReason: "handled" })
  ]);

  const finding = classifyDisposition(ledger, { id: "shf_done", action: "trash-resolve" });

  assert.equal(finding.ok, false);
  if (finding.ok) return;
  assert.equal(finding.reason, "already-resolved");
});

test("classifyDisposition blocks trash-resolve on a trashed record", () => {
  const repo = fixture();
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  writeLedgerFile(ledger, [
    baseRecord({
      id: "shf_trashed",
      status: "trashed",
      targetPath: join(repo, ".artshelf", "trash", "plan_1", "shf_trashed-backup.tar"),
      cleanupPlanId: "plan_1",
      receiptPath: join(repo, ".artshelf", "receipts", "plan_1.json"),
      cleanedAt: "2026-02-01T00:00:00.000Z"
    })
  ]);

  const finding = classifyDisposition(ledger, { id: "shf_trashed", action: "trash-resolve" });

  assert.equal(finding.ok, false);
  if (finding.ok) return;
  assert.equal(finding.reason, "already-trashed");
});

test("classifyDisposition requires a reason for resolve-only", () => {
  const { ledger } = presentBackupFixture();

  const finding = classifyDisposition(ledger, { id: "shf_backup", action: "resolve-only" });

  assert.equal(finding.ok, false);
  if (finding.ok) return;
  assert.equal(finding.reason, "missing-reason");
});

test("classifyDisposition treats resolve-only with a reason as actionable without moving files", () => {
  const { ledger, subject } = presentBackupFixture();

  const finding = classifyDisposition(ledger, { id: "shf_backup", action: "resolve-only", reason: "artifact no longer needed" });

  assert.equal(finding.ok, true);
  if (!finding.ok) return;
  assert.equal(finding.entry.action, "resolve-only");
  assert.equal(finding.entry.reason, "artifact no longer needed");
  // resolve-only never moves the file, so it never computes a trash target.
  assert.equal(finding.entry.targetPath, undefined);
  assert.equal(finding.entry.subjectPath, subject);
});

test("classifyDisposition blocks resolve-only on an already-resolved record", () => {
  const repo = fixture();
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  writeLedgerFile(ledger, [
    baseRecord({ id: "shf_done", status: "resolved", resolvedAt: "2026-02-01T00:00:00.000Z", resolutionReason: "handled" })
  ]);

  const finding = classifyDisposition(ledger, { id: "shf_done", action: "resolve-only", reason: "again" });

  assert.equal(finding.ok, false);
  if (finding.ok) return;
  assert.equal(finding.reason, "already-resolved");
});

test("classifyDisposition requires a horizon for snooze", () => {
  const { ledger } = presentBackupFixture();

  const finding = classifyDisposition(ledger, { id: "shf_backup", action: "snooze" });

  assert.equal(finding.ok, false);
  if (finding.ok) return;
  assert.equal(finding.reason, "missing-snooze-horizon");
});

test("classifyDisposition snooze with a ttl extends the retention horizon", () => {
  const { ledger } = presentBackupFixture();

  const finding = classifyDisposition(ledger, { id: "shf_backup", action: "snooze", ttl: "7d" });

  assert.equal(finding.ok, true);
  if (!finding.ok) return;
  assert.equal(finding.entry.action, "snooze");
  assert.deepEqual(finding.entry.retention, { mode: "ttl", ttl: "7d" });
  // Horizon is measured from the (fixed) clock: 2026-03-01 + 7d.
  assert.equal(finding.entry.retainUntil, "2026-03-08T00:00:00Z");
  assert.equal(finding.entry.targetPath, undefined);
});

test("classifyDisposition snooze with a retain-until date pins the horizon", () => {
  const { ledger } = presentBackupFixture();

  const finding = classifyDisposition(ledger, { id: "shf_backup", action: "snooze", retainUntil: "2026-09-01T00:00:00Z" });

  assert.equal(finding.ok, true);
  if (!finding.ok) return;
  assert.deepEqual(finding.entry.retention, { mode: "retain-until", retainUntil: "2026-09-01T00:00:00Z" });
  assert.equal(finding.entry.retainUntil, "2026-09-01T00:00:00Z");
});

test("classifyDisposition blocks snooze on a resolved record", () => {
  const repo = fixture();
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  writeLedgerFile(ledger, [
    baseRecord({ id: "shf_done", status: "resolved", resolvedAt: "2026-02-01T00:00:00.000Z", resolutionReason: "handled" })
  ]);

  const finding = classifyDisposition(ledger, { id: "shf_done", action: "snooze", ttl: "7d" });

  assert.equal(finding.ok, false);
  if (finding.ok) return;
  assert.equal(finding.reason, "terminal-record");
});

test("classifyDisposition treats keep on an active record as actionable", () => {
  const { ledger } = presentBackupFixture();

  const finding = classifyDisposition(ledger, { id: "shf_backup", action: "keep", reason: "still investigating" });

  assert.equal(finding.ok, true);
  if (!finding.ok) return;
  assert.equal(finding.entry.action, "keep");
  assert.equal(finding.entry.reason, "still investigating");
  assert.equal(finding.entry.targetPath, undefined);
});

test("classifyDisposition blocks keep on a trashed record", () => {
  const repo = fixture();
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  writeLedgerFile(ledger, [
    baseRecord({
      id: "shf_trashed",
      status: "trashed",
      targetPath: join(repo, ".artshelf", "trash", "plan_1", "shf_trashed-backup.tar"),
      cleanupPlanId: "plan_1",
      receiptPath: join(repo, ".artshelf", "receipts", "plan_1.json"),
      cleanedAt: "2026-02-01T00:00:00.000Z"
    })
  ]);

  const finding = classifyDisposition(ledger, { id: "shf_trashed", action: "keep" });

  assert.equal(finding.ok, false);
  if (finding.ok) return;
  assert.equal(finding.reason, "terminal-record");
});

test("classifyDisposition throws when the record id is unknown", () => {
  const { ledger } = presentBackupFixture();
  assert.throws(() => classifyDisposition(ledger, { id: "shf_missing", action: "keep" }), /not found/i);
});

test("createDisposePlan writes a reviewed plan for an actionable request", () => {
  const { repo, ledger } = presentBackupFixture();

  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "resolve-only", reason: "no longer needed" });

  assert.ok(plan.planId.startsWith("dispose_"), `unexpected plan id ${plan.planId}`);
  assert.equal(plan.request.id, "shf_backup");
  assert.equal(plan.request.action, "resolve-only");
  assert.equal(plan.blocked, null);
  assert.ok(plan.entry, "an actionable plan should carry an entry");
  assert.equal(plan.entry?.action, "resolve-only");
  assert.ok(plan.planPath, "plan path should be set");
  assert.equal(dirname(plan.planPath as string), join(repo, ".artshelf", "dispose-plans"));
  assert.equal(existsSync(plan.planPath as string), true);
  // The persisted plan round-trips exactly, so agents can replay the decision packet.
  const onDisk = JSON.parse(readFileSync(plan.planPath as string, "utf8"));
  assert.deepEqual(onDisk, plan);
});

test("createDisposePlan computes a trash target under the plan trash root for trash-resolve", () => {
  const { repo, ledger } = presentBackupFixture();

  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });

  assert.ok(plan.entry?.targetPath, "trash-resolve should compute a target path");
  assert.equal(dirname(plan.entry?.targetPath as string), join(repo, ".artshelf", "trash", plan.planId));
  assert.ok((plan.entry?.targetPath as string).endsWith("shf_backup-backup.tar"));
});

test("createDisposePlan registers the plan file as an artshelf-owned artifact", () => {
  const { ledger } = presentBackupFixture();

  const plan = createDisposePlan(ledger, { id: "shf_backup", action: "keep", reason: "watching it" });

  const artifact = readLedger(ledger).find((record) => record.path === plan.planPath);
  assert.ok(artifact, "the dispose plan file should be tracked in the ledger");
  assert.equal(artifact?.owner, "artshelf");
  assert.equal(artifact?.labels.includes("dispose-plan"), true);
  assert.equal(artifact?.labels.includes(plan.planId), true);
});

test("createDisposePlan reuses an existing plan with a matching request", () => {
  const { repo, ledger } = presentBackupFixture();

  const first = createDisposePlan(ledger, { id: "shf_backup", action: "snooze", ttl: "7d" });
  const second = createDisposePlan(ledger, { id: "shf_backup", action: "snooze", ttl: "7d" });

  assert.equal(second.planId, first.planId);
  assert.equal(second.planPath, first.planPath);
  assert.deepEqual(readdirSync(join(repo, ".artshelf", "dispose-plans")), [`${first.planId}.json`]);
  const artifacts = readLedger(ledger).filter((record) => record.labels.includes("dispose-plan"));
  assert.equal(artifacts.length, 1);
});

test("createDisposePlan does not write a plan for a blocked request", () => {
  const repo = fixture();
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  writeLedgerFile(ledger, [
    baseRecord({ id: "shf_done", status: "resolved", resolvedAt: "2026-02-01T00:00:00.000Z", resolutionReason: "handled" })
  ]);

  const plan = createDisposePlan(ledger, { id: "shf_done", action: "trash-resolve" });

  assert.equal(plan.planId, "not-created");
  assert.equal(plan.planPath, null);
  assert.equal(plan.entry, null);
  assert.equal(plan.blocked?.reason, "already-resolved");
  // Read-only on a block: no plan directory is created.
  assert.equal(existsSync(join(repo, ".artshelf", "dispose-plans")), false);
});

test("previewDisposePlan classifies without writing a plan or mutating the ledger", () => {
  const { repo, ledger } = presentBackupFixture();
  const before = readFileSync(ledger, "utf8");

  const plan = previewDisposePlan(ledger, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });

  assert.ok(plan.entry, "preview still classifies an actionable entry");
  assert.ok(plan.planPath, "preview still computes a plan path");
  assert.equal(existsSync(plan.planPath as string), false);
  assert.equal(existsSync(join(repo, ".artshelf", "dispose-plans")), false);
  assert.equal(readFileSync(ledger, "utf8"), before);
});
