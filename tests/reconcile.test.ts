import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyReconcileFindings } from "../src/reconcile.js";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "artshelf-reconcile-"));
}

// Author a ledger file directly so fixtures can carry stale absolute paths and
// arbitrary provenance without the existence checks prepareRecord enforces.
function writeLedgerFile(ledgerPath: string, records: Array<Record<string, unknown>>): void {
  mkdirSync(join(ledgerPath, ".."), { recursive: true });
  writeFileSync(ledgerPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function baseRecord(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "shf_test_1",
    path: "/does/not/matter",
    kind: "scratch",
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

test("repo-root rename produces a remap finding pointing at the reconstructed path", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  mkdirSync(join(repo, "build"), { recursive: true });
  const current = join(repo, "build", "out.txt");
  writeFileSync(current, "hello");

  writeLedgerFile(ledger, [
    baseRecord({
      id: "shf_remap",
      path: "/old-shelf/build/out.txt",
      provenance: {
        root: "repo",
        rootPath: "/old-shelf",
        relativePath: "build/out.txt",
        basename: "out.txt",
        pathKind: "file",
        fingerprint: { byteSize: 5 }
      }
    })
  ]);

  const findings = classifyReconcileFindings(ledger);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.id, "shf_remap");
  assert.equal(findings[0]?.category, "remap");
  assert.equal(findings[0]?.field, "path");
  assert.equal(findings[0]?.currentPath, "/old-shelf/build/out.txt");
  assert.equal(findings[0]?.proposedPath, current);
});

test(".shelf -> .artshelf ledger-local move produces a remap finding", () => {
  const repo = fixture();
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  mkdirSync(join(repo, ".artshelf", "plans"), { recursive: true });
  const current = join(repo, ".artshelf", "plans", "plan_x.json");
  writeFileSync(current, "{}");

  writeLedgerFile(ledger, [
    baseRecord({
      id: "shf_ledger_remap",
      owner: "artshelf",
      path: join(repo, ".shelf", "plans", "plan_x.json"),
      provenance: {
        root: "ledger",
        rootPath: join(repo, ".shelf"),
        relativePath: "plans/plan_x.json",
        basename: "plan_x.json",
        pathKind: "file",
        fingerprint: { byteSize: 2 }
      }
    })
  ]);

  const findings = classifyReconcileFindings(ledger);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.category, "remap");
  assert.equal(findings[0]?.field, "path");
  assert.equal(findings[0]?.proposedPath, current);
});

test("active record whose path is gone with no remap target is resolve-missing", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");

  writeLedgerFile(ledger, [
    baseRecord({
      id: "shf_gone",
      path: join(repo, "deleted.txt"),
      provenance: {
        root: "repo",
        rootPath: repo,
        relativePath: "deleted.txt",
        basename: "deleted.txt",
        pathKind: "file",
        fingerprint: { byteSize: 9 }
      }
    })
  ]);

  const findings = classifyReconcileFindings(ledger);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.category, "resolve-missing");
  assert.equal(findings[0]?.field, "path");
  assert.equal(findings[0]?.proposedPath, null);
});

test("active record with external provenance and a missing path is resolve-missing", () => {
  const repo = fixture();
  const ledger = join(repo, ".artshelf", "ledger.jsonl");

  writeLedgerFile(ledger, [
    baseRecord({
      id: "shf_external",
      path: "/tmp/some-external/file.txt",
      provenance: {
        root: "external",
        rootPath: null,
        relativePath: null,
        basename: "file.txt",
        pathKind: "file"
      }
    })
  ]);

  const findings = classifyReconcileFindings(ledger);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.category, "resolve-missing");
  assert.equal(findings[0]?.proposedPath, null);
});

test("legacy record without provenance and a missing path is resolve-missing", () => {
  const repo = fixture();
  const ledger = join(repo, ".artshelf", "ledger.jsonl");

  writeLedgerFile(ledger, [
    baseRecord({ id: "shf_legacy", path: join(repo, "legacy-gone.txt") })
  ]);

  const findings = classifyReconcileFindings(ledger);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.category, "resolve-missing");
  assert.equal(findings[0]?.proposedPath, null);
});

test("trashed record with a missing trash target is resolve-stale-trash", () => {
  const repo = fixture();
  const ledger = join(repo, ".artshelf", "ledger.jsonl");

  writeLedgerFile(ledger, [
    baseRecord({
      id: "shf_stale",
      status: "trashed",
      path: join(repo, "original.txt"),
      targetPath: join(repo, ".artshelf", "trash", "plan_1", "shf_stale-original.txt"),
      cleanupPlanId: "plan_1",
      receiptPath: join(repo, ".artshelf", "receipts", "plan_1.json"),
      cleanedAt: "2026-02-01T00:00:00.000Z",
      provenance: {
        root: "repo",
        rootPath: repo,
        relativePath: "original.txt",
        basename: "original.txt",
        pathKind: "file"
      }
    })
  ]);

  const findings = classifyReconcileFindings(ledger);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.category, "resolve-stale-trash");
  assert.equal(findings[0]?.field, "targetPath");
  assert.equal(findings[0]?.proposedPath, null);
});

test("a reconstructed candidate whose fingerprint mismatches is blocked, not remapped", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  mkdirSync(join(repo, "build"), { recursive: true });
  // A different file now sits at the reconstructed location (3 bytes vs recorded 5).
  writeFileSync(join(repo, "build", "out.txt"), "abc");

  writeLedgerFile(ledger, [
    baseRecord({
      id: "shf_blocked",
      path: "/old-shelf/build/out.txt",
      provenance: {
        root: "repo",
        rootPath: "/old-shelf",
        relativePath: "build/out.txt",
        basename: "out.txt",
        pathKind: "file",
        fingerprint: { byteSize: 5 }
      }
    })
  ]);

  const findings = classifyReconcileFindings(ledger);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.category, "blocked");
  assert.equal(findings[0]?.proposedPath, null);
});

test("healthy active and trashed records produce no findings", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const active = join(repo, "present.txt");
  writeFileSync(active, "ok");
  mkdirSync(join(repo, ".artshelf", "trash", "plan_1"), { recursive: true });
  const target = join(repo, ".artshelf", "trash", "plan_1", "shf_ok-present.txt");
  writeFileSync(target, "ok");

  writeLedgerFile(ledger, [
    baseRecord({
      id: "shf_active_ok",
      path: active,
      provenance: { root: "repo", rootPath: repo, relativePath: "present.txt", basename: "present.txt", pathKind: "file", fingerprint: { byteSize: 2 } }
    }),
    baseRecord({
      id: "shf_trash_ok",
      status: "trashed",
      path: join(repo, "gone-from-here.txt"),
      targetPath: target,
      cleanupPlanId: "plan_1",
      receiptPath: join(repo, ".artshelf", "receipts", "plan_1.json"),
      cleanedAt: "2026-02-01T00:00:00.000Z"
    })
  ]);

  const findings = classifyReconcileFindings(ledger);

  assert.deepEqual(findings, []);
});

test("findings preserve ledger record order for deterministic output", () => {
  const repo = fixture();
  const ledger = join(repo, ".artshelf", "ledger.jsonl");

  writeLedgerFile(ledger, [
    baseRecord({ id: "shf_a", path: join(repo, "a-gone.txt") }),
    baseRecord({ id: "shf_b", path: join(repo, "b-gone.txt") })
  ]);

  const findings = classifyReconcileFindings(ledger);

  assert.deepEqual(findings.map((finding) => finding.id), ["shf_a", "shf_b"]);
});
