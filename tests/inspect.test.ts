import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildInspectReport } from "../src/inspect.js";
import { buildInspectAgentPacket, printInspect } from "../src/renderers/inspect.js";
import type { ArtshelfRecord } from "../src/types.js";

const NOW = new Date("2026-06-19T00:00:00Z");
const LEDGER = "/repo/.artshelf/ledger.jsonl";

type InspectObject = ReturnType<typeof inspect> & Record<string, unknown>;

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "artshelf-inspect-"));
}

function baseRecord(overrides: Partial<ArtshelfRecord> = {}): ArtshelfRecord {
  return {
    id: "shf_20260601_000000_b77f",
    path: "/tmp/placeholder-does-not-exist",
    kind: "backup",
    reason: "dogfooding rollback backup",
    createdAt: "2026-06-01T00:00:00Z",
    retention: { mode: "manual-review" },
    cleanup: "review",
    owner: "manual",
    labels: ["dogfood"],
    status: "active",
    ...overrides
  };
}

function inspect(record: ArtshelfRecord) {
  return buildInspectReport(record, { now: NOW, ledgerPath: LEDGER });
}

function assertNoContentPreview(report: InspectObject): void {
  assert.equal("contentHint" in report, false);
  assert.equal("preview" in report, false);
}

test("inspect surfaces the core record identity fields", () => {
  const report = inspect(baseRecord());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.id, "shf_20260601_000000_b77f");
  assert.equal(report.kind, "backup");
  assert.equal(report.owner, "manual");
  assert.deepEqual(report.labels, ["dogfood"]);
  assert.equal(report.status, "active");
  assert.equal(report.cleanup, "review");
  assert.equal(report.reason, "dogfooding rollback backup");
  assert.equal(report.age, "18d");
  assertNoContentPreview(report);
});

test("inspect does not read or preview regular file contents", () => {
  const dir = fixtureDir();
  const path = join(dir, "notes.txt");
  writeFileSync(path, "short secret that must stay in the file only");
  const report = inspect(baseRecord({ path, kind: "evidence" }));

  assert.equal(report.existence, "present");
  assert.equal(report.nodeKind, "file");
  assert.equal(report.byteSize, 44);
  assertNoContentPreview(report);
});

test("inspect still reports file metadata for sensitive paths without content hints", () => {
  const dir = fixtureDir();
  const path = join(dir, ".env");
  writeFileSync(path, "API_KEY=short-secret");
  const report = inspect(baseRecord({ path, kind: "evidence" }));

  assert.equal(report.existence, "present");
  assert.equal(report.nodeKind, "file");
  assert.equal(report.byteSize, 20);
  assertNoContentPreview(report);
});

test("a missing path is classified as resolve-only with no mutation wording", () => {
  const dir = fixtureDir();
  const record = baseRecord({ path: join(dir, "gone"), retention: { mode: "manual-review" } });
  const report = inspect(record);

  assert.equal(report.existence, "missing");
  assert.equal(report.nodeKind, null);
  assert.equal(report.byteSize, null);
  assert.equal(report.dueState, "missing-path");
  assert.equal(report.recommendation, "resolve-only");
  assert.match(report.nextAction, /artshelf dispose --id shf_20260601_000000_b77f --action resolve-only --dry-run --reason '<why>' --ledger \/repo\/\.artshelf\/ledger\.jsonl/);
  assertNoContentPreview(report);
});

test("an active dangling symlink mirrors cleanup missing-path classification", () => {
  const dir = fixtureDir();
  const path = join(dir, "dangling-link");
  symlinkSync(join(dir, "missing-target"), path);
  const record = baseRecord({
    path,
    cleanup: "trash",
    retention: { mode: "retain-until", retainUntil: "2026-06-01T00:00:00Z" },
    retainUntil: "2026-06-01T00:00:00Z"
  });
  const report = inspect(record);

  assert.equal(report.existence, "missing");
  assert.equal(report.nodeKind, null);
  assert.equal(report.byteSize, null);
  assert.equal(report.dueState, "missing-path");
  assert.equal(report.recommendation, "resolve-only");
  assert.match(report.nextAction, /artshelf dispose --id shf_20260601_000000_b77f --action resolve-only --dry-run --reason '<why>' --ledger \/repo\/\.artshelf\/ledger\.jsonl/);
  assertNoContentPreview(report);
});

