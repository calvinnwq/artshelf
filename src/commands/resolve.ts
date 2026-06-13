import { resolveRecord } from "../ledger.js";
import { printJson } from "../renderers/json.js";
import { requiredStringFlag } from "../shared/flags.js";
import type { ParsedArgs } from "../shared/cli-types.js";

export function handleResolve(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  const id = parsed.positionals[0];
  if (!id) throw new Error("resolve requires <id>");
  const record = resolveRecord(ledgerPath, {
    id,
    status: requiredStringFlag(parsed, "status"),
    reason: requiredStringFlag(parsed, "reason")
  });
  if (json) return printJson({ ok: true, record, ledgerPath });
  process.stdout.write(`resolved ${record.id}\nstatus: ${record.status}\nledger: ${ledgerPath}\n`);
  return 0;
}
