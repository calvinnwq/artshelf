import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// End-to-end tests for the read-only `artshelf ui dashboard` and `artshelf ui detail` surface
// (Artshelf UI v1 contract slice 2: NGX-535 dashboard, NGX-536 detail drawer, NGX-537 needs-
// context). These commands make the existing read-only aggregation cores reachable through the
// agent-mediated `ui` command. Fixtures author registry + ledger files directly so rows can carry
// stale paths, trash provenance, or weak metadata without the existence checks the `put` path
// enforces, then drive the built CLI exactly as an agent would. ARTSHELF_NOW is pinned so ages and
// due classification stay deterministic; the registry is always passed explicitly so a developer's
// real registry never leaks in. The dashboard and drawer are recomputed from live state and never
// mutate anything or read file contents.

const CLI = new URL("../src/cli.js", import.meta.url);
const NOW = "2026-06-25T12:00:00.000Z";
const PAST_DUE = "2026-06-20T00:00:00.000Z";
const CREATED = "2026-06-01T00:00:00.000Z";

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  // Every dashboard/detail invocation passes --registry/--ledger explicitly, so a developer's real
  // ARTSHELF_REGISTRY never wins; the pinned clock keeps ages and due classification deterministic.
  const env = { ...process.env, ARTSHELF_NO_UPDATE_CHECK: "1", ARTSHELF_NOW: NOW };
  const result = spawnSync(process.execPath, [CLI.pathname, ...args], { encoding: "utf8", env });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "artshelf-ui-dash-"));
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

function dueCleanupRecord(dir: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return baseRecord({
    id: "shf_cleanup",
    path: realFile(dir, "scratch.txt"),
    retention: { mode: "ttl", ttl: "1d" },
    retainUntil: PAST_DUE,
    cleanup: "trash",
    ...over
  });
}

test("artshelf ui dashboard --json emits a compact multi-ledger snapshot with the eight buckets", () => {
  const dir = fixture();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir)]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  const result = run(["ui", "dashboard", "--registry", registryPath, "--json"]);
  assert.equal(result.status, 0, result.stderr);

  // Compact JSON is a single agent-optimized line, like the rest of the ui surface.
  assert.equal(result.stdout.trim().split("\n").length, 1, "ui dashboard --json must emit one compact line");
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.ok, true);
  assert.equal(packet.command, "ui-dashboard");
  assert.equal(packet.dashboard.schemaVersion, 1);
  assert.equal(packet.dashboard.registryPath, registryPath);

  // The eight UI v1 buckets are all present as counts.
  assert.deepEqual(Object.keys(packet.dashboard.counts).sort(), [
    "cleanup",
    "needs-context",
    "needs-review",
    "purge-candidates",
    "recent-receipts",
    "registry-reconcile",
    "resolve",
    "trash"
  ]);
  assert.equal(packet.dashboard.counts.cleanup, 1);
  assert.equal(packet.dashboard.buckets.cleanup[0].recordId, "shf_cleanup");
  assert.equal(packet.dashboard.buckets.cleanup[0].ledgerName, "primary");
  assert.equal(packet.dashboard.ledgers[0].ok, true);
});

test("artshelf ui dashboard prints a human lane summary with ledger health", () => {
  const dir = fixture();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir)]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  const result = run(["ui", "dashboard", "--registry", registryPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dashboard/i);
  assert.match(result.stdout, /1 ledger/);
  assert.match(result.stdout, /cleanup\s+1/);
  assert.match(result.stdout, /needs-review\s+0/);
});

test("artshelf ui dashboard routes a weak-reason record into needs-context (NGX-537 reachable)", () => {
  const dir = fixture();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  // A blank reason makes this otherwise-cleanup-ready row un-reviewable: it must move out of the
  // cleanup lane into needs-context, proving the NGX-537 classifier is reachable from the CLI.
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir, { id: "shf_weak", reason: "   " })]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  const packet = JSON.parse(run(["ui", "dashboard", "--registry", registryPath, "--json"]).stdout);
  assert.equal(packet.dashboard.counts["needs-context"], 1);
  assert.equal(packet.dashboard.counts.cleanup, 0);
  assert.equal(packet.dashboard.buckets.needsContext[0].needsContext.reason, "missing-reason");
});