test("an active manual-review record with a present path recommends keep", () => {
  const dir = fixtureDir();
  const path = join(dir, "notes.txt");
  writeFileSync(path, "decide later");
  const record = baseRecord({ path, cleanup: "review", retention: { mode: "manual-review" } });
  const report = inspect(record);

  assert.equal(report.existence, "present");
  assert.equal(report.nodeKind, "file");
  assert.equal(report.byteSize, 12);
  assert.equal(report.dueState, "manual-review");
  assert.equal(report.recommendation, "keep");
});

test("a not-yet-due retain-until record recommends snooze until expiry", () => {
  const dir = fixtureDir();
  const path = join(dir, "hold.txt");
  writeFileSync(path, "hold");
  const record = baseRecord({
    path,
    cleanup: "review",
    retention: { mode: "retain-until", retainUntil: "2026-12-01T00:00:00Z" },
    retainUntil: "2026-12-01T00:00:00Z"
  });
  const report = inspect(record);

  assert.equal(report.dueState, "kept");
  assert.equal(report.recommendation, "snooze");
  assert.match(report.nextAction, /2026-12-01/);
});

test("a due disposable artifact is trash-safe and points at the dry-run plan flow", () => {
  const dir = fixtureDir();
  const path = join(dir, "artifact.bin");
  writeFileSync(path, "x".repeat(10));
  const record = baseRecord({
    path,
    cleanup: "trash",
    retention: { mode: "retain-until", retainUntil: "2026-06-01T00:00:00Z" },
    retainUntil: "2026-06-01T00:00:00Z"
  });
  const report = inspect(record);

  assert.equal(report.dueState, "due");
  assert.equal(report.recommendation, "trash-safe");
  assert.match(report.nextAction, /artshelf dispose --id shf_20260601_000000_b77f --action trash-resolve --dry-run --reason '<why>' --ledger \/repo\/\.artshelf\/ledger\.jsonl/);
});

test("a due cleanup=review record stays a keep decision card", () => {
  const dir = fixtureDir();
  const path = join(dir, "review-me.txt");
  writeFileSync(path, "needs a human");
  const record = baseRecord({
    path,
    cleanup: "review",
    retention: { mode: "retain-until", retainUntil: "2026-06-01T00:00:00Z" },
    retainUntil: "2026-06-01T00:00:00Z"
  });
  const report = inspect(record);

  assert.equal(report.dueState, "due");
  assert.equal(report.recommendation, "keep");
});

test("a due cleanup=delete record is blocked because delete is refused", () => {
  const dir = fixtureDir();
  const path = join(dir, "danger.txt");
  writeFileSync(path, "nope");
  const record = baseRecord({
    path,
    cleanup: "delete",
    retention: { mode: "retain-until", retainUntil: "2026-06-01T00:00:00Z" },
    retainUntil: "2026-06-01T00:00:00Z"
  });
  const report = inspect(record);

  assert.equal(report.recommendation, "blocked");
  assert.match(report.nextAction, /delete/i);
});

test("an already-resolved record needs no action", () => {
  const report = inspect(baseRecord({ status: "resolved", resolvedAt: "2026-06-10T00:00:00Z", resolutionReason: "done" }));
  assert.equal(report.dueState, null);
  assert.equal(report.recommendation, "keep");
  assert.match(report.nextAction, /resolved/i);
});

