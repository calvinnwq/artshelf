#!/usr/bin/env node
import { maybeNotifyAvailableUpdate, runCommand } from "./commands/index.js";
import { VERSION } from "./config/package.js";
import { formatCliError } from "./shared/errors.js";
import { BOOLEAN_FLAGS, boolFlag, VALUE_FLAGS } from "./shared/flags.js";
import { renderHelp, resolveHelpKey } from "./shared/help-text.js";
import type { ParsedArgs } from "./shared/cli-types.js";


async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    let status = 0;
    let shouldCheckForUpdate = true;

    if (parsed.command === "--version" || parsed.command === "-v" || boolFlag(parsed, "version")) {
      process.stdout.write(`artshelf ${VERSION}\n`);
      return maybeNotifyUpdateAndReturn(0, parsed);
    }

    if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h" || boolFlag(parsed, "help")) {
      process.stdout.write(renderHelp(resolveHelpKey(parsed), VERSION));
      return maybeNotifyUpdateAndReturn(0, parsed);
    }

    if (parsed.command === undefined) {
      process.stdout.write(renderHelp("", VERSION));
      status = 0;
    } else {
      const result = await runCommand(parsed);
      status = result.status;
      shouldCheckForUpdate = result.shouldCheckForUpdate;
    }
    if (!shouldCheckForUpdate) return status;
    return maybeNotifyUpdateAndReturn(status, parsed);
  } catch (error) {
    process.stderr.write(formatCliError(error));
    return 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean | string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) continue;
    if (token === "-h") {
      flags.set("help", true);
      continue;
    }
    if (token === "-v") {
      flags.set("version", true);
      continue;
    }
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, true);
        continue;
      }
      if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown flag: --${name}`);
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
      index += 1;
      if (name === "label") {
        const previous = flags.get(name);
        flags.set(name, [...(Array.isArray(previous) ? previous : []), value]);
      } else {
        flags.set(name, value);
      }
      continue;
    }
    positionals.push(token);
  }
  return { command, positionals, flags };
}


async function maybeNotifyUpdateAndReturn(status: number, parsed: ParsedArgs): Promise<number> {
  await maybeNotifyAvailableUpdate(parsed);
  return status;
}

main(process.argv.slice(2))
  .then((status) => {
    process.exitCode = status;
  })
  .catch((error) => {
    process.stderr.write(formatCliError(error));
    process.exitCode = 1;
  });
