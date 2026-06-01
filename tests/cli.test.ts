import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CLI = new URL("../src/cli.js", import.meta.url);

test("help and version are useful", () => {
  const help = shelf(["help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Shelf 0\.1\.0/);
  assert.match(help.stdout, /shelf cleanup --dry-run/);

  const putHelp = shelf(["put", "--help"]);
  assert.equal(putHelp.status, 0);
  assert.match(putHelp.stdout, /shelf put <path>/);
  assert.match(putHelp.stdout, /--label <label>/);

  const version = shelf(["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout, "shelf 0.1.0\n");
});

test("unknown flags fail with a usage hint", () => {
  const result = shelf(["put", "/tmp", "--bogus"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown flag: --bogus/);
  assert.match(result.stderr, /shelf help/);
});

test("put refuses a missing path", () => {
  const fixture = fixtureDir();
  const result = shelf(["put", join(fixture, "missing"), "--reason", "debug", "--ttl", "1d", "--ledger", ledgerPath(fixture)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Path does not exist/);
});

test("put requires a reason and retention choice", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");

  assert.match(shelf(["put", artifact, "--ttl", "1d", "--ledger", ledgerPath(fixture)]).stderr, /Missing required --reason/);
  assert.match(shelf(["put", artifact, "--reason", "debug", "--ledger", ledgerPath(fixture)]).stderr, /Choose exactly one/);
});

test("put appends JSONL and list emits human and JSON output", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");

  const put = shelf([
    "put",
    artifact,
    "--reason",
    "debug parser output",
    "--ttl",
    "3d",
    "--kind",
    "scratch",
    "--cleanup",
    "trash",
    "--label",
    "debug",
    "--ledger",
    ledgerPath(fixture),
    "--json"
  ]);
  assert.equal(put.status, 0, put.stderr);

  const body = JSON.parse(put.stdout);
  assert.match(body.record.id, /^shf_/);
  assert.equal(body.record.kind, "scratch");
  assert.equal(body.record.cleanup, "trash");
  assert.deepEqual(body.record.labels, ["debug"]);

  const rawLedger = readFileSync(ledgerPath(fixture), "utf8").trim().split("\n");
  assert.equal(rawLedger.length, 1);

  const listed = shelf(["list", "--ledger", ledgerPath(fixture)]).stdout;
  assert.match(listed, /debug parser output/);
  assert.match(listed, /ledger:/);
  assert.equal(JSON.parse(shelf(["list", "--ledger", ledgerPath(fixture), "--json"]).stdout).entries.length, 1);
});

test("due classifies kept, due, manual review, and missing paths", () => {
  const fixture = fixtureDir();
  const ledger = ledgerPath(fixture);
  const kept = join(fixture, "kept.txt");
  const due = join(fixture, "due.txt");
  const review = join(fixture, "review.txt");
  const missing = join(fixture, "missing.txt");
  writeFileSync(kept, "kept");
  writeFileSync(due, "due");
  writeFileSync(review, "review");
  writeFileSync(missing, "missing");

  shelf(["put", kept, "--reason", "keep", "--retain-until", "2026-06-03T00:00:00Z", "--ledger", ledger], "2026-06-01T00:00:00Z");
  shelf(["put", due, "--reason", "due", "--retain-until", "2026-05-31T00:00:00Z", "--ledger", ledger], "2026-06-01T00:00:00Z");
  shelf(["put", review, "--reason", "review", "--manual-review", "--ledger", ledger], "2026-06-01T00:00:00Z");
  shelf(["put", missing, "--reason", "missing", "--ttl", "1d", "--ledger", ledger], "2026-06-01T00:00:00Z");

  rmSync(missing);
  const entries = JSON.parse(shelf(["due", "--ledger", ledger, "--json"], "2026-06-01T00:00:00Z").stdout).entries;
  assert.deepEqual(entries.map((entry: any) => entry.dueStatus).sort(), ["due", "kept", "manual-review", "missing-path"]);
  assert.match(shelf(["due", "--ledger", ledger], "2026-06-01T00:00:00Z").stdout, /due .*due\.txt/);
});

test("validate reports shape errors and missing paths as warnings", () => {
  const fixture = fixtureDir();
  const ledger = ledgerPath(fixture);
  mkdirSync(join(fixture, ".shelf"), { recursive: true });
  writeFileSync(ledger, JSON.stringify({
    id: "shf_test",
    path: join(fixture, "missing.txt"),
    kind: "scratch",
    reason: "gone",
    createdAt: "2026-06-01T00:00:00Z",
    retainUntil: "2026-06-02T00:00:00Z",
    retention: { mode: "ttl", ttl: "1d" },
    cleanup: "review",
    owner: "manual",
    labels: [],
    status: "active"
  }) + "\n");

  const result = shelf(["validate", "--ledger", ledger, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.warnings.length, 1);
});

test("cleanup dry-run creates a plan and execute requires a plan id", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  shelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  const refusal = shelf(["cleanup", "--execute", "--ledger", ledger]);
  assert.equal(refusal.status, 1);
  assert.match(refusal.stderr, /Missing required --plan-id/);

  const dryRun = shelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z");
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const plan = JSON.parse(dryRun.stdout).plan;
  assert.equal(plan.entries.length, 1);
  assert.equal(existsSync(plan.planPath), true);

  const executed = shelf(["cleanup", "--execute", "--plan-id", plan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:01:00Z");
  assert.equal(executed.status, 0, executed.stderr);
  const receipt = JSON.parse(executed.stdout).receipt;
  assert.equal(receipt.results[0].status, "trashed");
  assert.equal(existsSync(artifact), false);
  assert.equal(existsSync(receipt.results[0].target), true);
});

function shelf(args: string[], now?: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI.pathname, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...(now ? { SHELF_NOW: now } : {}) }
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "shelf-test-"));
  return dir;
}

function ledgerPath(fixture: string): string {
  return join(fixture, ".shelf", "ledger.jsonl");
}
