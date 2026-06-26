import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildArtifactDetail } from "../src/artifact-detail.js";

// Artifact detail drawer domain core (NGX-536). The drawer is the single-record deep view a
// dashboard row opens into: it composes the read-only inspect decision card with provenance, the
// audit trail, and the last action into the contract's Minimum Human-Judgment Fields. Fixtures
// author registry + ledger files directly so a record can carry provenance/audit/weak metadata
// without the existence checks the `put` path enforces. ARTSHELF_NOW is pinned at module scope
// (this file runs in its own runner process) so ages and due classification stay deterministic,
// and ARTSHELF_REGISTRY is cleared so every case targets its own fixture registry. The drawer is
// recomputed from live state and never reads or previews file contents.

const NOW = "2026-06-25T12:00:00.000Z";
const PAST_DUE = "2026-06-20T00:00:00.000Z";
const CREATED = "2026-06-01T00:00:00.000Z";

process.env.ARTSHELF_NOW = NOW;
delete process.env.ARTSHELF_REGISTRY;

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "artshelf-detail-"));
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
    createdAt: CREATED,
    retention: { mode: "manual-review" },
    cleanup: "review",
    owner: "manual",
    labels: [],
    status: "active",
    ...over
  };
}

function realFile(dir: string, name: string): string {
  const target = join(dir, name);
  writeFileSync(target, "x");
  return target;
}

// A single-ledger registry rooted in a fresh temp dir holding exactly the given records.
function singleLedger(records: Array<Record<string, unknown>>): { registryPath: string; ledgerPath: string; dir: string } {
  const dir = fixture();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, records);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);
  return { registryPath, ledgerPath, dir };
}

test("builds a detail drawer with the minimum human-judgment fields for a due cleanup artifact", () => {
  const dir = fixture();
  const present = realFile(dir, "scratch.txt");
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    baseRecord({ id: "shf_cleanup", path: present, retention: { mode: "ttl", ttl: "1d" }, retainUntil: PAST_DUE, cleanup: "trash" })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  const detail = buildArtifactDetail({ ledgerPath, recordId: "shf_cleanup", registryPath });

  assert.equal(detail.schemaVersion, 1);
  assert.equal(detail.recordId, "shf_cleanup"); // record id
  assert.equal(detail.ledgerName, "primary"); // ledger/source
  assert.equal(detail.ledgerPath, ledgerPath);
  assert.equal(detail.inspect.status, "active"); // current status
  assert.equal(detail.inspect.reason, "fixture artifact"); // original reason/purpose
  assert.equal(detail.createdAt, CREATED);
  assert.ok(detail.inspect.age.length > 0); // created age
  assert.ok(detail.dueReason && /due/i.test(detail.dueReason)); // review due reason
  assert.equal(detail.inspect.cleanup, "trash"); // cleanup policy
  assert.equal(detail.inspect.retention.mode, "ttl"); // retention intent
  assert.equal(detail.inspect.existence, "present"); // existence facts
  assert.equal(detail.inspect.recommendation, "trash-safe"); // inspect-card recommendation
  assert.equal(detail.needsContext, null);
  assert.equal(detail.provenance.present, false);
  assert.equal(detail.lastAction, null); // never acted on
});

test("embeds the get --inspect style decision card with a next action", () => {
  const dir = fixture();
  const present = realFile(dir, "card.txt");
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    baseRecord({ id: "shf_card", path: present, retention: { mode: "ttl", ttl: "1d" }, retainUntil: PAST_DUE, cleanup: "trash" })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  const detail = buildArtifactDetail({ ledgerPath, recordId: "shf_card", registryPath });

  // The drawer carries the same deterministic decision card `get <id> --inspect --json` prints.
  assert.equal(detail.inspect.schemaVersion, 1);
  assert.equal(detail.inspect.id, "shf_card");
  assert.equal(detail.inspect.recommendation, "trash-safe");
  assert.match(detail.inspect.nextAction, /artshelf dispose/);
  // Existence facts come from the inspect card's stat, never a file-content read.
  assert.equal(detail.inspect.nodeKind, "file");
  assert.equal(detail.inspect.byteSize, 1);
});

