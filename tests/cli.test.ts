import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CLI = new URL("../src/cli.js", import.meta.url);
const TEST_REGISTRY = join(mkdtempSync(join(tmpdir(), "shelf-test-registry-")), "ledgers.json");

test("help and version are useful", () => {
  const help = shelf(["help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Shelf 0\.1\.0/);
  assert.match(help.stdout, /shelf cleanup --dry-run/);

  const putHelp = shelf(["put", "--help"]);
  assert.equal(putHelp.status, 0);
  assert.match(putHelp.stdout, /shelf put <path>/);
  assert.match(putHelp.stdout, /--label <label>/);

  const resolveHelp = shelf(["help", "resolve"]);
  assert.equal(resolveHelp.status, 0);
  assert.match(resolveHelp.stdout, /shelf resolve <id>/);
  assert.match(resolveHelp.stdout, /--status resolved/);

  const findHelp = shelf(["help", "find"]);
  assert.equal(findHelp.status, 0);
  assert.match(findHelp.stdout, /shelf find/);
  assert.match(findHelp.stdout, /--path <path>/);

  const getHelp = shelf(["help", "get"]);
  assert.equal(getHelp.status, 0);
  assert.match(getHelp.stdout, /shelf get <id>/);

  const ledgersHelp = shelf(["help", "ledgers"]);
  assert.equal(ledgersHelp.status, 0);
  assert.match(ledgersHelp.stdout, /shelf ledgers list/);

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
  assert.match(listed, /active trash/);
  assert.match(listed, /ledger:/);
  assert.equal(JSON.parse(shelf(["list", "--ledger", ledgerPath(fixture), "--json"]).stdout).entries.length, 1);
  assert.equal(JSON.parse(shelf(["list", "--status", "active", "--ledger", ledgerPath(fixture), "--json"]).stdout).entries.length, 1);
  assert.equal(JSON.parse(shelf(["list", "--status", "resolved", "--ledger", ledgerPath(fixture), "--json"]).stdout).entries.length, 0);
});

test("find and get provide read-only idempotency queries", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  const otherArtifact = join(fixture, "other.txt");
  const ledger = ledgerPath(fixture);
  writeFileSync(artifact, "hello");
  writeFileSync(otherArtifact, "other");

  const put = JSON.parse(shelf([
    "put",
    artifact,
    "--reason",
    "workflow evidence",
    "--ttl",
    "14d",
    "--kind",
    "run-artifact",
    "--cleanup",
    "review",
    "--owner",
    "coding-workflow-pipeline",
    "--label",
    "cwfp-test",
    "--label",
    "implementation",
    "--ledger",
    ledger,
    "--json"
  ]).stdout);
  shelf([
    "put",
    otherArtifact,
    "--reason",
    "other evidence",
    "--ttl",
    "14d",
    "--owner",
    "other-owner",
    "--label",
    "cwfp-test",
    "--ledger",
    ledger
  ]);

  const found = JSON.parse(shelf([
    "find",
    "--path",
    artifact,
    "--owner",
    "coding-workflow-pipeline",
    "--label",
    "cwfp-test",
    "--status",
    "active",
    "--ledger",
    ledger,
    "--json"
  ]).stdout);
  assert.equal(found.entries.length, 1);
  assert.equal(found.entries[0].id, put.record.id);

  const noMatch = JSON.parse(shelf(["find", "--label", "missing", "--ledger", ledger, "--json"]).stdout);
  assert.deepEqual(noMatch.entries, []);

  const get = JSON.parse(shelf(["get", put.record.id, "--ledger", ledger, "--json"]).stdout);
  assert.equal(get.record.path, artifact);
  assert.equal(get.record.reason, "workflow evidence");

  const missingGet = shelf(["get", "shf_missing", "--ledger", ledger]);
  assert.equal(missingGet.status, 1);
  assert.match(missingGet.stderr, /Shelf record not found/);

  const unbounded = shelf(["find", "--ledger", ledger]);
  assert.equal(unbounded.status, 1);
  assert.match(unbounded.stderr, /find requires at least one/);
});

test("ledger registry gives one read-only entry point across ledgers", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const firstLedger = join(fixture, "one", ".shelf", "ledger.jsonl");
  const secondLedger = join(fixture, "two", ".shelf", "ledger.jsonl");
  const firstArtifact = join(fixture, "first.txt");
  const secondArtifact = join(fixture, "second.txt");
  writeFileSync(firstArtifact, "first");
  writeFileSync(secondArtifact, "second");

  const put = JSON.parse(shelf([
    "put",
    firstArtifact,
    "--reason",
    "first artifact",
    "--ttl",
    "1d",
    "--owner",
    "openclaw",
    "--label",
    "registry-smoke",
    "--ledger",
    firstLedger,
    "--registry",
    registry,
    "--json"
  ], "2026-06-01T00:00:00Z").stdout);
  assert.equal(put.ledger.path, firstLedger);

  mkdirSync(join(fixture, "two", ".shelf"), { recursive: true });
  writeFileSync(secondLedger, "");
  const add = JSON.parse(shelf([
    "ledgers",
    "add",
    "--ledger",
    secondLedger,
    "--name",
    "second",
    "--scope",
    "repo",
    "--registry",
    registry,
    "--json"
  ], "2026-06-01T00:01:00Z").stdout);
  assert.equal(add.ledger.name, "second");

  shelf([
    "put",
    secondArtifact,
    "--reason",
    "second artifact",
    "--manual-review",
    "--owner",
    "openclaw",
    "--label",
    "registry-smoke",
    "--ledger",
    secondLedger,
    "--registry",
    registry
  ], "2026-06-01T00:02:00Z");

  const ledgers = JSON.parse(shelf(["ledgers", "list", "--registry", registry, "--json"]).stdout).ledgers;
  assert.deepEqual(ledgers.map((ledger: any) => ledger.name), ["one", "second"]);

  const allList = JSON.parse(shelf(["list", "--all", "--registry", registry, "--json"]).stdout);
  assert.equal(allList.ledgers.length, 2);
  assert.equal(allList.ledgers.reduce((count: number, ledger: any) => count + ledger.entries.length, 0), 2);

  const allFind = JSON.parse(shelf(["find", "--all", "--owner", "openclaw", "--label", "registry-smoke", "--registry", registry, "--json"]).stdout);
  assert.equal(allFind.ledgers.reduce((count: number, ledger: any) => count + ledger.entries.length, 0), 2);

  const allGet = JSON.parse(shelf(["get", put.record.id, "--all", "--registry", registry, "--json"]).stdout);
  assert.equal(allGet.ledger.path, firstLedger);
  assert.equal(allGet.record.id, put.record.id);

  const allDue = JSON.parse(shelf(["due", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z").stdout);
  assert.deepEqual(allDue.ledgers.flatMap((ledger: any) => ledger.entries.map((entry: any) => entry.dueStatus)).sort(), ["due", "manual-review"]);

  const allValidate = JSON.parse(shelf(["validate", "--all", "--registry", registry, "--json"]).stdout);
  assert.equal(allValidate.ok, true);

  const review = JSON.parse(shelf(["review", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z").stdout);
  assert.equal(review.ok, true);
  assert.equal(review.ledgers.length, 2);
  assert.equal(review.ledgers.reduce((count: number, ledger: any) => count + ledger.plan.entries.length, 0), 2);
  for (const entry of review.ledgers) {
    assert.equal(existsSync(entry.plan.planPath), false);
  }

  const dryRun = JSON.parse(shelf(["cleanup", "--dry-run", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z").stdout);
  assert.equal(dryRun.plans.length, 2);
  assert.equal(dryRun.plans.reduce((count: number, entry: any) => count + entry.plan.entries.length, 0), 2);

  const refused = shelf(["cleanup", "--execute", "--all", "--plan-id", "plan_nope", "--registry", registry]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /cleanup --all is dry-run only/);
});

test("put records the artifact when registry update fails", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  const ledger = ledgerPath(fixture);
  const registry = join(fixture, "registry.json");
  writeFileSync(artifact, "hello");
  writeFileSync(registry, "{not json");

  const result = shelf([
    "put",
    artifact,
    "--reason",
    "partial failure guard",
    "--ttl",
    "1d",
    "--ledger",
    ledger,
    "--registry",
    registry
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(ledger), true);
  assert.equal(readLedger(ledger).length, 1);

  const jsonResult = shelf([
    "put",
    artifact,
    "--reason",
    "partial failure guard json",
    "--ttl",
    "1d",
    "--ledger",
    ledger,
    "--registry",
    registry,
    "--json"
  ]);
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  assert.match(JSON.parse(jsonResult.stdout).registryError, /Unexpected token|Expected property name/);
});

test("ledgers add requires an existing ledger path", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const missing = join(fixture, "missing", ".shelf", "ledger.jsonl");

  const result = shelf(["ledgers", "add", "--ledger", missing, "--registry", registry]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Ledger does not exist/);
  assert.equal(existsSync(registry), false);
});

test("ledgers add falls back from blank names to inferred names", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const ledger = join(fixture, "repo", ".shelf", "ledger.jsonl");
  mkdirSync(join(fixture, "repo", ".shelf"), { recursive: true });
  writeFileSync(ledger, "");

  const result = shelf(["ledgers", "add", "--ledger", ledger, "--name", "   ", "--registry", registry, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ledger.name, "repo");

  const list = JSON.parse(shelf(["ledgers", "list", "--registry", registry, "--json"]).stdout);
  assert.deepEqual(list.ledgers.map((entry: any) => entry.name), ["repo"]);
});

test("ledgers list --json reports validation status so agents detect stale entries without a separate validate pass", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const goodLedger = join(fixture, "good", ".shelf", "ledger.jsonl");
  const staleLedger = join(fixture, "stale", ".shelf", "ledger.jsonl");
  const brokenLedger = join(fixture, "broken", ".shelf", "ledger.jsonl");
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");

  shelf(["put", artifact, "--reason", "healthy", "--ttl", "7d", "--ledger", goodLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  mkdirSync(join(fixture, "stale", ".shelf"), { recursive: true });
  writeFileSync(staleLedger, "");
  shelf(["ledgers", "add", "--ledger", staleLedger, "--name", "stale", "--registry", registry]);
  rmSync(staleLedger);
  mkdirSync(join(fixture, "broken", ".shelf"), { recursive: true });
  writeFileSync(brokenLedger, "{not json\n");
  shelf(["ledgers", "add", "--ledger", brokenLedger, "--name", "broken", "--registry", registry]);

  const result = shelf(["ledgers", "list", "--registry", registry, "--json"]);
  assert.equal(result.status, 1, "a stale or invalid registered ledger should make ledgers list exit non-zero");
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.registryPath, registry);

  // Aggregate registry-health summary for fast scanning.
  assert.equal(body.summary.ledgers, 3);
  assert.equal(body.summary.ok, 1);
  assert.equal(body.summary.stale, 1);
  assert.equal(body.summary.invalid, 1);

  const good = body.ledgers.find((entry: any) => entry.name === "good");
  const stale = body.ledgers.find((entry: any) => entry.name === "stale");
  const broken = body.ledgers.find((entry: any) => entry.name === "broken");
  assert.ok(good);
  assert.ok(stale);
  assert.ok(broken);

  // Backward-compatible registry fields are preserved on every entry.
  for (const entry of [good, stale, broken]) {
    assert.equal(typeof entry.path, "string");
    assert.equal(typeof entry.scope, "string");
    assert.equal(typeof entry.createdAt, "string");
  }

  assert.equal(good.status, "ok");
  assert.equal(good.ok, true);
  assert.equal(good.entries, 1);
  assert.equal(good.errors.length, 0);
  assert.equal(good.warnings.length, 0);

  assert.equal(stale.status, "missing");
  assert.equal(stale.ok, false);
  assert.match(stale.errors[0], /registered ledger is missing/);

  assert.equal(broken.status, "invalid");
  assert.equal(broken.ok, false);
  assert.match(broken.errors[0], /Invalid JSONL/);
});

test("ledgers list human output calls out broken ledgers directly", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const goodLedger = join(fixture, "good", ".shelf", "ledger.jsonl");
  const staleLedger = join(fixture, "stale", ".shelf", "ledger.jsonl");
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");

  shelf(["put", artifact, "--reason", "healthy", "--ttl", "7d", "--ledger", goodLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  mkdirSync(join(fixture, "stale", ".shelf"), { recursive: true });
  writeFileSync(staleLedger, "");
  shelf(["ledgers", "add", "--ledger", staleLedger, "--name", "stale", "--registry", registry]);
  rmSync(staleLedger);

  const result = shelf(["ledgers", "list", "--registry", registry]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /shelf ledgers: needs attention/);
  assert.match(result.stdout, /1 ledgers? ok|1 ok/);
  assert.match(result.stdout, /\[stale\] missing/);
  assert.match(result.stdout, /\[good\] ok/);
  assert.match(result.stdout, /registry:/);
});

test("ledgers list --plain preserves the fast plain listing path", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const goodLedger = join(fixture, "good", ".shelf", "ledger.jsonl");
  const staleLedger = join(fixture, "stale", ".shelf", "ledger.jsonl");
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");

  shelf(["put", artifact, "--reason", "healthy", "--ttl", "7d", "--ledger", goodLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  mkdirSync(join(fixture, "stale", ".shelf"), { recursive: true });
  writeFileSync(staleLedger, "");
  shelf(["ledgers", "add", "--ledger", staleLedger, "--name", "stale", "--registry", registry]);
  rmSync(staleLedger);

  // Plain mode does not read ledger files, so a stale entry never makes it exit non-zero.
  const json = shelf(["ledgers", "list", "--plain", "--registry", registry, "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.equal(body.ok, true);
  assert.deepEqual(body.ledgers.map((entry: any) => entry.name), ["good", "stale"]);
  assert.equal("status" in body.ledgers[0], false);
  assert.equal("summary" in body, false);

  const human = shelf(["ledgers", "list", "--plain", "--registry", registry]);
  assert.equal(human.status, 0, human.stderr);
  assert.doesNotMatch(human.stdout, /needs attention/);
  assert.match(human.stdout, /good repo .*\.shelf/);
  assert.match(human.stdout, /registry:/);
});

test("review reports invalid registered ledgers without aborting", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const goodLedger = join(fixture, "good", ".shelf", "ledger.jsonl");
  const badLedger = join(fixture, "bad", ".shelf", "ledger.jsonl");
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");

  shelf([
    "put",
    artifact,
    "--reason",
    "good artifact",
    "--ttl",
    "1d",
    "--ledger",
    goodLedger,
    "--registry",
    registry
  ]);
  mkdirSync(join(fixture, "bad", ".shelf"), { recursive: true });
  writeFileSync(badLedger, "{not json\n");
  shelf(["ledgers", "add", "--ledger", badLedger, "--name", "bad", "--registry", registry]);

  const result = shelf(["review", "--all", "--registry", registry, "--json"]);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.ledgers.length, 2);
  const invalid = body.ledgers.find((entry: any) => entry.ledger.name === "bad");
  assert.ok(invalid);
  assert.equal(invalid.validate.ok, false);
  assert.match(invalid.validate.errors[0], /Invalid JSONL/);
  assert.equal(invalid.plan.planId, "not-created");
  assert.equal(invalid.plan.planPath, null);
});

test("registered ledgers missing from disk are reported as stale registry entries", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const ledger = join(fixture, "repo", ".shelf", "ledger.jsonl");
  mkdirSync(join(fixture, "repo", ".shelf"), { recursive: true });
  writeFileSync(ledger, "");
  shelf(["ledgers", "add", "--ledger", ledger, "--registry", registry]);
  rmSync(ledger);

  const result = shelf(["validate", "--all", "--registry", registry, "--json"]);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.match(body.ledgers[0].result.errors[0], /registered ledger is missing/);

  const human = shelf(["validate", "--all", "--registry", registry]);
  assert.equal(human.status, 1);
  assert.match(human.stdout, /error: registered ledger is missing/);

  for (const args of [
    ["list", "--all", "--registry", registry, "--json"],
    ["find", "--all", "--owner", "openclaw", "--registry", registry, "--json"],
    ["get", "shf_missing", "--all", "--registry", registry, "--json"],
    ["due", "--all", "--registry", registry, "--json"]
  ]) {
    const stale = shelf(args);
    assert.equal(stale.status, 1, `${args.join(" ")} should report stale registry entries`);
    const staleBody = JSON.parse(stale.stdout);
    assert.equal(staleBody.ok, false);
    assert.match(staleBody.ledgers[0].result.errors[0], /registered ledger is missing/);
  }
});

test("single ledger review treats a missing ledger as empty", () => {
  const fixture = fixtureDir();
  const ledger = ledgerPath(fixture);

  const result = shelf(["review", "--ledger", ledger, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.ledger.validate.entries, 0);
  assert.equal(body.ledger.plan.entries.length, 0);
  assert.equal(body.ledger.plan.planId, "not-created");
  assert.equal(body.ledger.plan.planPath, null);
});

test("review --all --json summarizes triage counts while preserving per-ledger detail", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const oneLedger = join(fixture, "one", ".shelf", "ledger.jsonl");
  const twoLedger = join(fixture, "two", ".shelf", "ledger.jsonl");
  const dueArtifact = join(fixture, "due.txt");
  const reviewArtifact = join(fixture, "review.txt");
  const keptArtifact = join(fixture, "kept.txt");
  writeFileSync(dueArtifact, "due");
  writeFileSync(reviewArtifact, "review");
  writeFileSync(keptArtifact, "kept");

  shelf(["put", dueArtifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", oneLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  shelf(["put", reviewArtifact, "--reason", "needs eyes", "--manual-review", "--ledger", twoLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  shelf(["put", keptArtifact, "--reason", "still kept", "--retain-until", "2026-06-10T00:00:00Z", "--ledger", twoLedger, "--registry", registry], "2026-06-01T00:00:00Z");

  const result = shelf(["review", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);

  // Aggregate triage summary for fast all-ledger scanning.
  assert.equal(body.summary.ledgers, 2);
  assert.equal(body.summary.ok, 2);
  assert.equal(body.summary.invalid, 0);
  assert.equal(body.summary.stale, 0);
  assert.equal(body.summary.due, 1);
  assert.equal(body.summary.manualReview, 1);
  assert.equal(body.summary.missingPath, 0);
  assert.equal(body.summary.executable, 2);
  assert.equal(body.summary.skipped, 1);
  assert.equal(body.summary.affected, 2);
  assert.equal(body.summary.planIds, undefined);
  assert.equal(body.summary.previewPlanIds.length, 2);
  for (const planId of body.summary.previewPlanIds) assert.match(planId, /^plan_/);
  assert.match(body.nextAction, /cleanup --dry-run --all/);

  // Existing per-ledger detail must remain for automation.
  assert.equal(body.ledgers.length, 2);
  const one = body.ledgers.find((entry: any) => entry.ledger.name === "one");
  const two = body.ledgers.find((entry: any) => entry.ledger.name === "two");
  assert.ok(one);
  assert.ok(two);
  assert.equal(one.validate.ok, true);
  assert.equal(one.plan.entries.length, 1);
  assert.equal(one.due.length, 1);
  assert.equal(two.plan.entries.length, 1);
  assert.equal(two.plan.skipped.length, 1);
});

test("review --all human output states the next safe action", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const oneLedger = join(fixture, "one", ".shelf", "ledger.jsonl");
  const twoLedger = join(fixture, "two", ".shelf", "ledger.jsonl");
  const dueArtifact = join(fixture, "due.txt");
  const reviewArtifact = join(fixture, "review.txt");
  writeFileSync(dueArtifact, "due");
  writeFileSync(reviewArtifact, "review");

  shelf(["put", dueArtifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", oneLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  shelf(["put", reviewArtifact, "--reason", "needs eyes", "--manual-review", "--ledger", twoLedger, "--registry", registry], "2026-06-01T00:00:00Z");

  const result = shelf(["review", "--all", "--registry", registry], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /review --all: needs attention/);
  assert.match(result.stdout, /triage: due 1/);
  assert.match(result.stdout, /manual-review 1/);
  assert.match(result.stdout, /executable 2/);
  assert.match(result.stdout, /next: .*cleanup --dry-run --all/);
  assert.match(result.stdout, /registry:/);
});

test("review --all is read-only and never writes cleanup plans", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const oneLedger = join(fixture, "one", ".shelf", "ledger.jsonl");
  const dueArtifact = join(fixture, "due.txt");
  writeFileSync(dueArtifact, "due");

  shelf(["put", dueArtifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", oneLedger, "--registry", registry], "2026-06-01T00:00:00Z");

  const before = readFileSync(oneLedger, "utf8");
  const result = shelf(["review", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.summary.executable, 1);
  assert.equal(body.ledgers[0].plan.entries.length, 1);

  // Read-only proof: the computed plan path is never written, and the ledger is untouched.
  assert.equal(existsSync(join(fixture, "one", ".shelf", "plans")), false);
  assert.equal(existsSync(body.ledgers[0].plan.planPath), false);
  assert.equal(readFileSync(oneLedger, "utf8"), before);
});

test("review --all reports all clear and nothing to do when no ledger needs attention", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const oneLedger = join(fixture, "one", ".shelf", "ledger.jsonl");
  const keptArtifact = join(fixture, "kept.txt");
  writeFileSync(keptArtifact, "kept");

  shelf(["put", keptArtifact, "--reason", "still kept", "--retain-until", "2026-06-10T00:00:00Z", "--cleanup", "trash", "--ledger", oneLedger, "--registry", registry], "2026-06-01T00:00:00Z");

  const result = shelf(["review", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.summary.affected, 0);
  assert.equal(body.summary.due, 0);
  assert.equal(body.summary.manualReview, 0);
  assert.equal(body.summary.missingPath, 0);
  assert.equal(body.summary.executable, 0);
  assert.equal(body.summary.planIds, undefined);
  assert.equal(body.summary.previewPlanIds.length, 0);
  assert.match(body.nextAction, /nothing to do/);

  const human = shelf(["review", "--all", "--registry", registry], "2026-06-03T00:00:00Z");
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /review --all: all clear/);
  assert.match(human.stdout, /next: nothing to do/);
});

test("cleanup all refuses invalid ledgers before writing any plans", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const goodLedger = join(fixture, "good", ".shelf", "ledger.jsonl");
  const badLedger = join(fixture, "bad", ".shelf", "ledger.jsonl");
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  shelf([
    "put",
    artifact,
    "--reason",
    "due artifact",
    "--ttl",
    "1d",
    "--ledger",
    goodLedger,
    "--registry",
    registry
  ], "2026-06-01T00:00:00Z");
  mkdirSync(join(fixture, "bad", ".shelf"), { recursive: true });
  writeFileSync(badLedger, "{not json\n");
  shelf(["ledgers", "add", "--ledger", badLedger, "--name", "bad", "--registry", registry]);

  const result = shelf(["cleanup", "--dry-run", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(existsSync(join(fixture, "good", ".shelf", "plans")), false);
});

test("registry preserves concurrent ledger registrations", async () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const jobs = Array.from({ length: 6 }, (_, index) => {
    const artifact = join(fixture, `artifact-${index}.txt`);
    writeFileSync(artifact, `artifact ${index}`);
    return shelfAsync([
      "put",
      artifact,
      "--reason",
      `concurrent artifact ${index}`,
      "--ttl",
      "1d",
      "--ledger",
      join(fixture, `repo-${index}`, ".shelf", "ledger.jsonl"),
      "--registry",
      registry,
      "--json"
    ]);
  });

  const results = await Promise.all(jobs);
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
  }

  const ledgers = JSON.parse(shelf(["ledgers", "list", "--registry", registry, "--json"]).stdout).ledgers;
  assert.equal(ledgers.length, 6);
  assert.deepEqual(ledgers.map((ledger: any) => ledger.name).sort(), ["repo-0", "repo-1", "repo-2", "repo-3", "repo-4", "repo-5"]);
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
  const afterDryRun = readLedger(ledger);
  assert.equal(afterDryRun.length, 2);
  assert.equal(afterDryRun[1]?.owner, "shelf");
  assert.equal(afterDryRun[1]?.kind, "run-artifact");
  assert.equal(afterDryRun[1]?.cleanup, "trash");
  assert.deepEqual(afterDryRun[1]?.labels, ["shelf", "cleanup-plan", plan.planId]);
  assert.equal(afterDryRun[1]?.path, plan.planPath);

  const executed = shelf(["cleanup", "--execute", "--plan-id", plan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:01:00Z");
  assert.equal(executed.status, 0, executed.stderr);
  const receipt = JSON.parse(executed.stdout).receipt;
  assert.equal(receipt.results[0].status, "trashed");
  assert.equal(existsSync(artifact), false);
  assert.equal(existsSync(receipt.results[0].target), true);
  const result = receipt.results[0];
  assert.ok(result);

  const records = readLedger(ledger);
  const record = records[0];
  assert.ok(record);
  assert.equal(record.status, "trashed");
  assert.equal(record.cleanupPlanId, plan.planId);
  assert.equal(record.receiptPath, receipt.receiptPath);
  assert.equal(record.targetPath, result.target);
  assert.equal(record.cleanedAt, "2026-06-03T00:01:00Z");
  assert.equal(records.length, 3);
  assert.equal(records[1]?.reason, `Shelf cleanup dry-run plan ${plan.planId}`);
  assert.equal(records[2]?.reason, `Shelf cleanup receipt for plan ${plan.planId}`);
  assert.equal(records[2]?.path, receipt.receiptPath);
  assert.equal(records[2]?.cleanup, "review");
  assert.deepEqual(records[2]?.labels, ["shelf", "cleanup-receipt", plan.planId]);

  const replayed = shelf(["cleanup", "--execute", "--plan-id", plan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:02:00Z");
  assert.equal(replayed.status, 0, replayed.stderr);
  assert.equal(JSON.parse(replayed.stdout).receipt.results[0].status, "skipped");
  const afterReplay = readLedger(ledger);
  const receiptRecords = afterReplay.filter((entry: any) => entry.owner === "shelf" && entry.labels.includes("cleanup-receipt"));
  assert.equal(receiptRecords.length, 1);
  assert.equal(receiptRecords[0].createdAt, "2026-06-03T00:02:00Z");
  assert.equal(receiptRecords[0].retainUntil, "2026-07-03T00:02:00Z");

  const due = JSON.parse(shelf(["due", "--ledger", ledger, "--json"], "2026-06-04T00:00:00Z").stdout).entries;
  assert.deepEqual(due.map((entry: any) => entry.reason), [
    `Shelf cleanup dry-run plan ${plan.planId}`,
    `Shelf cleanup receipt for plan ${plan.planId}`
  ]);
  assert.deepEqual(due.map((entry: any) => entry.dueStatus), ["kept", "kept"]);

  const followupPlan = JSON.parse(shelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-04T00:00:00Z").stdout).plan;
  assert.equal(followupPlan.planId, "not-created");
  assert.equal(followupPlan.planPath, null);
  assert.equal(followupPlan.entries.length, 0);
  assert.equal(followupPlan.skipped.length, 2);
  assert.equal(existsSync(join(fixture, ".shelf", "plans", "not-created.json")), false);
  assert.equal(JSON.parse(shelf(["validate", "--ledger", ledger, "--json"]).stdout).ok, true);
});

test("cleanup dry-run reuses an unchanged existing plan", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  shelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");

  const first = JSON.parse(shelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  const second = JSON.parse(shelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-04T00:00:00Z").stdout).plan;

  assert.equal(second.planId, first.planId);
  assert.equal(second.planPath, first.planPath);
  assert.equal(second.generatedAt, "2026-06-04T00:00:00Z");
  assert.equal(second.entries.length, 1);
  assert.equal(second.entries[0].id, first.entries[0].id);
  assert.equal(second.skipped.length, 1);
  assert.equal(second.skipped[0].reason, "retention has not expired");

  const stored = JSON.parse(readFileSync(first.planPath, "utf8"));
  assert.equal(stored.generatedAt, "2026-06-04T00:00:00Z");
  assert.equal(stored.planId, first.planId);

  const records = readLedger(ledger);
  const planRecords = records.filter((record: any) => record.owner === "shelf" && record.labels.includes("cleanup-plan"));
  assert.equal(planRecords.length, 1);
  assert.equal(planRecords[0].createdAt, "2026-06-04T00:00:00Z");
  assert.equal(planRecords[0].retainUntil, "2026-06-18T00:00:00Z");

  const executed = shelf(["cleanup", "--execute", "--plan-id", first.planId, "--ledger", ledger, "--json"], "2026-06-04T00:01:00Z");
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(JSON.parse(executed.stdout).receipt.results[0].status, "trashed");
});

test("cleanup execute records review and refused outcomes as terminal ledger state", () => {
  const fixture = fixtureDir();
  const review = join(fixture, "review.txt");
  const refused = join(fixture, "refused.txt");
  writeFileSync(review, "review");
  writeFileSync(refused, "refused");
  const ledger = ledgerPath(fixture);

  shelf(["put", review, "--reason", "needs eyes", "--manual-review", "--cleanup", "review", "--ledger", ledger], "2026-06-01T00:00:00Z");
  shelf(["put", refused, "--reason", "delete later", "--ttl", "1d", "--cleanup", "delete", "--ledger", ledger], "2026-06-01T00:00:00Z");

  const plan = JSON.parse(shelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  assert.equal(plan.entries.length, 2);

  const receipt = JSON.parse(shelf(["cleanup", "--execute", "--plan-id", plan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:01:00Z").stdout).receipt;
  assert.deepEqual(receipt.results.map((result: any) => result.status).sort(), ["refused", "review-required"]);

  const records = readLedger(ledger);
  const handled = records.filter((record: any) => record.owner !== "shelf");
  const shelfArtifacts = records.filter((record: any) => record.owner === "shelf");
  assert.deepEqual(handled.map((record: any) => record.status).sort(), ["cleanup-refused", "review-required"]);
  assert.equal(handled.every((record: any) => record.cleanupPlanId === plan.planId), true);
  assert.equal(handled.every((record: any) => record.receiptPath === receipt.receiptPath), true);
  assert.equal(handled.every((record: any) => record.cleanedAt === "2026-06-03T00:01:00Z"), true);
  assert.deepEqual(shelfArtifacts.map((record: any) => record.reason), [
    `Shelf cleanup dry-run plan ${plan.planId}`,
    `Shelf cleanup receipt for plan ${plan.planId}`
  ]);
  assert.equal(existsSync(review), true);
  assert.equal(existsSync(refused), true);

  const followupPlan = JSON.parse(shelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-04T00:00:00Z").stdout).plan;
  assert.equal(followupPlan.planId, "not-created");
  assert.equal(followupPlan.planPath, null);
  assert.equal(followupPlan.entries.length, 0);
});

test("list filters by status after cleanup state changes", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  shelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  const plan = JSON.parse(shelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  shelf(["cleanup", "--execute", "--plan-id", plan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:01:00Z");

  const active = JSON.parse(shelf(["list", "--status", "active", "--ledger", ledger, "--json"]).stdout).entries;
  const trashed = JSON.parse(shelf(["list", "--status", "trashed", "--ledger", ledger, "--json"]).stdout).entries;
  assert.deepEqual(active.map((record: any) => record.owner), ["shelf", "shelf"]);
  assert.equal(trashed.length, 1);
  assert.equal(trashed[0].status, "trashed");
  assert.match(shelf(["list", "--status", "not-real", "--ledger", ledger]).stderr, /Unknown status: not-real/);
});

test("cleanup dry-run does not write a plan when there are no cleanup entries", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  shelf(["put", artifact, "--reason", "still kept", "--ttl", "7d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");

  const dryRun = shelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-02T00:00:00Z");
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const plan = JSON.parse(dryRun.stdout).plan;
  assert.equal(plan.planId, "not-created");
  assert.equal(plan.planPath, null);
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(existsSync(join(fixture, ".shelf", "plans")), false);
  assert.equal(readLedger(ledger).length, 1);

  const human = shelf(["cleanup", "--dry-run", "--ledger", ledger], "2026-06-02T00:00:00Z");
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /plan not-created: 0 entries, 1 skipped/);
  assert.match(human.stdout, /plan: not created/);
});

test("resolve marks missing records as resolved and removes cleanup noise", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  const put = JSON.parse(shelf(["put", artifact, "--reason", "temporary evidence", "--ttl", "1d", "--cleanup", "review", "--ledger", ledger, "--json"], "2026-06-01T00:00:00Z").stdout);
  rmSync(artifact);
  assert.equal(JSON.parse(shelf(["validate", "--ledger", ledger, "--json"]).stdout).warnings.length, 1);

  const resolved = shelf([
    "resolve",
    put.record.id,
    "--status",
    "resolved",
    "--reason",
    "artifact inspected and no longer needed",
    "--ledger",
    ledger,
    "--json"
  ], "2026-06-02T00:00:00Z");
  assert.equal(resolved.status, 0, resolved.stderr);
  const body = JSON.parse(resolved.stdout);
  assert.equal(body.record.status, "resolved");
  assert.equal(body.record.resolvedAt, "2026-06-02T00:00:00Z");
  assert.equal(body.record.resolutionReason, "artifact inspected and no longer needed");

  const due = JSON.parse(shelf(["due", "--ledger", ledger, "--json"], "2026-06-04T00:00:00Z").stdout).entries;
  const plan = JSON.parse(shelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-04T00:00:00Z").stdout).plan;
  const validate = JSON.parse(shelf(["validate", "--ledger", ledger, "--json"]).stdout);
  assert.deepEqual(due, []);
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.skipped.length, 0);
  assert.equal(validate.ok, true);
  assert.equal(validate.warnings.length, 0);
  assert.equal(JSON.parse(shelf(["list", "--status", "resolved", "--ledger", ledger, "--json"]).stdout).entries.length, 1);

  const repeated = shelf(["resolve", put.record.id, "--status", "resolved", "--reason", "overwrite attempt", "--ledger", ledger]);
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /already resolved/);
  assert.equal(readLedger(ledger)[0].resolutionReason, "artifact inspected and no longer needed");

  const unsupported = shelf(["resolve", put.record.id, "--status", "active", "--reason", "reopen", "--ledger", ledger]);
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /resolve currently supports --status resolved/);
});

test("doctor reports a healthy machine and exits zero", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const artifact = join(fixture, "artifact.txt");
  const ledger = join(fixture, "repo", ".shelf", "ledger.jsonl");
  writeFileSync(artifact, "hello");
  shelf(["put", artifact, "--reason", "healthy", "--ttl", "7d", "--ledger", ledger, "--registry", registry]);

  const result = shelf(["doctor", "--registry", registry, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.version, "0.1.0");
  assert.equal(body.registryPath, registry);
  assert.equal(body.registryExists, true);
  assert.equal(body.registryOk, true);
  assert.equal(body.ledgers.length, 1);
  assert.equal(body.ledgers[0].name, "repo");
  assert.equal(body.ledgers[0].status, "ok");
  assert.equal(body.summary.ledgers, 1);
  assert.equal(body.summary.ok, 1);
  assert.equal(body.summary.stale, 0);
  assert.equal(body.summary.invalid, 0);
  assert.equal(body.cleanupSafety.executeRequiresLedgerAndPlanId, true);
  assert.equal(body.cleanupSafety.globalExecuteRefused, true);
  assert.equal(body.cleanupSafety.deleteRefusedInV1, true);
  assert.deepEqual(body.errors, []);
});

test("doctor reports stale registered ledgers and exits non-zero", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const ledger = join(fixture, "repo", ".shelf", "ledger.jsonl");
  mkdirSync(join(fixture, "repo", ".shelf"), { recursive: true });
  writeFileSync(ledger, "");
  shelf(["ledgers", "add", "--ledger", ledger, "--registry", registry]);
  rmSync(ledger);

  const result = shelf(["doctor", "--registry", registry, "--json"]);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.ledgers[0].status, "missing");
  assert.match(body.ledgers[0].errors[0], /registered ledger is missing/);
  assert.match(body.errors.join("\n"), /registered ledger is missing/);

  const human = shelf(["doctor", "--registry", registry]);
  assert.equal(human.status, 1);
  assert.match(human.stdout, /missing/);
});

test("doctor reports invalid registered ledgers and exits non-zero", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const ledger = join(fixture, "bad", ".shelf", "ledger.jsonl");
  mkdirSync(join(fixture, "bad", ".shelf"), { recursive: true });
  writeFileSync(ledger, "{not json\n");
  shelf(["ledgers", "add", "--ledger", ledger, "--name", "bad", "--registry", registry]);

  const result = shelf(["doctor", "--registry", registry, "--json"]);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.ledgers[0].status, "invalid");
  assert.match(body.ledgers[0].errors[0], /Invalid JSONL/);
  assert.equal(body.summary.invalid, 1);
});

test("doctor reports a corrupt registry as an actionable error without crashing", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  writeFileSync(registry, "{not json");

  const result = shelf(["doctor", "--registry", registry, "--json"]);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.registryOk, false);
  assert.equal(typeof body.registryError, "string");
  assert.match(body.errors.join("\n"), /registry/i);
});

test("doctor treats a fresh machine with no registry as healthy", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "missing-registry.json");

  const result = shelf(["doctor", "--registry", registry, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.registryExists, false);
  assert.equal(body.registryOk, true);
  assert.equal(body.ledgers.length, 0);
  assert.equal(body.summary.ledgers, 0);
});

test("doctor human output summarizes health and cleanup safety", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const artifact = join(fixture, "artifact.txt");
  const ledger = join(fixture, "repo", ".shelf", "ledger.jsonl");
  writeFileSync(artifact, "hello");
  shelf(["put", artifact, "--reason", "healthy", "--ttl", "7d", "--ledger", ledger, "--registry", registry]);

  const result = shelf(["doctor", "--registry", registry]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /shelf 0\.1\.0/);
  assert.match(result.stdout, /health: ok/);
  assert.match(result.stdout, /registry:/);
  assert.match(result.stdout, /plan id/i);
  assert.match(result.stdout, /execute/i);
});

test("doctor help explains the command", () => {
  const main = shelf(["help"]);
  assert.match(main.stdout, /shelf doctor/);

  const help = shelf(["help", "doctor"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /shelf doctor/);
  assert.match(help.stdout, /--json/);
});

test("status --all --json aggregates registry health and ledger counts for cron", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const oneLedger = join(fixture, "one", ".shelf", "ledger.jsonl");
  const twoLedger = join(fixture, "two", ".shelf", "ledger.jsonl");
  const dueArtifact = join(fixture, "due.txt");
  const reviewArtifact = join(fixture, "review.txt");
  const keptArtifact = join(fixture, "kept.txt");
  writeFileSync(dueArtifact, "due");
  writeFileSync(reviewArtifact, "review");
  writeFileSync(keptArtifact, "kept");

  shelf(["put", dueArtifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", oneLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  shelf(["put", reviewArtifact, "--reason", "needs eyes", "--manual-review", "--ledger", twoLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  shelf(["put", keptArtifact, "--reason", "still kept", "--retain-until", "2026-06-10T00:00:00Z", "--ledger", twoLedger, "--registry", registry], "2026-06-01T00:00:00Z");

  const result = shelf(["status", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.registryPath, registry);
  assert.equal(body.registryExists, true);
  assert.equal(body.registryOk, true);
  assert.equal(body.registryError, null);
  assert.equal(body.ledgers.length, 2);

  assert.equal(body.totals.ledgers, 2);
  assert.equal(body.totals.ok, 2);
  assert.equal(body.totals.stale, 0);
  assert.equal(body.totals.invalid, 0);
  assert.equal(body.totals.active, 3);
  assert.equal(body.totals.due, 1);
  assert.equal(body.totals.manualReview, 1);
  assert.equal(body.totals.missingPath, 0);
  assert.equal(body.totals.kept, 1);
  assert.equal(body.totals.pendingCleanup, 2);

  const one = body.ledgers.find((entry: any) => entry.name === "one");
  const two = body.ledgers.find((entry: any) => entry.name === "two");
  assert.ok(one);
  assert.ok(two);
  assert.equal(one.status, "ok");
  assert.equal(one.counts.active, 1);
  assert.equal(one.counts.due, 1);
  assert.equal(one.counts.pendingCleanup, 1);
  assert.equal(two.counts.active, 2);
  assert.equal(two.counts.manualReview, 1);
  assert.equal(two.counts.kept, 1);
  assert.equal(two.counts.pendingCleanup, 1);
});

test("status reports a single ledger's counts and never mutates state", () => {
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

  shelf(["put", kept, "--reason", "keep", "--retain-until", "2026-06-03T00:00:00Z", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  shelf(["put", due, "--reason", "due", "--retain-until", "2026-05-31T00:00:00Z", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  shelf(["put", review, "--reason", "review", "--manual-review", "--ledger", ledger], "2026-06-01T00:00:00Z");
  shelf(["put", missing, "--reason", "missing", "--ttl", "1d", "--ledger", ledger], "2026-06-01T00:00:00Z");
  rmSync(missing);

  const before = readFileSync(ledger, "utf8");
  const result = shelf(["status", "--ledger", ledger, "--json"], "2026-06-01T00:00:00Z");
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.ledger.counts.active, 4);
  assert.equal(body.ledger.counts.kept, 1);
  assert.equal(body.ledger.counts.due, 1);
  assert.equal(body.ledger.counts.manualReview, 1);
  assert.equal(body.ledger.counts.missingPath, 1);
  assert.equal(body.ledger.counts.pendingCleanup, 2);

  assert.equal(readFileSync(ledger, "utf8"), before);
  assert.equal(existsSync(join(fixture, ".shelf", "plans")), false);
  assert.equal(existsSync(join(fixture, ".shelf", "receipts")), false);
});

test("status --all reports a corrupt registry as non-zero without crashing", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  writeFileSync(registry, "{not json");

  const result = shelf(["status", "--all", "--registry", registry, "--json"]);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.registryOk, false);
  assert.equal(typeof body.registryError, "string");
});

test("status --all flags stale and invalid registered ledgers as non-zero", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const staleLedger = join(fixture, "stale", ".shelf", "ledger.jsonl");
  const badLedger = join(fixture, "bad", ".shelf", "ledger.jsonl");
  mkdirSync(join(fixture, "stale", ".shelf"), { recursive: true });
  writeFileSync(staleLedger, "");
  shelf(["ledgers", "add", "--ledger", staleLedger, "--name", "stale", "--registry", registry]);
  rmSync(staleLedger);
  mkdirSync(join(fixture, "bad", ".shelf"), { recursive: true });
  writeFileSync(badLedger, "{not json\n");
  shelf(["ledgers", "add", "--ledger", badLedger, "--name", "bad", "--registry", registry]);

  const result = shelf(["status", "--all", "--registry", registry, "--json"]);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  const stale = body.ledgers.find((entry: any) => entry.name === "stale");
  const bad = body.ledgers.find((entry: any) => entry.name === "bad");
  assert.ok(stale);
  assert.ok(bad);
  assert.equal(stale.status, "missing");
  assert.equal(bad.status, "invalid");
  assert.equal(body.totals.stale, 1);
  assert.equal(body.totals.invalid, 1);
});

test("status --all treats a machine with no registry as healthy", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "missing-registry.json");

  const result = shelf(["status", "--all", "--registry", registry, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.registryExists, false);
  assert.equal(body.registryOk, true);
  assert.equal(body.ledgers.length, 0);
  assert.equal(body.totals.ledgers, 0);
});

test("single ledger status treats a missing ledger as empty and healthy", () => {
  const fixture = fixtureDir();
  const ledger = ledgerPath(fixture);

  const result = shelf(["status", "--ledger", ledger, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.ledger.counts.active, 0);
  assert.equal(body.ledger.counts.pendingCleanup, 0);
});

test("status human output is compact enough to paste into Discord", () => {
  const fixture = fixtureDir();
  const ledger = ledgerPath(fixture);
  const due = join(fixture, "due.txt");
  const review = join(fixture, "review.txt");
  writeFileSync(due, "due");
  writeFileSync(review, "review");
  shelf(["put", due, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  shelf(["put", review, "--reason", "review", "--manual-review", "--ledger", ledger], "2026-06-01T00:00:00Z");

  const result = shelf(["status", "--ledger", ledger], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status: ok/);
  assert.match(result.stdout, /active 2/);
  assert.match(result.stdout, /due 1/);
  assert.match(result.stdout, /pending 2/);
  const lines = result.stdout.trim().split("\n");
  assert.ok(lines.length <= 4, `status human output should be short, got ${lines.length} lines`);
});

test("status help explains the command", () => {
  const main = shelf(["help"]);
  assert.match(main.stdout, /shelf status/);

  const help = shelf(["help", "status"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /shelf status/);
  assert.match(help.stdout, /--all/);
  assert.match(help.stdout, /--json/);
});

function shelf(args: string[], now?: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI.pathname, ...args], {
    encoding: "utf8",
    env: { ...process.env, SHELF_REGISTRY: TEST_REGISTRY, ...(now ? { SHELF_NOW: now } : {}) }
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function shelfAsync(args: string[], now?: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [CLI.pathname, ...args], {
      env: { ...process.env, SHELF_REGISTRY: TEST_REGISTRY, ...(now ? { SHELF_NOW: now } : {}) }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: any) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: any) => {
      stderr += chunk.toString();
    });
    child.on("close", (status: number | null) => {
      resolveResult({ status: status ?? 1, stdout, stderr });
    });
  });
}

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "shelf-test-"));
  return dir;
}

function ledgerPath(fixture: string): string {
  return join(fixture, ".shelf", "ledger.jsonl");
}

function readLedger(ledger: string): any[] {
  return readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}
