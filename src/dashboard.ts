import { existsSync } from "node:fs";
import { buildInspectReport } from "./inspect.js";
import type { InspectExistence, InspectRecommendation } from "./inspect.js";
import { listTrashedRecords, normalizeLedgerPath, previewTrashPurgePlan, readLedger, validateLedger } from "./ledger.js";
import { classifyRegistryPruneFindings } from "./registry-prune.js";
import { classifyReconcileFindings } from "./reconcile.js";
import { listRegisteredLedgers, normalizeRegistryPath } from "./registry.js";
import type { LedgerRegistryEntry, LedgerScope } from "./registry.js";
import { ageOf, now, toIso } from "./time.js";
import type { ArtshelfKind, ArtshelfRecord, ArtshelfStatus, CleanupAction, DueStatus, Retention } from "./types.js";

// Read-only multi-ledger review dashboard (NGX-535, Artshelf UI v1 contract slice 2). The
// dashboard recomputes live state from registered ledgers, the registry, and trash by
// composing the existing read-only domain surfaces (validate/due/inspect/trash/reconcile/
// registry-prune). It never mutates a ledger, registry, plan, or file, and it never reads or
// previews file contents - human judgment comes from metadata, original reason, provenance,
// inspect recommendations, and receipts. This module is the data core both the browser and the
// agent read.

// The eight dashboard lanes from the UI v1 contract. `needs-context` is the bucket for records
// whose original reason or provenance is too weak to review normally (NGX-537): they are pulled
// out of the normal review lanes so a human can add context before any disposition.
export type DashboardBucketKey =
  | "needs-review"
  | "needs-context"
  | "cleanup"
  | "resolve"
  | "trash"
  | "purge-candidates"
  | "registry-reconcile"
  | "recent-receipts";

export type DashboardReceiptKind = "cleanup" | "trash-purge" | "dispose" | "reconcile";
export type DashboardActionKind = "cleanup" | "dispose" | "reconcile" | "resolve" | "purge";

// The most recent completed action recorded on a row's audit trail, surfaced as "last action
// and receipt when available". Null while a row has never been acted on.
export type DashboardLastAction = {
  kind: DashboardActionKind;
  at: string;
  receiptPath: string | null;
  reason: string | null;
};

// Why a record is bucketed as needs-context (NGX-537): its original reason is missing or too
// vague to act on, or its provenance can't establish the artifact's origin. `label` is the
// reviewer-facing display copy the dashboard shows in place of a normal review action.
export type NeedsContextReason = "missing-reason" | "vague-reason" | "insufficient-provenance";
export type DashboardNeedsContext = { reason: NeedsContextReason; label: string };

// A reviewable artifact row (needs-review / needs-context / cleanup / resolve). Carries the
// contract's minimum human-judgment fields and never any file content.
export type DashboardArtifactRow = {
  recordId: string;
  ledgerName: string;
  ledgerPath: string;
  status: ArtshelfStatus;
  kind: ArtshelfKind;
  path: string;
  reason: string;
  createdAt: string;
  age: string;
  retention: Retention;
  retainUntil: string | null;
  cleanup: CleanupAction;
  existence: InspectExistence;
  dueState: DueStatus | null;
  recommendation: InspectRecommendation;
  hasProvenance: boolean;
  // Non-null when the record is pulled into the needs-context lane; null on rows that are
  // reviewable normally, so the UI can branch on a single field.
  needsContext: DashboardNeedsContext | null;
  lastAction: DashboardLastAction | null;
};

// A trash / purge-candidate row. Same projection the `trash list` surface uses, plus the
// owning ledger so the multi-ledger lane stays target-exact.
export type DashboardTrashRow = {
  recordId: string;
  ledgerName: string;
  ledgerPath: string;
  targetPath: string;
  cleanedAt: string;
  age: string;
  cleanupPlanId: string;
  receiptPath: string;
};

// A registry/reconcile problem row. `source` distinguishes a path-drift finding (reconcile)
// from a stale/duplicate registration (registry prune); both point at exact targets.
export type DashboardProblemRow = {
  source: "reconcile" | "registry";
  ledgerName: string | null;
  ledgerPath: string | null;
  recordId: string | null;
  category: string;
  detail: string;
  currentPath: string | null;
  proposedPath: string | null;
};

// A recent receipt row from the completed/recent lane.
export type DashboardReceiptRow = {
  recordId: string;
  ledgerName: string;
  ledgerPath: string;
  receiptKind: DashboardReceiptKind;
  path: string;
  reason: string;
  createdAt: string;
  age: string;
};

