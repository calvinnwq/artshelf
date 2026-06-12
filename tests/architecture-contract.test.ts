import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

test("cli entrypoint has a transitional size budget", () => {
  const cli = read("src/cli.ts");
  const lines = cli.split("\n").length;
  const commandHandlers = [...cli.matchAll(/^async function handle|^function handle/gm)].length;

  assert.ok(lines <= 2250, `src/cli.ts has ${lines} lines; move behavior out instead of growing it`);
  assert.ok(
    commandHandlers <= 16,
    `src/cli.ts has ${commandHandlers} command handlers; add command modules instead of more handlers`
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
