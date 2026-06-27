import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assertSafeGeneratedId, getRecord, readLedger, registerArtshelfArtifact, writeLedger } from "./ledger.js";
import { withPathLock } from "./locks.js";
import { addTtl, assertIsoDate, now, toIso } from "./time.js";
import type {
  ArtshelfRecord,
  ArtshelfStatus,
  DisposeAction,
  DisposeExecution,
  DisposeBlockReason,
  DisposePlan,
  DisposePlanEntry,
  DisposeResult,
  DisposeResultStatus,
  DisposeSubjectSnapshot,
  DisposeVerification,
  Retention
} from "./types.js";

const DISPOSE_ACTIONS: ReadonlySet<string> = new Set<DisposeAction>(["trash-resolve", "resolve-only", "snooze", "keep"]);
const ARTSHELF_STATUSES: ReadonlySet<string> = new Set<ArtshelfStatus>(["active", "review-required", "trashed", "cleanup-refused", "resolved"]);

// What the caller asked `dispose` to do: one record id, one action, plus the
// action-specific inputs (a reason for resolve-only, a horizon for snooze).
export type DisposeRequest = {
  id: string;
  action: DisposeAction;
  reason?: string | undefined;
  ttl?: string | undefined;
  retainUntil?: string | undefined;
};

// The read-only verdict for one disposition request: either an actionable plan entry
// (without a plan-id-scoped target yet) or a block reason. Classification never writes
// a plan or mutates anything.
export type DisposeFinding =
  | { ok: true; entry: DisposePlanEntry }
  | { ok: false; reason: DisposeBlockReason; detail: string };

// Classify one disposition request against the live ledger (NGX-483). This is the
// read-only safety engine the dry-run/execute workflow builds on: it loads the record,
// checks the requested action is applicable and safe, and returns either the actionable
// plan entry or a block reason with evidence. It never writes a plan or touches the
// filesystem. The returned entry carries no trash target yet; that is plan-id scoped and
// is filled in once a plan id exists.
export function classifyDisposition(ledgerPath: string, request: DisposeRequest): DisposeFinding {
  if (!DISPOSE_ACTIONS.has(request.action)) {
    return blocked("unknown-action", `unknown dispose action: ${request.action}`);
  }

  const record = getRecord(readLedger(ledgerPath), request.id);
  const subjectPath = record.path;
  const subject = snapshotSubject(subjectPath);
  const reason = (request.reason ?? "").trim();

  if (request.action === "trash-resolve") {
    if (record.status === "resolved") return blocked("already-resolved", "record is already resolved");
    if (record.status === "trashed") {
      return blocked("already-trashed", "record is already trashed; permanent removal is `trash purge`, ledger cleanup is resolve-only");
    }
    if (subject.existence === "missing") {
      return blocked("missing-subject-path", `recorded path is missing: ${subjectPath}; use resolve-only to close the ledger record`);
    }
    return ok(buildEntry(record, "trash-resolve", reason || defaultReason("trash-resolve"), subjectPath, subject));
  }

  if (request.action === "resolve-only") {
    if (record.status === "resolved") return blocked("already-resolved", "record is already resolved");
    if (record.status === "trashed") {
      return blocked("already-trashed", "record is already trashed; use trash purge for physical removal or reconcile stale trash after the target is gone");
    }
    if (!reason) return blocked("missing-reason", "resolve-only requires a reason");
    return ok(buildEntry(record, "resolve-only", reason, subjectPath, subject));
  }

  if (request.action === "snooze") {
    if (isTerminal(record.status)) return blocked("terminal-record", `cannot snooze a ${record.status} record`);
    if (request.ttl && request.retainUntil) {
      return blocked("ambiguous-snooze-horizon", "choose exactly one of --ttl or --retain-until");
    }
    if (!request.ttl && !request.retainUntil) {
      return blocked("missing-snooze-horizon", "snooze requires --ttl or --retain-until");
    }
    const snooze = buildSnoozeRetention(request);
    return ok(buildEntry(record, "snooze", reason || defaultReason("snooze"), subjectPath, subject, snooze));
  }

  // keep
  if (isTerminal(record.status)) return blocked("terminal-record", `cannot keep a ${record.status} record`);
  return ok(buildEntry(record, "keep", reason || defaultReason("keep"), subjectPath, subject));
}

