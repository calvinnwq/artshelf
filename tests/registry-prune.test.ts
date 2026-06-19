import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  classifyRegistryPruneFindings,
  createRegistryPrunePlan,
  executeRegistryPrunePlan,
  previewRegistryPrunePlan
} from "../src/registry-prune.js";
import { listRegisteredLedgers } from "../src/registry.js";

const CLI = new URL("../src/cli.js", import.meta.url);

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "artshelf-registry-prune-"));
}

type Entry = { name: string; path: string; scope?: "repo" | "user" | "other" };

// Author a registry file directly so fixtures can carry registrations that point at
// missing ledger files without the existence checks `ledgers add` enforces.
function writeRegistry(registryPath: string, entries: Entry[]): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  const registry = {
    version: 1,
    ledgers: entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      scope: entry.scope ?? "other",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }))
  };
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

// A present ledger file the registry can point at without being prunable.
function writeLedgerFile(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  return path;
}

function artshelf(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI.pathname, ...args], {
    encoding: "utf8",
    env: { ...process.env, ARTSHELF_NO_UPDATE_CHECK: "1" }
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("a present registered ledger produces no prune finding", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const present = writeLedgerFile(join(root, "present", ".artshelf", "ledger.jsonl"));
  writeRegistry(registryPath, [{ name: "present", path: present }]);

  const findings = classifyRegistryPruneFindings(registryPath);
  assert.deepEqual(findings, []);
});

test("a missing registered ledger becomes a single prune finding", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const missing = join(root, "gone", ".artshelf", "ledger.jsonl");
  writeRegistry(registryPath, [{ name: "gone", path: missing, scope: "repo" }]);

  const findings = classifyRegistryPruneFindings(registryPath);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.status, "prune");
  assert.equal(findings[0]?.name, "gone");
  assert.equal(findings[0]?.path, missing);
  assert.equal(findings[0]?.scope, "repo");
  assert.match(findings[0]?.reason ?? "", /missing/);
});

test("dry-run preview is not-created when nothing is prunable", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const present = writeLedgerFile(join(root, "present", ".artshelf", "ledger.jsonl"));
  writeRegistry(registryPath, [{ name: "present", path: present }]);

  const plan = previewRegistryPrunePlan(registryPath);
  assert.equal(plan.planId, "not-created");
  assert.equal(plan.planPath, null);
  assert.deepEqual(plan.entries, []);
});

test("dry-run preview lists prunable entries without writing a plan", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const missing = join(root, "gone", ".artshelf", "ledger.jsonl");
  writeRegistry(registryPath, [{ name: "gone", path: missing }]);

  const plan = previewRegistryPrunePlan(registryPath);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0]?.name, "gone");
  assert.equal(plan.registryPath, registryPath);
  // Preview never persists a plan file.
  assert.equal(existsSync(join(root, "registry-prune-plans")), false);
});

test("dry-run create persists a plan file only when action is needed and leaves the registry untouched", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const missing = join(root, "gone", ".artshelf", "ledger.jsonl");
  writeRegistry(registryPath, [{ name: "gone", path: missing }]);
  const before = readFileSync(registryPath, "utf8");

  const plan = createRegistryPrunePlan(registryPath);
  assert.notEqual(plan.planId, "not-created");
  assert.ok(plan.planPath, "plan should declare a plan path");
  assert.equal(existsSync(plan.planPath as string), true);

  // The reviewed plan id and registry path round-trip through the persisted file.
  const persisted = JSON.parse(readFileSync(plan.planPath as string, "utf8")) as { planId: string; registryPath: string };
  assert.equal(persisted.planId, plan.planId);
  assert.equal(persisted.registryPath, registryPath);

  // Dry-run is read-only except for plan creation: the registry file is unchanged.
  assert.equal(readFileSync(registryPath, "utf8"), before);
});

test("dry-run create is a no-op with no plan file when nothing is prunable", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const present = writeLedgerFile(join(root, "present", ".artshelf", "ledger.jsonl"));
  writeRegistry(registryPath, [{ name: "present", path: present }]);

  const plan = createRegistryPrunePlan(registryPath);
  assert.equal(plan.planId, "not-created");
  assert.equal(plan.planPath, null);
  assert.equal(existsSync(join(root, "registry-prune-plans")), false);
});

test("repeated dry-runs reuse the same reviewed plan id", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const missing = join(root, "gone", ".artshelf", "ledger.jsonl");
  writeRegistry(registryPath, [{ name: "gone", path: missing }]);

  const first = createRegistryPrunePlan(registryPath);
  const second = createRegistryPrunePlan(registryPath);
  assert.equal(second.planId, first.planId);
  assert.equal(second.planPath, first.planPath);
  // Exactly one plan file exists despite two dry-runs.
  assert.deepEqual(readdirSync(join(root, "registry-prune-plans")).sort(), [`${first.planId}.json`]);
});