// Per-ledger source health, mirroring the review surface: an invalid or missing ledger is
// reported here and contributes no bucket rows, so one bad ledger never breaks the dashboard.
export type DashboardLedgerStatus = {
  name: string;
  path: string;
  scope: LedgerScope;
  exists: boolean;
  ok: boolean;
  errors: string[];
  records: number;
};

export type DashboardBuckets = {
  needsReview: DashboardArtifactRow[];
  needsContext: DashboardArtifactRow[];
  cleanup: DashboardArtifactRow[];
  resolve: DashboardArtifactRow[];
  trash: DashboardTrashRow[];
  purgeCandidates: DashboardTrashRow[];
  registryReconcile: DashboardProblemRow[];
  recentReceipts: DashboardReceiptRow[];
};

export type DashboardSnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  registryPath: string;
  ledgers: DashboardLedgerStatus[];
  buckets: DashboardBuckets;
  counts: Record<DashboardBucketKey, number>;
};

export type BuildDashboardOptions = {
  registryPath?: string;
  // Optional single-ledger scope for a ledger-targeted UI session.
  ledgerPath?: string;
  // How many of the most recent receipts to surface across all ledgers (default 10).
  recentReceiptsLimit?: number;
  // Age threshold for the purge-candidate lane; default "0d" treats every trashed record as a
  // purge candidate (selection and the one-way-door approval live in the later purge slice).
  purgeOlderThan?: string;
};

// Receipt records are artshelf-owned artifacts the cleanup/dispose/reconcile/purge flows
// register on the ledger; the receipt lane reads them straight back so the dashboard can show
// completed actions without re-deriving them.
const RECEIPT_LABELS: Record<string, DashboardReceiptKind> = {
  "cleanup-receipt": "cleanup",
  "trash-purge-receipt": "trash-purge",
  "dispose-receipt": "dispose",
  "reconcile-receipt": "reconcile"
};

const DEFAULT_RECENT_RECEIPTS = 10;
// "0d" means "older than zero days ago", i.e. every already-trashed record is a purge
// candidate. Selecting an exact subset and the one-way-door approval are the later purge slice.
const DEFAULT_PURGE_OLDER_THAN = "0d";

export function buildDashboard(options: BuildDashboardOptions = {}): DashboardSnapshot {
  const registryPath = normalizeRegistryPath(options.registryPath);
  const ledgerPath = options.ledgerPath === undefined ? null : normalizeLedgerPath(options.ledgerPath);
  const recentReceiptsLimit = options.recentReceiptsLimit ?? DEFAULT_RECENT_RECEIPTS;
  const purgeOlderThan = options.purgeOlderThan ?? DEFAULT_PURGE_OLDER_THAN;
  const at = now();

  const buckets: DashboardBuckets = {
    needsReview: [],
    needsContext: [],
    cleanup: [],
    resolve: [],
    trash: [],
    purgeCandidates: [],
    registryReconcile: [],
    recentReceipts: []
  };
  const ledgers: DashboardLedgerStatus[] = [];

  const registeredLedgers = listRegisteredLedgers(registryPath);
  const reviewLedgers = ledgerPath === null ? registeredLedgers : scopedReviewLedgers(registeredLedgers, ledgerPath);

  for (const ledger of reviewLedgers) {
    const exists = existsSync(ledger.path);
    const validation = exists
      ? validateLedger(ledger.path)
      : { ok: false, errors: [`registered ledger is missing: ${ledger.path}`], entries: 0 };
    ledgers.push({
      name: ledger.name,
      path: ledger.path,
      scope: ledger.scope,
      exists,
      ok: validation.ok,
      errors: validation.errors,
      records: validation.entries
    });
    // An invalid or missing ledger is reported above but contributes no rows: never run
    // inspect/reconcile/trash reads against a ledger that failed validation.
    if (!validation.ok) continue;

    classifyLedgerRecords(ledger, at, buckets);
    for (const trashed of listTrashedRecords(ledger.path)) {
      buckets.trash.push(trashRow(ledger, trashed.id, trashed.targetPath, trashed.cleanedAt, trashed.cleanupPlanId, trashed.receiptPath, trashed.age));
    }
    for (const entry of previewTrashPurgePlan(ledger.path, purgeOlderThan).entries) {
      buckets.purgeCandidates.push(trashRow(ledger, entry.id, entry.targetPath, entry.cleanedAt, entry.cleanupPlanId, entry.receiptPath, ageOf(at, entry.cleanedAt)));
    }
    for (const finding of classifyReconcileFindings(ledger.path)) {
      buckets.registryReconcile.push({
        source: "reconcile",
        ledgerName: ledger.name,
        ledgerPath: ledger.path,
        recordId: finding.id,
        category: finding.category,
        detail: finding.reason,
        currentPath: finding.currentPath,
        proposedPath: finding.proposedPath
      });
    }
  }

  for (const finding of classifyRegistryPruneFindings(registryPath)) {
    if (ledgerPath !== null && finding.path !== ledgerPath) continue;
    buckets.registryReconcile.push({
      source: "registry",
      ledgerName: finding.name,
      ledgerPath: finding.path,
      recordId: null,
      category: finding.status,
      detail: finding.reason,
      currentPath: finding.path,
      proposedPath: null
    });
  }

  buckets.recentReceipts.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  buckets.recentReceipts = buckets.recentReceipts.slice(0, recentReceiptsLimit);

  return {
    schemaVersion: 1,
    generatedAt: toIso(at),
    registryPath,
    ledgers,
    buckets,
    counts: {
      "needs-review": buckets.needsReview.length,
      "needs-context": buckets.needsContext.length,
      cleanup: buckets.cleanup.length,
      resolve: buckets.resolve.length,
      trash: buckets.trash.length,
      "purge-candidates": buckets.purgeCandidates.length,
      "registry-reconcile": buckets.registryReconcile.length,
      "recent-receipts": buckets.recentReceipts.length
    }
  };
}

