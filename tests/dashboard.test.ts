import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildDashboard } from "../src/dashboard.js";

// Read-only multi-ledger dashboard aggregation (NGX-535). Fixtures author registry + ledger
// files directly so a row can carry stale paths, trash provenance, or weak metadata without
// the existence checks the `put` path enforces. ARTSHELF_NOW is pinned at module scope (this
// file runs in its own test-runner process) so ages and due classification stay deterministic,
// and ARTSHELF_REGISTRY is cleared so every case targets its own fixture registry. The
// dashboard is recomputed from live state, so each case asserts how an existing read-only
// surface lands in its lane - never a mutation.

const NOW = "2026-06-25T12:00:00.000Z";
const PAST_DUE = "2026-06-20T00:00:00.000Z";
const FUTURE_HOLD = "2026-12-01T00:00:00.000Z";
const CLEANED_AT = "2026-06-10T00:00:00.000Z";

process.env.ARTSHELF_NOW = NOW;
delete process.env.ARTSHELF_REGISTRY;

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "artshelf-dashboard-"));
}

function writeLedgerFile(ledgerPath: string, records: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function writeRegistry(registryPath: string, ledgers: Array<{ name: string; path: string; scope?: string }>): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  const entries = ledgers.map((ledger) => ({
    name: ledger.name,
    path: ledger.path,
    scope: ledger.scope ?? "other",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  }));
  writeFileSync(registryPath, JSON.stringify({ version: 1, ledgers: entries }, null, 2) + "\n");
}

function baseRecord(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "shf_1",
    path: "/does/not/exist/file.txt",
    kind: "scratch",
    reason: "fixture artifact",
    createdAt: "2026-06-01T00:00:00.000Z",
    retention: { mode: "manual-review" },
    cleanup: "review",
    owner: "manual",
    labels: [],
    status: "active",
    ...over
  };
}

// A single-ledger registry rooted in a fresh temp dir. Returns the registry path plus a helper
// to materialize a real file under the dir (for rows whose path must exist).
function singleLedger(records: Array<Record<string, unknown>>): { registryPath: string; ledgerPath: string; dir: string } {
  const dir = fixture();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, records);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);
  return { registryPath, ledgerPath, dir };
}

function realFile(dir: string, name: string): string {
  const target = join(dir, name);
  writeFileSync(target, "x");
  return target;
}

test("buildDashboard over an empty registry yields a typed snapshot with empty lanes", () => {
  const dir = fixture();
  const registryPath = join(dir, "ledgers.json");
  writeRegistry(registryPath, []);

  const snapshot = buildDashboard({ registryPath });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.registryPath, registryPath);
  assert.match(snapshot.generatedAt, /^2026-06-25T12:00:00Z$/);
  assert.deepEqual(snapshot.ledgers, []);
  for (const lane of Object.values(snapshot.buckets)) assert.deepEqual(lane, []);
  assert.equal(
    Object.values(snapshot.counts).reduce((sum, count) => sum + count, 0),
    0
  );
});

test("a due trash-cleanup artifact with a present path lands in the cleanup lane", () => {
  const dir = fixture();
  const present = realFile(dir, "scratch.txt");
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    baseRecord({
      id: "shf_cleanup",
      path: present,
      retention: { mode: "ttl", ttl: "1d" },
      retainUntil: PAST_DUE,
      cleanup: "trash"
    })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  const snapshot = buildDashboard({ registryPath });

  assert.equal(snapshot.buckets.cleanup.length, 1);
  const row = snapshot.buckets.cleanup[0]!;
  assert.equal(row.recordId, "shf_cleanup");
  assert.equal(row.ledgerName, "primary");
  assert.equal(row.ledgerPath, ledgerPath);
  assert.equal(row.recommendation, "trash-safe");
  assert.equal(row.existence, "present");
  assert.equal(row.dueState, "due");
  assert.equal(row.reason, "fixture artifact");
  assert.equal(snapshot.buckets.needsReview.length, 0);
  assert.equal(snapshot.counts["cleanup"], 1);
});

test("an active record whose path is gone lands in the resolve lane", () => {
  const { registryPath } = singleLedger([
    baseRecord({ id: "shf_gone", path: "/missing/artifact.bin", retention: { mode: "ttl", ttl: "1d" }, retainUntil: PAST_DUE, cleanup: "trash" })
  ]);

  const snapshot = buildDashboard({ registryPath });

  assert.equal(snapshot.buckets.resolve.length, 1);
  const row = snapshot.buckets.resolve[0]!;
  assert.equal(row.recordId, "shf_gone");
  assert.equal(row.recommendation, "resolve-only");
  assert.equal(row.existence, "missing");
  assert.equal(snapshot.buckets.cleanup.length, 0);
});