// Build the dispose plan without persisting anything (dry-run preview). Fully read-only:
// it classifies the request and returns the plan a `--dry-run` would create, but never
// writes a plan file or touches the ledger.
export function previewDisposePlan(ledgerPath: string, request: DisposeRequest): DisposePlan {
  return buildDisposePlan(ledgerPath, request);
}

// Create (or reuse) a reviewed dispose plan (dry-run). This is the only part of dry-run
// that writes: it persists the plan JSON and registers it as an artshelf-owned artifact
// so a later `--execute` can bind to an exact reviewed plan id. When an earlier plan
// already covers the same request it is reused verbatim (stable plan id, target rebound
// to that id), and when the request is blocked no plan artifact is created at all.
export function createDisposePlan(ledgerPath: string, request: DisposeRequest): DisposePlan {
  const plan = buildDisposePlan(ledgerPath, request);
  if (!plan.entry) return plan;

  const existing = matchingExistingDisposePlan(ledgerPath, plan);
  if (existing) return existing;
  if (!plan.planPath) throw new Error("dispose plan path was not created");

  writeDisposePlanFile(plan.planPath, plan);
  registerArtshelfArtifact(ledgerPath, plan.planPath, {
    reason: `Artshelf dispose dry-run plan ${plan.planId}`,
    ttl: "14d",
    kind: "run-artifact",
    cleanup: "trash",
    labels: ["artshelf", "dispose-plan", plan.planId]
  });
  return plan;
}

// Apply a reviewed dispose plan (NGX-483 `dispose --execute`). This is the only mutating
// dispose entrypoint and it is deliberately conservative:
//   * It refuses up front when the plan id is missing, the plan file is absent, or the
//     plan's declared id/ledger does not match the scoped request (no fresh-plan-then-
//     execute; the command layer enforces that, this binds to one exact reviewed plan id).
//   * A rerun of a plan this row already executed is idempotent (re-derived from the row,
//     never re-moved or re-stamped).
//   * Before mutating it re-snapshots the live subject and refuses (skips) the entry when
//     the record status moved on or the subject drifted from the reviewed snapshot, and
//     for trash-resolve it refuses a target a foreign artifact already occupies.
// A receipt is written before (intent) and after (verified outcome) the mutation so an
// executed disposition stays auditable, and is registered as an artshelf-owned artifact.
export function executeDisposePlan(ledgerPath: string, planId: string): DisposeExecution {
  const entry = readDisposePlanEntry(ledgerPath, planId);
  return executeDisposePlanEntry(ledgerPath, planId, entry);
}

export function executeDisposePlanEntry(ledgerPath: string, planId: string, entry: DisposePlanEntry): DisposeExecution {
  const boundEntry = assertDisposePlanEntryExecutable(entry, planId, ledgerPath);
  const receiptPath = disposeReceiptPath(ledgerPath, planId);
  return withPathLock(ledgerPath, () => {
    const completedReceipt = existsSync(receiptPath) ? readCompletedDisposeReceipt(receiptPath, planId, boundEntry) : null;
    if (completedReceipt) {
      registerDisposeReceipt(ledgerPath, receiptPath, planId);
      return {
        planId,
        receiptPath,
        executedAt: completedReceipt.executedAt,
        result: completedReceipt.result
      };
    }

    const records = readLedger(ledgerPath);
    const index = records.findIndex((record) => record.id === boundEntry.id);
    const record = index >= 0 ? records[index] : undefined;
    if (record?.disposePlanId === planId) {
      const replayReceiptPath = record.disposeReceiptPath ?? receiptPath;
      const receipt = existsSync(replayReceiptPath) ? readCompletedDisposeReceipt(replayReceiptPath, planId, boundEntry) : null;
      const started = receipt ? null : readStartedDisposeReceipt(replayReceiptPath, planId);
      const result = receipt?.result ?? appliedResultFromRecord(boundEntry, record);
      const executedAt = receipt?.executedAt ?? record.disposedAt ?? started?.executedAt ?? toIso(now());
      if (!receipt) {
        writeDisposeReceipt(replayReceiptPath, { planId, ledgerPath, executedAt, status: "completed", result });
      }
      registerDisposeReceipt(ledgerPath, replayReceiptPath, planId);
      return {
        planId,
        receiptPath: replayReceiptPath,
        executedAt,
        result
      };
    }

    const started = readStartedDisposeReceipt(receiptPath, planId);
    const executedAt = started?.executedAt ?? toIso(now());
    const audit: DisposeAudit = { planId, receiptPath, executedAt };

    // Announce intent before any mutation so an interrupted move leaves a breadcrumb.
    writeDisposeReceipt(receiptPath, { planId, ledgerPath, executedAt, status: "started", action: boundEntry.action, target: boundEntry.targetPath ?? null });

    const outcome = applyDisposeEntry(records, index, boundEntry, audit);
    if (outcome.records) writeLedger(ledgerPath, outcome.records);

    writeDisposeReceipt(receiptPath, { planId, ledgerPath, executedAt, status: "completed", result: outcome.result });
    registerDisposeReceipt(ledgerPath, receiptPath, planId);
    return { planId, receiptPath, executedAt, result: outcome.result };
  }, "Artshelf ledger");
}

