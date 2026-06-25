import { lastActionOf, needsContextBadge } from "./dashboard.js";
import type { DashboardLastAction, DashboardNeedsContext } from "./dashboard.js";
import { buildInspectReport } from "./inspect.js";
import type { InspectReport } from "./inspect.js";
import { getRecord, normalizeLedgerPath, readLedger } from "./ledger.js";
import { listRegisteredLedgers, normalizeRegistryPath } from "./registry.js";
import { now, toIso } from "./time.js";
import type { ArtshelfRecord, DueStatus, PathProvenance } from "./types.js";

// Read-only artifact detail drawer (NGX-536, Artshelf UI v1 contract slice 2). The drawer is the
// single-record deep view a dashboard row opens into. It composes the existing read-only inspect
// decision card (the same one `get <id> --inspect --json` prints) with a structured provenance
// view, the full audit trail, the last action, and the NGX-537 needs-context badge into the
// contract's Minimum Human-Judgment Fields. Like the dashboard, it recomputes from live ledger
// state, never mutates anything, and never reads or previews file contents - human judgment comes
// from metadata, the original reason, provenance, the inspect recommendation, and receipts.

// One entry in the chronological audit trail. "created" is the row's birth; the rest mirror the
// audited dispositions `lastActionOf` ranks (the drawer shows the whole trail, not just the last).
export type ArtifactAuditKind = "created" | "cleanup" | "dispose" | "reconcile" | "resolve" | "purge";

export type ArtifactAuditEvent = {
  kind: ArtifactAuditKind;
  at: string;
  receiptPath: string | null;
  reason: string | null;
  // Action-specific context (e.g. trash target, the path a reconcile remapped from), else null.
  detail: string | null;
};

// Structured provenance view. `present` is false for legacy rows written before path provenance
// existed; when present, the full PathProvenance is surfaced so the drawer can show root/relative
// path/fingerprint without re-deriving anything. This is metadata only - never a file read.
export type ArtifactProvenanceView = {
  present: boolean;
  provenance: PathProvenance | null;
};

export type ArtifactDetail = {
  schemaVersion: 1;
  generatedAt: string;
  recordId: string;
  // Friendly registry name for the owning ledger, or null when the ledger is unregistered.
  ledgerName: string | null;
  ledgerPath: string;
  createdAt: string;
  // Concise human phrase for why the record is up for review now, or null when nothing is due
  // (terminal records, or rows held within their retention window).
  dueReason: string | null;
  // The full inspect decision card: status, reason, existence facts, age, retention, cleanup
  // policy, due state, recommendation, and next action.
  inspect: InspectReport;
  // NGX-537 weak-reason/insufficient-provenance badge, null when reviewable normally.
  needsContext: DashboardNeedsContext | null;
  provenance: ArtifactProvenanceView;
  // Chronological audit trail, oldest-first, ending in the most recent action.
  audit: ArtifactAuditEvent[];
  // The single most recent audited action with its receipt, or null when never acted on.
  lastAction: DashboardLastAction | null;
};

export type BuildArtifactDetailOptions = {
  // Which ledger holds the record; defaults to the working-directory ledger.
  ledgerPath?: string;
  recordId: string;
  // Registry used only to resolve the ledger's friendly name; defaults to the standard registry.
  registryPath?: string;
  now?: Date;
};

export function buildArtifactDetail(options: BuildArtifactDetailOptions): ArtifactDetail {
  const ledgerPath = normalizeLedgerPath(options.ledgerPath);
  const at = options.now ?? now();
  const record = getRecord(readLedger(ledgerPath), options.recordId);
  const inspect = buildInspectReport(record, { ledgerPath, now: at });

  return {
    schemaVersion: 1,
    generatedAt: toIso(at),
    recordId: record.id,
    ledgerName: resolveLedgerName(ledgerPath, options.registryPath),
    ledgerPath,
    createdAt: record.createdAt,
    dueReason: dueReasonOf(inspect.dueState),
    inspect,
    needsContext: needsContextBadge(record),
    provenance: provenanceView(record),
    audit: auditTrail(record),
    lastAction: lastActionOf(record)
  };
}

// Resolve the owning ledger's registry name. The drawer is opened for a known ledger path, so this
// is a best-effort lookup: an unregistered (but readable) ledger yields a null name rather than an
// error, mirroring how the dashboard tolerates ad-hoc ledgers.
function resolveLedgerName(ledgerPath: string, registryPath?: string): string | null {
  const registered = listRegisteredLedgers(normalizeRegistryPath(registryPath));
  return registered.find((ledger) => ledger.path === ledgerPath)?.name ?? null;
}

// Concise "review due reason" copy keyed off the inspect due state. Null for terminal records,
// where review is moot (the inspect card itself carries the already-resolved/trashed next action).
const DUE_REASON_COPY: Record<DueStatus, string> = {
  due: "Past its retention window and due for review now.",
  "manual-review": "Held for manual review - a human decision is required before any disposition.",
  "missing-path": "The recorded path is missing - confirm the artifact is gone, then resolve it.",
  kept: "Within its retention hold - not due for review yet."
};

function dueReasonOf(dueState: DueStatus | null): string | null {
  return dueState ? DUE_REASON_COPY[dueState] : null;
}

function provenanceView(record: ArtshelfRecord): ArtifactProvenanceView {
  const provenance = record.provenance ?? null;
  return { present: provenance !== null, provenance };
}

// The full audit trail in chronological order. Mirrors the audited dispositions `lastActionOf`
// ranks, plus the record's creation, so the drawer shows the whole history while `lastAction`
// highlights the latest. Timestamps come straight off the record's audit fields.
function auditTrail(record: ArtshelfRecord): ArtifactAuditEvent[] {
  const events: ArtifactAuditEvent[] = [
    { kind: "created", at: record.createdAt, receiptPath: null, reason: record.reason.trim() ? record.reason : null, detail: null }
  ];
  if (record.cleanedAt) {
    events.push({
      kind: "cleanup",
      at: record.cleanedAt,
      receiptPath: record.receiptPath ?? null,
      reason: record.cleanupReason ?? null,
      detail: record.targetPath ? `moved to ${record.targetPath}` : null
    });
  }
  if (record.disposedAt) {
    events.push({
      kind: "dispose",
      at: record.disposedAt,
      receiptPath: record.disposeReceiptPath ?? null,
      reason: record.disposeReason ?? null,
      detail: record.disposeAction ?? null
    });
  }
  if (record.reconciledAt) {
    events.push({
      kind: "reconcile",
      at: record.reconciledAt,
      receiptPath: record.reconcileReceiptPath ?? null,
      reason: record.reconcileReason ?? null,
      detail: record.previousPath ? `was ${record.previousPath}` : null
    });
  }
  if (record.resolvedAt) {
    events.push({ kind: "resolve", at: record.resolvedAt, receiptPath: null, reason: record.resolutionReason ?? null, detail: null });
  }
  if (record.purgedAt) {
    events.push({ kind: "purge", at: record.purgedAt, receiptPath: record.purgeReceiptPath ?? null, reason: null, detail: "no recovery path" });
  }
  return events.sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime());
}