test("a review-required record lands in the needs-review lane", () => {
  const { registryPath } = singleLedger([
    baseRecord({
      id: "shf_review",
      status: "review-required",
      cleanupPlanId: "plan_r",
      receiptPath: "/x/receipt.json",
      cleanedAt: CLEANED_AT
    })
  ]);

  const snapshot = buildDashboard({ registryPath });

  assert.equal(snapshot.buckets.needsReview.length, 1);
  const row = snapshot.buckets.needsReview[0]!;
  assert.equal(row.recordId, "shf_review");
  assert.equal(row.recommendation, "blocked");
  assert.equal(row.status, "review-required");
});

test("a manual-review held record needs review, while a snoozed record is not surfaced", () => {
  const dir = fixture();
  const present = realFile(dir, "held.txt");
  const snoozedFile = realFile(dir, "snoozed.txt");
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    baseRecord({ id: "shf_manual", path: present, retention: { mode: "manual-review" }, cleanup: "review" }),
    baseRecord({ id: "shf_snooze", path: snoozedFile, retention: { mode: "ttl", ttl: "30d" }, retainUntil: FUTURE_HOLD, cleanup: "trash" })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  const snapshot = buildDashboard({ registryPath });

  assert.deepEqual(
    snapshot.buckets.needsReview.map((row) => row.recordId),
    ["shf_manual"]
  );
  assert.equal(snapshot.buckets.needsReview[0]!.dueState, "manual-review");
  assert.equal(snapshot.buckets.cleanup.length, 0);
  assert.equal(snapshot.buckets.resolve.length, 0);
});

test("trashed records populate both the trash lane and the purge-candidate lane", () => {
  const { registryPath } = singleLedger([
    baseRecord({
      id: "shf_trashed",
      status: "trashed",
      path: "/orig/path.txt",
      targetPath: "/trash/plan_a/path.txt",
      cleanedAt: CLEANED_AT,
      receiptPath: "/x/receipts/plan_a.json",
      cleanupPlanId: "plan_a"
    })
  ]);

  const snapshot = buildDashboard({ registryPath });

  assert.equal(snapshot.buckets.trash.length, 1);
  const trashRow = snapshot.buckets.trash[0]!;
  assert.equal(trashRow.recordId, "shf_trashed");
  assert.equal(trashRow.targetPath, "/trash/plan_a/path.txt");
  assert.equal(trashRow.cleanupPlanId, "plan_a");
  assert.equal(trashRow.ledgerName, "primary");

  assert.equal(snapshot.buckets.purgeCandidates.length, 1);
  assert.equal(snapshot.buckets.purgeCandidates[0]!.recordId, "shf_trashed");

  // A trashed record is not also a reviewable artifact.
  assert.equal(snapshot.buckets.cleanup.length, 0);
  assert.equal(snapshot.buckets.resolve.length, 0);
  assert.equal(snapshot.buckets.needsReview.length, 0);
});

test("a missing registered ledger surfaces a registry prune problem and contributes no rows", () => {
  const dir = fixture();
  const registryPath = join(dir, "ledgers.json");
  const missingLedger = join(dir, "gone", "ledger.jsonl");
  writeRegistry(registryPath, [{ name: "stale", path: missingLedger }]);

  const snapshot = buildDashboard({ registryPath });

  assert.equal(snapshot.ledgers.length, 1);
  assert.equal(snapshot.ledgers[0]!.ok, false);
  assert.equal(snapshot.ledgers[0]!.exists, false);

  const registryProblems = snapshot.buckets.registryReconcile.filter((problem) => problem.source === "registry");
  assert.equal(registryProblems.length, 1);
  assert.equal(registryProblems[0]!.category, "prune");
  assert.equal(registryProblems[0]!.ledgerPath, missingLedger);
});

