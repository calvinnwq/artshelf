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
    "adapters/",
    "renderers/",
    "config/",
    "shared/",
    "ledger.ts",
    "registry.ts",
    "Import Direction",
    "Output And Safety Rules",
    "Closeout Guardrails",
    "NGX-410"
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

  assert.ok(lines <= 520, `src/cli.ts has ${lines} lines; move behavior out instead of growing it`);
  assert.ok(
    commandHandlers === 0,
    `src/cli.ts has ${commandHandlers} command handlers; command behavior belongs in src/commands`
  );
});


const PUBLIC_COMMANDS = [
  "cleanup",
  "doctor",
  "due",
  "find",
  "get",
  "ledgers",
  "list",
  "put",
  "reconcile",
  "resolve",
  "review",
  "status",
  "trash",
  "update",
  "validate"
] as const;

test("the public command surface is documented and routed through the command boundary", () => {
  const architecture = read("ARCHITECTURE.md");
  const cli = read("src/cli.ts");
  const helpText = read("src/shared/help-text.ts");
  const commands = read("src/commands/index.ts");

  for (const command of PUBLIC_COMMANDS) {
    assert.match(architecture, new RegExp(`\\b${escapeRegExp(command)}\\b`), `${command} should be named in ARCHITECTURE.md`);
    assert.match(helpText, new RegExp(`name: "${escapeRegExp(command)}"`), `${command} should appear in top-level help`);
    assert.match(commands, new RegExp(`case "${escapeRegExp(command)}":`), `${command} should be dispatched by src/commands/index.ts`);
  }

  assert.doesNotMatch(cli, /^function handlePut/gm);
  assert.doesNotMatch(cli, /^function handleTrash/gm);
});

test("command modules are real discoverable implementations", () => {
  const commandFiles = readdirSync("src/commands")
    .filter((file) => file.endsWith(".ts") && !["index.ts", "shared.ts"].includes(file))
    .sort();

  assert.deepEqual(commandFiles, PUBLIC_COMMANDS.map((command) => `${command}.ts`).sort());

  for (const command of PUBLIC_COMMANDS) {
    const path = `src/commands/${command}.ts`;
    const contents = read(path);
    const handlerName = `handle${capitalizeCommand(command)}`;
    assert.match(contents, new RegExp(`export (async )?function ${handlerName}\\b`), `${path} should export ${handlerName}`);
    assert.doesNotMatch(contents, /^export const .*CommandName = /m, `${path} should not be a marker module`);
  }

  const index = read("src/commands/index.ts");
  assert.doesNotMatch(index, /^function handle[A-Z]/gm, "src/commands/index.ts should dispatch imported command handlers, not own command implementations");
});


test("renderers own shared output helpers", () => {
  for (const file of [
    "src/renderers/json.ts",
    "src/renderers/attention.ts",
    "src/renderers/status.ts",
    "src/renderers/doctor.ts",
    "src/renderers/review.ts",
    "src/shared/errors.ts"
  ]) {
    assert.equal(existsSync(file), true, `${file} should exist`);
  }

  const commands = read("src/commands/index.ts");
  assert.doesNotMatch(commands, /^function printJson/gm);
  assert.doesNotMatch(commands, /^function attentionGlyph/gm);
  assert.doesNotMatch(commands, /^function printStatus/gm);
  assert.doesNotMatch(commands, /^function buildStatusAgentPacket/gm);
  assert.doesNotMatch(commands, /^function printDoctor/gm);
  assert.doesNotMatch(commands, /^function buildDoctorAgentPacket/gm);
  assert.doesNotMatch(commands, /^function printReview/gm);
  assert.doesNotMatch(commands, /^function buildReviewAgentPacket/gm);
});


