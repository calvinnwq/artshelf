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
  // Dispose audit trail (NGX-483), set by `dispose --execute`. disposePlanId/
  // disposeReceiptPath/disposedAt/disposeAction/disposeReason record which reviewed
  // disposition plan acted on the row and how, so an executed disposition stays
  // auditable independent of the resolve/retention fields the action also touches.
  disposePlanId?: string;
  disposeReceiptPath?: string;
  disposedAt?: string;
  disposeAction?: DisposeAction;
  disposeReason?: string;
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
  fingerprint: string | null;
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
  | "ambiguous-snooze-horizon"
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

// Outcome of applying one reviewed dispose plan entry (NGX-483 `dispose --execute`).
// trashed: the row was moved into Artshelf trash and awaits a separate purge;
// resolved: the row was closed without moving the file; snoozed: the retention
// horizon was extended, the row stays active; kept: the row was marked
// reviewed-and-kept with its retention preserved; skipped: the entry was refused
// (stale snapshot, status drift, or a target conflict) and nothing was mutated.
export type DisposeResultStatus = "trashed" | "resolved" | "snoozed" | "kept" | "skipped";

// Post-execution verification captured in the receipt so the audit trail proves what
// actually happened on disk and in the ledger. targetPresent is null for actions that
// move nothing (resolve-only/snooze/keep).
export type DisposeVerification = {
  recordStatus: ArtshelfStatus;
  subjectPresent: boolean;
  targetPresent: boolean | null;
};

// The single result of executing a dispose plan. One plan binds one record id to one
// action, so execution yields exactly one result (unlike cleanup/reconcile result arrays).
export type DisposeResult = {
  id: string;
  action: DisposeAction;
  status: DisposeResultStatus;
  reason: string;
  // trash-resolve: the recorded path the subject moved out of; null otherwise.
  previousPath: string | null;
  // trash-resolve: the trash destination the subject moved to; null otherwise.
  targetPath: string | null;
  // snooze: the new retention/horizon stamped on the row; null otherwise.
  retention: Retention | null;
  retainUntil: string | null;
  verification: DisposeVerification;
};

// The receipt-backed outcome of `dispose --execute`. receiptPath points at the persisted,
// artshelf-owned receipt that records the action, target, resolve/retention changes, and
// verification for resumability and audit.
export type DisposeExecution = {
  planId: string;
  receiptPath: string;
  executedAt: string;
  result: DisposeResult;
};

// === Artshelf UI session (NGX-531, Artshelf UI v1 contract slice 1) ===

// The review surface scope. "user" is the default global, working-directory-agnostic
// review across registered ledgers; "repo" narrows the session - and its on-disk
// storage location - to the current repository's `.artshelf/ui` tree.
export type UiSessionScope = "user" | "repo";

// Lifecycle of a UI review session. "active" accepts browser event writes (gated by the
// capability token) and agent polling; "ended" revokes the browser write capability but
// stays readable so history/receipts survive for audit and resume.
export type UiSessionStatus = "active" | "ended";

// Durable session metadata persisted at `<ui-home>/sessions/<id>/session.json`. The
// session is the handoff layer of the v1 contract: the browser records decisions and the
// agent executes, so this row never holds executable authority itself - only the
// capability token that authorizes browser event writes while the session is active.
// The token is an unguessable, same-machine capability secret (capability protection,
// not full account authentication), so it is stored alongside the user-owned session
// state rather than hashed: `artshelf ui` reprints the access link with the token on
// resume, and `validateBrowserToken` only honors it while the session stays active.
export type UiSession = {
  version: 1;
  id: string; // session_<id>
  scope: UiSessionScope;
  status: UiSessionStatus;
  createdAt: string;
  updatedAt: string;
  // ISO-8601 when the session was ended, else null while active.
  endedAt: string | null;
  // Explicit single-ledger target captured at start, or null for the multi-ledger
  // default. A non-null value narrows resume matching and the (later) dashboard scope.
  ledgerPath: string | null;
  // Unguessable capability token gating browser event writes for this session.
  token: string;
};

// Lifecycle of one actionable event. Browser-submitted events start `pending` and leave
// the agent's poll queue once the agent replies with a terminal/progress status.
export type UiEventStatus =
  | "pending"
  | "acknowledged"
  | "in_progress"
  | "completed"
  | "rejected"
  | "stale"
  | "failed"
  | "cancelled";

