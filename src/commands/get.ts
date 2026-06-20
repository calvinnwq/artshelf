import { buildInspectReport } from "../inspect.js";
import { getRecord, readLedger } from "../ledger.js";
import { normalizeRegistryPath } from "../registry.js";
import { buildInspectAgentPacket, printInspect } from "../renderers/inspect.js";
import { printCompactJson, printJson } from "../renderers/json.js";
import { boolFlag, stringFlag } from "../shared/flags.js";
import type { ParsedArgs } from "../shared/cli-types.js";
import type { ArtshelfRecord } from "../types.js";
import { printRegisteredLedgerValidation, validateRegisteredLedgersOrThrow } from "./shared.js";

export function handleGet(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  const id = parsed.positionals[0];
  if (!id) throw new Error("get requires <id>");
  const inspect = boolFlag(parsed, "inspect");
  const agent = boolFlag(parsed, "agent");
  if (agent && !inspect) throw new Error("--agent requires --inspect for get");
  if (boolFlag(parsed, "all")) {
    const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
    const validation = validateRegisteredLedgersOrThrow(registryPath);
    if (!validation.ok) return printRegisteredLedgerValidation(registryPath, validation.results, json || agent);
    for (const { ledger } of validation.results) {
      const record = readLedger(ledger.path).find((entry) => entry.id === id);
      if (record) {
        if (inspect) return renderInspect(record, ledger.path, json, agent);
        if (json) return printJson({ ok: true, registryPath, ledger, record });
        process.stdout.write(`${record.id} ${record.kind} ${record.status} ${record.cleanup} ${record.path}\nreason: ${record.reason}\nledger: ${ledger.path}\nregistry: ${registryPath}\n`);
        return 0;
      }
    }
    throw new Error(`Artshelf record not found: ${id}`);
  }
  const record = getRecord(readLedger(ledgerPath), id);
  if (inspect) return renderInspect(record, ledgerPath, json, agent);
  if (json) return printJson({ ok: true, ledgerPath, record });
  process.stdout.write(`${record.id} ${record.kind} ${record.status} ${record.cleanup} ${record.path}\nreason: ${record.reason}\nledger: ${ledgerPath}\n`);
  return 0;
}

// Read-only inspect surface (NGX-482): builds a deterministic decision report and
// renders it as a human card, full JSON, or a compact agent packet. --agent wins
// over --json, matching `review`. Never mutates the ledger or the filesystem.
function renderInspect(record: ArtshelfRecord, ledgerPath: string, json: boolean, agent: boolean): number {
  const report = buildInspectReport(record, { ledgerPath });
  if (agent) return printCompactJson(buildInspectAgentPacket(report, ledgerPath));
  if (json) return printJson({ ok: true, ledgerPath, inspect: report });
  printInspect(report, ledgerPath);
  return 0;
}