test("shared CLI contracts and update adapters are explicit modules", () => {
  for (const file of [
    "src/shared/cli-types.ts",
    "src/shared/flags.ts",
    "src/config/env.ts",
    "src/config/paths.ts",
    "src/config/package.ts",
    "src/adapters/process.ts",
    "src/adapters/update.ts"
  ]) {
    assert.equal(existsSync(file), true, `${file} should exist`);
  }

  const cli = read("src/cli.ts");
  const commands = read("src/commands/index.ts");
  assert.doesNotMatch(cli, /^type ParsedArgs/gm);
  assert.doesNotMatch(commands, /^type ParsedArgs/gm);
  assert.doesNotMatch(commands, /^function getLatestVersion/gm);
  assert.doesNotMatch(commands, /process\.env\.ARTSHELF_UPDATE_DRY_RUN/);
  assert.doesNotMatch(commands, /spawnSync\("npm"/);
});

test("help text rendering stays out of the executable entrypoint", () => {
  const cli = read("src/cli.ts");
  const helpText = read("src/shared/help-text.ts");

  assert.doesNotMatch(cli, /\bCOMMAND_GROUPS\b/);
  assert.doesNotMatch(cli, /\bNESTED_HELP\b/);
  assert.doesNotMatch(cli, /\bfunction renderTopLevelHelp\b/);
  assert.doesNotMatch(cli, /\bfunction printHelp\b/);
  assert.doesNotMatch(cli, /Usage:\n  artshelf put/);

  assert.match(helpText, /\bexport function resolveHelpKey\b/);
  assert.match(helpText, /\bexport function renderHelp\b/);
  assert.match(helpText, /\bCOMMAND_GROUPS\b/);
});


test("architecture guardrails catch boundary and migration regressions", () => {
  const cli = read("src/cli.ts");
  assert.doesNotMatch(cli, /from "\.\/ledger\.js"/);
  assert.doesNotMatch(cli, /from "\.\/registry\.js"/);
  assert.doesNotMatch(cli, /from "\.\/adapters\//);
  assert.doesNotMatch(cli, /from "\.\/renderers\//);

  const sourceFiles = [
    "src/commands/index.ts",
    ...readdirSync("src/commands").filter((file) => file.endsWith(".ts") && file !== "index.ts").map((file) => `src/commands/${file}`),
    "src/adapters/update.ts",
    "src/adapters/process.ts",
    "src/config/env.ts",
    "src/config/paths.ts",
    "src/config/package.ts",
    "src/renderers/attention.ts",
    "src/renderers/doctor.ts",
    "src/renderers/json.ts",
    "src/renderers/review.ts",
    "src/renderers/status.ts",
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

test("layer imports only cross approved boundaries", () => {
  assertAllowedImports({
    directory: "src/renderers",
    disallowed: [/node:/, /\.\.\/ledger\.js/, /\.\.\/commands\//, /\.\.\/adapters\//, /\.\.\/config\//]
  });
  assertAllowedImports({
    directory: "src/adapters",
    disallowed: [/\.\.\/commands\//, /\.\.\/renderers\//, /\.\.\/ledger\.js/, /\.\.\/registry\.js/]
  });
  assertAllowedImports({
    directory: "src/config",
    disallowed: [/\.\.\/commands\//, /\.\.\/renderers\//, /\.\.\/adapters\//, /\.\.\/ledger\.js/, /\.\.\/registry\.js/]
  });
  assertAllowedImports({
    directory: "src/shared",
    disallowed: [/node:/, /\.\.\/commands\//, /\.\.\/renderers\//, /\.\.\/adapters\//, /\.\.\/config\//, /\.\.\/ledger\.js/, /\.\.\/registry\.js/]
  });
});

function capitalizeCommand(command: string): string {
  return command.split("-").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("");
}

function assertAllowedImports(options: { directory: string; disallowed: RegExp[] }): void {
  for (const file of readdirSync(options.directory).filter((entry) => entry.endsWith(".ts"))) {
    const path = `${options.directory}/${file}`;
    const contents = read(path);
    for (const match of contents.matchAll(/^\s*import\b(?!\s+type\b)(?:[^"';]*?\bfrom\b)?\s*["']([^"']+)["']/gm)) {
      const specifier = match[1];
      for (const pattern of options.disallowed) {
        assert.doesNotMatch(specifier, pattern, `${path} imports across a forbidden boundary: ${specifier}`);
      }
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