export function readDisposePlanEntry(ledgerPath: string, planId: string): DisposePlanEntry {
  if (!planId) throw new Error("dispose --execute requires --plan-id");
  const planPath = disposePlanPath(ledgerPath, planId);
  if (!existsSync(planPath)) throw new Error(`Dispose plan not found: ${planId}`);
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as DisposePlan;
  return assertDisposePlanExecutable(plan, planId, ledgerPath);
}

type DisposeAudit = { planId: string; receiptPath: string; executedAt: string };

// `records` is the mutated ledger to persist, or null when the entry was refused (no write).
type DisposeOutcome = { records: ArtshelfRecord[] | null; result: DisposeResult };

// Decide and apply the disposition for one reviewed entry against the live ledger. The
// guard order matters: idempotency (this plan already ran) is checked before drift, since
// a completed trash-resolve legitimately leaves the subject missing.
function applyDisposeEntry(records: ArtshelfRecord[], index: number, entry: DisposePlanEntry, audit: DisposeAudit): DisposeOutcome {
  const record = index >= 0 ? records[index] : undefined;
  if (!record) {
    return refusal(entry, "record is missing from ledger", entry.status, snapshotSubject(entry.subjectPath), null);
  }

  if (record.disposePlanId === audit.planId) {
    return { records: null, result: appliedResultFromRecord(entry, record) };
  }

  const live = snapshotSubject(entry.subjectPath);
  if (record.path !== entry.path || record.path !== entry.subjectPath) {
    return refusal(entry, "live ledger path no longer matches the reviewed plan", record.status, live, null);
  }
  if (entry.action === "trash-resolve" && record.status === entry.status && canResumeTrashResolve(entry, live)) {
    return applyTrashResolveFromTarget(records, index, record, entry, audit);
  }
  if (record.status !== entry.status || subjectDrifted(entry.subject, live)) {
    return refusal(entry, "live ledger state no longer matches the reviewed plan", record.status, live, null);
  }

  if (entry.action === "trash-resolve") return applyTrashResolve(records, index, record, entry, audit);
  if (entry.action === "resolve-only") return applyResolve(records, index, record, entry, audit, live);
  if (entry.action === "snooze") return applySnooze(records, index, record, entry, audit, live);
  return applyKeep(records, index, record, entry, audit, live);
}

// trash-resolve moves the subject into the plan-scoped trash target, then resolves the row.
// Because the target path embeds the unique plan id, a foreign file at that exact path is a
// genuine conflict; the prior-run case (target present, subject already moved away) is
// handled by the idempotency guard upstream, so here a present target means a conflict.
function applyTrashResolve(records: ArtshelfRecord[], index: number, record: ArtshelfRecord, entry: DisposePlanEntry, audit: DisposeAudit): DisposeOutcome {
  const target = entry.targetPath as string;
  if (existsSync(target)) {
    return refusal(entry, `target path already exists: ${target}`, record.status, snapshotSubject(entry.subjectPath), target);
  }
  mkdirSync(dirname(target), { recursive: true });
  renameSync(entry.subjectPath, target);

  const updated: ArtshelfRecord = {
    ...record,
    status: "trashed",
    targetPath: target,
    previousPath: entry.subjectPath,
    ...disposeStamp(entry, audit)
  };
  return applied(records, index, updated, {
    action: "trash-resolve",
    status: "trashed",
    reason: entry.reason,
    previousPath: entry.subjectPath,
    targetPath: target,
    retention: null,
    retainUntil: null,
    verification: verify(entry, "trashed", target)
  });
}