test("a drifted path on a valid ledger surfaces a reconcile problem", () => {
  const dir = fixture();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  // Active record whose recorded path is gone with no provenance to remap: a resolve-missing
  // reconcile finding.
  writeLedgerFile(ledgerPath, [
    baseRecord({ id: "shf_drift", path: "/was/here/output.log", retention: { mode: "manual-review" } })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  const snapshot = buildDashboard({ registryPath });

  const reconcileProblems = snapshot.buckets.registryReconcile.filter((problem) => problem.source === "reconcile");
  assert.equal(reconcileProblems.length, 1);
  assert.equal(reconcileProblems[0]!.recordId, "shf_drift");
  assert.equal(reconcileProblems[0]!.ledgerName, "primary");
});

test("artshelf-owned receipt records land in the recent-receipts lane, not a review lane", () => {
  const dir = fixture();
  const present = realFile(dir, "receipt.json");
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    baseRecord({
      id: "shf_receipt",
      path: present,
      owner: "artshelf",
      labels: ["artshelf", "cleanup-receipt", "plan_a"],
      reason: "Artshelf cleanup receipt for plan plan_a",
      createdAt: "2026-06-22T00:00:00.000Z",
      retention: { mode: "ttl", ttl: "1d" },
      retainUntil: PAST_DUE,
      cleanup: "trash"
    })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  const snapshot = buildDashboard({ registryPath });

  assert.equal(snapshot.buckets.recentReceipts.length, 1);
  const row = snapshot.buckets.recentReceipts[0]!;
  assert.equal(row.recordId, "shf_receipt");
  assert.equal(row.receiptKind, "cleanup");
  // A receipt is not double-counted as a cleanup candidate even though it is due.
  assert.equal(snapshot.buckets.cleanup.length, 0);
});

test("recent receipts are newest-first and capped by the limit", () => {
  const dir = fixture();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  const receipt = (id: string, createdAt: string, kind: string, label: string): Record<string, unknown> =>
    baseRecord({
      id,
      path: realFile(dir, `${id}.json`),
      owner: "artshelf",
      labels: ["artshelf", label, "plan_x"],
      reason: `Artshelf ${kind} receipt`,
      createdAt,
      retention: { mode: "ttl", ttl: "365d" },
      retainUntil: FUTURE_HOLD,
      cleanup: "trash"
    });
  writeLedgerFile(ledgerPath, [
    receipt("shf_old", "2026-06-01T00:00:00.000Z", "cleanup", "cleanup-receipt"),
    receipt("shf_mid", "2026-06-10T00:00:00.000Z", "dispose", "dispose-receipt"),
    receipt("shf_new", "2026-06-20T00:00:00.000Z", "reconcile", "reconcile-receipt")
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  const snapshot = buildDashboard({ registryPath, recentReceiptsLimit: 2 });

  assert.deepEqual(
    snapshot.buckets.recentReceipts.map((row) => row.recordId),
    ["shf_new", "shf_mid"]
  );
  assert.equal(snapshot.buckets.recentReceipts[0]!.receiptKind, "reconcile");
});

test("the needs-context lane is present and unpopulated until the NGX-537 classifier lands", () => {
  const dir = fixture();
  const present = realFile(dir, "vague.txt");
  // Even a record with an empty reason stays a normal reviewable artifact in this slice.
  const { registryPath } = singleLedger([
    baseRecord({ id: "shf_vague", path: present, reason: "", retention: { mode: "ttl", ttl: "1d" }, retainUntil: PAST_DUE, cleanup: "trash" })
  ]);

  const snapshot = buildDashboard({ registryPath });

  assert.ok(Array.isArray(snapshot.buckets.needsContext));
  assert.equal(snapshot.buckets.needsContext.length, 0);
  // The weak-reason record is still classified normally for now.
  assert.equal(snapshot.buckets.cleanup.length, 1);
});

test("buckets aggregate across multiple registered ledgers and a bad ledger is isolated", () => {
  const dir = fixture();
  const presentA = realFile(dir, "a.txt");
  const ledgerA = join(dir, "a", "ledger.jsonl");
  const ledgerBad = join(dir, "b", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerA, [
    baseRecord({ id: "shf_a", path: presentA, retention: { mode: "ttl", ttl: "1d" }, retainUntil: PAST_DUE, cleanup: "trash" })
  ]);
  // Malformed ledger: a record missing required fields fails validation.
  writeLedgerFile(ledgerBad, [{ id: "shf_bad" }]);
  writeRegistry(registryPath, [
    { name: "alpha", path: ledgerA },
    { name: "broken", path: ledgerBad }
  ]);

  const snapshot = buildDashboard({ registryPath });

  assert.equal(snapshot.ledgers.length, 2);
  const broken = snapshot.ledgers.find((ledger) => ledger.name === "broken")!;
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.length > 0);
  // The good ledger still contributes its cleanup row.
  assert.deepEqual(
    snapshot.buckets.cleanup.map((row) => row.recordId),
    ["shf_a"]
  );
});
