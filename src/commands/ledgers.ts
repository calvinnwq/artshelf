import { existsSync } from "node:fs";
import { normalizeLedgerPath } from "../ledger.js";
import {
  listRegisteredLedgers,
  normalizeRegistryPath,
  registerLedger
} from "../registry.js";
import type { LedgerRegistryEntry } from "../registry.js";
import { printJson } from "../renderers/json.js";
import { boolFlag, requiredStringFlag, stringFlag } from "../shared/flags.js";
import { LEDGERS_HELP } from "../shared/help-text.js";
import type { ParsedArgs } from "../shared/cli-types.js";
import { validateRegisteredLedger } from "./shared.js";

export function handleLedgers(parsed: ParsedArgs, json: boolean): number {
  const action = parsed.positionals[0] ?? "list";
  const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
  if (action === "help") {
    process.stdout.write(LEDGERS_HELP);
    return 0;
  }
  if (action === "add") {
    const ledgerPath = normalizeLedgerPath(requiredStringFlag(parsed, "ledger"));
    if (!existsSync(ledgerPath)) throw new Error(`Ledger does not exist: ${ledgerPath}`);
    const entry = registerLedger({
      ledgerPath,
      name: stringFlag(parsed, "name"),
      scope: stringFlag(parsed, "scope"),
      registryPath
    });
    if (json) return printJson({ ok: true, registryPath, ledger: entry });
    process.stdout.write(`registered ${entry.name}\nledger: ${entry.path}\nregistry: ${registryPath}\n`);
    return 0;
  }
  if (action === "list") {
    if (boolFlag(parsed, "plain")) {
      const ledgers = listRegisteredLedgers(registryPath);
      if (json) return printJson({ ok: true, registryPath, ledgers });
      if (ledgers.length === 0) {
        process.stdout.write(`no registered Artshelf ledgers\nregistry: ${registryPath}\n`);
        return 0;
      }
      for (const ledger of ledgers) process.stdout.write(`${ledger.name} ${ledger.scope} ${ledger.path}\n`);
      process.stdout.write(`registry: ${registryPath}\n`);
      return 0;
    }

    const report = buildLedgersReport(registryPath);
    if (json) {
      printJson(report);
      return report.ok ? 0 : 1;
    }
    printLedgersList(report);
    return report.ok ? 0 : 1;
  }
  throw new Error(`Unknown ledgers action: ${action}`);
}

type LedgerListing = LedgerRegistryEntry & {
  status: "ok" | "missing" | "invalid";
  ok: boolean;
  entries: number;
  errors: string[];
  warnings: string[];
};

type LedgersReport = {
  ok: boolean;
  registryPath: string;
  registryExists: boolean;
  registryOk: boolean;
  registryError: string | null;
  ledgers: LedgerListing[];
  summary: { ledgers: number; ok: number; stale: number; invalid: number; warnings: number };
};

function buildLedgersReport(registryPath: string): LedgersReport {
  let registryOk = true;
  let registryError: string | null = null;
  let entries: LedgerRegistryEntry[] = [];
  try {
    entries = listRegisteredLedgers(registryPath);
  } catch (error) {
    registryOk = false;
    registryError = (error as Error).message;
  }

  const ledgers: LedgerListing[] = entries.map((entry) => {
    const result = validateRegisteredLedger(entry);
    const status: LedgerListing["status"] = result.ok ? "ok" : existsSync(entry.path) ? "invalid" : "missing";
    return {
      ...entry,
      status,
      ok: result.ok,
      entries: result.entries,
      errors: result.errors,
      warnings: result.warnings
    };
  });

  const summary = {
    ledgers: ledgers.length,
    ok: ledgers.filter((ledger) => ledger.status === "ok").length,
    stale: ledgers.filter((ledger) => ledger.status === "missing").length,
    invalid: ledgers.filter((ledger) => ledger.status === "invalid").length,
    warnings: ledgers.reduce((count, ledger) => count + ledger.warnings.length, 0)
  };

  return {
    ok: registryOk && summary.stale === 0 && summary.invalid === 0,
    registryPath,
    registryExists: existsSync(registryPath),
    registryOk,
    registryError,
    ledgers,
    summary
  };
}

function printLedgersList(report: LedgersReport): void {
  process.stdout.write(`artshelf ledgers: ${report.ok ? "ok" : "needs attention"}\n`);
  process.stdout.write(`registry: ${report.registryPath}${report.registryExists ? "" : " (absent)"} — ${report.summary.ledgers} ledgers (${report.summary.ok} ok, ${report.summary.stale} stale, ${report.summary.invalid} invalid)\n`);
  if (report.registryError) process.stdout.write(`registry error: ${report.registryError}\n`);
  if (report.ledgers.length === 0) {
    process.stdout.write("no registered Artshelf ledgers\n");
    return;
  }
  for (const ledger of report.ledgers) {
    if (ledger.status === "ok") {
      process.stdout.write(`[${ledger.name}] ok ${ledger.scope}: ${ledger.entries} entries, ${ledger.warnings.length} warnings — ${ledger.path}\n`);
    } else {
      process.stdout.write(`[${ledger.name}] ${ledger.status} ${ledger.scope}: ${ledger.errors.join("; ")} — ${ledger.path}\n`);
    }
  }
}
