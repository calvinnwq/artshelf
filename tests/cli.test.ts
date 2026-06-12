import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const CLI = new URL("../src/cli.js", import.meta.url);
const PACKAGE_JSON = decodeURIComponent(new URL("../../package.json", import.meta.url).pathname);
const PACKAGE_VERSION = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).version;
const TEST_REGISTRY = join(mkdtempSync(join(tmpdir(), "artshelf-test-registry-")), "ledgers.json");

test("help and version are useful", () => {
  const help = artshelf(["help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, new RegExp(`Artshelf ${escapeRegExp(PACKAGE_VERSION)}`));
  assert.match(help.stdout, /-h, --help\s+Show help for artshelf or a specific command/);
  // Top-level help is short and grouped: it points to per-command help instead of
  // dumping every command variant (NGX-389).
  assert.match(help.stdout, /Available Commands:/);
  assert.match(help.stdout, /Use "artshelf <command> --help" for more information about a command\./);
  assert.doesNotMatch(help.stdout, /artshelf trash purge --older-than/);
  assert.doesNotMatch(help.stdout, /artshelf cleanup --dry-run --all/);

  const putHelp = artshelf(["put", "--help"]);
  assert.equal(putHelp.status, 0);
  assert.match(putHelp.stdout, /artshelf put <path>/);
  assert.match(putHelp.stdout, /--label <label>/);

  const resolveHelp = artshelf(["help", "resolve"]);
  assert.equal(resolveHelp.status, 0);
  assert.match(resolveHelp.stdout, /artshelf resolve <id>/);
  assert.match(resolveHelp.stdout, /--status resolved/);

  const findHelp = artshelf(["help", "find"]);
  assert.equal(findHelp.status, 0);
  assert.match(findHelp.stdout, /artshelf find/);
  assert.match(findHelp.stdout, /--path <path>/);

  const getHelp = artshelf(["help", "get"]);
  assert.equal(getHelp.status, 0);
  assert.match(getHelp.stdout, /artshelf get <id>/);

  const trashHelp = artshelf(["help", "trash"]);
  assert.equal(trashHelp.status, 0);
  assert.match(trashHelp.stdout, /Inspect and purge Artshelf trash\./);
  assert.match(trashHelp.stdout, /Usage:\n\s+artshelf trash \[command\]/);
  assert.match(trashHelp.stdout, /Available Commands:/);
  assert.match(trashHelp.stdout, /\n\s+list\s+List records currently held in Artshelf trash/);
  assert.match(trashHelp.stdout, /\n\s+purge\s+Plan or execute approved permanent trash deletion/);
  assert.match(trashHelp.stdout, /Flags:\n\s+-h, --help\s+help for trash/);
  assert.match(trashHelp.stdout, /Use "artshelf trash <command> --help" for more information about a command\./);

  const ledgersHelp = artshelf(["help", "ledgers"]);
  assert.equal(ledgersHelp.status, 0);
  assert.match(ledgersHelp.stdout, /Manage the ledger registry\./);
  assert.match(ledgersHelp.stdout, /Usage:\n\s+artshelf ledgers \[command\]/);
  assert.match(ledgersHelp.stdout, /Available Commands:/);
  assert.match(ledgersHelp.stdout, /\n\s+list\s+List and validate registered ledgers/);
  assert.match(ledgersHelp.stdout, /\n\s+add\s+Register an existing ledger file/);
  assert.match(ledgersHelp.stdout, /Flags:\n\s+-h, --help\s+help for ledgers/);
  assert.match(ledgersHelp.stdout, /Use "artshelf ledgers <command> --help" for more information about a command\./);

  const trashShorthandHelp = artshelf(["trash", "--help"]);
  assert.equal(trashShorthandHelp.status, 0);
  assert.match(trashShorthandHelp.stdout, /Inspect and purge Artshelf trash\./);

  const trashShortHelp = artshelf(["trash", "-h"]);
  assert.equal(trashShortHelp.status, 0);
  assert.match(trashShortHelp.stdout, /Inspect and purge Artshelf trash\./);

  const ledgersShorthandHelp = artshelf(["ledgers", "--help"]);
  assert.equal(ledgersShorthandHelp.status, 0);
  assert.match(ledgersShorthandHelp.stdout, /Manage the ledger registry\./);

  const ledgersShortHelp = artshelf(["ledgers", "-h"]);
  assert.equal(ledgersShortHelp.status, 0);
  assert.match(ledgersShortHelp.stdout, /Manage the ledger registry\./);

  const ledgersHelpSubcommand = artshelf(["ledgers", "help"]);
  assert.equal(ledgersHelpSubcommand.status, 0);
  assert.match(ledgersHelpSubcommand.stdout, /Manage the ledger registry\./);

  const updateHelp = artshelf(["help", "update"]);
  assert.equal(updateHelp.status, 0);
  assert.match(updateHelp.stdout, /artshelf update/);
  assert.match(updateHelp.stdout, /npm install -g artshelf@latest/);

  const version = artshelf(["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout, `artshelf ${PACKAGE_VERSION}\n`);

  const shortVersion = artshelf(["-v"]);
  assert.equal(shortVersion.status, 0);
  assert.equal(shortVersion.stdout, `artshelf ${PACKAGE_VERSION}\n`);

  const commandShortVersion = artshelf(["trash", "-v"]);
  assert.equal(commandShortVersion.status, 0);
  assert.equal(commandShortVersion.stdout, `artshelf ${PACKAGE_VERSION}\n`);
});

test("top-level help groups commands and reclassifies scope flags", () => {
  const help = artshelf(["help"]);
  assert.equal(help.status, 0);

  // One short product description and a compact usage line.
  assert.match(help.stdout, /Usage:\n\s+artshelf <command> \[options\]/);

  // Commands are grouped and listed by name with a one-line summary.
  for (const group of ["Create", "Inspect", "Review", "Clean", "System"]) {
    assert.match(help.stdout, new RegExp(`\\n\\s+${group}\\n`), `missing command group ${group}`);
  }
  assert.match(help.stdout, /\n\s+put\s+\S/);
  assert.match(help.stdout, /\n\s+due\s+\S/);
  assert.match(help.stdout, /\n\s+validate\s+\S/);
  assert.match(help.stdout, /\n\s+trash\s+\S/);

  // Only --help/--version are global; --json is presented as an output mode.
  assert.match(help.stdout, /Global Options:[\s\S]*-h, --help[\s\S]*-v, --version/);
  assert.match(help.stdout, /Output:\n\s+--json\s+Emit machine-readable JSON/);

  // --ledger/--registry/--all are reclassified as command-specific scope flags,
  // not universal global options.
  assert.match(help.stdout, /Scope \(command-specific\):/);
  assert.match(help.stdout, /--ledger <path>/);
  assert.match(help.stdout, /--registry <path>/);
  const globalBlock = help.stdout.slice(
    help.stdout.indexOf("Global Options:"),
    help.stdout.indexOf("Output:")
  );
  assert.doesNotMatch(globalBlock, /--ledger|--registry|--all/);
});

test("focused help covers due, validate, and nested trash/ledgers commands", () => {
  const due = artshelf(["due", "--help"]);
  assert.equal(due.status, 0, due.stderr);
  assert.match(due.stdout, /artshelf due \[--ledger <path>\] \[--json\]/);
  assert.match(due.stdout, /artshelf due --all/);
  assert.doesNotMatch(due.stdout, /Available Commands:/);

  const validate = artshelf(["validate", "--help"]);
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /artshelf validate \[--ledger <path>\] \[--json\]/);
  assert.match(validate.stdout, /artshelf validate --all/);
  assert.doesNotMatch(validate.stdout, /Available Commands:/);

  // Nested commands get their own focused help instead of the whole trash family.
  const trashList = artshelf(["trash", "list", "--help"]);
  assert.equal(trashList.status, 0, trashList.stderr);
  assert.match(trashList.stdout, /artshelf trash list/);
  assert.match(trashList.stdout, /Options:\n/);
  assert.match(trashList.stdout, /\s+--ledger <path>/);
  assert.match(trashList.stdout, /\s+--all/);
  assert.match(trashList.stdout, /\s+--json/);
  assert.doesNotMatch(trashList.stdout, /artshelf trash purge/);

  const trashListShortHelp = artshelf(["trash", "list", "-h"]);
  assert.equal(trashListShortHelp.status, 0, trashListShortHelp.stderr);
  assert.match(trashListShortHelp.stdout, /artshelf trash list/);
  assert.match(trashListShortHelp.stdout, /Options:\n/);

  const trashPurge = artshelf(["trash", "purge", "--help"]);
  assert.equal(trashPurge.status, 0, trashPurge.stderr);
  assert.match(trashPurge.stdout, /artshelf trash purge --execute --plan-id <id>/);
  assert.match(trashPurge.stdout, /--older-than <ttl>/);
  assert.match(trashPurge.stdout, /Options:\n/);
  assert.match(trashPurge.stdout, /\s+--older-than <ttl>/);
  assert.match(trashPurge.stdout, /\s+--dry-run/);
  assert.match(trashPurge.stdout, /\s+--execute/);
  assert.match(trashPurge.stdout, /\s+--plan-id <id>/);
  assert.match(trashPurge.stdout, /\s+--ledger <path>/);
  assert.match(trashPurge.stdout, /\s+--json/);
  assert.doesNotMatch(trashPurge.stdout, /artshelf trash list/);

  const trashPurgeShortHelp = artshelf(["trash", "purge", "-h"]);
  assert.equal(trashPurgeShortHelp.status, 0, trashPurgeShortHelp.stderr);
  assert.match(trashPurgeShortHelp.stdout, /artshelf trash purge --execute --plan-id <id>/);
  assert.match(trashPurgeShortHelp.stdout, /Options:\n/);

  const ledgersList = artshelf(["ledgers", "list", "--help"]);
  assert.equal(ledgersList.status, 0, ledgersList.stderr);
  assert.match(ledgersList.stdout, /artshelf ledgers list/);
  assert.match(ledgersList.stdout, /--plain/);
  assert.match(ledgersList.stdout, /Options:\n/);
  assert.match(ledgersList.stdout, /\s+--plain/);
  assert.match(ledgersList.stdout, /\s+--registry <path>/);
  assert.match(ledgersList.stdout, /\s+--json/);
  assert.doesNotMatch(ledgersList.stdout, /artshelf ledgers add/);

  const ledgersListShortHelp = artshelf(["ledgers", "list", "-h"]);
  assert.equal(ledgersListShortHelp.status, 0, ledgersListShortHelp.stderr);
  assert.match(ledgersListShortHelp.stdout, /artshelf ledgers list/);
  assert.match(ledgersListShortHelp.stdout, /Options:\n/);

  const ledgersAdd = artshelf(["ledgers", "add", "--help"]);
  assert.equal(ledgersAdd.status, 0, ledgersAdd.stderr);
  assert.match(ledgersAdd.stdout, /artshelf ledgers add --ledger <path>/);
  assert.match(ledgersAdd.stdout, /Options:\n/);
  assert.match(ledgersAdd.stdout, /\s+--ledger <path>/);
  assert.match(ledgersAdd.stdout, /\s+--name <name>/);
  assert.match(ledgersAdd.stdout, /\s+--scope /);
  assert.match(ledgersAdd.stdout, /\s+--json/);
  assert.doesNotMatch(ledgersAdd.stdout, /artshelf ledgers list/);

  const ledgersAddShortHelp = artshelf(["ledgers", "add", "-h"]);
  assert.equal(ledgersAddShortHelp.status, 0, ledgersAddShortHelp.stderr);
  assert.match(ledgersAddShortHelp.stdout, /artshelf ledgers add --ledger <path>/);
  assert.match(ledgersAddShortHelp.stdout, /Options:\n/);

  // `artshelf help <command> <subcommand>` routes to the same nested help.
  const helpTrashPurge = artshelf(["help", "trash", "purge"]);
  assert.equal(helpTrashPurge.status, 0);
  assert.match(helpTrashPurge.stdout, /artshelf trash purge --execute/);
  assert.match(helpTrashPurge.stdout, /Options:\n/);
  assert.doesNotMatch(helpTrashPurge.stdout, /artshelf trash list/);
});

test("commands surface an available update on stderr without breaking JSON stdout", () => {
  const fixture = fixtureDir();
  const cache = join(fixture, "update-cache.json");
  const result = artshelf(["status", "--ledger", ledgerPath(fixture), "--json"], undefined, {
    ARTSHELF_NO_UPDATE_CHECK: undefined,
    ARTSHELF_LATEST_VERSION: "99.0.0",
    ARTSHELF_UPDATE_CACHE: cache
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.match(result.stderr, new RegExp(`A new version of artshelf is available: v${escapeRegExp(PACKAGE_VERSION)} -> v99\\.0\\.0`));
  assert.match(result.stderr, /Run "artshelf update" to update npm installs/);
});

test("commands stay quiet when the current version is the latest", () => {
  const fixture = fixtureDir();
  const result = artshelf(["--version"], undefined, {
    ARTSHELF_NO_UPDATE_CHECK: undefined,
    ARTSHELF_LATEST_VERSION: PACKAGE_VERSION,
    ARTSHELF_UPDATE_CACHE: join(fixture, "update-cache.json")
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `artshelf ${PACKAGE_VERSION}\n`);
  assert.equal(result.stderr, "");
});

test("update dry-run reports the npm update command", () => {
  const result = artshelf(["update"], undefined, {
    ARTSHELF_LATEST_VERSION: "99.0.0",
    ARTSHELF_UPDATE_DRY_RUN: "1"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`A new version of artshelf is available: v${escapeRegExp(PACKAGE_VERSION)} -> v99\\.0\\.0`));
  assert.match(result.stdout, /Dry run: would run "npm install -g artshelf@latest"/);
  assert.equal(result.stderr, "");

  const json = artshelf(["update", "--json"], undefined, {
    ARTSHELF_LATEST_VERSION: "99.0.0",
    ARTSHELF_UPDATE_DRY_RUN: "1"
  });
  assert.equal(json.status, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.dryRun, true);
  assert.deepEqual(body.command, ["npm", "install", "-g", "artshelf@latest"]);
});

test("update json returns the installer exit code on failure", () => {
  const fixture = fixtureDir();
  const bin = join(fixture, "bin");
  mkdirSync(bin, { recursive: true });
  const npm = join(bin, "npm");
  writeFileSync(npm, "#!/bin/sh\nprintf 'fake stdout\\n'\nprintf 'fake stderr\\n' >&2\nexit 17\n");
  chmodSync(npm, 0o755);

  const result = artshelf(["update", "--json"], undefined, {
    ARTSHELF_LATEST_VERSION: "99.0.0",
    PATH: `${bin}:${process.env.PATH ?? ""}`
  });

  assert.equal(result.status, 17);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.updated, false);
  assert.match(body.stdout, /fake stdout/);
  assert.match(body.stderr, /fake stderr/);
});

test("update reports npm spawn errors", () => {
  const fixture = fixtureDir();
  const bin = join(fixture, "bin");
  mkdirSync(bin, { recursive: true });

  const json = artshelf(["update", "--json"], undefined, {
    ARTSHELF_LATEST_VERSION: "99.0.0",
    PATH: bin
  });
  assert.equal(json.status, 1);
  const body = JSON.parse(json.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.updated, false);
  assert.match(body.stderr, /spawnSync npm/);

  const human = artshelf(["update"], undefined, {
    ARTSHELF_LATEST_VERSION: "99.0.0",
    PATH: bin
  });
  assert.equal(human.status, 1);
  assert.match(human.stderr, /Update failed: spawnSync npm/);
});

test("failed update checks are cached for the TTL", () => {
  const fixture = fixtureDir();
  const cache = join(fixture, "update-cache.json");
  const env = {
    ARTSHELF_NO_UPDATE_CHECK: undefined,
    ARTSHELF_NPM_REGISTRY_URL: "http://127.0.0.1:1/artshelf/latest",
    ARTSHELF_UPDATE_CACHE: cache,
    ARTSHELF_UPDATE_CHECK_TTL_MS: "60000"
  };

  const first = artshelf(["--version"], undefined, env);
  assert.equal(first.status, 0, first.stderr);
  const failedCache = JSON.parse(readFileSync(cache, "utf8"));
  assert.equal(failedCache.latest, null);
  assert.equal(typeof failedCache.checkedAt, "number");

  const checkedAt = Date.now();
  writeFileSync(cache, `${JSON.stringify({ latest: null, checkedAt }, null, 2)}\n`);
  const second = artshelf(["--version"], undefined, env);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(readFileSync(cache, "utf8")).checkedAt, checkedAt);
});

test("unknown flags fail with a usage hint", () => {
  const result = artshelf(["put", "/tmp", "--bogus"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown flag: --bogus/);
  assert.match(result.stderr, /artshelf help/);
});

test("put refuses a missing path", () => {
  const fixture = fixtureDir();
  const result = artshelf(["put", join(fixture, "missing"), "--reason", "debug", "--ttl", "1d", "--ledger", ledgerPath(fixture)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Path does not exist/);
});

test("put requires a reason and retention choice", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");

  assert.match(artshelf(["put", artifact, "--ttl", "1d", "--ledger", ledgerPath(fixture)]).stderr, /Missing required --reason/);
  assert.match(artshelf(["put", artifact, "--reason", "debug", "--ledger", ledgerPath(fixture)]).stderr, /Choose exactly one/);
});

test("put appends JSONL and list emits human and JSON output", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");

  const put = artshelf([
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

  const listed = artshelf(["list", "--ledger", ledgerPath(fixture)]).stdout;
  assert.match(listed, /debug parser output/);
  assert.match(listed, /active trash/);
  assert.match(listed, /ledger:/);
  assert.equal(JSON.parse(artshelf(["list", "--ledger", ledgerPath(fixture), "--json"]).stdout).entries.length, 1);
  assert.equal(JSON.parse(artshelf(["list", "--status", "active", "--ledger", ledgerPath(fixture), "--json"]).stdout).entries.length, 1);
  assert.equal(JSON.parse(artshelf(["list", "--status", "resolved", "--ledger", ledgerPath(fixture), "--json"]).stdout).entries.length, 0);
});

test("default storage paths use Artshelf names", () => {
  const fixture = fixtureDir();
  const home = join(fixture, "home");
  const repo = join(fixture, "repo");
  const artifact = join(repo, "artifact.txt");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(artifact, "hello");
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, ARTSHELF_NOW: "2026-06-01T00:00:00Z" };
  delete env.ARTSHELF_REGISTRY;
  delete env.SHELF_REGISTRY;

  const result = spawnSync(process.execPath, [
    CLI.pathname,
    "put",
    artifact,
    "--reason",
    "default path smoke",
    "--ttl",
    "1d",
    "--json"
  ], {
    cwd: repo,
    encoding: "utf8",
    env
  });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  const expectedLedgerPath = join(realpathSync(repo), ".artshelf", "ledger.jsonl");
  assert.equal(body.ledger.path, expectedLedgerPath);
  const registryPath = join(home, ".artshelf", "ledgers.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  assert.equal(registry.ledgers[0].path, expectedLedgerPath);
});

test("find and get provide read-only idempotency queries", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  const otherArtifact = join(fixture, "other.txt");
  const ledger = ledgerPath(fixture);
  writeFileSync(artifact, "hello");
  writeFileSync(otherArtifact, "other");

  const put = JSON.parse(artshelf([
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
  artshelf([
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

  const found = JSON.parse(artshelf([
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

  const noMatch = JSON.parse(artshelf(["find", "--label", "missing", "--ledger", ledger, "--json"]).stdout);
  assert.deepEqual(noMatch.entries, []);

  const get = JSON.parse(artshelf(["get", put.record.id, "--ledger", ledger, "--json"]).stdout);
  assert.equal(get.record.path, artifact);
  assert.equal(get.record.reason, "workflow evidence");

  const missingGet = artshelf(["get", "shf_missing", "--ledger", ledger]);
  assert.equal(missingGet.status, 1);
  assert.match(missingGet.stderr, /Artshelf record not found/);

  const unbounded = artshelf(["find", "--ledger", ledger]);
  assert.equal(unbounded.status, 1);
  assert.match(unbounded.stderr, /find requires at least one/);
});

test("ledger registry gives one read-only entry point across ledgers", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const firstLedger = join(fixture, "one", ".artshelf", "ledger.jsonl");
  const secondLedger = join(fixture, "two", ".artshelf", "ledger.jsonl");
  const firstArtifact = join(fixture, "first.txt");
  const secondArtifact = join(fixture, "second.txt");
  writeFileSync(firstArtifact, "first");
  writeFileSync(secondArtifact, "second");

  const put = JSON.parse(artshelf([
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

  mkdirSync(join(fixture, "two", ".artshelf"), { recursive: true });
  writeFileSync(secondLedger, "");
  const add = JSON.parse(artshelf([
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

  artshelf([
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

  const ledgers = JSON.parse(artshelf(["ledgers", "list", "--registry", registry, "--json"]).stdout).ledgers;
  assert.deepEqual(ledgers.map((ledger: any) => ledger.name), ["one", "second"]);

  const allList = JSON.parse(artshelf(["list", "--all", "--registry", registry, "--json"]).stdout);
  assert.equal(allList.ledgers.length, 2);
  assert.equal(allList.ledgers.reduce((count: number, ledger: any) => count + ledger.entries.length, 0), 2);

  const allFind = JSON.parse(artshelf(["find", "--all", "--owner", "openclaw", "--label", "registry-smoke", "--registry", registry, "--json"]).stdout);
  assert.equal(allFind.ledgers.reduce((count: number, ledger: any) => count + ledger.entries.length, 0), 2);

  const allGet = JSON.parse(artshelf(["get", put.record.id, "--all", "--registry", registry, "--json"]).stdout);
  assert.equal(allGet.ledger.path, firstLedger);
  assert.equal(allGet.record.id, put.record.id);

  const allDue = JSON.parse(artshelf(["due", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z").stdout);
  assert.deepEqual(allDue.ledgers.flatMap((ledger: any) => ledger.entries.map((entry: any) => entry.dueStatus)).sort(), ["due", "manual-review"]);

  const allValidate = JSON.parse(artshelf(["validate", "--all", "--registry", registry, "--json"]).stdout);
  assert.equal(allValidate.ok, true);

  const review = JSON.parse(artshelf(["review", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z").stdout);
  assert.equal(review.ok, true);
  assert.equal(review.ledgers.length, 2);
  assert.equal(review.ledgers.reduce((count: number, ledger: any) => count + ledger.plan.entries.length, 0), 2);
  for (const entry of review.ledgers) {
    assert.equal(existsSync(entry.plan.planPath), false);
  }

  const dryRun = JSON.parse(artshelf(["cleanup", "--dry-run", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z").stdout);
  assert.equal(dryRun.plans.length, 2);
  assert.equal(dryRun.plans.reduce((count: number, entry: any) => count + entry.plan.entries.length, 0), 2);

  const refused = artshelf(["cleanup", "--execute", "--all", "--plan-id", "plan_nope", "--registry", registry]);
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

  const result = artshelf([
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

  const jsonResult = artshelf([
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
  const missing = join(fixture, "missing", ".artshelf", "ledger.jsonl");

  const result = artshelf(["ledgers", "add", "--ledger", missing, "--registry", registry]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Ledger does not exist/);
  assert.equal(existsSync(registry), false);
});

test("ledgers add falls back from blank names to inferred names", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const ledger = join(fixture, "repo", ".artshelf", "ledger.jsonl");
  mkdirSync(join(fixture, "repo", ".artshelf"), { recursive: true });
  writeFileSync(ledger, "");

  const result = artshelf(["ledgers", "add", "--ledger", ledger, "--name", "   ", "--registry", registry, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ledger.name, "repo");

  const list = JSON.parse(artshelf(["ledgers", "list", "--registry", registry, "--json"]).stdout);
  assert.deepEqual(list.ledgers.map((entry: any) => entry.name), ["repo"]);
});

test("ledgers list --json reports validation status so agents detect stale entries without a separate validate pass", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const goodLedger = join(fixture, "good", ".artshelf", "ledger.jsonl");
  const staleLedger = join(fixture, "stale", ".artshelf", "ledger.jsonl");
  const brokenLedger = join(fixture, "broken", ".artshelf", "ledger.jsonl");
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");

  artshelf(["put", artifact, "--reason", "healthy", "--ttl", "7d", "--ledger", goodLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  mkdirSync(join(fixture, "stale", ".artshelf"), { recursive: true });
  writeFileSync(staleLedger, "");
  artshelf(["ledgers", "add", "--ledger", staleLedger, "--name", "stale", "--registry", registry]);
  rmSync(staleLedger);
  mkdirSync(join(fixture, "broken", ".artshelf"), { recursive: true });
  writeFileSync(brokenLedger, "{not json\n");
  artshelf(["ledgers", "add", "--ledger", brokenLedger, "--name", "broken", "--registry", registry]);

  const result = artshelf(["ledgers", "list", "--registry", registry, "--json"]);
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
  const goodLedger = join(fixture, "good", ".artshelf", "ledger.jsonl");
  const staleLedger = join(fixture, "stale", ".artshelf", "ledger.jsonl");
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");

  artshelf(["put", artifact, "--reason", "healthy", "--ttl", "7d", "--ledger", goodLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  mkdirSync(join(fixture, "stale", ".artshelf"), { recursive: true });
  writeFileSync(staleLedger, "");
  artshelf(["ledgers", "add", "--ledger", staleLedger, "--name", "stale", "--registry", registry]);
  rmSync(staleLedger);

  const result = artshelf(["ledgers", "list", "--registry", registry]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /artshelf ledgers: needs attention/);
  assert.match(result.stdout, /1 ledgers? ok|1 ok/);
  assert.match(result.stdout, /\[stale\] missing/);
  assert.match(result.stdout, /\[good\] ok/);
  assert.match(result.stdout, /registry:/);
});

test("ledgers list --plain preserves the fast plain listing path", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const goodLedger = join(fixture, "good", ".artshelf", "ledger.jsonl");
  const staleLedger = join(fixture, "stale", ".artshelf", "ledger.jsonl");
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");

  artshelf(["put", artifact, "--reason", "healthy", "--ttl", "7d", "--ledger", goodLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  mkdirSync(join(fixture, "stale", ".artshelf"), { recursive: true });
  writeFileSync(staleLedger, "");
  artshelf(["ledgers", "add", "--ledger", staleLedger, "--name", "stale", "--registry", registry]);
  rmSync(staleLedger);

  // Plain mode does not read ledger files, so a stale entry never makes it exit non-zero.
  const json = artshelf(["ledgers", "list", "--plain", "--registry", registry, "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.equal(body.ok, true);
  assert.deepEqual(body.ledgers.map((entry: any) => entry.name), ["good", "stale"]);
  assert.equal("status" in body.ledgers[0], false);
  assert.equal("summary" in body, false);

  const human = artshelf(["ledgers", "list", "--plain", "--registry", registry]);
  assert.equal(human.status, 0, human.stderr);
  assert.doesNotMatch(human.stdout, /needs attention/);
  assert.match(human.stdout, /good repo .*\.artshelf/);
  assert.match(human.stdout, /registry:/);
});

test("review reports invalid registered ledgers without aborting", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const goodLedger = join(fixture, "good", ".artshelf", "ledger.jsonl");
  const badLedger = join(fixture, "bad", ".artshelf", "ledger.jsonl");
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");

  artshelf([
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
  mkdirSync(join(fixture, "bad", ".artshelf"), { recursive: true });
  writeFileSync(badLedger, "{not json\n");
  artshelf(["ledgers", "add", "--ledger", badLedger, "--name", "bad", "--registry", registry]);

  const result = artshelf(["review", "--all", "--registry", registry, "--json"]);
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
  const ledger = join(fixture, "repo", ".artshelf", "ledger.jsonl");
  mkdirSync(join(fixture, "repo", ".artshelf"), { recursive: true });
  writeFileSync(ledger, "");
  artshelf(["ledgers", "add", "--ledger", ledger, "--registry", registry]);
  rmSync(ledger);

  const result = artshelf(["validate", "--all", "--registry", registry, "--json"]);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.match(body.ledgers[0].result.errors[0], /registered ledger is missing/);

  const human = artshelf(["validate", "--all", "--registry", registry]);
  assert.equal(human.status, 1);
  assert.match(human.stdout, /error: registered ledger is missing/);

  for (const args of [
    ["list", "--all", "--registry", registry, "--json"],
    ["find", "--all", "--owner", "openclaw", "--registry", registry, "--json"],
    ["get", "shf_missing", "--all", "--registry", registry, "--json"],
    ["due", "--all", "--registry", registry, "--json"]
  ]) {
    const stale = artshelf(args);
    assert.equal(stale.status, 1, `${args.join(" ")} should report stale registry entries`);
    const staleBody = JSON.parse(stale.stdout);
    assert.equal(staleBody.ok, false);
    assert.match(staleBody.ledgers[0].result.errors[0], /registered ledger is missing/);
  }
});

test("single ledger review treats a missing ledger as empty", () => {
  const fixture = fixtureDir();
  const ledger = ledgerPath(fixture);

  const result = artshelf(["review", "--ledger", ledger, "--json"]);
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
  const oneLedger = join(fixture, "one", ".artshelf", "ledger.jsonl");
  const twoLedger = join(fixture, "two", ".artshelf", "ledger.jsonl");
  const dueArtifact = join(fixture, "due.txt");
  const reviewArtifact = join(fixture, "review.txt");
  const keptArtifact = join(fixture, "kept.txt");
  writeFileSync(dueArtifact, "due");
  writeFileSync(reviewArtifact, "review");
  writeFileSync(keptArtifact, "kept");

  artshelf(["put", dueArtifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", oneLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  artshelf(["put", reviewArtifact, "--reason", "needs eyes", "--manual-review", "--ledger", twoLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  artshelf(["put", keptArtifact, "--reason", "still kept", "--retain-until", "2026-06-10T00:00:00Z", "--ledger", twoLedger, "--registry", registry], "2026-06-01T00:00:00Z");

  const result = artshelf(["review", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z");
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
  const oneLedger = join(fixture, "one", ".artshelf", "ledger.jsonl");
  const twoLedger = join(fixture, "two", ".artshelf", "ledger.jsonl");
  const dueArtifact = join(fixture, "due.txt");
  const reviewArtifact = join(fixture, "review.txt");
  writeFileSync(dueArtifact, "due");
  writeFileSync(reviewArtifact, "review");

  artshelf(["put", dueArtifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", oneLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  artshelf(["put", reviewArtifact, "--reason", "needs eyes", "--manual-review", "--ledger", twoLedger, "--registry", registry], "2026-06-01T00:00:00Z");

  const result = artshelf(["review", "--all", "--registry", registry], "2026-06-03T00:00:00Z");
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
  const oneLedger = join(fixture, "one", ".artshelf", "ledger.jsonl");
  const dueArtifact = join(fixture, "due.txt");
  writeFileSync(dueArtifact, "due");

  artshelf(["put", dueArtifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", oneLedger, "--registry", registry], "2026-06-01T00:00:00Z");

  const before = readFileSync(oneLedger, "utf8");
  const result = artshelf(["review", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.summary.executable, 1);
  assert.equal(body.ledgers[0].plan.entries.length, 1);

  // Read-only proof: the computed plan path is never written, and the ledger is untouched.
  assert.equal(existsSync(join(fixture, "one", ".artshelf", "plans")), false);
  assert.equal(existsSync(body.ledgers[0].plan.planPath), false);
  assert.equal(readFileSync(oneLedger, "utf8"), before);
});

test("review --all reports all clear and nothing to do when no ledger needs attention", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const oneLedger = join(fixture, "one", ".artshelf", "ledger.jsonl");
  const keptArtifact = join(fixture, "kept.txt");
  writeFileSync(keptArtifact, "kept");

  artshelf(["put", keptArtifact, "--reason", "still kept", "--retain-until", "2026-06-10T00:00:00Z", "--cleanup", "trash", "--ledger", oneLedger, "--registry", registry], "2026-06-01T00:00:00Z");

  const result = artshelf(["review", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z");
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

  const human = artshelf(["review", "--all", "--registry", registry], "2026-06-03T00:00:00Z");
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /review --all: all clear/);
  assert.match(human.stdout, /next: nothing to do/);
});

test("cleanup all refuses invalid ledgers before writing any plans", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const goodLedger = join(fixture, "good", ".artshelf", "ledger.jsonl");
  const badLedger = join(fixture, "bad", ".artshelf", "ledger.jsonl");
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  artshelf([
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
  mkdirSync(join(fixture, "bad", ".artshelf"), { recursive: true });
  writeFileSync(badLedger, "{not json\n");
  artshelf(["ledgers", "add", "--ledger", badLedger, "--name", "bad", "--registry", registry]);

  const result = artshelf(["cleanup", "--dry-run", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(existsSync(join(fixture, "good", ".artshelf", "plans")), false);
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
      join(fixture, `repo-${index}`, ".artshelf", "ledger.jsonl"),
      "--registry",
      registry,
      "--json"
    ]);
  });

  const results = await Promise.all(jobs);
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
  }

  const ledgers = JSON.parse(artshelf(["ledgers", "list", "--registry", registry, "--json"]).stdout).ledgers;
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

  artshelf(["put", kept, "--reason", "keep", "--retain-until", "2026-06-03T00:00:00Z", "--ledger", ledger], "2026-06-01T00:00:00Z");
  artshelf(["put", due, "--reason", "due", "--retain-until", "2026-05-31T00:00:00Z", "--ledger", ledger], "2026-06-01T00:00:00Z");
  artshelf(["put", review, "--reason", "review", "--manual-review", "--ledger", ledger], "2026-06-01T00:00:00Z");
  artshelf(["put", missing, "--reason", "missing", "--ttl", "1d", "--ledger", ledger], "2026-06-01T00:00:00Z");

  rmSync(missing);
  const entries = JSON.parse(artshelf(["due", "--ledger", ledger, "--json"], "2026-06-01T00:00:00Z").stdout).entries;
  assert.deepEqual(entries.map((entry: any) => entry.dueStatus).sort(), ["due", "kept", "manual-review", "missing-path"]);
  assert.match(artshelf(["due", "--ledger", ledger], "2026-06-01T00:00:00Z").stdout, /due .*due\.txt/);
});

test("validate reports shape errors and missing paths as warnings", () => {
  const fixture = fixtureDir();
  const ledger = ledgerPath(fixture);
  mkdirSync(join(fixture, ".artshelf"), { recursive: true });
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

  const result = artshelf(["validate", "--ledger", ledger, "--json"]);
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

  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  const refusal = artshelf(["cleanup", "--execute", "--ledger", ledger]);
  assert.equal(refusal.status, 1);
  assert.match(refusal.stderr, /Missing required --plan-id/);

  const dryRun = artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z");
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const plan = JSON.parse(dryRun.stdout).plan;
  assert.equal(plan.entries.length, 1);
  assert.equal(existsSync(plan.planPath), true);
  const afterDryRun = readLedger(ledger);
  assert.equal(afterDryRun.length, 2);
  assert.equal(afterDryRun[1]?.owner, "artshelf");
  assert.equal(afterDryRun[1]?.kind, "run-artifact");
  assert.equal(afterDryRun[1]?.cleanup, "trash");
  assert.deepEqual(afterDryRun[1]?.labels, ["artshelf", "cleanup-plan", plan.planId]);
  assert.equal(afterDryRun[1]?.path, plan.planPath);

  const executed = artshelf(["cleanup", "--execute", "--plan-id", plan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:01:00Z");
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
  assert.equal(records[1]?.reason, `Artshelf cleanup dry-run plan ${plan.planId}`);
  assert.equal(records[2]?.reason, `Artshelf cleanup receipt for plan ${plan.planId}`);
  assert.equal(records[2]?.path, receipt.receiptPath);
  assert.equal(records[2]?.cleanup, "review");
  assert.deepEqual(records[2]?.labels, ["artshelf", "cleanup-receipt", plan.planId]);

  const replayed = artshelf(["cleanup", "--execute", "--plan-id", plan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:02:00Z");
  assert.equal(replayed.status, 0, replayed.stderr);
  assert.equal(JSON.parse(replayed.stdout).receipt.results[0].status, "skipped");
  const afterReplay = readLedger(ledger);
  const receiptRecords = afterReplay.filter((entry: any) => entry.owner === "artshelf" && entry.labels.includes("cleanup-receipt"));
  assert.equal(receiptRecords.length, 1);
  assert.equal(receiptRecords[0].createdAt, "2026-06-03T00:02:00Z");
  assert.equal(receiptRecords[0].retainUntil, "2026-07-03T00:02:00Z");

  const due = JSON.parse(artshelf(["due", "--ledger", ledger, "--json"], "2026-06-04T00:00:00Z").stdout).entries;
  assert.deepEqual(due.map((entry: any) => entry.reason), [
    `Artshelf cleanup dry-run plan ${plan.planId}`,
    `Artshelf cleanup receipt for plan ${plan.planId}`
  ]);
  assert.deepEqual(due.map((entry: any) => entry.dueStatus), ["kept", "kept"]);

  const followupPlan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-04T00:00:00Z").stdout).plan;
  assert.equal(followupPlan.planId, "not-created");
  assert.equal(followupPlan.planPath, null);
  assert.equal(followupPlan.entries.length, 0);
  assert.equal(followupPlan.skipped.length, 2);
  assert.equal(existsSync(join(fixture, ".artshelf", "plans", "not-created.json")), false);
  assert.equal(JSON.parse(artshelf(["validate", "--ledger", ledger, "--json"]).stdout).ok, true);
});

test("cleanup dry-run reuses an unchanged existing plan", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");

  const first = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  const second = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-04T00:00:00Z").stdout).plan;

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
  const planRecords = records.filter((record: any) => record.owner === "artshelf" && record.labels.includes("cleanup-plan"));
  assert.equal(planRecords.length, 1);
  assert.equal(planRecords[0].createdAt, "2026-06-04T00:00:00Z");
  assert.equal(planRecords[0].retainUntil, "2026-06-18T00:00:00Z");

  const executed = artshelf(["cleanup", "--execute", "--plan-id", first.planId, "--ledger", ledger, "--json"], "2026-06-04T00:01:00Z");
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(JSON.parse(executed.stdout).receipt.results[0].status, "trashed");
});

test("cleanup dry-run migrates legacy Shelf-owned plan records instead of duplicating them", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  const first = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  const legacyRecords = readLedger(ledger).map((record) => record.owner === "artshelf" ? {
    ...record,
    owner: "shelf",
    labels: record.labels.map((label: string) => label === "artshelf" ? "shelf" : label)
  } : record);
  writeFileSync(ledger, legacyRecords.map((record) => JSON.stringify(record)).join("\n") + "\n");

  const second = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-04T00:00:00Z").stdout).plan;
  assert.equal(second.planId, first.planId);

  const records = readLedger(ledger);
  const planRecords = records.filter((record: any) => record.path === first.planPath);
  assert.equal(planRecords.length, 1);
  assert.equal(planRecords[0].owner, "artshelf");
  assert.deepEqual(planRecords[0].labels, ["artshelf", "cleanup-plan", first.planId]);
  assert.equal(planRecords[0].createdAt, "2026-06-04T00:00:00Z");
});

test("cleanup execute records review and refused outcomes as terminal ledger state", () => {
  const fixture = fixtureDir();
  const review = join(fixture, "review.txt");
  const refused = join(fixture, "refused.txt");
  writeFileSync(review, "review");
  writeFileSync(refused, "refused");
  const ledger = ledgerPath(fixture);

  artshelf(["put", review, "--reason", "needs eyes", "--manual-review", "--cleanup", "review", "--ledger", ledger], "2026-06-01T00:00:00Z");
  artshelf(["put", refused, "--reason", "delete later", "--ttl", "1d", "--cleanup", "delete", "--ledger", ledger], "2026-06-01T00:00:00Z");

  const plan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  assert.equal(plan.entries.length, 2);

  const receipt = JSON.parse(artshelf(["cleanup", "--execute", "--plan-id", plan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:01:00Z").stdout).receipt;
  assert.deepEqual(receipt.results.map((result: any) => result.status).sort(), ["refused", "review-required"]);

  const records = readLedger(ledger);
  const handled = records.filter((record: any) => record.owner !== "artshelf");
  const shelfArtifacts = records.filter((record: any) => record.owner === "artshelf");
  assert.deepEqual(handled.map((record: any) => record.status).sort(), ["cleanup-refused", "review-required"]);
  assert.equal(handled.every((record: any) => record.cleanupPlanId === plan.planId), true);
  assert.equal(handled.every((record: any) => record.receiptPath === receipt.receiptPath), true);
  assert.equal(handled.every((record: any) => record.cleanedAt === "2026-06-03T00:01:00Z"), true);
  assert.deepEqual(shelfArtifacts.map((record: any) => record.reason), [
    `Artshelf cleanup dry-run plan ${plan.planId}`,
    `Artshelf cleanup receipt for plan ${plan.planId}`
  ]);
  assert.equal(existsSync(review), true);
  assert.equal(existsSync(refused), true);

  const followupPlan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-04T00:00:00Z").stdout).plan;
  assert.equal(followupPlan.planId, "not-created");
  assert.equal(followupPlan.planPath, null);
  assert.equal(followupPlan.entries.length, 0);
});

test("trash list reports trashed entries with target/receipt/plan metadata and age", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  const plan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  const execute = JSON.parse(artshelf(["cleanup", "--execute", "--plan-id", plan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:01:00Z").stdout).receipt;
  const purgedEntry = readLedger(ledger).find((entry) => entry.status === "trashed");
  assert.ok(purgedEntry);

  const listed = JSON.parse(artshelf(["trash", "list", "--ledger", ledger, "--json"]).stdout);
  assert.equal(listed.entries.length, 1);
  const listedEntry = listed.entries[0];
  assert.equal(listedEntry.id, purgedEntry.id);
  assert.equal(listedEntry.targetPath, execute.results[0].target);
  assert.equal(listedEntry.receiptPath, execute.receiptPath);
  assert.equal(listedEntry.cleanupPlanId, plan.planId);
  assert.equal(typeof listedEntry.age, "string");
  assert.match(listedEntry.age, /\d+[dhm](\s\d+[dhm])*/);
  assert.equal(existsSync(execute.results[0].target), true);
});

test("trash list --all aggregates trashed records across a registry", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const artifactOne = join(fixture, "artifact-1.txt");
  const artifactTwo = join(fixture, "artifact-2.txt");
  const ledgerOne = ledgerPath(join(fixture, "one"));
  const ledgerTwo = ledgerPath(join(fixture, "two"));
  writeFileSync(artifactOne, "hello one");
  writeFileSync(artifactTwo, "hello two");

  artshelf(["ledgers", "add", "--ledger", ledgerOne, "--name", "one", "--registry", registry]);
  artshelf(["ledgers", "add", "--ledger", ledgerTwo, "--name", "two", "--registry", registry]);
  artshelf(["put", artifactOne, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledgerOne, "--registry", registry], "2026-06-01T00:00:00Z");
  artshelf(["put", artifactTwo, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledgerTwo, "--registry", registry], "2026-06-01T00:00:00Z");

  const cleanupOne = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledgerOne, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  const cleanupTwo = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledgerTwo, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  const receiptOne = JSON.parse(artshelf(["cleanup", "--execute", "--plan-id", cleanupOne.planId, "--ledger", ledgerOne, "--json"], "2026-06-03T00:01:00Z").stdout).receipt;
  const receiptTwo = JSON.parse(artshelf(["cleanup", "--execute", "--plan-id", cleanupTwo.planId, "--ledger", ledgerTwo, "--json"], "2026-06-03T00:01:00Z").stdout).receipt;

  const listed = JSON.parse(artshelf(["trash", "list", "--all", "--registry", registry, "--json"], "2026-06-03T00:02:00Z").stdout);
  assert.equal(listed.ledgers.length, 2);
  assert.equal(listed.ledgers[0].ledger.name, "one");
  assert.equal(listed.ledgers[1].ledger.name, "two");
  assert.equal(listed.ledgers[0].entries.length, 1);
  assert.equal(listed.ledgers[1].entries.length, 1);

  assert.equal(listed.ledgers[0].entries[0].receiptPath, receiptOne.receiptPath);
  assert.equal(listed.ledgers[1].entries[0].receiptPath, receiptTwo.receiptPath);
});

test("trash list fails loudly for malformed trashed records", () => {
  const fixture = fixtureDir();
  const ledger = ledgerPath(fixture);
  mkdirSync(dirname(ledger), { recursive: true });
  writeFileSync(ledger, `${JSON.stringify({ id: "broken", path: fixture, status: "trashed" })}\n`);

  const listed = artshelf(["trash", "list", "--ledger", ledger], "2026-06-03T00:02:00Z");
  assert.equal(listed.status, 1);
  assert.match(listed.stderr, /trashed record broken missing cleanup metadata/);
});

test("trash purge refuses execution without review and refuses --all execution", () => {
  const fixture = fixtureDir();
  const ledger = ledgerPath(fixture);
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");

  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  const barePreview = artshelf(["trash", "purge", "--older-than", "1h", "--ledger", ledger], "2026-06-03T00:01:00Z");
  assert.equal(barePreview.status, 1);
  assert.match(barePreview.stderr, /trash purge requires either --dry-run or --execute/);

  const missing = artshelf(["trash", "purge", "--execute", "--ledger", ledger], "2026-06-03T00:01:00Z");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing required --plan-id/);

  const unreviewed = artshelf(["trash", "purge", "--execute", "--plan-id", "purge_missing", "--ledger", ledger], "2026-06-03T00:01:00Z");
  assert.equal(unreviewed.status, 1);
  assert.match(unreviewed.stderr, /Trash purge plan not found/);
  const unsafePlanId = artshelf(["trash", "purge", "--execute", "--plan-id", "../purge_escape", "--ledger", ledger], "2026-06-03T00:01:00Z");
  assert.equal(unsafePlanId.status, 1);
  assert.match(unsafePlanId.stderr, /Invalid trash purge plan id/);

  const allExecute = artshelf(["trash", "purge", "--all", "--execute", "--plan-id", "purge_missing", "--registry", join(fixture, "registry.json")], "2026-06-03T00:01:00Z");
  assert.equal(allExecute.status, 1);
  assert.match(allExecute.stderr, /trash purge --all is not supported/);
  const allDryRun = artshelf(["trash", "purge", "--older-than", "1h", "--all", "--ledger", ledger], "2026-06-03T00:01:00Z");
  assert.equal(allDryRun.status, 1);
  assert.match(allDryRun.stderr, /trash purge --all is not supported/);
});

test("trash purge dry-run then execute deletes trashed targets and updates ledger records", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  const cleanupPlan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  const cleanupReceipt = JSON.parse(artshelf(["cleanup", "--execute", "--plan-id", cleanupPlan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:01:00Z").stdout).receipt;
  const trashedId = cleanupReceipt.results[0].id;
  const trashedPath = cleanupReceipt.results[0].target;

  assert.equal(existsSync(trashedPath), true);

  const purgePlan = JSON.parse(artshelf(["trash", "purge", "--older-than", "1h", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T02:00:00Z").stdout).plan;
  assert.equal(purgePlan.entries.length, 1);
  assert.equal(purgePlan.entries[0].id, trashedId);
  assert.equal(purgePlan.entries[0].targetPath, trashedPath);
  assert.equal(purgePlan.entries[0].cleanupPlanId, cleanupPlan.planId);
  assert.equal(purgePlan.entries[0].receiptPath, cleanupReceipt.receiptPath);

  const result = JSON.parse(artshelf(["trash", "purge", "--execute", "--plan-id", purgePlan.purgePlanId, "--ledger", ledger, "--json"], "2026-06-03T02:01:00Z").stdout).receipt;
  assert.equal(result.results[0].status, "purged");
  assert.equal(existsSync(trashedPath), false);
  const receiptFile = JSON.parse(readFileSync(result.receiptPath, "utf8"));
  assert.equal(receiptFile.status, undefined);
  assert.equal(receiptFile.completedAt, "2026-06-03T02:01:00Z");

  const ledgerEntries = readLedger(ledger);
  const record = ledgerEntries.find((entry) => entry.id === trashedId);
  assert.ok(record);
  assert.equal(record.status, "resolved");
  assert.equal(record.purgePlanId, purgePlan.purgePlanId);
  assert.equal(record.purgeReceiptPath, result.receiptPath);
  assert.equal(record.resolutionReason, "trash purge completed");
  assert.equal(record.resolvedAt, "2026-06-03T02:01:00Z");
  const receiptBeforeRepeat = readFileSync(result.receiptPath, "utf8");
  const repeated = artshelf(["trash", "purge", "--execute", "--plan-id", purgePlan.purgePlanId, "--ledger", ledger, "--json"], "2026-06-03T02:02:00Z");
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /Trash purge receipt already exists/);
  assert.equal(readFileSync(result.receiptPath, "utf8"), receiptBeforeRepeat);
});

test("trash purge execute skips stale plans and targets outside Artshelf trash", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  const outside = join(fixture, "outside.txt");
  writeFileSync(artifact, "hello");
  writeFileSync(outside, "do not delete");
  const ledger = ledgerPath(fixture);

  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  const cleanupPlan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  const cleanupReceipt = JSON.parse(artshelf(["cleanup", "--execute", "--plan-id", cleanupPlan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:01:00Z").stdout).receipt;
  const trashedPath = cleanupReceipt.results[0].target;

  const stalePlan = JSON.parse(artshelf(["trash", "purge", "--older-than", "1h", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T02:00:00Z").stdout).plan;
  stalePlan.entries[0].targetPath = outside;
  writeFileSync(stalePlan.planPath, `${JSON.stringify(stalePlan, null, 2)}\n`);

  const staleResult = JSON.parse(artshelf(["trash", "purge", "--execute", "--plan-id", stalePlan.purgePlanId, "--ledger", ledger, "--json"], "2026-06-03T02:01:00Z").stdout).receipt;
  assert.equal(staleResult.results[0].status, "skipped");
  assert.equal(staleResult.results[0].reason, "plan entry no longer matches ledger record");
  assert.equal(existsSync(outside), true);
  assert.equal(existsSync(trashedPath), true);

  const ledgerEntries = readFileSync(ledger, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const trashedRecord = ledgerEntries.find((entry) => entry.status === "trashed");
  assert.ok(trashedRecord);
  trashedRecord.targetPath = outside;
  writeFileSync(ledger, `${ledgerEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const outsidePlan = JSON.parse(artshelf(["trash", "purge", "--older-than", "1h", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T02:02:00Z").stdout).plan;
  const outsideResult = JSON.parse(artshelf(["trash", "purge", "--execute", "--plan-id", outsidePlan.purgePlanId, "--ledger", ledger, "--json"], "2026-06-03T02:03:00Z").stdout).receipt;
  assert.equal(outsideResult.results[0].status, "skipped");
  assert.equal(outsideResult.results[0].reason, "target is outside Artshelf trash");
  assert.equal(existsSync(outside), true);
  assert.equal(existsSync(trashedPath), true);

  const planTrashRoot = dirname(trashedPath);
  const rootTargetEntries = readFileSync(ledger, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const rootTargetRecord = rootTargetEntries.find((entry) => entry.status === "trashed");
  assert.ok(rootTargetRecord);
  rootTargetRecord.targetPath = planTrashRoot;
  writeFileSync(ledger, `${rootTargetEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const rootTargetPlan = JSON.parse(artshelf(["trash", "purge", "--older-than", "1h", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T02:04:00Z").stdout).plan;
  const rootTargetResult = JSON.parse(artshelf(["trash", "purge", "--execute", "--plan-id", rootTargetPlan.purgePlanId, "--ledger", ledger, "--json"], "2026-06-03T02:05:00Z").stdout).receipt;
  assert.equal(rootTargetResult.results[0].status, "skipped");
  assert.equal(rootTargetResult.results[0].reason, "target is not a trashed artifact path");
  assert.equal(existsSync(trashedPath), true);
});

test("trash purge writes receipt and records failed delete attempts", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  const cleanupPlan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  const cleanupReceipt = JSON.parse(artshelf(["cleanup", "--execute", "--plan-id", cleanupPlan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:01:00Z").stdout).receipt;
  const trashedPath = cleanupReceipt.results[0].target;
  const purgePlan = JSON.parse(artshelf(["trash", "purge", "--older-than", "1h", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T02:00:00Z").stdout).plan;

  chmodSync(dirname(trashedPath), 0o500);
  const result = JSON.parse(artshelf(["trash", "purge", "--execute", "--plan-id", purgePlan.purgePlanId, "--ledger", ledger, "--json"], "2026-06-03T02:01:00Z").stdout).receipt;
  chmodSync(dirname(trashedPath), 0o700);

  assert.equal(result.results[0].status, "failed");
  assert.equal(existsSync(trashedPath), true);
  const receiptFile = JSON.parse(readFileSync(result.receiptPath, "utf8"));
  assert.equal(receiptFile.results[0].status, "failed");
  assert.equal(receiptFile.completedAt, "2026-06-03T02:01:00Z");
  assert.equal(readLedger(ledger).find((entry) => entry.id === cleanupReceipt.results[0].id)?.status, "trashed");
});

test("trash purge validates malformed plans before writing a blocking receipt", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  const cleanupPlan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  artshelf(["cleanup", "--execute", "--plan-id", cleanupPlan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:01:00Z");
  const purgePlan = JSON.parse(artshelf(["trash", "purge", "--older-than", "1h", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T02:00:00Z").stdout).plan;

  purgePlan.entries = null;
  writeFileSync(purgePlan.planPath, `${JSON.stringify(purgePlan, null, 2)}\n`);

  const result = artshelf(["trash", "purge", "--execute", "--plan-id", purgePlan.purgePlanId, "--ledger", ledger, "--json"], "2026-06-03T02:01:00Z");
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(dirname(ledger), "purge-receipts", `${purgePlan.purgePlanId}.json`)), false);
});

test("trash purge resumes started receipts after an interrupted delete", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  const cleanupPlan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  const cleanupReceipt = JSON.parse(artshelf(["cleanup", "--execute", "--plan-id", cleanupPlan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:01:00Z").stdout).receipt;
  const trashedPath = cleanupReceipt.results[0].target;
  const purgePlan = JSON.parse(artshelf(["trash", "purge", "--older-than", "1h", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T02:00:00Z").stdout).plan;
  const receiptPath = join(dirname(ledger), "purge-receipts", `${purgePlan.purgePlanId}.json`);

  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify({
    purgePlanId: purgePlan.purgePlanId,
    executedAt: "2026-06-03T02:00:30Z",
    status: "started",
    results: [{ id: cleanupReceipt.results[0].id, status: "deleting", targetPath: trashedPath }]
  }, null, 2)}\n`);
  rmSync(trashedPath, { recursive: true, force: true });

  const result = JSON.parse(artshelf(["trash", "purge", "--execute", "--plan-id", purgePlan.purgePlanId, "--ledger", ledger, "--json"], "2026-06-03T02:01:00Z").stdout).receipt;

  assert.equal(result.results[0].status, "purged");
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).executedAt, "2026-06-03T02:00:30Z");
  assert.equal(readLedger(ledger).find((entry) => entry.id === cleanupReceipt.results[0].id)?.status, "resolved");
});

test("trash purge reconciles started receipts with prior purged evidence", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  const cleanupPlan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  const cleanupReceipt = JSON.parse(artshelf(["cleanup", "--execute", "--plan-id", cleanupPlan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:01:00Z").stdout).receipt;
  const trashedPath = cleanupReceipt.results[0].target;
  const purgePlan = JSON.parse(artshelf(["trash", "purge", "--older-than", "1h", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T02:00:00Z").stdout).plan;
  const receiptPath = join(dirname(ledger), "purge-receipts", `${purgePlan.purgePlanId}.json`);

  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify({
    purgePlanId: purgePlan.purgePlanId,
    executedAt: "2026-06-03T02:00:30Z",
    status: "started",
    results: [{ id: cleanupReceipt.results[0].id, status: "purged", targetPath: trashedPath }]
  }, null, 2)}\n`);
  rmSync(trashedPath, { recursive: true, force: true });

  const result = JSON.parse(artshelf(["trash", "purge", "--execute", "--plan-id", purgePlan.purgePlanId, "--ledger", ledger, "--json"], "2026-06-03T02:01:00Z").stdout).receipt;

  assert.equal(result.results[0].status, "purged");
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).completedAt, "2026-06-03T02:01:00Z");
  assert.equal(readLedger(ledger).find((entry) => entry.id === cleanupReceipt.results[0].id)?.status, "resolved");
});

test("trash purge execute skips targets that resolve outside ledger trash", () => {
  const fixture = fixtureDir();
  const ledger = ledgerPath(fixture);
  const ledgerDir = dirname(ledger);
  const externalTrash = join(fixture, "external-trash");
  const cleanupPlanId = "plan_symlink";
  const realTarget = join(externalTrash, cleanupPlanId, "artifact.txt");
  const apparentTarget = join(ledgerDir, "trash", cleanupPlanId, "artifact.txt");

  mkdirSync(dirname(realTarget), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(realTarget, "do not delete");
  symlinkSync(externalTrash, join(ledgerDir, "trash"));
  writeFileSync(ledger, `${JSON.stringify({
    id: "shf_symlink",
    path: join(fixture, "original.txt"),
    kind: "run-artifact",
    reason: "symlink trash root",
    createdAt: "2026-06-01T00:00:00Z",
    retention: { mode: "ttl", ttl: "1d" },
    cleanup: "trash",
    status: "trashed",
    targetPath: apparentTarget,
    cleanedAt: "2026-06-01T00:00:00Z",
    receiptPath: join(ledgerDir, "receipts", "receipt.json"),
    cleanupPlanId
  })}\n`);

  const purgePlan = JSON.parse(artshelf(["trash", "purge", "--older-than", "1h", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T02:00:00Z").stdout).plan;
  const result = JSON.parse(artshelf(["trash", "purge", "--execute", "--plan-id", purgePlan.purgePlanId, "--ledger", ledger, "--json"], "2026-06-03T02:01:00Z").stdout).receipt;
  assert.equal(result.results[0].status, "skipped");
  assert.equal(result.results[0].reason, "target resolves outside Artshelf trash");
  assert.equal(existsSync(realTarget), true);
});

test("trash purge unlinks dangling symlink artifacts inside ledger trash", () => {
  const fixture = fixtureDir();
  const ledger = ledgerPath(fixture);
  const ledgerDir = dirname(ledger);
  const cleanupPlanId = "plan_broken_symlink_artifact";
  const externalTarget = join(fixture, "missing-outside.txt");
  const apparentTarget = join(ledgerDir, "trash", cleanupPlanId, "artifact-link");

  mkdirSync(dirname(apparentTarget), { recursive: true });
  symlinkSync(externalTarget, apparentTarget);
  writeFileSync(ledger, `${JSON.stringify({
    id: "shf_broken_symlink_artifact",
    path: join(fixture, "original-link"),
    kind: "run-artifact",
    reason: "broken symlink artifact",
    createdAt: "2026-06-01T00:00:00Z",
    retention: { mode: "ttl", ttl: "1d" },
    cleanup: "trash",
    status: "trashed",
    targetPath: apparentTarget,
    cleanedAt: "2026-06-01T00:00:00Z",
    receiptPath: join(ledgerDir, "receipts", "receipt.json"),
    cleanupPlanId
  })}\n`);

  const purgePlan = JSON.parse(artshelf(["trash", "purge", "--older-than", "1h", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T02:00:00Z").stdout).plan;
  const result = JSON.parse(artshelf(["trash", "purge", "--execute", "--plan-id", purgePlan.purgePlanId, "--ledger", ledger, "--json"], "2026-06-03T02:01:00Z").stdout).receipt;

  assert.equal(result.results[0].status, "purged");
  assert.equal(existsSync(apparentTarget), false);
});

test("trash purge unlinks quarantined symlink artifacts inside ledger trash", () => {
  const fixture = fixtureDir();
  const ledger = ledgerPath(fixture);
  const ledgerDir = dirname(ledger);
  const cleanupPlanId = "plan_symlink_artifact";
  const externalTarget = join(fixture, "outside.txt");
  const apparentTarget = join(ledgerDir, "trash", cleanupPlanId, "artifact-link");

  mkdirSync(dirname(apparentTarget), { recursive: true });
  writeFileSync(externalTarget, "do not delete");
  symlinkSync(externalTarget, apparentTarget);
  writeFileSync(ledger, `${JSON.stringify({
    id: "shf_symlink_artifact",
    path: join(fixture, "original-link"),
    kind: "run-artifact",
    reason: "symlink artifact",
    createdAt: "2026-06-01T00:00:00Z",
    retention: { mode: "ttl", ttl: "1d" },
    cleanup: "trash",
    status: "trashed",
    targetPath: apparentTarget,
    cleanedAt: "2026-06-01T00:00:00Z",
    receiptPath: join(ledgerDir, "receipts", "receipt.json"),
    cleanupPlanId
  })}\n`);

  const purgePlan = JSON.parse(artshelf(["trash", "purge", "--older-than", "1h", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T02:00:00Z").stdout).plan;
  const result = JSON.parse(artshelf(["trash", "purge", "--execute", "--plan-id", purgePlan.purgePlanId, "--ledger", ledger, "--json"], "2026-06-03T02:01:00Z").stdout).receipt;

  assert.equal(result.results[0].status, "purged");
  assert.equal(existsSync(apparentTarget), false);
  assert.equal(existsSync(externalTarget), true);
});

test("trash purge dry-run reports not-created when no trashed entries match", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  artshelf(["put", artifact, "--reason", "not due yet", "--ttl", "7d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  const dryRun = JSON.parse(artshelf(["trash", "purge", "--older-than", "1h", "--dry-run", "--ledger", ledger, "--json"], "2026-06-01T00:05:00Z").stdout);
  assert.equal(dryRun.plan.purgePlanId, "not-created");
  assert.equal(dryRun.plan.entries.length, 0);
  assert.equal(dryRun.plan.skipped.length, 0);
  assert.equal(dryRun.plan.planPath, null);
  const human = artshelf(["trash", "purge", "--older-than", "1h", "--dry-run", "--ledger", ledger], "2026-06-01T00:05:00Z");
  assert.equal(human.status, 0);
  assert.match(human.stdout, /no matching trashed records/);
  assert.equal(existsSync(join(fixture, ".artshelf", "purge-plans")), false);
});

test("list filters by status after cleanup state changes", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  artshelf(["put", artifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  const plan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-03T00:00:00Z").stdout).plan;
  artshelf(["cleanup", "--execute", "--plan-id", plan.planId, "--ledger", ledger, "--json"], "2026-06-03T00:01:00Z");

  const active = JSON.parse(artshelf(["list", "--status", "active", "--ledger", ledger, "--json"]).stdout).entries;
  const trashed = JSON.parse(artshelf(["list", "--status", "trashed", "--ledger", ledger, "--json"]).stdout).entries;
  assert.deepEqual(active.map((record: any) => record.owner), ["artshelf", "artshelf"]);
  assert.equal(trashed.length, 1);
  assert.equal(trashed[0].status, "trashed");
  assert.match(artshelf(["list", "--status", "not-real", "--ledger", ledger]).stderr, /Unknown status: not-real/);
});

test("cleanup dry-run does not write a plan when there are no cleanup entries", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  artshelf(["put", artifact, "--reason", "still kept", "--ttl", "7d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");

  const dryRun = artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-02T00:00:00Z");
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const plan = JSON.parse(dryRun.stdout).plan;
  assert.equal(plan.planId, "not-created");
  assert.equal(plan.planPath, null);
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(existsSync(join(fixture, ".artshelf", "plans")), false);
  assert.equal(readLedger(ledger).length, 1);

  const human = artshelf(["cleanup", "--dry-run", "--ledger", ledger], "2026-06-02T00:00:00Z");
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /plan not-created: 0 entries, 1 skipped/);
  assert.match(human.stdout, /plan: not created/);
});

test("resolve marks missing records as resolved and removes cleanup noise", () => {
  const fixture = fixtureDir();
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  const ledger = ledgerPath(fixture);

  const put = JSON.parse(artshelf(["put", artifact, "--reason", "temporary evidence", "--ttl", "1d", "--cleanup", "review", "--ledger", ledger, "--json"], "2026-06-01T00:00:00Z").stdout);
  rmSync(artifact);
  assert.equal(JSON.parse(artshelf(["validate", "--ledger", ledger, "--json"]).stdout).warnings.length, 1);

  const resolved = artshelf([
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

  const due = JSON.parse(artshelf(["due", "--ledger", ledger, "--json"], "2026-06-04T00:00:00Z").stdout).entries;
  const plan = JSON.parse(artshelf(["cleanup", "--dry-run", "--ledger", ledger, "--json"], "2026-06-04T00:00:00Z").stdout).plan;
  const validate = JSON.parse(artshelf(["validate", "--ledger", ledger, "--json"]).stdout);
  assert.deepEqual(due, []);
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.skipped.length, 0);
  assert.equal(validate.ok, true);
  assert.equal(validate.warnings.length, 0);
  assert.equal(JSON.parse(artshelf(["list", "--status", "resolved", "--ledger", ledger, "--json"]).stdout).entries.length, 1);

  const repeated = artshelf(["resolve", put.record.id, "--status", "resolved", "--reason", "overwrite attempt", "--ledger", ledger]);
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /already resolved/);
  assert.equal(readLedger(ledger)[0].resolutionReason, "artifact inspected and no longer needed");

  const unsupported = artshelf(["resolve", put.record.id, "--status", "active", "--reason", "reopen", "--ledger", ledger]);
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /resolve currently supports --status resolved/);
});

test("doctor reports a healthy machine and exits zero", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const artifact = join(fixture, "artifact.txt");
  const ledger = join(fixture, "repo", ".artshelf", "ledger.jsonl");
  writeFileSync(artifact, "hello");
  artshelf(["put", artifact, "--reason", "healthy", "--ttl", "7d", "--ledger", ledger, "--registry", registry]);

  const result = artshelf(["doctor", "--registry", registry, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.version, PACKAGE_VERSION);
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
  const ledger = join(fixture, "repo", ".artshelf", "ledger.jsonl");
  mkdirSync(join(fixture, "repo", ".artshelf"), { recursive: true });
  writeFileSync(ledger, "");
  artshelf(["ledgers", "add", "--ledger", ledger, "--registry", registry]);
  rmSync(ledger);

  const result = artshelf(["doctor", "--registry", registry, "--json"]);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.ledgers[0].status, "missing");
  assert.match(body.ledgers[0].errors[0], /registered ledger is missing/);
  assert.match(body.errors.join("\n"), /registered ledger is missing/);

  const human = artshelf(["doctor", "--registry", registry]);
  assert.equal(human.status, 1);
  assert.match(human.stdout, /missing/);
});

test("doctor reports invalid registered ledgers and exits non-zero", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const ledger = join(fixture, "bad", ".artshelf", "ledger.jsonl");
  mkdirSync(join(fixture, "bad", ".artshelf"), { recursive: true });
  writeFileSync(ledger, "{not json\n");
  artshelf(["ledgers", "add", "--ledger", ledger, "--name", "bad", "--registry", registry]);

  const result = artshelf(["doctor", "--registry", registry, "--json"]);
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

  const result = artshelf(["doctor", "--registry", registry, "--json"]);
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

  const result = artshelf(["doctor", "--registry", registry, "--json"]);
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
  const ledger = join(fixture, "repo", ".artshelf", "ledger.jsonl");
  writeFileSync(artifact, "hello");
  artshelf(["put", artifact, "--reason", "healthy", "--ttl", "7d", "--ledger", ledger, "--registry", registry]);

  const result = artshelf(["doctor", "--registry", registry]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`artshelf ${escapeRegExp(PACKAGE_VERSION)}`));
  assert.match(result.stdout, /health: ok/);
  assert.match(result.stdout, /registry:/);
  assert.match(result.stdout, /plan id/i);
  assert.match(result.stdout, /execute/i);
});

test("doctor help explains the command", () => {
  const main = artshelf(["help"]);
  assert.match(main.stdout, /\bdoctor\b/);

  const help = artshelf(["help", "doctor"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /artshelf doctor/);
  assert.match(help.stdout, /--json/);
  assert.match(help.stdout, /--agent/);
});

test("doctor --agent emits a compact deterministic decision packet alongside full --json", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const artifact = join(fixture, "artifact.txt");
  const ledger = join(fixture, "repo", ".artshelf", "ledger.jsonl");
  writeFileSync(artifact, "hello");
  artshelf(["put", artifact, "--reason", "healthy", "--ttl", "7d", "--ledger", ledger, "--registry", registry]);

  const result = artshelf(["doctor", "--registry", registry, "--agent"]);
  assert.equal(result.status, 0, result.stderr);

  // Token-efficient: a single compact JSON line, never pretty-printed.
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, "agent packet must be a single compact JSON line");
  assert.ok(!result.stdout.includes("\n  "), "agent packet must not be pretty-printed");

  const packet = JSON.parse(result.stdout);
  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.command, "doctor");
  assert.equal(packet.health, "ok");
  assert.equal(packet.version, PACKAGE_VERSION);
  assert.equal(typeof packet.node, "string");
  assert.equal(packet.registry.path, registry);
  assert.equal(packet.registry.exists, true);
  assert.equal(packet.registry.ok, true);
  assert.equal(packet.registry.error, null);
  assert.deepEqual(packet.ledgers, { total: 1, ok: 1, stale: 0, invalid: 0, warnings: 0 });
  assert.deepEqual(packet.attention, []);
  assert.deepEqual(packet.blockers, []);
  // Cleanup-safety posture travels with the agent packet so a model can confirm it.
  assert.deepEqual(packet.cleanupSafety, {
    executeRequiresLedgerAndPlanId: true,
    globalExecuteRefused: true,
    deleteRefusedInV1: true,
    dryRunBeforeMutation: true
  });
  assert.match(packet.nextAction, /healthy/i);
  assert.equal(packet.verification, `artshelf doctor --agent --registry ${registry}`);

  // Backward compatibility: full --json still emits the pretty audit report unchanged.
  const fullJson = artshelf(["doctor", "--registry", registry, "--json"]);
  assert.equal(fullJson.status, 0, fullJson.stderr);
  assert.ok(fullJson.stdout.includes("\n  "), "--json stays pretty-printed");
  const fullBody = JSON.parse(fullJson.stdout);
  assert.equal(fullBody.summary.ledgers, 1);
  assert.equal(fullBody.attention, undefined, "full --json must not grow agent-only fields");
  assert.equal(fullBody.nextAction, undefined, "full --json must not grow agent-only fields");
  assert.equal(fullBody.schemaVersion, undefined, "full --json must not grow agent-only fields");
});

test("doctor --agent surfaces broken registry entries as blockers and exits non-zero", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const staleLedger = join(fixture, "stale", ".artshelf", "ledger.jsonl");
  const badLedger = join(fixture, "bad", ".artshelf", "ledger.jsonl");
  mkdirSync(join(fixture, "stale", ".artshelf"), { recursive: true });
  writeFileSync(staleLedger, "");
  artshelf(["ledgers", "add", "--ledger", staleLedger, "--name", "stale", "--registry", registry]);
  rmSync(staleLedger);
  mkdirSync(join(fixture, "bad", ".artshelf"), { recursive: true });
  writeFileSync(badLedger, "{not json\n");
  artshelf(["ledgers", "add", "--ledger", badLedger, "--name", "bad", "--registry", registry]);

  const result = artshelf(["doctor", "--registry", registry, "--agent"]);
  assert.equal(result.status, 1);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.health, "attention");
  assert.equal(packet.ledgers.stale, 1);
  assert.equal(packet.ledgers.invalid, 1);
  assert.deepEqual(packet.attention, ["stale", "invalid"]);
  assert.equal(packet.blockers.length, 2);
  assert.ok(packet.blockers.some((line: string) => /stale/.test(line)));
  assert.ok(packet.blockers.some((line: string) => /bad/.test(line)));
  assert.match(packet.nextAction, /repair/i);
});

test("doctor --agent flags warnings as attention while the machine stays healthy", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const artifact = join(fixture, "artifact.txt");
  const ledger = join(fixture, "repo", ".artshelf", "ledger.jsonl");
  writeFileSync(artifact, "hello");
  artshelf(["put", artifact, "--reason", "vanishing", "--ttl", "7d", "--ledger", ledger, "--registry", registry]);
  rmSync(artifact); // active record now points at a missing path -> warning, not an error

  const result = artshelf(["doctor", "--registry", registry, "--agent"]);
  assert.equal(result.status, 0, result.stderr);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.health, "ok"); // warnings never fail the machine
  assert.equal(packet.ledgers.warnings, 1);
  assert.deepEqual(packet.attention, ["warnings"]);
  assert.deepEqual(packet.blockers, []);
  assert.match(packet.nextAction, /validate --all/);
});

test("status --all --json aggregates registry health and ledger counts for cron", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const oneLedger = join(fixture, "one", ".artshelf", "ledger.jsonl");
  const twoLedger = join(fixture, "two", ".artshelf", "ledger.jsonl");
  const dueArtifact = join(fixture, "due.txt");
  const reviewArtifact = join(fixture, "review.txt");
  const keptArtifact = join(fixture, "kept.txt");
  writeFileSync(dueArtifact, "due");
  writeFileSync(reviewArtifact, "review");
  writeFileSync(keptArtifact, "kept");

  artshelf(["put", dueArtifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", oneLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  artshelf(["put", reviewArtifact, "--reason", "needs eyes", "--manual-review", "--ledger", twoLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  artshelf(["put", keptArtifact, "--reason", "still kept", "--retain-until", "2026-06-10T00:00:00Z", "--ledger", twoLedger, "--registry", registry], "2026-06-01T00:00:00Z");

  const result = artshelf(["status", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z");
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

  artshelf(["put", kept, "--reason", "keep", "--retain-until", "2026-06-03T00:00:00Z", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  artshelf(["put", due, "--reason", "due", "--retain-until", "2026-05-31T00:00:00Z", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  artshelf(["put", review, "--reason", "review", "--manual-review", "--ledger", ledger], "2026-06-01T00:00:00Z");
  artshelf(["put", missing, "--reason", "missing", "--ttl", "1d", "--ledger", ledger], "2026-06-01T00:00:00Z");
  rmSync(missing);

  const before = readFileSync(ledger, "utf8");
  const result = artshelf(["status", "--ledger", ledger, "--json"], "2026-06-01T00:00:00Z");
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
  assert.equal(existsSync(join(fixture, ".artshelf", "plans")), false);
  assert.equal(existsSync(join(fixture, ".artshelf", "receipts")), false);
});

test("status --all reports a corrupt registry as non-zero without crashing", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  writeFileSync(registry, "{not json");

  const result = artshelf(["status", "--all", "--registry", registry, "--json"]);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.registryOk, false);
  assert.equal(typeof body.registryError, "string");
});

test("status --all flags stale and invalid registered ledgers as non-zero", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const staleLedger = join(fixture, "stale", ".artshelf", "ledger.jsonl");
  const badLedger = join(fixture, "bad", ".artshelf", "ledger.jsonl");
  mkdirSync(join(fixture, "stale", ".artshelf"), { recursive: true });
  writeFileSync(staleLedger, "");
  artshelf(["ledgers", "add", "--ledger", staleLedger, "--name", "stale", "--registry", registry]);
  rmSync(staleLedger);
  mkdirSync(join(fixture, "bad", ".artshelf"), { recursive: true });
  writeFileSync(badLedger, "{not json\n");
  artshelf(["ledgers", "add", "--ledger", badLedger, "--name", "bad", "--registry", registry]);

  const result = artshelf(["status", "--all", "--registry", registry, "--json"]);
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

  const result = artshelf(["status", "--all", "--registry", registry, "--json"]);
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

  const result = artshelf(["status", "--ledger", ledger, "--json"]);
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
  artshelf(["put", due, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");
  artshelf(["put", review, "--reason", "review", "--manual-review", "--ledger", ledger], "2026-06-01T00:00:00Z");

  const result = artshelf(["status", "--ledger", ledger], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status: ok/);
  assert.match(result.stdout, /active 2/);
  assert.match(result.stdout, /due 1/);
  assert.match(result.stdout, /pending 2/);
  const lines = result.stdout.trim().split("\n");
  assert.ok(lines.length <= 4, `status human output should be short, got ${lines.length} lines`);
});

// Human render (NGX-396): default output carries a scannable left-column glyph so
// attention state is obvious at a glance — ✓ clear, ⚠ needs attention — without
// ANSI color (piped output stays clean) and without growing the line budget.
test("status human render flags actionable work with a glyph and clears it when nothing is due", () => {
  const busyFixture = fixtureDir();
  const busyLedger = ledgerPath(busyFixture);
  const due = join(busyFixture, "due.txt");
  writeFileSync(due, "due");
  artshelf(["put", due, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", busyLedger], "2026-06-01T00:00:00Z");

  const attention = artshelf(["status", "--ledger", busyLedger], "2026-06-03T00:00:00Z");
  assert.equal(attention.status, 0, attention.stderr);
  // The ledger is still valid (word stays `ok` for backward compatibility), but
  // the leading glyph marks that there is due work to act on.
  assert.match(attention.stdout, /^⚠ artshelf status: ok/);

  const calmFixture = fixtureDir();
  const calmLedger = ledgerPath(calmFixture);
  const kept = join(calmFixture, "kept.txt");
  writeFileSync(kept, "kept");
  artshelf(["put", kept, "--reason", "still needed", "--retain-until", "2026-06-30T00:00:00Z", "--ledger", calmLedger], "2026-06-01T00:00:00Z");

  const clear = artshelf(["status", "--ledger", calmLedger], "2026-06-03T00:00:00Z");
  assert.equal(clear.status, 0, clear.stderr);
  assert.match(clear.stdout, /^✓ artshelf status: ok/);
  assert.doesNotMatch(clear.stdout, /⚠/);
});

test("status --all human render marks each ledger with its own attention glyph", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const busy = join(fixture, "busy", ".artshelf", "ledger.jsonl");
  const calm = join(fixture, "calm", ".artshelf", "ledger.jsonl");
  const due = join(fixture, "due.txt");
  const kept = join(fixture, "kept.txt");
  writeFileSync(due, "due");
  writeFileSync(kept, "kept");
  artshelf(["put", due, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", busy, "--registry", registry], "2026-06-01T00:00:00Z");
  artshelf(["put", kept, "--reason", "still needed", "--retain-until", "2026-06-30T00:00:00Z", "--ledger", calm, "--registry", registry], "2026-06-01T00:00:00Z");

  const result = artshelf(["status", "--all", "--registry", registry], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 0, result.stderr);
  // Per-ledger rows each carry their own glyph so the column scans top-to-bottom.
  assert.match(result.stdout, /⚠ \[busy\]/);
  assert.match(result.stdout, /✓ \[calm\]/);
  // The header rolls up to attention because at least one ledger has due work.
  assert.match(result.stdout, /^⚠ artshelf status:/);
});

test("doctor human render marks health and each registered ledger with a glyph", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const healthy = join(fixture, "healthy", ".artshelf", "ledger.jsonl");
  const artifact = join(fixture, "artifact.txt");
  writeFileSync(artifact, "hello");
  artshelf(["put", artifact, "--reason", "healthy", "--ttl", "7d", "--ledger", healthy, "--registry", registry]);

  const ok = artshelf(["doctor", "--registry", registry]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /✓ health: ok/);
  assert.match(ok.stdout, /✓ ok healthy/);
  assert.doesNotMatch(ok.stdout, /⚠/);

  const badLedger = join(fixture, "bad", ".artshelf", "ledger.jsonl");
  mkdirSync(join(fixture, "bad", ".artshelf"), { recursive: true });
  writeFileSync(badLedger, "{not json\n");
  artshelf(["ledgers", "add", "--ledger", badLedger, "--name", "bad", "--registry", registry]);

  const broken = artshelf(["doctor", "--registry", registry]);
  assert.equal(broken.status, 1, broken.stderr);
  assert.match(broken.stdout, /⚠ health: needs attention/);
  assert.match(broken.stdout, /⚠ invalid bad/);
});

test("review --all human render marks the header and each ledger with a glyph", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const busy = join(fixture, "busy", ".artshelf", "ledger.jsonl");
  const calm = join(fixture, "calm", ".artshelf", "ledger.jsonl");
  const due = join(fixture, "due.txt");
  const kept = join(fixture, "kept.txt");
  writeFileSync(due, "due");
  writeFileSync(kept, "kept");
  artshelf(["put", due, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", busy, "--registry", registry], "2026-06-01T00:00:00Z");
  artshelf(["put", kept, "--reason", "still needed", "--retain-until", "2026-06-30T00:00:00Z", "--ledger", calm, "--registry", registry], "2026-06-01T00:00:00Z");

  const result = artshelf(["review", "--all", "--registry", registry], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^⚠ artshelf review --all: needs attention/);
  assert.match(result.stdout, /⚠ \[busy\]/);
  assert.match(result.stdout, /✓ \[calm\]/);
});

test("status help explains the command", () => {
  const main = artshelf(["help"]);
  assert.match(main.stdout, /\bstatus\b/);

  const help = artshelf(["help", "status"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /artshelf status/);
  assert.match(help.stdout, /--all/);
  assert.match(help.stdout, /--json/);
  assert.match(help.stdout, /--agent/);
});

test("status --all --agent emits a compact deterministic agent packet alongside full --json", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const oneLedger = join(fixture, "one", ".artshelf", "ledger.jsonl");
  const twoLedger = join(fixture, "two", ".artshelf", "ledger.jsonl");
  const dueArtifact = join(fixture, "due.txt");
  const reviewArtifact = join(fixture, "review.txt");
  const keptArtifact = join(fixture, "kept.txt");
  writeFileSync(dueArtifact, "due");
  writeFileSync(reviewArtifact, "review");
  writeFileSync(keptArtifact, "kept");

  artshelf(["put", dueArtifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", oneLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  artshelf(["put", reviewArtifact, "--reason", "needs eyes", "--manual-review", "--ledger", twoLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  artshelf(["put", keptArtifact, "--reason", "still kept", "--retain-until", "2026-06-10T00:00:00Z", "--ledger", twoLedger, "--registry", registry], "2026-06-01T00:00:00Z");

  const result = artshelf(["status", "--all", "--registry", registry, "--agent"], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 0, result.stderr);

  // Token-efficient: a single compact JSON line, never pretty-printed.
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, "agent packet must be a single compact JSON line");
  assert.ok(!result.stdout.includes("\n  "), "agent packet must not be pretty-printed");

  const packet = JSON.parse(result.stdout);
  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.command, "status");
  assert.equal(packet.scope, "all");
  assert.equal(packet.health, "ok");
  assert.equal(packet.registry.path, registry);
  assert.equal(packet.registry.exists, true);
  assert.equal(packet.registry.ok, true);
  assert.equal(packet.registry.error, null);
  assert.deepEqual(packet.ledgers, { total: 2, ok: 2, stale: 0, invalid: 0 });

  // Counts mirror the audited --json totals exactly.
  assert.deepEqual(packet.counts, { active: 3, due: 1, manualReview: 1, missingPath: 0, kept: 1, pendingCleanup: 2 });

  // Attention names the nonzero actionable categories only, in a stable order.
  assert.deepEqual(packet.attention, ["due", "manualReview", "pendingCleanup"]);
  assert.deepEqual(packet.blockers, []);
  assert.match(packet.nextAction, /review --all/);
  assert.equal(packet.verification, `artshelf status --all --agent --registry ${registry}`);

  // Backward compatibility: full --json still emits the pretty audit report unchanged.
  const fullJson = artshelf(["status", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z");
  assert.equal(fullJson.status, 0, fullJson.stderr);
  assert.ok(fullJson.stdout.includes("\n  "), "--json stays pretty-printed");
  const fullBody = JSON.parse(fullJson.stdout);
  assert.equal(fullBody.totals.active, 3);
  assert.equal(fullBody.totals.pendingCleanup, 2);
  assert.equal(fullBody.attention, undefined, "full --json must not grow agent-only fields");
});

test("status --all --agent surfaces broken ledgers as blockers and exits non-zero", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const staleLedger = join(fixture, "stale", ".artshelf", "ledger.jsonl");
  const badLedger = join(fixture, "bad", ".artshelf", "ledger.jsonl");
  mkdirSync(join(fixture, "stale", ".artshelf"), { recursive: true });
  writeFileSync(staleLedger, "");
  artshelf(["ledgers", "add", "--ledger", staleLedger, "--name", "stale", "--registry", registry]);
  rmSync(staleLedger);
  mkdirSync(join(fixture, "bad", ".artshelf"), { recursive: true });
  writeFileSync(badLedger, "{not json\n");
  artshelf(["ledgers", "add", "--ledger", badLedger, "--name", "bad", "--registry", registry]);

  const result = artshelf(["status", "--all", "--registry", registry, "--agent"]);
  assert.equal(result.status, 1);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.health, "attention");
  assert.equal(packet.ledgers.stale, 1);
  assert.equal(packet.ledgers.invalid, 1);
  assert.equal(packet.blockers.length, 2);
  assert.ok(packet.blockers.some((line: string) => /stale/.test(line)));
  assert.ok(packet.blockers.some((line: string) => /bad/.test(line)));
  assert.match(packet.nextAction, /repair/i);
});

test("status --agent reports a single ledger packet without registry aggregates", () => {
  const fixture = fixtureDir();
  const ledger = ledgerPath(fixture);
  const due = join(fixture, "due.txt");
  writeFileSync(due, "due");
  artshelf(["put", due, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger], "2026-06-01T00:00:00Z");

  const result = artshelf(["status", "--ledger", ledger, "--agent"], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, "agent packet must be a single compact JSON line");

  const packet = JSON.parse(result.stdout);
  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.scope, "single");
  assert.equal(packet.ledgerPath, ledger);
  assert.equal(packet.registry, undefined);
  assert.equal(packet.ledgers, undefined);
  assert.equal(packet.health, "ok");
  assert.equal(packet.counts.due, 1);
  assert.equal(packet.counts.pendingCleanup, 1);
  assert.deepEqual(packet.attention, ["due", "pendingCleanup"]);
  assert.equal(packet.verification, `artshelf status --agent --ledger ${ledger}`);
});

test("review help explains the render modes", () => {
  const main = artshelf(["help"]);
  assert.match(main.stdout, /\breview\b/);

  const help = artshelf(["help", "review"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /artshelf review/);
  assert.match(help.stdout, /--all/);
  assert.match(help.stdout, /--json/);
  assert.match(help.stdout, /--agent/);
  assert.match(help.stdout, /Render modes:/);
  assert.match(help.stdout, /--agent takes\s+precedence over --json/);
});

test("review --all --agent emits a compact deterministic decision packet alongside full --json", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const oneLedger = join(fixture, "one", ".artshelf", "ledger.jsonl");
  const twoLedger = join(fixture, "two", ".artshelf", "ledger.jsonl");
  const dueArtifact = join(fixture, "due.txt");
  const missingArtifact = join(fixture, "missing.txt");
  const reviewArtifact = join(fixture, "review.txt");
  const keptArtifact = join(fixture, "kept.txt");
  writeFileSync(dueArtifact, "due");
  writeFileSync(missingArtifact, "missing");
  writeFileSync(reviewArtifact, "review");
  writeFileSync(keptArtifact, "kept");

  artshelf(["put", dueArtifact, "--reason", "expired", "--ttl", "1d", "--cleanup", "trash", "--ledger", oneLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  const missingPut = JSON.parse(artshelf(["put", missingArtifact, "--reason", "gone", "--ttl", "1d", "--cleanup", "trash", "--ledger", oneLedger, "--registry", registry, "--json"], "2026-06-01T00:00:00Z").stdout);
  rmSync(missingArtifact);
  artshelf(["put", reviewArtifact, "--reason", "needs eyes", "--manual-review", "--ledger", twoLedger, "--registry", registry], "2026-06-01T00:00:00Z");
  artshelf(["put", keptArtifact, "--reason", "still kept", "--retain-until", "2026-06-10T00:00:00Z", "--ledger", twoLedger, "--registry", registry], "2026-06-01T00:00:00Z");

  const result = artshelf(["review", "--all", "--registry", registry, "--agent"], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 0, result.stderr);

  // Token-efficient: a single compact JSON line, never pretty-printed.
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, "agent packet must be a single compact JSON line");
  assert.ok(!result.stdout.includes("\n  "), "agent packet must not be pretty-printed");

  const packet = JSON.parse(result.stdout);
  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.command, "review");
  assert.equal(packet.scope, "all");
  assert.equal(packet.health, "ok");
  assert.equal(packet.registry.path, registry);
  assert.equal(packet.registry.exists, true);
  assert.deepEqual(packet.ledgers, { total: 2, ok: 2, stale: 0, invalid: 0 });

  // Triage counts mirror the audited --json review summary exactly.
  assert.deepEqual(packet.counts, { due: 1, manualReview: 1, missingPath: 1, executable: 2, skipped: 2 });

  // Decision groups reuse the ArtshelfReviewReport vocabulary.
  assert.deepEqual(packet.decisionSummary, { readyForApproval: 1, needsReviewFirst: 2, blocked: 0 });

  // Ready-for-approval holds the exact, plan-less resolve target for the missing path.
  assert.equal(packet.readyForApproval.length, 1);
  const resolve = packet.readyForApproval[0];
  assert.equal(resolve.actionType, "resolve-missing");
  assert.ok(resolve.itemIds.includes(missingPut.record.id));
  assert.match(resolve.approvalTarget, new RegExp(`^approve artshelf resolve missing ledger .+ ids ${escapeRegExp(missingPut.record.id)}$`));

  // Trash-safe cleanup is read-only here: it points at the dry-run that mints a
  // reviewed plan instead of leaking a preview plan id, so it stays needs-review.
  const cleanup = packet.needsReviewFirst.find((decision: any) => decision.actionType === "cleanup");
  assert.ok(cleanup, "cleanup decision present");
  assert.equal(cleanup.approvalTarget, null);
  assert.ok(cleanup.itemIds.length === 1);
  assert.match(cleanup.nextStep, /artshelf cleanup --dry-run --ledger .+ --json/);

  const inspect = packet.needsReviewFirst.find((decision: any) => decision.actionType === "inspect");
  assert.ok(inspect, "manual-review inspect decision present");
  assert.equal(inspect.approvalTarget, null);

  assert.deepEqual(packet.blocked, []);

  // Invariant: ready-for-approval always carries an exact approval target; the
  // needs-review-first and blocked groups never leak one.
  for (const decision of packet.readyForApproval) assert.equal(typeof decision.approvalTarget, "string");
  for (const decision of [...packet.needsReviewFirst, ...packet.blocked]) assert.equal(decision.approvalTarget, null);

  // Cleanup-safety posture is stated in the packet and stays read-only.
  assert.deepEqual(packet.safety, { dryRunOnly: true, executeAllRefused: true, noExecuteRan: true, noResolveRan: true, noDeleteRan: true });
  assert.match(packet.nextAction, /cleanup --dry-run --all/);
  assert.equal(packet.verification, `artshelf review --all --agent --registry ${registry}`);

  // Read-only proof: review --agent never writes a cleanup plan.
  assert.equal(existsSync(join(fixture, "one", ".artshelf", "plans")), false);

  // Backward compatibility: full --json review report stays pretty and unchanged.
  const fullJson = artshelf(["review", "--all", "--registry", registry, "--json"], "2026-06-03T00:00:00Z");
  assert.equal(fullJson.status, 0, fullJson.stderr);
  assert.ok(fullJson.stdout.includes("\n  "), "--json stays pretty-printed");
  const fullBody = JSON.parse(fullJson.stdout);
  assert.equal(fullBody.summary.executable, 2);
  assert.equal(fullBody.decisionSummary, undefined, "full --json must not grow agent-only fields");
  assert.equal(fullBody.readyForApproval, undefined);
});

test("review --all --agent surfaces broken ledgers as blocked decisions and exits non-zero", () => {
  const fixture = fixtureDir();
  const registry = join(fixture, "registry.json");
  const staleLedger = join(fixture, "stale", ".artshelf", "ledger.jsonl");
  const badLedger = join(fixture, "bad", ".artshelf", "ledger.jsonl");
  mkdirSync(join(fixture, "stale", ".artshelf"), { recursive: true });
  writeFileSync(staleLedger, "");
  artshelf(["ledgers", "add", "--ledger", staleLedger, "--name", "stale", "--registry", registry]);
  rmSync(staleLedger);
  mkdirSync(join(fixture, "bad", ".artshelf"), { recursive: true });
  writeFileSync(badLedger, "{not json\n");
  artshelf(["ledgers", "add", "--ledger", badLedger, "--name", "bad", "--registry", registry]);

  const result = artshelf(["review", "--all", "--registry", registry, "--agent"]);
  assert.equal(result.status, 1);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.health, "attention");
  assert.equal(packet.ledgers.stale, 1);
  assert.equal(packet.ledgers.invalid, 1);
  assert.equal(packet.blocked.length, 2);
  assert.equal(packet.decisionSummary.blocked, 2);
  for (const decision of packet.blocked) {
    assert.equal(decision.actionType, "fix-registry");
    assert.equal(decision.approvalTarget, null);
  }
  assert.ok(packet.blocked.some((decision: any) => /stale/.test(decision.label)));
  assert.ok(packet.blocked.some((decision: any) => /bad/.test(decision.label)));
  assert.match(packet.nextAction, /repair/i);
});

test("review --agent reports a single-ledger packet without registry aggregates", () => {
  const fixture = fixtureDir();
  const ledger = ledgerPath(fixture);
  const missingArtifact = join(fixture, "missing.txt");
  writeFileSync(missingArtifact, "missing");
  const put = JSON.parse(artshelf(["put", missingArtifact, "--reason", "gone", "--ttl", "1d", "--cleanup", "trash", "--ledger", ledger, "--json"], "2026-06-01T00:00:00Z").stdout);
  rmSync(missingArtifact);

  const result = artshelf(["review", "--ledger", ledger, "--agent"], "2026-06-03T00:00:00Z");
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, "agent packet must be a single compact JSON line");

  const packet = JSON.parse(result.stdout);
  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.command, "review");
  assert.equal(packet.scope, "single");
  assert.equal(packet.ledgerPath, ledger);
  assert.equal(packet.registry, undefined);
  assert.equal(packet.ledgers, undefined);
  assert.equal(packet.health, "ok");
  assert.equal(packet.counts.missingPath, 1);
  assert.equal(packet.readyForApproval.length, 1);
  assert.equal(packet.readyForApproval[0].actionType, "resolve-missing");
  assert.match(packet.readyForApproval[0].approvalTarget, new RegExp(`^approve artshelf resolve missing ledger .+ ids ${escapeRegExp(put.record.id)}$`));
  assert.equal(packet.verification, `artshelf review --agent --ledger ${ledger}`);
});

function artshelf(args: string[], now?: string, extraEnv: Record<string, string | undefined> = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI.pathname, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ARTSHELF_NO_UPDATE_CHECK: "1",
      ARTSHELF_REGISTRY: TEST_REGISTRY,
      ...(now ? { ARTSHELF_NOW: now } : {}),
      ...extraEnv
    }
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function shelfAsync(args: string[], now?: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [CLI.pathname, ...args], {
      env: { ...process.env, ARTSHELF_NO_UPDATE_CHECK: "1", ARTSHELF_REGISTRY: TEST_REGISTRY, ...(now ? { ARTSHELF_NOW: now } : {}) }
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
  const dir = mkdtempSync(join(tmpdir(), "artshelf-test-"));
  return dir;
}

function ledgerPath(fixture: string): string {
  return join(fixture, ".artshelf", "ledger.jsonl");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readLedger(ledger: string): any[] {
  return readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}
