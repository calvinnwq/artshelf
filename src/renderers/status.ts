import type { LedgerRegistryEntry } from "../registry.js";
import { attentionGlyph } from "./attention.js";

export type StatusCounts = {
  active: number;
  due: number;
  manualReview: number;
  missingPath: number;
  kept: number;
  pendingCleanup: number;
};

export type StatusLedger = {
  name: string;
  path: string;
  scope: LedgerRegistryEntry["scope"];
  status: "ok" | "missing" | "invalid";
  ok: boolean;
  counts: StatusCounts;
  errors: string[];
};

export type StatusReport = {
  ok: boolean;
  registryPath: string;
  registryExists: boolean;
  registryOk: boolean;
  registryError: string | null;
  ledgers: StatusLedger[];
  totals: StatusCounts & { ledgers: number; ok: number; stale: number; invalid: number };
};

export type StatusAgentPacket = {
  schemaVersion: 1;
  command: "status";
  scope: "all" | "single";
  health: "ok" | "attention";
  ledgerPath?: string;
  registry?: { path: string; exists: boolean; ok: boolean; error: string | null };
  ledgers?: { total: number; ok: number; stale: number; invalid: number };
  counts: StatusCounts;
  attention: string[];
  blockers: string[];
  nextAction: string;
  verification: string;
};

const STATUS_ATTENTION_CATEGORIES: ReadonlyArray<keyof StatusCounts> = ["due", "manualReview", "missingPath", "pendingCleanup"];

export function emptyStatusCounts(): StatusCounts {
  return { active: 0, due: 0, manualReview: 0, missingPath: 0, kept: 0, pendingCleanup: 0 };
}

export function sumStatusCounts(ledgers: StatusLedger[], key: keyof StatusCounts): number {
  return ledgers.reduce((total, ledger) => total + ledger.counts[key], 0);
}

export function statusAttention(counts: StatusCounts): string[] {
  return STATUS_ATTENTION_CATEGORIES.filter((key) => counts[key] > 0);
}

export function statusCommand(scope: "all" | "single", command: "status" | "review", ledgerPath?: string): string {
  if (scope === "all") return `artshelf ${command} --all`;
  return ledgerPath ? `artshelf ${command} --ledger ${ledgerPath}` : `artshelf ${command}`;
}

function statusNextAction(
  blockers: string[],
  counts: StatusCounts,
  scope: "all" | "single",
  ledgerPath?: string,
  registryPath?: string
): string {
  if (blockers.length > 0) {
    const verify = statusCommand(scope, "status", ledgerPath);
    return `repair ${blockers.length} broken ledger(s) above, then re-run \`${verify}\``;
  }
  const review = statusCommand(scope, "review", ledgerPath);
  if (counts.pendingCleanup > 0 || counts.due > 0) {
    return `run \`${review}\` to preview cleanup plans; nothing is auto-executed`;
  }
  if (counts.manualReview > 0) {
    return `run \`${review}\` to inspect manual-review records; nothing is auto-executed`;
  }
  if (counts.missingPath > 0) {
    const reconcile = scope === "all" ? `artshelf reconcile --dry-run --all${registryPath ? ` --registry ${registryPath}` : ""}` : `artshelf reconcile --dry-run --ledger ${ledgerPath}`;
    return `run \`${reconcile} --json\` and then \`${review}\` to surface reconcile-ready approvals; nothing is auto-executable`;
  }
  return "nothing due — no broken ledgers and no due, manual-review, missing-path, or pending cleanup entries";
}

export function buildStatusAgentPacketAll(report: StatusReport): StatusAgentPacket {
  const blockers: string[] = [];
  if (report.registryError) blockers.push(`registry unreadable: ${report.registryError}`);
  for (const ledger of report.ledgers) {
    if (ledger.status !== "ok") {
      blockers.push(`${ledger.name} ${ledger.status}${ledger.errors.length ? `: ${ledger.errors[0]}` : ""}`);
    }
  }
  const counts: StatusCounts = {
    active: report.totals.active,
    due: report.totals.due,
    manualReview: report.totals.manualReview,
    missingPath: report.totals.missingPath,
    kept: report.totals.kept,
    pendingCleanup: report.totals.pendingCleanup
  };
  return {
    schemaVersion: 1,
    command: "status",
    scope: "all",
    health: report.ok ? "ok" : "attention",
    registry: { path: report.registryPath, exists: report.registryExists, ok: report.registryOk, error: report.registryError },
    ledgers: { total: report.totals.ledgers, ok: report.totals.ok, stale: report.totals.stale, invalid: report.totals.invalid },
    counts,
    attention: statusAttention(counts),
    blockers,
    nextAction: statusNextAction(blockers, counts, "all", undefined, report.registryPath),
    verification: `artshelf status --all --agent --registry ${report.registryPath}`
  };
}

export function buildStatusAgentPacketSingle(ledger: StatusLedger, ledgerPath: string): StatusAgentPacket {
  const blockers: string[] = ledger.ok
    ? []
    : [`${ledger.status}${ledger.errors.length ? `: ${ledger.errors[0]}` : ""}`];
  return {
    schemaVersion: 1,
    command: "status",
    scope: "single",
    health: ledger.ok ? "ok" : "attention",
    ledgerPath,
    counts: ledger.counts,
    attention: statusAttention(ledger.counts),
    blockers,
    nextAction: statusNextAction(blockers, ledger.counts, "single", ledgerPath),
    verification: `artshelf status --agent --ledger ${ledgerPath}`
  };
}

export function printStatusAll(report: StatusReport): void {
  const anyActionable = report.ledgers.some((ledger) => statusAttention(ledger.counts).length > 0);
  process.stdout.write(`${attentionGlyph(!report.ok || anyActionable)} artshelf status: ${report.ok ? "ok" : "needs attention"}\n`);
  process.stdout.write(`registry: ${report.registryPath}${report.registryExists ? "" : " (absent)"} — ${report.totals.ledgers} ledgers (${report.totals.ok} ok, ${report.totals.stale} stale, ${report.totals.invalid} invalid)\n`);
  if (report.registryError) process.stdout.write(`registry error: ${report.registryError}\n`);
  for (const ledger of report.ledgers) {
    if (ledger.status === "ok") {
      process.stdout.write(`${attentionGlyph(statusAttention(ledger.counts).length > 0)} [${ledger.name}] ${formatStatusCounts(ledger.counts)}\n`);
    } else {
      process.stdout.write(`⚠ [${ledger.name}] ${ledger.status}: ${ledger.errors.join("; ")}\n`);
    }
  }
  process.stdout.write(`total: ${formatStatusCounts(report.totals)}\n`);
}

export function printStatusSingle(ledger: StatusLedger): void {
  const needsAttention = !ledger.ok || statusAttention(ledger.counts).length > 0;
  process.stdout.write(`${attentionGlyph(needsAttention)} artshelf status: ${ledger.ok ? "ok" : ledger.status}\n`);
  process.stdout.write(`ledger: ${ledger.path}\n`);
  if (ledger.ok) {
    process.stdout.write(`${formatStatusCounts(ledger.counts)}\n`);
  } else {
    for (const message of ledger.errors) process.stdout.write(`error: ${message}\n`);
  }
}

function formatStatusCounts(counts: StatusCounts): string {
  return `active ${counts.active} · due ${counts.due} · manual-review ${counts.manualReview} · missing ${counts.missingPath} · kept ${counts.kept} · pending ${counts.pendingCleanup}`;
}