test("surfaces a structured provenance view when the record carries provenance", () => {
  const { registryPath, ledgerPath } = singleLedger([
    baseRecord({
      id: "shf_prov",
      path: "/repo/out/keep.txt",
      reason: "release notes draft awaiting sign-off",
      provenance: { root: "repo", rootPath: "/repo", relativePath: "out/keep.txt", basename: "keep.txt", pathKind: "file", fingerprint: { byteSize: 12 } }
    })
  ]);

  const detail = buildArtifactDetail({ ledgerPath, recordId: "shf_prov", registryPath });

  assert.equal(detail.provenance.present, true);
  assert.equal(detail.provenance.provenance?.root, "repo");
  assert.equal(detail.provenance.provenance?.relativePath, "out/keep.txt");
  assert.equal(detail.provenance.provenance?.fingerprint?.byteSize, 12);
});

test("routes a weak original reason into the needs-context badge (NGX-537)", () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({ id: "shf_weak", reason: "   " })]);

  const detail = buildArtifactDetail({ ledgerPath, recordId: "shf_weak", registryPath });

  assert.equal(detail.needsContext?.reason, "missing-reason");
  assert.match(detail.needsContext?.label ?? "", /reason/i);
});

test("reconstructs the audit trail oldest-first and reports the last action with its receipt", () => {
  // A record reconciled, then trashed by a cleanup plan: creation plus two audited dispositions.
  const { registryPath, ledgerPath } = singleLedger([
    baseRecord({
      id: "shf_audited",
      status: "trashed",
      path: "/orig/output.log",
      targetPath: "/trash/plan_a/output.log",
      createdAt: CREATED,
      reconciledAt: "2026-06-05T00:00:00.000Z",
      reconcilePlanId: "rec_plan",
      reconcileReceiptPath: "/x/reconcile-receipt.json",
      reconcileReason: "remapped after move",
      previousPath: "/was/here/output.log",
      cleanedAt: "2026-06-10T00:00:00.000Z",
      receiptPath: "/x/cleanup-receipt.json",
      cleanupReason: "trashed by reviewed plan",
      cleanupPlanId: "plan_a"
    })
  ]);

  const detail = buildArtifactDetail({ ledgerPath, recordId: "shf_audited", registryPath });

  assert.deepEqual(
    detail.audit.map((event) => event.kind),
    ["created", "reconcile", "cleanup"]
  );
  // Strictly chronological, oldest-first timeline.
  for (let i = 1; i < detail.audit.length; i += 1) {
    assert.ok(new Date(detail.audit[i]!.at).getTime() >= new Date(detail.audit[i - 1]!.at).getTime());
  }
  // The last action is the most recent audited disposition, carrying its receipt and reason.
  assert.equal(detail.lastAction?.kind, "cleanup");
  assert.equal(detail.lastAction?.receiptPath, "/x/cleanup-receipt.json");
  assert.equal(detail.lastAction?.reason, "trashed by reviewed plan");
});

test("a missing artifact path yields a resolve-only card with a missing-path due reason", () => {
  const { registryPath, ledgerPath } = singleLedger([
    baseRecord({ id: "shf_gone", path: "/missing/artifact.bin", retention: { mode: "ttl", ttl: "1d" }, retainUntil: PAST_DUE, cleanup: "trash" })
  ]);

  const detail = buildArtifactDetail({ ledgerPath, recordId: "shf_gone", registryPath });

  assert.equal(detail.inspect.existence, "missing");
  assert.equal(detail.inspect.dueState, "missing-path");
  assert.equal(detail.inspect.recommendation, "resolve-only");
  assert.ok(detail.dueReason && /missing/i.test(detail.dueReason));
});

test("throws for an unknown record id", () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({ id: "shf_known" })]);

  assert.throws(() => buildArtifactDetail({ ledgerPath, recordId: "shf_missing", registryPath }), /not found/i);
});

test("ledgerName is null when the ledger is not registered", () => {
  const dir = fixture();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [baseRecord({ id: "shf_unreg" })]);
  writeRegistry(registryPath, []); // empty registry: the ledger is readable but unregistered

  const detail = buildArtifactDetail({ ledgerPath, recordId: "shf_unreg", registryPath });

  assert.equal(detail.ledgerName, null);
});
