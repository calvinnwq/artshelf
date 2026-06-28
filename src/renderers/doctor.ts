import type { LedgerRegistryEntry } from "../registry.js";
import { attentionGlyph } from "./attention.js";

export type DoctorLedger = {
  name: string;
  path: string;
  scope: LedgerRegistryEntry["scope"];
  status: "ok" | "missing" | "invalid";
  ok: boolean;
  entries: number;
  errors: string[];
  warnings: string[];
};

export type DoctorReport = {
  ok: boolean;
  version: string;
  node: string;
  ledgerPath: string;
  ledgerExists: boolean;
  registryPath: string;
  registryExists: boolean;
  registryOk: boolean;
  registryError: string | null;
  ledgers: DoctorLedger[];
  summary: { ledgers: number; ok: number; stale: number; invalid: number; warnings: number };
  cleanupSafety: {
    executeRequiresLedgerAndPlanId: boolean;
    globalExecuteRefused: boolean;
    deleteRefusedInV1: boolean;
    dryRunBeforeMutation: boolean;
  };
  errors: string[];
};

export type DoctorAgentPacket = {
  schemaVersion: 1;
  command: "doctor";
  health: "ok" | "attention";
  version: string;
  node: string;
  ledgerPath: string;
  registry: { path: string; exists: boolean; ok: boolean; error: string | null };
  ledgers: { total: number; ok: number; stale: number; invalid: number; warnings: number };
  attention: string[];
  blockers: string[];
  cleanupSafety: DoctorReport["cleanupSafety"];
  nextAction: string;
  verification: string;
};

const DOCTOR_ATTENTION_CATEGORIES: ReadonlyArray<keyof DoctorReport["summary"]> = ["stale", "invalid", "warnings"];

function doctorAttention(summary: DoctorReport["summary"]): string[] {
  return DOCTOR_ATTENTION_CATEGORIES.filter((key) => summary[key] > 0);
}

function doctorNextAction(blockers: string[], summary: DoctorReport["summary"], registryPath: string): string {
  if (blockers.length > 0) {
    const fixes: string[] = [];
    if (summary.stale > 0) {
      fixes.push(
        `run \`artshelf ledgers prune --dry-run --registry ${registryPath}\` to review removing ${summary.stale} missing/stale registration(s)`
      );
    }
    if (summary.invalid > 0) {
      fixes.push(`repair ${summary.invalid} invalid ledger file(s) above`);
    }
    if (fixes.length === 0) {
      return `repair ${blockers.length} registry/ledger issue(s) above, then re-run \`artshelf doctor\``;
    }
    return `${fixes.join("; ")}, then re-run \`artshelf doctor\``;
  }
  if (summary.warnings > 0) {
    return `healthy, but ${summary.warnings} warning(s) noted — run \`artshelf reconcile --dry-run --all --registry ${registryPath}\` to prepare reconcile-ready approvals, then run \`artshelf review --all --registry ${registryPath}\`; nothing is auto-executed`;
  }
  return "artshelf is healthy on this machine — cleanup safety enforced; no action needed";
}

export function buildDoctorAgentPacket(report: DoctorReport): DoctorAgentPacket {
  const blockers: string[] = [];
  if (report.registryError) blockers.push(`registry unreadable: ${report.registryError}`);
  for (const ledger of report.ledgers) {
    if (ledger.status !== "ok") {
      blockers.push(`${ledger.name} ${ledger.status}${ledger.errors.length ? `: ${ledger.errors[0]}` : ""}`);
    }
  }
  return {
    schemaVersion: 1,
    command: "doctor",
    health: report.ok ? "ok" : "attention",
    version: report.version,
    node: report.node,
    ledgerPath: report.ledgerPath,
    registry: { path: report.registryPath, exists: report.registryExists, ok: report.registryOk, error: report.registryError },
    ledgers: {
      total: report.summary.ledgers,
      ok: report.summary.ok,
      stale: report.summary.stale,
      invalid: report.summary.invalid,
      warnings: report.summary.warnings
    },
    attention: doctorAttention(report.summary),
    blockers,
    cleanupSafety: report.cleanupSafety,
    nextAction: doctorNextAction(blockers, report.summary, report.registryPath),
    verification: `artshelf doctor --agent --registry ${report.registryPath}`
  };
}

export function printDoctor(report: DoctorReport): void {
  process.stdout.write(`artshelf ${report.version} (node ${report.node})\n`);
  process.stdout.write(`${attentionGlyph(!report.ok)} health: ${report.ok ? "ok" : "needs attention"}\n`);
  process.stdout.write(`ledger: ${report.ledgerPath}${report.ledgerExists ? "" : " (absent)"}\n`);
  process.stdout.write(`registry: ${report.registryPath}${report.registryExists ? "" : " (absent)"}\n`);
  if (report.registryError) process.stdout.write(`registry error: ${report.registryError}\n`);
  process.stdout.write(`registered ledgers: ${report.summary.ledgers} (${report.summary.ok} ok, ${report.summary.stale} stale, ${report.summary.invalid} invalid)\n`);
  for (const ledger of report.ledgers) {
    process.stdout.write(`  ${attentionGlyph(ledger.status !== "ok")} ${ledger.status} ${ledger.name} ${ledger.path}\n`);
    for (const message of ledger.errors) process.stdout.write(`    error: ${message}\n`);
  }
  process.stdout.write("cleanup safety: execute requires a reviewed plan id against a single ledger; --all execute is refused; cleanup=delete is refused; physical trash purge requires a separate reviewed purge plan or exact approved trash-purge bundle\n");
  if (!report.ok) {
    for (const message of report.errors) process.stdout.write(`error: ${message}\n`);
  }
}
