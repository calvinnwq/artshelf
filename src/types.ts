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
  // Reconcile audit trail (NGX-437), set by `reconcile --execute`. previousPath is the
  // path the row held before a remap (or the stale path resolved away); reconcilePlanId
  // /reconcileReceiptPath/reconciledAt/reconcileReason record which reviewed plan acted
  // on the row and why, so executed changes stay auditable.
  previousPath?: string;
  reconcilePlanId?: string;
  reconcileReceiptPath?: string;
  reconciledAt?: string;
  reconcileReason?: string;
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

// Outcome of applying one reviewed plan entry during `reconcile --execute` (NGX-437):
// - remapped: the row's path was rewritten to newPath and provenance recomputed.
// - resolved: the row was archived/resolved ledger-only (resolve-missing / stale-trash).
// - skipped: the live ledger no longer matched the reviewed plan, so the entry was
//   refused rather than applied to stale state.
export type ReconcileResultStatus = "remapped" | "resolved" | "skipped";

export type ReconcileResult = {
  id: string;
  category: ReconcileCategory;
  field: ReconcileField;
  status: ReconcileResultStatus;
  previousPath: string;
  newPath: string | null;
  reason: string;
};

// Receipt returned (and persisted) by `reconcile --execute`. Mirrors the cleanup
// receipt shape so executed reconcile actions leave the same kind of audit artifact.
export type ReconcileExecution = {
  planId: string;
  receiptPath: string;
  executedAt: string;
  results: ReconcileResult[];
};

// How a reviewed artifact is disposed (NGX-483). Each action mirrors an inspect
// recommendation bucket so `get --inspect` hands straight off to a dispose plan:
// - trash-resolve: move the recorded path to Artshelf trash and resolve the row.
// - resolve-only:  resolve the ledger row only (no file move), reason required.
// - snooze:        extend retention / the next review horizon, files untouched.
// - keep:          mark the row reviewed and quiet until a new review boundary.
export type DisposeAction = "trash-resolve" | "resolve-only" | "snooze" | "keep";

// Snapshot of the disposition subject captured at dry-run time. `dispose --execute`
// re-captures it and refuses the plan when the live subject drifted (path or metadata
// changed since review), satisfying NGX-483's stale-plan refusal requirement.
export type DisposeSubjectSnapshot = {
  existence: "present" | "missing";
  nodeKind: "file" | "directory" | "other" | null;
  byteSize: number | null;
};

// Why a requested disposition cannot be planned. A blocked request is read-only: it
// never writes a plan file or mutates the ledger; the caller renders the reason and
// refuses with clear evidence.
export type DisposeBlockReason =
  | "already-resolved"
  | "already-trashed"
  | "missing-subject-path"
  | "target-conflict"
  | "terminal-record"
  | "missing-reason"
  | "missing-snooze-horizon"
  | "unknown-action";

// The single actionable entry of a reviewed dispose plan. One plan binds exactly one
// record id to one action (unlike cleanup/reconcile, which scan a whole ledger), and
// `dispose --execute` applies exactly this entry or refuses it as stale.
export type DisposePlanEntry = {
  id: string;
  action: DisposeAction;
  // Record status observed at dry-run time; execute refuses if the live status moved on.
  status: ArtshelfStatus;
  // The recorded artifact path at dry-run time.
  path: string;
  // The filesystem node the action reads or moves (record.path for live rows).
  subjectPath: string;
  // Disposition reason captured for the audit trail.
  reason: string;
  // Subject snapshot used to refuse a drifted plan at execute time.
  subject: DisposeSubjectSnapshot;
  // trash-resolve only: the Artshelf trash destination the subject will move to.
  targetPath?: string;
  // snooze only: the new retention and absolute review horizon the record will carry.
  retention?: Retention;
  retainUntil?: string;
};

// A reviewed dispose plan produced by `dispose --dry-run`. It mirrors the plan-id-bound
// shape of cleanup/reconcile so execute can require an exact reviewed plan id. `entry`
// is the actionable disposition, or null when the request is blocked; `blocked` carries
// the refusal reason for review only. `planPath` is null until the plan is persisted and
// stays null for a blocked (not-created) plan.
export type DisposePlan = {
  planId: string;
  generatedAt: string;
  ledgerPath: string;
  request: { id: string; action: DisposeAction };
  entry: DisposePlanEntry | null;
  blocked: { id: string; action: DisposeAction; reason: DisposeBlockReason; detail: string } | null;
  planPath: string | null;
};
