import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  classifyRegistryPruneFindings,
  createRegistryPrunePlan,
  previewRegistryPrunePlan
} from "../src/registry-prune.js";

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
