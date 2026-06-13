import { appendPreparedRecord, prepareRecord } from "../ledger.js";
import { normalizeRegistryPath, registerLedger } from "../registry.js";
import type { LedgerRegistryEntry } from "../registry.js";
import { printJson } from "../renderers/json.js";
import { arrayFlag, boolFlag, requiredStringFlag, stringFlag } from "../shared/flags.js";
import type { ParsedArgs } from "../shared/cli-types.js";

export function handlePut(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  const path = parsed.positionals[0];
  if (!path) throw new Error("put requires <path>");

  const record = prepareRecord({
    path,
    reason: requiredStringFlag(parsed, "reason"),
    ttl: stringFlag(parsed, "ttl"),
    retainUntil: stringFlag(parsed, "retain-until"),
    manualReview: boolFlag(parsed, "manual-review"),
    kind: stringFlag(parsed, "kind"),
    cleanup: stringFlag(parsed, "cleanup"),
    owner: stringFlag(parsed, "owner"),
    labels: arrayFlag(parsed, "label")
  });
  const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
  appendPreparedRecord(ledgerPath, record);
  let ledger: LedgerRegistryEntry | undefined;
  let registryError: string | undefined;
  try {
    ledger = registerLedger({ ledgerPath, registryPath });
  } catch (error) {
    registryError = (error as Error).message;
  }

  if (json) return printJson({ ok: true, record, ledgerPath, registryPath, ...(ledger ? { ledger } : {}), ...(registryError ? { registryError } : {}) });
  process.stdout.write(`recorded ${record.id}\npath: ${record.path}\nretains until: ${record.retainUntil ?? "manual review"}\nledger: ${ledgerPath}\n`);
  if (registryError) process.stdout.write(`registry warning: ${registryError}\n`);
  return 0;
}