export type UiReplyStatus = Exclude<UiEventStatus, "pending">;

// Event taxonomy for the durable session log. The first block is the v1 set; the second
// block is reserved future-compatible types the contract names so the storage model does
// not need to change to carry them later.
export type UiEventType =
  | "inspect_requested"
  | "comment_added"
  | "decision_submitted"
  | "dry_run_requested"
  | "approval_bundle_submitted"
  | "session_done"
  | "question_answered"
  | "filter_saved"
  | "session_note_added";

// The lightweight human triage decisions the browser records against one reviewed record
// (NGX-538). Each is an *intent*, not an execution: it names what the human wants done, and
// the agent later translates it into the matching approval-gated `dispose` action and runs
// that through the existing CLI path. The browser never mutates a ledger/file/trash/plan
// itself. The 1:1 mapping the agent applies is:
//   - keep    -> dispose --action keep          (mark reviewed-and-quiet, retention kept)
//   - trash   -> dispose --action trash-resolve (move the path to Artshelf trash, resolve row)
//   - resolve -> dispose --action resolve-only  (resolve the ledger row only, no file move)
//   - defer   -> dispose --action snooze        (extend retention / the next review horizon)
export type UiDecisionIntent = "keep" | "trash" | "resolve" | "defer";

// One event in the durable, append-only session log. `target` carries the exact
// ledger/registry/record/plan identifiers the event concerns (never an ambiguous global
// action); `payload` is the type-specific body (comment text, decision intent, bundle id,
// dry-run request, etc.). `source` records who wrote the event so the agent's poll queue
// can distinguish browser-submitted work from its own bookkeeping. Replies the agent
// appends reference this event by id and advance its status; the event row's own
// `status`/`updatedAt` reflect the latest reply when read back.
export type UiEvent = {
  id: string; // event_<id>
  sessionId: string; // session_<id>
  type: UiEventType;
  status: UiEventStatus;
  source: "browser" | "agent";
  createdAt: string;
  updatedAt: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
};

// An agent reply appended to the session log. A reply advances exactly one event's status
// (acknowledged/in_progress/completed/rejected/stale/failed/cancelled) and carries the
// agent's result, receipt, validation failure, question, or status note in `payload`. The
// log stays append-only - replies are never rewritten into the event row on disk - so the
// full receipt/decision trail survives reload, restart, and resume.
export type UiReply = {
  id: string; // reply_<id>
  sessionId: string; // session_<id>
  eventId: string; // event_<id> this reply advances
  status: UiReplyStatus;
  createdAt: string;
  payload: Record<string, unknown>;
};

// One event paired with the agent replies appended against it, in log order. This is the read
// model the browser session/dashboard history renders (NGX-538: "agent replies update the event
// projection and are visible in the session/dashboard history"). The event carries its folded
// current status; each reply preserves its own payload so the agent's note, receipt, or rejection
// reason stays visible to the human after reload, restart, or resume - unlike the compact
// poll/status projection (readSessionEvents), which keeps only the latest status.
export type UiSessionHistoryEntry = {
  event: UiEvent;
  replies: UiReply[];
};

// One exact target inside an approval snapshot. Cross-ledger action is always a bundle of
// exact per-target actions, so every target carries its own ledger/registry/record/plan
// context plus the human-facing label shown at approval time - never a global execute.
export type UiApprovalTarget = {
  targetId: string;
  ledgerPath: string;
  registryPath: string | null;
  recordPath: string | null;
  planId: string | null;
  actionType: string;
  // Row-level human label shown at approval time.
  label: string;
};

// Immutable reviewed approval snapshot persisted at
// `<ui-home>/sessions/<id>/bundles/<bundle-id>.json`. Slice 1 only defines the storage
// model and fingerprint; the full review/execute flow lands in later slices. The
// `fingerprint` is a deterministic digest over the selected targets and key reviewed
// facts so a later agent can detect drift and refuse a stale or tampered bundle before
// executing any exact target.
export type UiApprovalSnapshot = {
  id: string; // bundle_<id>
  sessionId: string; // session_<id>
  createdAt: string;
  actionType: string;
  targets: UiApprovalTarget[];
  // Reviewed snapshot of the key plan facts captured at approval time.
  reviewed: Record<string, unknown>;
  // Deterministic fingerprint over `targets` + `reviewed`.
  fingerprint: string;
};