test("a trashed record inspects its trash target and needs no action", () => {
  const dir = fixtureDir();
  const target = join(dir, "trash", "shf-artifact");
  mkdirSync(join(dir, "trash"), { recursive: true });
  writeFileSync(target, "trashed bytes");
  const record = baseRecord({
    status: "trashed",
    path: "/tmp/original-now-gone",
    targetPath: target,
    cleanedAt: "2026-06-05T00:00:00Z",
    receiptPath: "/repo/.artshelf/receipts/plan.json",
    cleanupPlanId: "plan_x"
  });
  const report = inspect(record);

  assert.equal(report.subjectPath, target);
  assert.equal(report.existence, "present");
  assert.equal(report.byteSize, 13);
  assert.equal(report.recommendation, "keep");
  assert.match(report.nextAction, /trash/i);
  assertNoContentPreview(report);
});

test("a trashed record with a dangling symlink trash target remains present", () => {
  const dir = fixtureDir();
  const trashDir = join(dir, "trash");
  const target = join(trashDir, "shf-link");
  mkdirSync(trashDir, { recursive: true });
  symlinkSync(join(dir, "missing-target"), target);
  const record = baseRecord({
    status: "trashed",
    path: "/tmp/original-now-gone",
    targetPath: target,
    cleanedAt: "2026-06-05T00:00:00Z",
    receiptPath: "/repo/.artshelf/receipts/plan.json",
    cleanupPlanId: "plan_x"
  });
  const report = inspect(record);

  assert.equal(report.subjectPath, target);
  assert.equal(report.existence, "present");
  assert.equal(report.nodeKind, "other");
  assert.equal(report.byteSize, null);
  assert.equal(report.recommendation, "keep");
  assert.match(report.nextAction, /trash purge/);
  assertNoContentPreview(report);
});

test("a trashed record with a missing trash target routes to ledger-only resolve guidance", () => {
  const dir = fixtureDir();
  const target = join(dir, "trash", "missing-artifact");
  const record = baseRecord({
    status: "trashed",
    path: "/tmp/original-now-gone",
    targetPath: target,
    cleanedAt: "2026-06-05T00:00:00Z",
    receiptPath: "/repo/.artshelf/receipts/plan.json",
    cleanupPlanId: "plan_x"
  });
  const report = inspect(record);

  assert.equal(report.subjectPath, target);
  assert.equal(report.existence, "missing");
  assert.equal(report.recommendation, "resolve-only");
  assert.match(report.nextAction, /artshelf resolve shf_20260601_000000_b77f --ledger \/repo\/\.artshelf\/ledger\.jsonl --status resolved/);
  assert.doesNotMatch(report.nextAction, /trash purge/);
});

test("a cleanup-refused record is blocked for manual handling", () => {
  const report = inspect(baseRecord({ status: "cleanup-refused", cleanupReason: "delete disabled" }));
  assert.equal(report.recommendation, "blocked");
});

test("a directory reports its recursive size without content hints", () => {
  const dir = fixtureDir();
  const root = join(dir, "backup");
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "a.txt"), "12345");
  writeFileSync(join(root, "nested", "b.txt"), "678");
  const report = inspect(baseRecord({ path: root, kind: "backup" }));

  assert.equal(report.nodeKind, "directory");
  assert.equal(report.byteSize, 8);
  assertNoContentPreview(report);
});

test("a directory reports when its recursive size hits the entry cap", () => {
  const dir = fixtureDir();
  const root = join(dir, "backup");
  mkdirSync(root, { recursive: true });
  for (let index = 0; index < 10_001; index += 1) {
    writeFileSync(join(root, `file-${index}.txt`), "x");
  }
  const report = inspect(baseRecord({ path: root, kind: "backup" }));

  assert.equal(report.nodeKind, "directory");
  assert.equal(report.byteSizeTruncated, true);
  assert.equal(typeof report.byteSize, "number");
});

test("a directory reports when recursive size scanning is incomplete", () => {
  const dir = fixtureDir();
  const root = join(dir, "backup");
  const blocked = join(root, "blocked");
  mkdirSync(blocked, { recursive: true });
  writeFileSync(join(root, "visible.txt"), "12345");
  writeFileSync(join(blocked, "hidden.txt"), "678");
  chmodSync(blocked, 0);
  try {
    const report = inspect(baseRecord({ path: root, kind: "backup" }));

    assert.equal(report.nodeKind, "directory");
    assert.equal(report.byteSizeTruncated, true);
    assert.equal(report.byteSize, 5);
  } finally {
    chmodSync(blocked, 0o700);
  }
});

