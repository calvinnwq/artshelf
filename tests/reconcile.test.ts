import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readLedger } from "../src/ledger.js";
import { classifyReconcileFindings, createReconcilePlan, previewReconcilePlan } from "../src/reconcile.js";

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

// Set up a repo whose recorded artifact moved with a repo-root rename: the old
// absolute path is gone but the artifact (same name + byte size) exists under the
// current repo root, so it classifies as a safe `remap`.
function remapFixture(): { repo: string; ledger: string; current: string } {
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
  return { repo, ledger, current };
}

test("createReconcilePlan writes a reviewed plan for actionable findings", () => {
  const { repo, ledger, current } = remapFixture();

  const plan = createReconcilePlan(ledger);

  assert.ok(plan.planId.startsWith("reconcile_"), `unexpected plan id ${plan.planId}`);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0]?.id, "shf_remap");
  assert.equal(plan.entries[0]?.category, "remap");
  assert.equal(plan.entries[0]?.proposedPath, current);
  assert.deepEqual(plan.blocked, []);
  assert.ok(plan.planPath, "plan path should be set");
  assert.equal(dirname(plan.planPath as string), join(repo, ".artshelf", "reconcile-plans"));
  assert.equal(existsSync(plan.planPath as string), true);
  // The persisted plan round-trips exactly, so agents can replay the decision packet.
  const onDisk = JSON.parse(readFileSync(plan.planPath as string, "utf8"));
  assert.deepEqual(onDisk, plan);
});

test("createReconcilePlan registers the plan file as an artshelf-owned artifact", () => {
  const { ledger } = remapFixture();

  const plan = createReconcilePlan(ledger);

  const artifact = readLedger(ledger).find((record) => record.path === plan.planPath);
  assert.ok(artifact, "the reconcile plan file should be tracked in the ledger");
  assert.equal(artifact?.owner, "artshelf");
  assert.equal(artifact?.labels.includes("reconcile-plan"), true);
  assert.equal(artifact?.labels.includes(plan.planId), true);
});

test("createReconcilePlan reuses an existing plan with matching findings", () => {
  const { repo, ledger } = remapFixture();

  const first = createReconcilePlan(ledger);
  const second = createReconcilePlan(ledger);

  assert.equal(second.planId, first.planId);
  assert.equal(second.planPath, first.planPath);
  assert.deepEqual(readdirSync(join(repo, ".artshelf", "reconcile-plans")), [`${first.planId}.json`]);
  const artifacts = readLedger(ledger).filter((record) => record.labels.includes("reconcile-plan"));
  assert.equal(artifacts.length, 1);
});

test("createReconcilePlan does not create a plan when only blocked findings exist", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  mkdirSync(join(repo, "build"), { recursive: true });
  // 3 bytes here vs the recorded 5 -> reconstructed candidate is blocked, not remapped.
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

  const plan = createReconcilePlan(ledger);

  assert.equal(plan.planId, "not-created");
  assert.equal(plan.planPath, null);
  assert.deepEqual(plan.entries, []);
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0]?.id, "shf_blocked");
  // Read-only: no plan artifact is written when nothing is executable.
  assert.equal(existsSync(join(repo, ".artshelf", "reconcile-plans")), false);
});

test("previewReconcilePlan classifies without writing a plan or mutating the ledger", () => {
  const { repo, ledger } = remapFixture();
  const before = readFileSync(ledger, "utf8");

  const plan = previewReconcilePlan(ledger);

  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0]?.category, "remap");
  assert.ok(plan.planPath, "preview still computes a plan path");
  assert.equal(existsSync(plan.planPath as string), false);
  assert.equal(existsSync(join(repo, ".artshelf", "reconcile-plans")), false);
  assert.equal(readFileSync(ledger, "utf8"), before);
});

test("createReconcilePlan separates blocked findings from actionable entries", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  mkdirSync(join(repo, "build"), { recursive: true });
  writeFileSync(join(repo, "build", "good.txt"), "hello"); // 5 bytes -> remap
  writeFileSync(join(repo, "build", "bad.txt"), "abc"); // 3 bytes vs recorded 5 -> blocked

  writeLedgerFile(ledger, [
    baseRecord({
      id: "shf_good",
      path: "/old/build/good.txt",
      provenance: { root: "repo", rootPath: "/old", relativePath: "build/good.txt", basename: "good.txt", pathKind: "file", fingerprint: { byteSize: 5 } }
    }),
    baseRecord({
      id: "shf_bad",
      path: "/old/build/bad.txt",
      provenance: { root: "repo", rootPath: "/old", relativePath: "build/bad.txt", basename: "bad.txt", pathKind: "file", fingerprint: { byteSize: 5 } }
    })
  ]);

  const plan = createReconcilePlan(ledger);

  assert.deepEqual(plan.entries.map((entry) => entry.id), ["shf_good"]);
  assert.deepEqual(plan.blocked.map((entry) => entry.id), ["shf_bad"]);
});
