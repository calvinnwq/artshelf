import { filterRecordsByStatus, readLedger } from "../ledger.js";
import { normalizeRegistryPath } from "../registry.js";
import { printJson } from "../renderers/json.js";
import { boolFlag, stringFlag } from "../shared/flags.js";
import type { ParsedArgs } from "../shared/cli-types.js";
import { printLedgerEntries, printRegisteredLedgerValidation, validateRegisteredLedgersOrThrow } from "./shared.js";

export function handleList(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  if (boolFlag(parsed, "all")) {
    const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
    const status = stringFlag(parsed, "status");
    const validation = validateRegisteredLedgersOrThrow(registryPath);
    if (!validation.ok) return printRegisteredLedgerValidation(registryPath, validation.results, json);
    const results = validation.results.map(({ ledger }) => ({
      ledger,
      entries: filterRecordsByStatus(readLedger(ledger.path), status)
    }));
    if (json) return printJson({ ok: true, registryPath, ...(status ? { status } : {}), ledgers: results });
    printLedgerEntries(results, status);
    process.stdout.write(`registry: ${registryPath}\n`);
    return 0;
  }

  const status = stringFlag(parsed, "status");
  const records = filterRecordsByStatus(readLedger(ledgerPath), status);
  if (json) return printJson({ ok: true, ledgerPath, ...(status ? { status } : {}), entries: records });
  if (records.length === 0) {
    process.stdout.write(`no artshelf entries${status ? ` with status ${status}` : ""}\nledger: ${ledgerPath}\n`);
    return 0;
  }
  for (const record of records) {
    process.stdout.write(`${record.id} ${record.kind} ${record.status} ${record.cleanup} ${record.path} :: ${record.reason}\n`);
  }
  process.stdout.write(`ledger: ${ledgerPath}\n`);
  return 0;
}
