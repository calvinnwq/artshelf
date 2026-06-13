import { validateLedger } from "../ledger.js";
import { normalizeRegistryPath } from "../registry.js";
import { printJson } from "../renderers/json.js";
import { boolFlag, stringFlag } from "../shared/flags.js";
import type { ParsedArgs } from "../shared/cli-types.js";
import { registeredLedgersOrThrow, validateRegisteredLedger } from "./shared.js";

export function handleValidate(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  if (boolFlag(parsed, "all")) {
    const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
    const results = registeredLedgersOrThrow(registryPath).map((ledger) => ({ ledger, result: validateRegisteredLedger(ledger) }));
    const ok = results.every((entry) => entry.result.ok);
    if (json) {
      printJson({ ok, registryPath, ledgers: results });
      return ok ? 0 : 1;
    }
    for (const entry of results) {
      process.stdout.write(`${entry.result.ok ? "ok" : "invalid"} ${entry.ledger.name}: ${entry.result.entries} entries, ${entry.result.errors.length} errors, ${entry.result.warnings.length} warnings\nledger: ${entry.ledger.path}\n`);
      for (const error of entry.result.errors) process.stdout.write(`error: ${error}\n`);
      for (const warning of entry.result.warnings) process.stdout.write(`warning: ${warning}\n`);
    }
    process.stdout.write(`registry: ${registryPath}\n`);
    return ok ? 0 : 1;
  }
  const result = validateLedger(ledgerPath);
  if (json) return printJson({ ledgerPath, ...result });
  process.stdout.write(`${result.ok ? "ok" : "invalid"}: ${result.entries} entries, ${result.errors.length} errors, ${result.warnings.length} warnings\n`);
  for (const error of result.errors) process.stdout.write(`error: ${error}\n`);
  for (const warning of result.warnings) process.stdout.write(`warning: ${warning}\n`);
  process.stdout.write(`ledger: ${ledgerPath}\n`);
  return result.ok ? 0 : 1;
}