test("ambiguous duplicate registry paths are blocked, not pruned", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const missing = join(root, "dup", ".artshelf", "ledger.jsonl");
  writeRegistry(registryPath, [
    { name: "dup-a", path: missing },
    { name: "dup-b", path: missing }
  ]);

  const findings = classifyRegistryPruneFindings(registryPath);
  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => finding.status === "blocked"));

  const plan = createRegistryPrunePlan(registryPath);
  assert.equal(plan.planId, "not-created");
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.skipped.length, 2);
  assert.equal(existsSync(join(root, "registry-prune-plans")), false);
});

test("CLI: ledgers prune --dry-run --json emits a plan with the exact approval target", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const missing = join(root, "gone", ".artshelf", "ledger.jsonl");
  writeRegistry(registryPath, [{ name: "gone", path: missing }]);

  const result = artshelf(["ledgers", "prune", "--dry-run", "--registry", registryPath, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as {
    ok: boolean;
    plan: { planId: string; entries: unknown[] };
    approve: string;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.plan.entries.length, 1);
  assert.equal(payload.approve, `approve artshelf ledgers prune registry ${registryPath} plan ${payload.plan.planId}`);
});

test("CLI: ledgers prune --dry-run human output names the prunable ledger and approval target", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const missing = join(root, "gone", ".artshelf", "ledger.jsonl");
  writeRegistry(registryPath, [{ name: "gone", path: missing }]);

  const result = artshelf(["ledgers", "prune", "--dry-run", "--registry", registryPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gone/);
  assert.match(result.stdout, /approve artshelf ledgers prune registry .* plan /);
});

test("CLI: ledgers prune --dry-run reports a clean no-op when nothing is prunable", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const present = writeLedgerFile(join(root, "present", ".artshelf", "ledger.jsonl"));
  writeRegistry(registryPath, [{ name: "present", path: present }]);

  const result = artshelf(["ledgers", "prune", "--dry-run", "--registry", registryPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing to prune/i);
  assert.equal(existsSync(join(root, "registry-prune-plans")), false);
});

test("CLI: ledgers prune --dry-run --agent emits a single-line packet with the approval target", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const missing = join(root, "gone", ".artshelf", "ledger.jsonl");
  writeRegistry(registryPath, [{ name: "gone", path: missing }]);

  const result = artshelf(["ledgers", "prune", "--dry-run", "--registry", registryPath, "--agent"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1, "agent output is a single line");
  const packet = JSON.parse(result.stdout) as { approve: string; prunable: number };
  assert.equal(packet.prunable, 1);
  assert.match(packet.approve, /^approve artshelf ledgers prune registry .* plan /);
});

test("execute removes the missing registration and writes a rollback copy and receipt", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const present = writeLedgerFile(join(root, "present", ".artshelf", "ledger.jsonl"));
  const missing = join(root, "gone", ".artshelf", "ledger.jsonl");
  writeRegistry(registryPath, [
    { name: "present", path: present },
    { name: "gone", path: missing, scope: "repo" }
  ]);
  const before = readFileSync(registryPath, "utf8");

  const plan = createRegistryPrunePlan(registryPath);
  const receipt = executeRegistryPrunePlan(registryPath, plan.planId);

  // Only the missing registration is removed; the present one stays registered.
  const remaining = listRegisteredLedgers(registryPath);
  assert.deepEqual(remaining.map((entry) => entry.name), ["present"]);

  // Receipt records removed names/paths, plan id, executedAt, rollback path, verification.
  assert.equal(receipt.planId, plan.planId);
  assert.deepEqual(receipt.removed.map((entry) => entry.name), ["gone"]);
  assert.equal(receipt.removed[0]?.path, missing);
  assert.equal(receipt.skipped.length, 0);
  assert.match(receipt.executedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(receipt.verification.ok, true);

  // Rollback copy is the pre-mutation registry, byte-for-byte.
  const rollbackPath = receipt.rollbackPath;
  if (!rollbackPath) throw new Error("missing rollback path");
  assert.equal(readFileSync(rollbackPath, "utf8"), before);

  // Receipt is persisted and round-trips its plan id.
  assert.equal(existsSync(receipt.receiptPath), true);
  const persisted = JSON.parse(readFileSync(receipt.receiptPath, "utf8")) as { planId: string };
  assert.equal(persisted.planId, plan.planId);
});

test("execute refuses a missing plan id", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  writeRegistry(registryPath, [{ name: "gone", path: join(root, "gone", ".artshelf", "ledger.jsonl") }]);

  assert.throws(() => executeRegistryPrunePlan(registryPath, ""), /--plan-id/);
});

