import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("architecture contract is the source of truth for CLI structure", () => {
  assert.equal(existsSync("ARCHITECTURE.md"), true);

  const architecture = read("ARCHITECTURE.md");
  for (const text of [
    "source of truth",
    "src/cli.ts",
    "commands/",
    "core/",
    "adapters/",
    "renderers/",
    "config/",
    "shared/",
    "Import Direction",
    "Output And Safety Rules",
    "Migration Order",
    "NGX-406",
    "NGX-407"
  ]) {
    assert.match(architecture, new RegExp(escapeRegExp(text)), text);
  }
});

test("agent and contributor docs point to the architecture contract", () => {
  const agents = read("AGENTS.md");
  const contributing = read("CONTRIBUTING.md");

  assert.match(agents, /ARCHITECTURE\.md/);
  assert.match(agents, /Before changing Artshelf CLI routing/);
  assert.match(contributing, /ARCHITECTURE\.md/);
});

test("cli entrypoint stays thin and handler-free", () => {
  const cli = read("src/cli.ts");
  const lines = cli.split("\n").length;
  const commandHandlers = [...cli.matchAll(/^async function handle|^function handle/gm)].length;

  assert.ok(lines <= 650, `src/cli.ts has ${lines} lines; move behavior out instead of growing it`);
  assert.ok(
    commandHandlers === 0,
    `src/cli.ts has ${commandHandlers} command handlers; command behavior belongs in src/commands`
  );
});


test("command modules own CLI command implementations", () => {
  const commandFiles = [
    "cleanup",
    "doctor",
    "due",
    "find",
    "get",
    "ledgers",
    "list",
    "put",
    "resolve",
    "review",
    "status",
    "trash",
    "update"
  ];

  for (const command of commandFiles) {
    assert.equal(existsSync(`src/commands/${command}.ts`), true, `${command} command module should exist`);
  }

  const cli = read("src/cli.ts");
  assert.doesNotMatch(cli, /^function handlePut/gm);
  assert.doesNotMatch(cli, /^function handleTrash/gm);
});


test("renderers own shared output helpers", () => {
  for (const file of [
    "src/renderers/json.ts",
    "src/renderers/attention.ts",
    "src/shared/errors.ts"
  ]) {
    assert.equal(existsSync(file), true, `${file} should exist`);
  }

  const commands = read("src/commands/index.ts");
  assert.doesNotMatch(commands, /^function printJson/gm);
  assert.doesNotMatch(commands, /^function attentionGlyph/gm);
});


test("shared CLI contracts and update adapters are explicit modules", () => {
  for (const file of [
    "src/shared/cli-types.ts",
    "src/shared/flags.ts",
    "src/config/package.ts",
    "src/adapters/update.ts"
  ]) {
    assert.equal(existsSync(file), true, `${file} should exist`);
  }

  const cli = read("src/cli.ts");
  const commands = read("src/commands/index.ts");
  assert.doesNotMatch(cli, /^type ParsedArgs/gm);
  assert.doesNotMatch(commands, /^type ParsedArgs/gm);
  assert.doesNotMatch(commands, /^function getLatestVersion/gm);
});


test("architecture guardrails catch boundary and migration regressions", () => {
  const cli = read("src/cli.ts");
  assert.doesNotMatch(cli, /from "\.\/ledger\.js"/);
  assert.doesNotMatch(cli, /from "\.\/registry\.js"/);

  const sourceFiles = [
    "src/commands/index.ts",
    ...readdirSync("src/commands").filter((file) => file.endsWith(".ts") && file !== "index.ts").map((file) => `src/commands/${file}`),
    "src/adapters/update.ts",
    "src/config/package.ts",
    "src/renderers/attention.ts",
    "src/renderers/json.ts",
    "src/shared/cli-types.ts",
    "src/shared/errors.ts",
    "src/shared/flags.ts",
    "src/shared/help-text.ts"
  ];

  for (const file of sourceFiles) {
    const contents = read(file);
    assert.doesNotMatch(contents, /during the NGX-407 extraction|temporary migration|compatibility shim/, file);
    assert.doesNotMatch(contents, /from "\.\.\/cli\.js"|from "\.\/cli\.js"/, file);
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
