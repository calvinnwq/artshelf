import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { revalidateApprovalSnapshot, startOrResumeSession, writeApprovalSnapshot } from "../src/session.js";
import type { UiApprovalSnapshot, UiApprovalTarget } from "../src/types.js";
import { collectApprovalLiveFacts, executeApprovalBundle } from "../src/ui-execute.js";

// NGX-540 live-facts re-read. Approval persisted an immutable snapshot; before executing, the agent
// must re-read the live ledger/record state and revalidate the *selected* per-target context against
// it. collectApprovalLiveFacts is that re-read: it resolves each selected target to its live ledger
// row (matched by record id) and reflects the SPEC drift signals - record gone, status changed,
// remap - so revalidateApprovalSnapshot/executeApprovalBundle can refuse or skip a stale target.

function freshHome(): string {
  return join(mkdtempSync(join(tmpdir(), "artshelf-ui-livefacts-")), "ui");
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

// One ledger directory with the given records already written; returns the ledger path.
function ledgerWith(records: Array<Record<string, unknown>>): string {
  const repo = mkdtempSync(join(tmpdir(), "artshelf-livefacts-repo-"));
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  writeLedgerFile(ledger, records);
  return ledger;
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

function bundle(
  home: string,
  targets: UiApprovalTarget[],
  selectedTargetIds: string[],
  reviewed: Record<string, unknown> = {}
): UiApprovalSnapshot {
  const session = startOrResumeSession({ home, scope: "user" });
  return writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets,
    selectedTargetIds,
    reviewed
  });
}

test("collectApprovalLiveFacts reproduces the exact selection when every selected record is present and active", () => {
  const home = freshHome();
  const ledger = ledgerWith([record("shf_a", "/subjects/a"), record("shf_b", "/subjects/b")]);
  const targets = [target("shf_a", ledger, "/subjects/a"), target("shf_b", ledger, "/subjects/b")];
  const snapshot = bundle(home, targets, ["shf_a", "shf_b"]);

  const live = collectApprovalLiveFacts(snapshot);

  assert.deepEqual(live.targets, targets);
  assert.deepEqual(live.reviewed, {});
  // The re-read reproduces the approved selection, so revalidation is fresh: safe to execute.
  assert.equal(revalidateApprovalSnapshot(snapshot, live).status, "fresh");
});

test("collectApprovalLiveFacts omits a vanished record so revalidation marks the target missing/stale", () => {
  const home = freshHome();
  // shf_b is no longer in the live ledger (resolved out-of-band).
  const ledger = ledgerWith([record("shf_a", "/subjects/a")]);
  const targets = [target("shf_a", ledger, "/subjects/a"), target("shf_b", ledger, "/subjects/b")];
  const snapshot = bundle(home, targets, ["shf_a", "shf_b"]);

  const live = collectApprovalLiveFacts(snapshot);

  assert.deepEqual(live.targets.map((entry) => entry.targetId), ["shf_a"]);
  const verdict = revalidateApprovalSnapshot(snapshot, live);
  assert.equal(verdict.status, "stale");
  assert.deepEqual(verdict.missingTargetIds, ["shf_b"]);
});

test("collectApprovalLiveFacts omits a record whose status already went terminal as no-longer-actionable", () => {
  const home = freshHome();
  // shf_a was approved for trash-resolve but has since been trashed: the approved action is moot.
  const ledger = ledgerWith([record("shf_a", "/subjects/a", { status: "trashed" }), record("shf_b", "/subjects/b")]);
  const targets = [target("shf_a", ledger, "/subjects/a"), target("shf_b", ledger, "/subjects/b")];
  const snapshot = bundle(home, targets, ["shf_a", "shf_b"]);

  const live = collectApprovalLiveFacts(snapshot);

  assert.deepEqual(live.targets.map((entry) => entry.targetId), ["shf_b"]);
  assert.deepEqual(revalidateApprovalSnapshot(snapshot, live).missingTargetIds, ["shf_a"]);
});