function applyTrashResolveFromTarget(records: ArtshelfRecord[], index: number, record: ArtshelfRecord, entry: DisposePlanEntry, audit: DisposeAudit): DisposeOutcome {
  const target = entry.targetPath as string;
  const updated: ArtshelfRecord = {
    ...record,
    status: "trashed",
    targetPath: target,
    previousPath: entry.subjectPath,
    ...disposeStamp(entry, audit)
  };
  return applied(records, index, updated, {
    action: "trash-resolve",
    status: "trashed",
    reason: entry.reason,
    previousPath: entry.subjectPath,
    targetPath: target,
    retention: null,
    retainUntil: null,
    verification: verify(entry, "trashed", target)
  });
}

// resolve-only closes the ledger row without touching the filesystem.
function applyResolve(records: ArtshelfRecord[], index: number, record: ArtshelfRecord, entry: DisposePlanEntry, audit: DisposeAudit, live: DisposeSubjectSnapshot): DisposeOutcome {
  const updated: ArtshelfRecord = {
    ...record,
    status: "resolved",
    resolvedAt: audit.executedAt,
    resolutionReason: entry.reason,
    ...disposeStamp(entry, audit)
  };
  return applied(records, index, updated, {
    action: "resolve-only",
    status: "resolved",
    reason: entry.reason,
    previousPath: null,
    targetPath: null,
    retention: null,
    retainUntil: null,
    verification: verifyLive("resolved", live)
  });
}

// snooze extends the retention horizon (applied verbatim from the reviewed plan, never
// recomputed) and leaves the row active and the file in place.
function applySnooze(records: ArtshelfRecord[], index: number, record: ArtshelfRecord, entry: DisposePlanEntry, audit: DisposeAudit, live: DisposeSubjectSnapshot): DisposeOutcome {
  const retention = entry.retention as Retention;
  const retainUntil = entry.retainUntil as string;
  const updated: ArtshelfRecord = {
    ...record,
    retention,
    retainUntil,
    ...disposeStamp(entry, audit)
  };
  return applied(records, index, updated, {
    action: "snooze",
    status: "snoozed",
    reason: entry.reason,
    previousPath: null,
    targetPath: null,
    retention,
    retainUntil,
    verification: verifyLive(updated.status, live)
  });
}

// keep stamps the reviewed-and-kept audit on the row, preserving its status and retention
// verbatim. Due and inspect classification consume the audit stamp to keep the reviewed
// decision quiet while the same active record remains present.
function applyKeep(records: ArtshelfRecord[], index: number, record: ArtshelfRecord, entry: DisposePlanEntry, audit: DisposeAudit, live: DisposeSubjectSnapshot): DisposeOutcome {
  const updated: ArtshelfRecord = { ...record, ...disposeStamp(entry, audit) };
  return applied(records, index, updated, {
    action: "keep",
    status: "kept",
    reason: entry.reason,
    previousPath: null,
    targetPath: null,
    retention: null,
    retainUntil: null,
    verification: verifyLive(updated.status, live)
  });
}

function disposeStamp(entry: DisposePlanEntry, audit: DisposeAudit): Pick<ArtshelfRecord, "disposePlanId" | "disposeReceiptPath" | "disposedAt" | "disposeAction" | "disposeReason"> {
  return {
    disposePlanId: audit.planId,
    disposeReceiptPath: audit.receiptPath,
    disposedAt: audit.executedAt,
    disposeAction: entry.action,
    disposeReason: entry.reason
  };
}

// Splice the mutated record into the ledger and pair it with the execution result.
function applied(records: ArtshelfRecord[], index: number, updated: ArtshelfRecord, result: Omit<DisposeResult, "id">): DisposeOutcome {
  const next = records.slice();
  next[index] = updated;
  return { records: next, result: { id: updated.id, ...result } };
}