test("execute refuses an unknown plan id", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  writeRegistry(registryPath, [{ name: "gone", path: join(root, "gone", ".artshelf", "ledger.jsonl") }]);

  assert.throws(() => executeRegistryPrunePlan(registryPath, "registry-prune_20260101_000000_dead"), /not found/i);
});

test("execute refuses a plan whose registry path does not match the request", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const missing = join(root, "gone", ".artshelf", "ledger.jsonl");
  writeRegistry(registryPath, [{ name: "gone", path: missing }]);
  const plan = createRegistryPrunePlan(registryPath);

  // Tamper the persisted plan so its declared registry path drifts from the request.
  const planFile = plan.planPath as string;
  const tampered = JSON.parse(readFileSync(planFile, "utf8")) as { registryPath: string };
  tampered.registryPath = join(root, "other", "ledgers.json");
  writeFileSync(planFile, `${JSON.stringify(tampered, null, 2)}\n`);

  assert.throws(() => executeRegistryPrunePlan(registryPath, plan.planId), /registry mismatch/i);
});

test("execute skips an entry whose ledger file reappeared and leaves it registered", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const missing = join(root, "gone", ".artshelf", "ledger.jsonl");
  writeRegistry(registryPath, [{ name: "gone", path: missing }]);
  const plan = createRegistryPrunePlan(registryPath);

  // The ledger file reappears after the plan was reviewed: execute must not remove it.
  writeLedgerFile(missing);

  const receipt = executeRegistryPrunePlan(registryPath, plan.planId);
  assert.equal(receipt.removed.length, 0);
  assert.deepEqual(receipt.skipped.map((entry) => entry.name), ["gone"]);
  assert.equal(listRegisteredLedgers(registryPath).length, 1);
  assert.equal(receipt.rollbackPath, null);
});

test("execute skips an entry that became an ambiguous duplicate path", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const missing = join(root, "dup", ".artshelf", "ledger.jsonl");
  writeRegistry(registryPath, [{ name: "dup-a", path: missing }]);
  const plan = createRegistryPrunePlan(registryPath);

  // A second registration now shares the planned path: pruning either is ambiguous.
  writeRegistry(registryPath, [
    { name: "dup-a", path: missing },
    { name: "dup-b", path: missing }
  ]);

  const receipt = executeRegistryPrunePlan(registryPath, plan.planId);
  assert.equal(receipt.removed.length, 0);
  assert.deepEqual(receipt.skipped.map((entry) => entry.name), ["dup-a"]);
  assert.equal(listRegisteredLedgers(registryPath).length, 2);
});

test("re-executing a completed plan is a no-op that preserves the original rollback copy", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const missing = join(root, "gone", ".artshelf", "ledger.jsonl");
  writeRegistry(registryPath, [{ name: "gone", path: missing }]);
  const plan = createRegistryPrunePlan(registryPath);

  const first = executeRegistryPrunePlan(registryPath, plan.planId);
  const rollbackPath = first.rollbackPath;
  if (!rollbackPath) throw new Error("missing rollback path");
  const rollbackAfterFirst = readFileSync(rollbackPath, "utf8");
  const receiptAfterFirst = readFileSync(first.receiptPath, "utf8");
  assert.match(rollbackAfterFirst, /gone/);

  const second = executeRegistryPrunePlan(registryPath, plan.planId);
  assert.deepEqual(second.removed.map((entry) => entry.name), ["gone"]);
  assert.equal(second.verification.ok, true);
  assert.equal(readFileSync(rollbackPath, "utf8"), rollbackAfterFirst);
  assert.equal(readFileSync(first.receiptPath, "utf8"), receiptAfterFirst);
});

test("CLI: ledgers prune --execute --json removes the registration and reports the receipt", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  const missing = join(root, "gone", ".artshelf", "ledger.jsonl");
  writeRegistry(registryPath, [{ name: "gone", path: missing }]);
  const plan = createRegistryPrunePlan(registryPath);

  const result = artshelf(["ledgers", "prune", "--execute", "--plan-id", plan.planId, "--registry", registryPath, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as {
    ok: boolean;
    receipt: { removed: { name: string }[]; rollbackPath: string; receiptPath: string; verification: { ok: boolean } };
  };
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.receipt.removed.map((entry) => entry.name), ["gone"]);
  assert.equal(payload.receipt.verification.ok, true);
  assert.equal(existsSync(payload.receipt.rollbackPath), true);
  assert.equal(existsSync(payload.receipt.receiptPath), true);
  assert.equal(listRegisteredLedgers(registryPath).length, 0);
});

test("CLI: ledgers prune --execute without a plan id is refused", () => {
  const root = fixtureRoot();
  const registryPath = join(root, "ledgers.json");
  writeRegistry(registryPath, [{ name: "gone", path: join(root, "gone", ".artshelf", "ledger.jsonl") }]);

  const result = artshelf(["ledgers", "prune", "--execute", "--registry", registryPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--plan-id/);
});