test("collectApprovalLiveFacts reflects a remapped record path as a changed target", () => {
  const home = freshHome();
  // shf_a's record now points at a different subject path than the human reviewed.
  const ledger = ledgerWith([record("shf_a", "/subjects/a-moved"), record("shf_b", "/subjects/b")]);
  const targets = [target("shf_a", ledger, "/subjects/a"), target("shf_b", ledger, "/subjects/b")];
  const snapshot = bundle(home, targets, ["shf_a", "shf_b"]);

  const live = collectApprovalLiveFacts(snapshot);

  const liveA = live.targets.find((entry) => entry.targetId === "shf_a");
  assert.equal(liveA?.recordPath, "/subjects/a-moved");
  const verdict = revalidateApprovalSnapshot(snapshot, live);
  assert.equal(verdict.status, "stale");
  assert.deepEqual(verdict.changedTargetIds, ["shf_a"]);
});

test("collectApprovalLiveFacts re-reads only the selected subset and ignores unselected candidate rows", () => {
  const home = freshHome();
  // Only shf_a is approved; shf_b is an unselected candidate whose record is gone - it must not appear.
  const ledger = ledgerWith([record("shf_a", "/subjects/a")]);
  const targets = [target("shf_a", ledger, "/subjects/a"), target("shf_b", ledger, "/subjects/b")];
  const snapshot = bundle(home, targets, ["shf_a"]);

  const live = collectApprovalLiveFacts(snapshot);

  assert.deepEqual(live.targets.map((entry) => entry.targetId), ["shf_a"]);
  assert.equal(revalidateApprovalSnapshot(snapshot, live).status, "fresh");
});

test("collectApprovalLiveFacts treats a missing ledger file as the subject being gone", () => {
  const home = freshHome();
  const targets = [target("shf_a", "/no/such/.artshelf/ledger.jsonl", "/subjects/a")];
  const snapshot = bundle(home, targets, ["shf_a"]);

  const live = collectApprovalLiveFacts(snapshot);

  assert.deepEqual(live.targets, []);
  assert.deepEqual(revalidateApprovalSnapshot(snapshot, live).missingTargetIds, ["shf_a"]);
});

test("collectApprovalLiveFacts re-confirms no opaque reviewed facts, so a reviewed-bearing bundle is conservatively refused", () => {
  const home = freshHome();
  const ledger = ledgerWith([record("shf_a", "/subjects/a")]);
  const targets = [target("shf_a", ledger, "/subjects/a")];
  // The bundle captured a shared reviewed basis the executor cannot yet independently re-derive.
  const snapshot = bundle(home, targets, ["shf_a"], { planTotal: 3 });

  const live = collectApprovalLiveFacts(snapshot);

  assert.deepEqual(live.reviewed, {});
  const verdict = revalidateApprovalSnapshot(snapshot, live);
  assert.equal(verdict.status, "stale");
  assert.deepEqual(verdict.reviewedKeysDrifted, ["planTotal"]);
});

test("collectApprovalLiveFacts feeds executeApprovalBundle so a present target executes while a vanished one is skipped_stale", () => {
  const home = freshHome();
  const ledger = ledgerWith([record("shf_a", "/subjects/a")]);
  const targets = [target("shf_a", ledger, "/subjects/a"), target("shf_b", ledger, "/subjects/b")];
  const snapshot = bundle(home, targets, ["shf_a", "shf_b"]);

  const executed: string[] = [];
  const result = executeApprovalBundle(snapshot, collectApprovalLiveFacts(snapshot), (entry) => {
    executed.push(entry.targetId);
    return { outcome: "executed", detail: `disposed ${entry.targetId}` };
  });

  assert.deepEqual(executed, ["shf_a"]);
  assert.equal(result.status, "partial");
  assert.equal(result.receipts.find((entry) => entry.targetId === "shf_a")!.outcome, "executed");
  assert.equal(result.receipts.find((entry) => entry.targetId === "shf_b")!.outcome, "skipped_stale");
});