function refusal(entry: DisposePlanEntry, reason: string, recordStatus: ArtshelfStatus, live: DisposeSubjectSnapshot, target: string | null): DisposeOutcome {
  return {
    records: null,
    result: {
      id: entry.id,
      action: entry.action,
      status: "skipped",
      reason,
      previousPath: null,
      targetPath: null,
      retention: null,
      retainUntil: null,
      verification: {
        recordStatus,
        subjectPresent: live.existence === "present",
        targetPresent: entry.action === "trash-resolve" ? (target ? existsSync(target) : false) : null
      }
    }
  };
}

// Re-derive the result of a plan this row already executed, reading the on-disk reality so
// an idempotent rerun reports the same outcome without mutating anything.
function appliedResultFromRecord(entry: DisposePlanEntry, record: ArtshelfRecord): DisposeResult {
  const action = record.disposeAction ?? entry.action;
  const target = action === "trash-resolve" ? (record.targetPath ?? null) : null;
  return {
    id: entry.id,
    action,
    status: resultStatusFor(action),
    reason: record.disposeReason ?? entry.reason,
    previousPath: record.previousPath ?? null,
    targetPath: target,
    retention: action === "snooze" ? (record.retention ?? null) : null,
    retainUntil: action === "snooze" ? (record.retainUntil ?? null) : null,
    verification: {
      recordStatus: record.status,
      subjectPresent: existsSync(entry.subjectPath),
      targetPresent: action === "trash-resolve" ? (target ? existsSync(target) : false) : null
    }
  };
}

function resultStatusFor(action: DisposeAction): DisposeResultStatus {
  if (action === "trash-resolve") return "trashed";
  if (action === "snooze") return "snoozed";
  if (action === "keep") return "kept";
  return "resolved";
}

// Verify a trash-resolve outcome: the subject is gone from its recorded path and present
// at the trash target.
function verify(entry: DisposePlanEntry, recordStatus: ArtshelfStatus, target: string): DisposeVerification {
  return {
    recordStatus,
    subjectPresent: existsSync(entry.subjectPath),
    targetPresent: existsSync(target)
  };
}

// Verify a non-moving outcome (resolve-only/snooze/keep): the subject stays where it was.
function verifyLive(recordStatus: ArtshelfStatus, live: DisposeSubjectSnapshot): DisposeVerification {
  return { recordStatus, subjectPresent: live.existence === "present", targetPresent: null };
}

// Two subject snapshots agree only when existence, node kind, byte size, and fingerprint
// all match; any drift since the reviewed dry-run refuses the plan.
function subjectDrifted(reviewed: DisposeSubjectSnapshot, live: DisposeSubjectSnapshot): boolean {
  return reviewed.existence !== live.existence || reviewed.nodeKind !== live.nodeKind || reviewed.byteSize !== live.byteSize || reviewed.fingerprint !== live.fingerprint;
}

function canResumeTrashResolve(entry: DisposePlanEntry, live: DisposeSubjectSnapshot): boolean {
  if (live.existence !== "missing" || !entry.targetPath || !existsSync(entry.targetPath)) return false;
  return !subjectDrifted(entry.subject, snapshotSubject(entry.targetPath));
}

// Bind a loaded dispose plan to the request before any mutation, mirroring reconcile's
// assertReconcilePlanExecutable: the plan must declare the requested id, belong to the
// executing ledger, and carry a single well-formed actionable entry.
function assertDisposePlanExecutable(plan: DisposePlan, planId: string, ledgerPath: string): DisposePlanEntry {
  if (plan.planId !== planId) {
    throw new Error(`Dispose plan id mismatch: plan file declares ${plan.planId}, requested ${planId}`);
  }
  if (plan.ledgerPath !== ledgerPath) {
    throw new Error(`Dispose plan ledger mismatch: plan was created for ${plan.ledgerPath}, executing ${ledgerPath}`);
  }
  return assertDisposePlanEntryExecutable(plan.entry, planId, ledgerPath);
}

