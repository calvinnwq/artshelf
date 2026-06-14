import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// NGX-360: guard the approval-only cleanup execution model. These tests lock in
// the safety boundary so future features (status/doctor/review/...) cannot
// quietly add a daemon, auto-execute, global execute, fresh-plan-then-execute,
// or silent deletion path.

const CLI = new URL("../src/cli.js", import.meta.url);
const TEST_REGISTRY = join(mkdtempSync(join(tmpdir(), "artshelf-safety-registry-")), "ledgers.json");

test("cleanup help states the approval-only execution boundary in plain language", () => {
  const help = artshelf(["help", "cleanup"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /artshelf cleanup --execute --plan-id <id>/);
  assert.match(help.stdout, /approval-only/i);
  assert.match(help.stdout, /no daemon/i);
  assert.match(help.stdout, /auto-execute/i);
  assert.match(help.stdout, /global execute/i);
  assert.match(help.stdout, /reviewed plan id/i);
  assert.match(help.stdout, /--all mode is dry-run only/i);
});

test("cleanup --execute --all is refused so there is no global execute path", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");

  const refused = artshelf(["cleanup", "--execute", "--all", "--plan-id", "plan_nope", "--registry", registry]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /cleanup --all is dry-run only/);
  assert.match(refused.stderr, /reviewed --plan-id/);
});

test("cleanup --execute requires a reviewed plan id and never computes a fresh live set", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);
  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");

  const missing = artshelf(["cleanup", "--execute", "--ledger", ledger], "2026-06-03T00:00:00Z");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing required --plan-id/);

  // An id that was never reviewed into a plan file is refused, not freshly computed.
  const unreviewed = artshelf(["cleanup", "--execute", "--plan-id", "plan_never_reviewed", "--ledger", ledger], "2026-06-03T00:00:00Z");
  assert.equal(unreviewed.status, 1);
  assert.match(unreviewed.stderr, /Cleanup plan not found/);

  // The due artifact is untouched: execute moved or deleted nothing.
  assert.equal(existsSync(artifact), true);
  assert.equal(existsSync(join(fixture, ".artshelf", "trash")), false);
});

test("cleanup --execute refuses physical delete so there is no silent deletion path", () => {
  const fixture = fixtureDir();
  const target = join(fixture, "delete-me.txt");
  writeFileSync(target, "keep me safe");
  const ledger = ledgerPath(fixture);
  artshelf(["put", target, "--reason", "delete later", "--ttl", "1d", "--cleanup", "delete", "--ledger", ledger], "2026-06-01T00:00:00Z");

  const plan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  const receipt = JSON.parse(artshelf(["cleanup", "--execute", "--plan-id", plan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:01:00Z").stdout).receipt;

  const deleteResult = receipt.results.find((result: any) => result.id === plan.entries[0].id);
  assert.ok(deleteResult);
  assert.equal(deleteResult.status, "refused");
  assert.match(deleteResult.reason, /delete is disabled in v1/);
  assert.equal(existsSync(target), true, "delete must never remove the file in v1");
});

// NGX-426: cleanup --execute must reject unsafe or mismatched plan inputs before
// it moves files or writes receipts, matching the plan-id-bound posture trash
// purge already has.

test("cleanup --execute refuses an unsafe --plan-id before writing a receipt or trash", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);
  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");

  const unsafe = artshelf(["cleanup", "--execute", "--plan-id", "../plan_escape", "--ledger", ledger], "2026-06-03T00:00:00Z");
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /Invalid cleanup plan id/);

  const shelfDir = join(fixture, ".artshelf");
  assert.equal(existsSync(artifact), true, "an unsafe plan id must move nothing");
  assert.equal(existsSync(join(shelfDir, "trash")), false, "an unsafe plan id must not create trash");
  assert.equal(existsSync(join(shelfDir, "receipts")), false, "an unsafe plan id must not write a receipt");
});