test("artshelf ui detail --json returns the minimum human-judgment fields for one record", () => {
  const dir = fixture();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir)]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  const result = run(["ui", "detail", "shf_cleanup", "--ledger", ledgerPath, "--registry", registryPath, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1, "ui detail --json must emit one compact line");

  const packet = JSON.parse(result.stdout);
  assert.equal(packet.ok, true);
  assert.equal(packet.command, "ui-detail");
  const detail = packet.detail;
  assert.equal(detail.schemaVersion, 1);
  assert.equal(detail.recordId, "shf_cleanup");
  assert.equal(detail.ledgerName, "primary");
  assert.equal(detail.inspect.status, "active");
  assert.equal(detail.inspect.reason, "fixture artifact");
  assert.equal(detail.inspect.existence, "present");
  assert.equal(detail.inspect.recommendation, "trash-safe");
  assert.ok(detail.dueReason && /due/i.test(detail.dueReason));
  assert.equal(detail.provenance.present, false);
  assert.equal(detail.needsContext, null);
  assert.deepEqual(detail.audit.map((event: { kind: string }) => event.kind), ["created"]);
  assert.equal(detail.lastAction, null);
});

test("artshelf ui detail prints a human card with the inspect recommendation and next action", () => {
  const dir = fixture();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir)]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  const result = run(["ui", "detail", "shf_cleanup", "--ledger", ledgerPath, "--registry", registryPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /shf_cleanup/);
  assert.match(result.stdout, /primary/);
  assert.match(result.stdout, /fixture artifact/);
  assert.match(result.stdout, /trash-safe/);
  assert.match(result.stdout, /artshelf dispose/);
});

test("artshelf ui detail surfaces structured provenance when the record carries it", () => {
  const { registryPath, ledgerPath } = singleLedger([
    baseRecord({
      id: "shf_prov",
      path: "/repo/out/keep.txt",
      reason: "release notes draft awaiting sign-off",
      provenance: { root: "repo", rootPath: "/repo", relativePath: "out/keep.txt", basename: "keep.txt", pathKind: "file", fingerprint: { byteSize: 12 } }
    })
  ]);

  const packet = JSON.parse(
    run(["ui", "detail", "shf_prov", "--ledger", ledgerPath, "--registry", registryPath, "--json"]).stdout
  );
  assert.equal(packet.detail.provenance.present, true);
  assert.equal(packet.detail.provenance.provenance.root, "repo");
  assert.equal(packet.detail.provenance.provenance.relativePath, "out/keep.txt");
  assert.equal(packet.detail.needsContext, null);
});

test("artshelf ui detail flags insufficient provenance as needs-context (NGX-537)", () => {
  const { registryPath, ledgerPath } = singleLedger([
    baseRecord({
      id: "shf_external",
      path: "/does/not/exist/external.bin",
      reason: "exported analytics dump pending review",
      provenance: { root: "external", rootPath: null, relativePath: null, basename: "external.bin", pathKind: "other" }
    })
  ]);

  const packet = JSON.parse(
    run(["ui", "detail", "shf_external", "--ledger", ledgerPath, "--registry", registryPath, "--json"]).stdout
  );
  assert.equal(packet.detail.needsContext.reason, "insufficient-provenance");
  assert.match(packet.detail.needsContext.label, /provenance/i);
});

test("artshelf ui detail errors on an unknown record id", () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({ id: "shf_known" })]);

  const result = run(["ui", "detail", "shf_missing", "--ledger", ledgerPath, "--registry", registryPath, "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not found/i);
});

test("artshelf ui detail requires a record id", () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({ id: "shf_known" })]);

  const result = run(["ui", "detail", "--ledger", ledgerPath, "--registry", registryPath, "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /record id/i);
});

test("artshelf ui help and nested help cover the dashboard and detail read surface", () => {
  const family = run(["ui", "--help"]);
  assert.equal(family.status, 0, family.stderr);
  for (const sub of ["dashboard", "detail", "serve", "review", "poll", "reply", "end"]) {
    assert.match(family.stdout, new RegExp(`\\b${sub}\\b`));
  }

  const dashboard = run(["help", "ui", "dashboard"]);
  assert.equal(dashboard.status, 0, dashboard.stderr);
  assert.match(dashboard.stdout, /artshelf ui dashboard/);
  assert.doesNotMatch(dashboard.stdout, /Available Commands:/);

  const detail = run(["ui", "detail", "--help"]);
  assert.equal(detail.status, 0, detail.stderr);
  assert.match(detail.stdout, /artshelf ui detail/);
  assert.match(detail.stdout, /<record-id>|&lt;record-id&gt;/);
});

test("artshelf ui serve help documents the loopback browser launch and triage-intent boundary", () => {
  const serve = run(["help", "ui", "serve"]);
  assert.equal(serve.status, 0, serve.stderr);
  assert.match(serve.stdout, /artshelf ui serve/);
  // NGX-538: the detail drawer captures human triage intents but the served surface
  // still never mutates ledgers/files/trash/plans directly, and stays loopback-bound.
  assert.match(serve.stdout, /triage intents/i);
  assert.match(serve.stdout, /never mutates ledgers, files, trash, or plans/i);
  assert.match(serve.stdout, /loopback|127\.0\.0\.1/);
  assert.doesNotMatch(serve.stdout, /Available Commands:/);
});