function assertDisposePlanEntryExecutable(entry: DisposePlanEntry | null, planId: string, ledgerPath: string): DisposePlanEntry {
  if (
    !entry ||
    typeof entry.id !== "string" ||
    !DISPOSE_ACTIONS.has(entry.action) ||
    typeof entry.status !== "string" ||
    !ARTSHELF_STATUSES.has(entry.status) ||
    typeof entry.path !== "string" ||
    typeof entry.subjectPath !== "string" ||
    typeof entry.reason !== "string" ||
    !isSubjectSnapshot(entry.subject)
  ) {
    throw new Error(`Dispose plan entry is malformed: ${planId}`);
  }
  if (entry.action === "trash-resolve") {
    const expectedTarget = disposeTrashTarget(ledgerPath, planId, entry.id, entry.subjectPath);
    if (entry.targetPath !== expectedTarget) {
      throw new Error(`Dispose plan target path mismatch: expected ${expectedTarget}`);
    }
  } else if (entry.targetPath !== undefined) {
    throw new Error(`Dispose plan entry is malformed: ${planId}`);
  }
  if (entry.action === "snooze") {
    if (!isSnoozeRetention(entry.retention) || typeof entry.retainUntil !== "string") {
      throw new Error(`Dispose plan entry is malformed: ${planId}`);
    }
    assertIsoDate(entry.retainUntil, "dispose plan retainUntil");
  } else if (entry.retention !== undefined || entry.retainUntil !== undefined) {
    throw new Error(`Dispose plan entry is malformed: ${planId}`);
  }
  return entry;
}

function isSubjectSnapshot(value: unknown): value is DisposeSubjectSnapshot {
  if (!value || typeof value !== "object") return false;
  const subject = value as Partial<DisposeSubjectSnapshot>;
  const validExistence = subject.existence === "present" || subject.existence === "missing";
  const validNodeKind = subject.nodeKind === "file" || subject.nodeKind === "directory" || subject.nodeKind === "other" || subject.nodeKind === null;
  const validByteSize = subject.byteSize === null || (typeof subject.byteSize === "number" && Number.isFinite(subject.byteSize) && subject.byteSize >= 0);
  const validFingerprint = subject.fingerprint === null || typeof subject.fingerprint === "string";
  return validExistence && validNodeKind && validByteSize && validFingerprint;
}