test("cleanup --execute refuses a plan whose planId does not match the requested id", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);
  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");

  const plan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  // Copy the reviewed plan to a different (still-safe) plan-id path while leaving
  // its internal planId pointing at the original. The requested id now mismatches.
  const plansDir = join(fixture, ".artshelf", "plans");
  const mismatchedId = "plan_mismatched_id";
  writeFileSync(join(plansDir, `${mismatchedId}.json`), readFileSync(join(plansDir, `${plan.planId}.json`), "utf8"));

  const refused = artshelf(["cleanup", "--execute", "--plan-id", mismatchedId, "--ledger", ledger], "2026-06-03T00:01:00Z");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /plan id mismatch/i);

  const shelfDir = join(fixture, ".artshelf");
  assert.equal(existsSync(artifact), true, "a mismatched planId must move nothing");
  assert.equal(existsSync(join(shelfDir, "trash")), false, "a mismatched planId must not create trash");
  assert.equal(existsSync(join(shelfDir, "receipts", `${mismatchedId}.json`)), false, "a mismatched planId must not write a receipt");
});

test("cleanup --execute refuses a plan whose ledgerPath does not match the executing ledger", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);
  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");

  const plan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  // Tamper the stored plan so it claims to belong to a different ledger.
  const planFile = join(fixture, ".artshelf", "plans", `${plan.planId}.json`);
  writeFileSync(planFile, JSON.stringify({ ...plan, ledgerPath: join(fixture, "other-ledger.jsonl") }, null, 2));

  const refused = artshelf(["cleanup", "--execute", "--plan-id", plan.planId, "--ledger", ledger], "2026-06-03T00:01:00Z");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /ledger mismatch/i);

  assert.equal(existsSync(artifact), true, "a mismatched ledgerPath must move nothing");
  assert.equal(existsSync(join(fixture, ".artshelf", "trash")), false, "a mismatched ledgerPath must not create trash");
});

test("cleanup --execute refuses a plan whose entries are malformed before mutation", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);
  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");

  const plan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  const planFile = join(fixture, ".artshelf", "plans", `${plan.planId}.json`);
  writeFileSync(planFile, JSON.stringify({ ...plan, entries: "not-an-array" }, null, 2));

  const refused = artshelf(["cleanup", "--execute", "--plan-id", plan.planId, "--ledger", ledger], "2026-06-03T00:01:00Z");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /entries/i);

  assert.equal(existsSync(artifact), true, "a malformed plan must move nothing");
  assert.equal(existsSync(join(fixture, ".artshelf", "trash")), false, "a malformed plan must not create trash");
});

test("read-only status, review, and doctor never execute cleanup", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);
  const registry = join(fixture, "registry.json");
  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger, "--registry", registry], "2026-06-01T00:00:00Z");

  // Even when handed --execute, these read-only commands must not move files.
  for (const command of ["status", "review", "doctor"]) {
    artshelf([command, "--execute", "--ledger", ledger, "--registry", registry], "2026-06-03T00:00:00Z");
  }

  const shelfDir = join(fixture, ".artshelf");
  assert.equal(existsSync(artifact), true);
  assert.equal(existsSync(join(shelfDir, "plans")), false, "read-only commands must not write plans");
  assert.equal(existsSync(join(shelfDir, "receipts")), false, "read-only commands must not write receipts");
  assert.equal(existsSync(join(shelfDir, "trash")), false, "read-only commands must not trash files");
});

test("SPEC's Cleanup Safety Model section names the five execution boundaries in plain language", () => {
  const section = specSection("Cleanup Safety Model");
  assert.match(section, /no daemon/i, "must say there is no daemon");
  assert.match(section, /no auto-execute/i, "must say there is no auto-execute");
  assert.match(section, /no global execute/i, "must say there is no global execute");
  assert.match(section, /no fresh-plan-then-execute/i, "must say there is no fresh-plan-then-execute");
  assert.match(section, /no silent delet/i, "must say there is no silent deletion");
});

function specSection(title: string): string {
  const spec = readFileSync("SPEC.md", "utf8");
  const heading = `## ${title}`;
  const start = spec.indexOf(heading);
  assert.notEqual(start, -1, `SPEC.md is missing the "${title}" section`);
  const rest = spec.slice(start + heading.length);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

function artshelf(args: string[], now?: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI.pathname, ...args], {
    encoding: "utf8",
    env: { ...process.env, ARTSHELF_NO_UPDATE_CHECK: "1", ARTSHELF_REGISTRY: TEST_REGISTRY, ...(now ? { ARTSHELF_NOW: now } : {}) }
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "artshelf-safety-"));
}

function ledgerPath(fixture: string): string {
  return join(fixture, ".artshelf", "ledger.jsonl");
}