function scopedReviewLedgers(registeredLedgers: LedgerRegistryEntry[], ledgerPath: string): LedgerRegistryEntry[] {
  const matching = registeredLedgers.filter((ledger) => ledger.path === ledgerPath);
  if (matching.length > 0) return matching;
  return [{ name: "selected", path: ledgerPath, scope: "other", createdAt: "", updatedAt: "" }];
}

// Route each record of one valid ledger into its review lane. Receipts go to the recent lane;
// trashed/resolved/terminal rows are handled by the dedicated trash/purge passes or are not
// actionable; everything else is bucketed by its read-only inspect recommendation.
function classifyLedgerRecords(ledger: LedgerRegistryEntry, at: Date, buckets: DashboardBuckets): void {
  for (const record of readLedger(ledger.path)) {
    const receiptKind = receiptKindOf(record);
    if (receiptKind) {
      buckets.recentReceipts.push({
        recordId: record.id,
        ledgerName: ledger.name,
        ledgerPath: ledger.path,
        receiptKind,
        path: record.path,
        reason: record.reason,
        createdAt: record.createdAt,
        age: ageOf(at, record.createdAt)
      });
      continue;
    }
    // Trashed rows surface through the trash/purge lanes; resolved rows are terminal.
    if (record.status === "trashed" || record.status === "resolved") continue;

    const report = buildInspectReport(record, { ledgerPath: ledger.path, now: at });
    const needsContext = classifyNeedsContext(record);
    const row = artifactRow(ledger, record, report);
    // NGX-537: a record whose original reason or provenance is too weak to review is pulled out
    // of the normal review lanes and surfaced as needs-context so a human can add context first.
    if (needsContext) {
      buckets.needsContext.push(row);
      continue;
    }
    switch (report.recommendation) {
      case "trash-safe":
        buckets.cleanup.push(row);
        break;
      case "resolve-only":
        buckets.resolve.push(row);
        break;
      case "blocked":
        buckets.needsReview.push(row);
        break;
      case "keep":
      case "snooze":
        // A held row only needs review when a human decision is actually pending.
        if (report.dueState === "due" || report.dueState === "manual-review") buckets.needsReview.push(row);
        break;
    }
  }
}

// Reviewer-facing copy for each needs-context reason (NGX-537). The dashboard shows this in
// place of a normal review action, telling the reviewer what context to add.
const NEEDS_CONTEXT_COPY: Record<NeedsContextReason, string> = {
  "missing-reason": "No original reason was recorded - add context before this artifact can be reviewed.",
  "vague-reason": "The original reason is too vague to act on - add context before this artifact can be reviewed.",
  "insufficient-provenance": "Provenance can't establish where this artifact came from - add context before this artifact can be reviewed."
};

// Tokens that carry no review signal on their own - scratch/placeholder words and generic
// nouns that never say WHY an artifact is worth tracking. A reason built only from these is
// too vague to act on.
const LOW_SIGNAL_TOKENS: ReadonlySet<string> = new Set([
  "tmp", "temp", "test", "tests", "testing", "todo", "fixme", "wip", "stuff", "thing", "things",
  "misc", "file", "files", "data", "asdf", "foo", "bar", "baz", "qux", "na", "none", "null",
  "nil", "tbd", "placeholder", "scratch", "junk", "untitled", "new", "old", "copy", "draft",
  "sample", "demo", "dummy", "delete", "remove", "x", "y", "z"
]);

// Below this many alphanumerics a reason is too small to convey purpose ("x", "ab", "...").
const MIN_REASON_ALNUM = 4;

