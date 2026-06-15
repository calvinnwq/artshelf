export type ArtshelfKind =
  | "scratch"
  | "backup"
  | "run-artifact"
  | "evidence"
  | "cache"
  | "quarantine"
  | "other";

// Which known root a recorded path lived under when it was captured. Ledger-owned
// paths (trash/plans/receipts) classify as "ledger"; other paths inside the repo
// classify as "repo"; everything else is "external". The relative path against the
// matched root is what survives a `shelf` -> `artshelf` or `.shelf` -> `.artshelf`
// rename, letting a future reconcile reconstruct the current path from the current
// root without Artshelf becoming a daemon.
export type PathRootKind = "repo" | "ledger" | "external";

// The kind of filesystem node observed at capture time.
export type PathNodeKind = "file" | "directory" | "other";

// Lightweight, deterministic matching hint for regular files. Size only: cheap to
// capture, stable in tests, and enough to disambiguate rename candidates without
// hashing potentially large artifacts.
export type PathFingerprint = {
  byteSize: number;
};

// Path provenance attached to new records so future reconcile work can reason about
// moved/renamed artifacts. The original absolute path is preserved separately on the
// record (`path`/`targetPath`); provenance adds the reconstruct-and-match data.
export type PathProvenance = {
  root: PathRootKind;
  // Absolute path of the matched root at capture time, or null when external.
  rootPath: string | null;
  // POSIX-separated path relative to rootPath, or null when external.
  relativePath: string | null;
  // Final path segment, always present, for cheap rename matching.
  basename: string;
  pathKind: PathNodeKind;
  fingerprint?: PathFingerprint;
};

export type CleanupAction = "trash" | "review" | "delete";
export type ArtshelfStatus = "active" | "review-required" | "trashed" | "cleanup-refused" | "resolved";
export type Retention =
  | { mode: "ttl"; ttl: string }
  | { mode: "retain-until"; retainUntil: string }
  | { mode: "manual-review" };

export type ArtshelfRecord = {
  id: string;
  path: string;
  kind: ArtshelfKind;
  reason: string;
  createdAt: string;
  retainUntil?: string;
  retention: Retention;
  cleanup: CleanupAction;
  owner: string;
  labels: string[];
  status: ArtshelfStatus;
  cleanupPlanId?: string;
  receiptPath?: string;
  cleanedAt?: string;
  targetPath?: string;
  cleanupReason?: string;
  purgedAt?: string;
  purgePlanId?: string;
  purgeReceiptPath?: string;
  resolvedAt?: string;
  resolutionReason?: string;
  // Absent on legacy records written before path provenance existed. Legacy rows are
  // treated as missing provenance, not malformed data.
  provenance?: PathProvenance;
};

export type DueStatus = "due" | "manual-review" | "missing-path" | "kept";

export type DueEntry = {
  id: string;
  path: string;
  reason: string;
  cleanup: CleanupAction;
  dueStatus: DueStatus;
  retainUntil?: string;
};

export type CleanupPlanEntry = {
  id: string;
  path: string;
  action: CleanupAction;
  dueStatus: DueStatus;
};

export type CleanupPlan = {
  planId: string;
  generatedAt: string;
  ledgerPath: string;
  entries: CleanupPlanEntry[];
  skipped: Array<{ id: string; path: string; reason: string; dueStatus: DueStatus }>;
  planPath: string | null;
};

export type TrashPurgePlan = {
  purgePlanId: string;
  generatedAt: string;
  ledgerPath: string;
  olderThan: string;
  cutoff: string;
  entries: Array<{ id: string; targetPath: string; cleanedAt: string; receiptPath: string; cleanupPlanId: string }>;
  skipped: Array<{ id: string; targetPath: string; reason: string }>;
  planPath: string | null;
};

// How a drifted path can be reconciled. Mirrors NGX-437's classification taxonomy:
// - remap: a moved/renamed path can be safely rewritten to its current location
//   using provenance (e.g. repo-root or `.shelf` -> `.artshelf` renames).
// - resolve-missing: an active record's path is gone with no safe remap target;
//   it can be resolved after confirmation.
// - resolve-stale-trash: an already-trashed record's trash target is gone; the
//   ledger row can be resolved/archived without touching the filesystem.
// - registry-remap: a registered ledger path moved (emitted by the registry pass).
// - blocked: ambiguous, unsafe, multiple candidates, outside safe roots, or
//   insufficient evidence to act automatically.
export type ReconcileCategory =
  | "remap"
  | "resolve-missing"
  | "resolve-stale-trash"
  | "registry-remap"
  | "blocked";

// Which recorded path on a ledger row drifted.
export type ReconcileField = "path" | "targetPath";

// A single reconcile observation about one drifted path. Read-only: findings never
// mutate the ledger. `currentPath` is the stale path recorded today; `proposedPath`
// is the reconstructed current location for a `remap`, and null for every other
// category (where there is nothing safe to point at).
export type ReconcileFinding = {
  id: string;
  category: ReconcileCategory;
  field: ReconcileField;
  status: ArtshelfStatus;
  currentPath: string;
  proposedPath: string | null;
  reason: string;
};

// A reviewed reconcile plan produced by `reconcile --dry-run` (NGX-437). It mirrors
// CleanupPlan's plan-id-bound shape so execution can later require an exact reviewed
// plan id. `entries` are the actionable findings (remap / resolve-missing /
// resolve-stale-trash) that a scoped `--execute` may apply; `blocked` carries the
// findings surfaced for review but never auto-applied. `planPath` is null until the
// plan is actually persisted (it stays null for an empty preview).
export type ReconcilePlan = {
  planId: string;
  generatedAt: string;
  ledgerPath: string;
  entries: ReconcileFinding[];
  blocked: ReconcileFinding[];
  planPath: string | null;
};
