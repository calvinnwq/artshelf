import { dueEntries, readLedger } from "../ledger.js";
import { normalizeRegistryPath } from "../registry.js";
import { printJson } from "../renderers/json.js";
import { boolFlag, stringFlag } from "../shared/flags.js";
import type { ParsedArgs } from "../shared/cli-types.js";
import { printDueEntries, printRegisteredLedgerValidation, validateRegisteredLedgersOrThrow } from "./shared.js";

export function handleDue(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  if (boolFlag(parsed, "all")) {
    const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
    const validation = validateRegisteredLedgersOrThrow(registryPath);
    if (!validation.ok) return printRegisteredLedgerValidation(registryPath, validation.results, json);
    const results = validation.results.map(({ ledger }) => ({ ledger, entries: dueEntries(readLedger(ledger.path)) }));
    if (json) return printJson({ ok: true, registryPath, ledgers: results });
    printDueEntries(results);
    process.stdout.write(`registry: ${registryPath}\n`);
    return 0;
  }
  const entries = dueEntries(readLedger(ledgerPath));
  const visible = entries.filter((entry) => entry.dueStatus !== "kept");
  if (json) return printJson({ ok: true, ledgerPath, entries });
  if (visible.length === 0) {
    process.stdout.write(`nothing due\nledger: ${ledgerPath}\n`);
    return 0;
  }
  for (const entry of visible) {
    process.stdout.write(`${entry.dueStatus} ${entry.id} ${entry.cleanup} ${entry.path} :: ${entry.reason}\n`);
  }
  process.stdout.write(`ledger: ${ledgerPath}\n`);
  return 0;
}