function isSnoozeRetention(value: unknown): value is Retention {
  if (!value || typeof value !== "object") return false;
  const retention = value as Partial<Retention>;
  if (retention.mode === "ttl") {
    if (typeof retention.ttl !== "string") return false;
    try {
      addTtl(new Date(0), retention.ttl);
      return true;
    } catch {
      return false;
    }
  }
  if (retention.mode === "retain-until") {
    if (typeof retention.retainUntil !== "string") return false;
    try {
      assertIsoDate(retention.retainUntil, "dispose plan retainUntil");
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function disposeReceiptPath(ledgerPath: string, planId: string): string {
  assertSafeGeneratedId(planId, "dispose plan id");
  return join(dirname(ledgerPath), "dispose-receipts", `${planId}.json`);
}

function writeDisposeReceipt(receiptPath: string, value: unknown): void {
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(value, null, 2)}\n`);
}

function readCompletedDisposeReceipt(receiptPath: string, planId: string, expected?: Pick<DisposePlanEntry, "id" | "action">): { executedAt: string; result: DisposeResult } | null {
  let receipt: { planId?: unknown; executedAt?: unknown; status?: unknown; result?: unknown };
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { planId?: unknown; executedAt?: unknown; status?: unknown; result?: unknown };
  } catch {
    return null;
  }
  if (receipt.planId !== planId || receipt.status !== "completed" || typeof receipt.executedAt !== "string" || !isDisposeResult(receipt.result)) {
    return null;
  }
  if (expected && (receipt.result.id !== expected.id || receipt.result.action !== expected.action)) {
    throw new Error(`Dispose receipt result mismatch: receipt ${receiptPath} reports ${receipt.result.id}/${receipt.result.action}, expected ${expected.id}/${expected.action}`);
  }
  return { executedAt: receipt.executedAt, result: receipt.result };
}

function readStartedDisposeReceipt(receiptPath: string, planId: string): { executedAt: string } | null {
  if (!existsSync(receiptPath)) return null;
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { planId?: unknown; executedAt?: unknown; status?: unknown };
    if (receipt.planId !== planId || receipt.status !== "started" || typeof receipt.executedAt !== "string") return null;
    return { executedAt: receipt.executedAt };
  } catch {
    return null;
  }
}

function registerDisposeReceipt(ledgerPath: string, receiptPath: string, planId: string): void {
  const registered = readLedger(ledgerPath).some((record) => (
    record.status === "active" &&
    record.path === receiptPath &&
    record.labels.includes("dispose-receipt") &&
    record.labels.includes(planId) &&
    (record.owner === "artshelf" || record.owner === "shelf")
  ));
  if (registered) return;
  registerArtshelfArtifact(ledgerPath, receiptPath, {
    reason: `Artshelf dispose receipt for plan ${planId}`,
    ttl: "30d",
    kind: "run-artifact",
    cleanup: "review",
    labels: ["artshelf", "dispose-receipt", planId]
  });
}

function isDisposeResult(value: unknown): value is DisposeResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<DisposeResult>;
  return (
    typeof result.id === "string" &&
    typeof result.action === "string" &&
    DISPOSE_ACTIONS.has(result.action) &&
    typeof result.status === "string" &&
    typeof result.reason === "string" &&
    (typeof result.previousPath === "string" || result.previousPath === null) &&
    (typeof result.targetPath === "string" || result.targetPath === null) &&
    Boolean(result.verification)
  );
}

function buildDisposePlan(ledgerPath: string, request: DisposeRequest): DisposePlan {
  const generatedAt = now();
  const finding = classifyDisposition(ledgerPath, request);
  const base = {
    generatedAt: toIso(generatedAt),
    ledgerPath,
    request: { id: request.id, action: request.action }
  };

  if (!finding.ok) {
    return {
      planId: "not-created",
      ...base,
      entry: null,
      blocked: { id: request.id, action: request.action, reason: finding.reason, detail: finding.detail },
      planPath: null
    };
  }

  const planId = makeDisposePlanId(generatedAt);
  return {
    planId,
    ...base,
    entry: scopeTarget(finding.entry, planId, ledgerPath),
    blocked: null,
    planPath: disposePlanPath(ledgerPath, planId)
  };
}

function buildEntry(
  record: ArtshelfRecord,
  action: DisposeAction,
  reason: string,
  subjectPath: string,
  subject: DisposeSubjectSnapshot,
  snooze?: { retention: Retention; retainUntil: string }
): DisposePlanEntry {
  return {
    id: record.id,
    action,
    status: record.status,
    path: record.path,
    subjectPath,
    reason,
    subject,
    ...(snooze ? { retention: snooze.retention, retainUntil: snooze.retainUntil } : {})
  };
}

// Attach the plan-id-scoped trash target to a trash-resolve entry; every other action
// leaves the subject in place, so it carries no target. Recomputing here (rather than in
// classify) keeps the target bound to whichever plan id finally owns the entry, including
// a reused plan id.
function scopeTarget(entry: DisposePlanEntry, planId: string, ledgerPath: string): DisposePlanEntry {
  if (entry.action !== "trash-resolve") return entry;
  return { ...entry, targetPath: disposeTrashTarget(ledgerPath, planId, entry.id, entry.subjectPath) };
}

function buildSnoozeRetention(request: DisposeRequest): { retention: Retention; retainUntil: string } {
  if (request.ttl) {
    return { retention: { mode: "ttl", ttl: request.ttl }, retainUntil: toIso(addTtl(now(), request.ttl)) };
  }
  const retainUntil = assertIsoDate(request.retainUntil as string, "--retain-until");
  return { retention: { mode: "retain-until", retainUntil }, retainUntil };
}

function snapshotSubject(path: string): DisposeSubjectSnapshot {
  let stat: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number };
  try {
    stat = lstatSync(path);
  } catch {
    return { existence: "missing", nodeKind: null, byteSize: null, fingerprint: null };
  }
  if (stat.isSymbolicLink()) return { existence: "present", nodeKind: "other", byteSize: null, fingerprint: fingerprintSubject(path, "other") };
  if (stat.isFile()) return { existence: "present", nodeKind: "file", byteSize: stat.size, fingerprint: fingerprintSubject(path, "file") };
  if (stat.isDirectory()) return { existence: "present", nodeKind: "directory", byteSize: null, fingerprint: fingerprintSubject(path, "directory") };
  return { existence: "present", nodeKind: "other", byteSize: null, fingerprint: fingerprintSubject(path, "other") };
}

function fingerprintSubject(path: string, nodeKind: "file" | "directory" | "other"): string | null {
  try {
    if (nodeKind === "file") return createHash("sha256").update(readFileSync(path)).digest("hex");
    if (nodeKind === "directory") return fingerprintDirectory(path);
    return createHash("sha256").update(readlinkSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function fingerprintDirectory(path: string): string {
  const hash = createHash("sha256");
  hash.update("directory\0");
  for (const name of readdirSync(path).sort()) {
    const childPath = join(path, name);
    const stat = lstatSync(childPath);
    hash.update(name);
    hash.update("\0");
    if (stat.isFile()) {
      hash.update("file\0");
      hash.update(String(stat.size));
      hash.update("\0");
      hash.update(readFileSync(childPath));
      continue;
    }
    if (stat.isDirectory()) {
      hash.update("directory\0");
      hash.update(fingerprintDirectory(childPath));
      continue;
    }
    if (stat.isSymbolicLink()) {
      hash.update("symlink\0");
      hash.update(readlinkSync(childPath));
      continue;
    }
    hash.update("other\0");
  }
  return hash.digest("hex");
}

function isTerminal(status: ArtshelfStatus): boolean {
  return status === "resolved" || status === "trashed";
}

function defaultReason(action: DisposeAction): string {
  return `${action} via approved dispose plan`;
}

function ok(entry: DisposePlanEntry): DisposeFinding {
  return { ok: true, entry };
}

function blocked(reason: DisposeBlockReason, detail: string): DisposeFinding {
  return { ok: false, reason, detail };
}

// Reuse an earlier plan whose request fingerprint matches this one's so repeated dry-runs
// converge on a single stable plan id (mirrors cleanup/reconcile plan reuse). Volatile
// fields (generatedAt, the plan-id-scoped target, and the absolute retainUntil) are not
// fingerprinted, so the same logical request reuses its plan across clock ticks.
function matchingExistingDisposePlan(ledgerPath: string, plan: DisposePlan): DisposePlan | null {
  const plansDir = join(dirname(ledgerPath), "dispose-plans");
  if (!existsSync(plansDir)) return null;

  const filenames = readdirSync(plansDir).filter((name) => name.endsWith(".json")).sort().reverse();
  for (const filename of filenames) {
    const planPath = join(plansDir, filename);
    try {
      const candidate = JSON.parse(readFileSync(planPath, "utf8")) as DisposePlan;
      if (candidate.ledgerPath !== ledgerPath) continue;
      if (completedDisposeReceiptExists(ledgerPath, candidate.planId)) continue;
      if (disposePlanFingerprint(candidate) !== disposePlanFingerprint(plan)) continue;
      return { ...candidate, planPath };
    } catch {
      continue;
    }
  }
  return null;
}

function disposePlanFingerprint(plan: DisposePlan): string {
  if (!plan.entry) return "";
  return JSON.stringify({
    id: plan.entry.id,
    action: plan.entry.action,
    status: plan.entry.status,
    reason: plan.entry.reason,
    path: plan.entry.path,
    subjectPath: plan.entry.subjectPath,
    subject: plan.entry.subject,
    retention: plan.entry.retention ?? null,
    retainUntil: plan.entry.retainUntil ?? null
  });
}

function completedDisposeReceiptExists(ledgerPath: string, planId: string): boolean {
  const receiptPath = disposeReceiptPath(ledgerPath, planId);
  return existsSync(receiptPath) && readCompletedDisposeReceipt(receiptPath, planId) !== null;
}

function writeDisposePlanFile(planPath: string, plan: DisposePlan): void {
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
}

function makeDisposePlanId(date: Date): string {
  return `dispose_${toIso(date).replace(/[-:]/g, "").replace("T", "_").replace("Z", "")}_${randomBytes(2).toString("hex")}`;
}

function disposePlanPath(ledgerPath: string, planId: string): string {
  assertSafeGeneratedId(planId, "dispose plan id");
  return join(dirname(ledgerPath), "dispose-plans", `${planId}.json`);
}

function disposeTrashTarget(ledgerPath: string, planId: string, id: string, subjectPath: string): string {
  assertSafeGeneratedId(planId, "dispose plan id");
  assertSafeGeneratedId(id, "dispose record id");
  return join(dirname(ledgerPath), "trash", planId, `${id}-${basename(subjectPath)}`);
}
