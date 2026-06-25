import type { ParsedArgs } from "./cli-types.js";

export const BOOLEAN_FLAGS = new Set(["all", "json", "agent", "manual-review", "dry-run", "execute", "help", "version", "plain"]);
const COMMAND_BOOLEAN_FLAGS = new Map<string, ReadonlySet<string>>([["get", new Set(["inspect"])]]);
export const VALUE_FLAGS = new Set([
  "cleanup",
  "action",
  "event",
  "id",
  "kind",
  "label",
  "ledger",
  "name",
  "owner",
  "path",
  "payload",
  "plan-id",
  "older-than",
  "registry",
  "reason",
  "retain-until",
  "scope",
  "status",
  "ttl"
]);

export function isBooleanFlag(name: string, command: string | undefined): boolean {
  return BOOLEAN_FLAGS.has(name) || (command !== undefined && (COMMAND_BOOLEAN_FLAGS.get(command)?.has(name) ?? false));
}

export function requiredStringFlag(parsed: ParsedArgs, name: string): string {
  const value = stringFlag(parsed, name);
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

export function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (Array.isArray(value)) return value[value.length - 1];
  return typeof value === "string" ? value : undefined;
}

export function boolFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

export function arrayFlag(parsed: ParsedArgs, name: string): string[] {
  const value = parsed.flags.get(name);
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}