// NGX-537: classify how weak a record's review context is. Reason quality is the dominant
// signal (the contract buckets missing/vague reasons as needs-context); provenance is a
// secondary fallback. Returns null when the record carries enough context to review normally.
function classifyNeedsContext(record: ArtshelfRecord): NeedsContextReason | null {
  const reason = record.reason.trim();
  if (reason.length === 0) return "missing-reason";
  if (isVagueReason(reason)) return "vague-reason";
  if (hasInsufficientProvenance(record)) return "insufficient-provenance";
  return null;
}

function isVagueReason(reason: string): boolean {
  const tokens = reason.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  // Punctuation-only ("...", "???") or too few alphanumerics to mean anything.
  if (tokens.join("").length < MIN_REASON_ALNUM) return true;
  // Every token is a scratch/placeholder/generic word, so nothing says why it is tracked.
  return tokens.every((token) => LOW_SIGNAL_TOKENS.has(token));
}

// "Insufficient provenance" is deliberately narrow. A record written without any provenance is
// a legacy/unknown-origin row the dashboard still reviews normally - its reason carries the
// context. Only a present-but-uninformative provenance is too weak: an external root with no
// fingerprint can place the artifact through neither a known root nor a content match.
function hasInsufficientProvenance(record: ArtshelfRecord): boolean {
  const provenance = record.provenance;
  if (!provenance) return false;
  return provenance.root === "external" && provenance.fingerprint === undefined;
}

function receiptKindOf(record: ArtshelfRecord): DashboardReceiptKind | null {
  if (record.owner !== "artshelf") return null;
  for (const label of record.labels) {
    const kind = RECEIPT_LABELS[label];
    if (kind) return kind;
  }
  return null;
}

function artifactRow(
  ledger: LedgerRegistryEntry,
  record: ArtshelfRecord,
  report: ReturnType<typeof buildInspectReport>
): DashboardArtifactRow {
  return {
    recordId: record.id,
    ledgerName: ledger.name,
    ledgerPath: ledger.path,
    status: record.status,
    kind: record.kind,
    path: record.path,
    reason: record.reason,
    createdAt: record.createdAt,
    age: report.age,
    retention: record.retention,
    retainUntil: record.retainUntil ?? null,
    cleanup: record.cleanup,
    existence: report.existence,
    dueState: report.dueState,
    recommendation: report.recommendation,
    hasProvenance: Boolean(record.provenance),
    needsContext: needsContextBadge(record),
    lastAction: lastActionOf(record)
  };
}

// NGX-537: the reviewer-facing needs-context badge for a record, or null when its reason and
// provenance are strong enough to review normally. Shared by the dashboard rows and the artifact
// detail drawer (NGX-536) so both branch on one consistent badge built from one classifier.
export function needsContextBadge(record: ArtshelfRecord): DashboardNeedsContext | null {
  const reason = classifyNeedsContext(record);
  return reason ? { reason, label: NEEDS_CONTEXT_COPY[reason] } : null;
}

function trashRow(
  ledger: LedgerRegistryEntry,
  recordId: string,
  targetPath: string,
  cleanedAt: string,
  cleanupPlanId: string,
  receiptPath: string,
  age: string
): DashboardTrashRow {
  return { recordId, ledgerName: ledger.name, ledgerPath: ledger.path, targetPath, cleanedAt, age, cleanupPlanId, receiptPath };
}

// The most recent completed action recorded on a row's audit trail. Each disposition writes a
// distinct timestamp/receipt set, so the latest one is the row's "last action". Shared with the
// artifact detail drawer (NGX-536), which shows the full audit trail alongside this latest action.
export function lastActionOf(record: ArtshelfRecord): DashboardLastAction | null {
  const candidates: DashboardLastAction[] = [];
  if (record.cleanedAt) candidates.push({ kind: "cleanup", at: record.cleanedAt, receiptPath: record.receiptPath ?? null, reason: record.cleanupReason ?? null });
  if (record.disposedAt) candidates.push({ kind: "dispose", at: record.disposedAt, receiptPath: record.disposeReceiptPath ?? null, reason: record.disposeReason ?? null });
  if (record.reconciledAt) candidates.push({ kind: "reconcile", at: record.reconciledAt, receiptPath: record.reconcileReceiptPath ?? null, reason: record.reconcileReason ?? null });
  if (record.resolvedAt) candidates.push({ kind: "resolve", at: record.resolvedAt, receiptPath: null, reason: record.resolutionReason ?? null });
  if (record.purgedAt) candidates.push({ kind: "purge", at: record.purgedAt, receiptPath: record.purgeReceiptPath ?? null, reason: null });
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, candidate) => (new Date(candidate.at).getTime() > new Date(latest.at).getTime() ? candidate : latest));
}