test("resolve-only next action carries the inspected ledger path", () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "custom-ledger.jsonl");
  const record = baseRecord({ path: join(dir, "gone"), retention: { mode: "manual-review" } });
  const report = buildInspectReport(record, { now: NOW, ledgerPath });

  assert.equal(report.recommendation, "resolve-only");
  assert.match(report.nextAction, new RegExp(`dispose --id shf_20260601_000000_b77f --action resolve-only --dry-run --reason '<why>' --ledger ${ledgerPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("copyable inspect commands shell-quote unsafe ledger paths", () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger path's;$(echo nope).jsonl");
  const record = baseRecord({ path: join(dir, "gone"), retention: { mode: "manual-review" } });
  const report = buildInspectReport(record, { now: NOW, ledgerPath });
  const packet = buildInspectAgentPacket(report, ledgerPath);
  const quotedLedger = `'${ledgerPath.replace(/'/g, "'\\''")}'`;

  assert.match(report.nextAction, new RegExp(`dispose --id shf_20260601_000000_b77f --action resolve-only --dry-run --reason '<why>' --ledger ${quotedLedger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(packet.verification, `artshelf get shf_20260601_000000_b77f --inspect --agent --ledger ${quotedLedger}`);

  const artifactPath = join(dir, "artifact.txt");
  writeFileSync(artifactPath, "x");
  const updatedTrashReport = buildInspectReport(
    baseRecord({
      path: artifactPath,
      cleanup: "trash",
      retention: { mode: "retain-until", retainUntil: "2026-06-01T00:00:00Z" },
      retainUntil: "2026-06-01T00:00:00Z"
    }),
    { now: NOW, ledgerPath }
  );
  assert.match(updatedTrashReport.nextAction, new RegExp(`dispose --id shf_20260601_000000_b77f --action trash-resolve --dry-run --reason '<why>' --ledger ${quotedLedger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("agent packet has no preview safety flag because inspect emits no previews", () => {
  const report = inspect(baseRecord());
  const packet = buildInspectAgentPacket(report, LEDGER) as ReturnType<typeof buildInspectAgentPacket> & { safety: Record<string, unknown> };

  assert.equal(packet.safety.readOnly, true);
  assert.equal(packet.safety.noFileMoves, true);
  assert.equal(packet.safety.noLedgerMutation, true);
  assert.equal("previewRedacted" in packet.safety, false);
});

test("human inspect output escapes ledger-controlled metadata to one line and omits previews", () => {
  const dir = fixtureDir();
  const path = join(dir, "notes.txt");
  writeFileSync(path, "safe notes");
  const report = inspect(
    baseRecord({
      id: "shf_20260601_000000_b77f\nnext: fake",
      path,
      reason: "real reason\nnext: fake approval",
      owner: "owner\u001b[31m",
      labels: ["safe", "label\u202esecret"]
    })
  );
  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    printInspect(report, "/repo/ledger\nnext: fake");
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.doesNotMatch(stdout, /^next: fake/m);
  assert.match(stdout, /shf_20260601_000000_b77f\\nnext: fake/);
  assert.match(stdout, /reason: real reason\\nnext: fake approval/);
  assert.match(stdout, /owner: owner\\u001b/);
  assert.match(stdout, /label\\u202esecret/);
  assert.match(stdout, /ledger: \/repo\/ledger\\nnext: fake/);
  assert.doesNotMatch(stdout, /preview:/i);
  assert.doesNotMatch(stdout, /safe notes/);
});

test("directory size uses a streaming entry iterator", () => {
  const source = readFileSync(join(process.cwd(), "dist/src/inspect.js"), "utf8");

  assert.doesNotMatch(source, /\breaddirSync\b/);
  assert.match(source, /\bopendirSync\b/);
});
