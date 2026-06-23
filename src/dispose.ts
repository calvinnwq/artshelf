import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assertSafeGeneratedId, getRecord, readLedger, registerArtshelfArtifact } from "./ledger.js";
import { addTtl, assertIsoDate, now, toIso } from "./time.js";
import type {
  ArtshelfRecord,
  ArtshelfStatus,
  DisposeAction,
  DisposeBlockReason,
  DisposePlan,
  DisposePlanEntry,
  DisposeSubjectSnapshot,
  Retention
} from "./types.js";

const DISPOSE_ACTIONS: ReadonlySet<string> = new Set<DisposeAction>(["trash-resolve", "resolve-only", "snooze", "keep"]);

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
    if (!reason) return blocked("missing-reason", "resolve-only requires a reason");
    return ok(buildEntry(record, "resolve-only", reason, subjectPath, subject));
  }

  if (request.action === "snooze") {
    if (isTerminal(record.status)) return blocked("terminal-record", `cannot snooze a ${record.status} record`);
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
  const reviewed = existing
    ? { ...plan, planId: existing.planId, planPath: existing.planPath, entry: scopeTarget(plan.entry, existing.planId, ledgerPath) }
    : plan;
  if (!reviewed.planPath) throw new Error("dispose plan path was not created");

  writeDisposePlanFile(reviewed.planPath, reviewed);
  registerArtshelfArtifact(ledgerPath, reviewed.planPath, {
    reason: `Artshelf dispose dry-run plan ${reviewed.planId}`,
    ttl: "14d",
    kind: "run-artifact",
    cleanup: "trash",
    labels: ["artshelf", "dispose-plan", reviewed.planId]
  });
  return reviewed;
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
    return { existence: "missing", nodeKind: null, byteSize: null };
  }
  if (stat.isSymbolicLink()) return { existence: "present", nodeKind: "other", byteSize: null };
  if (stat.isFile()) return { existence: "present", nodeKind: "file", byteSize: stat.size };
  if (stat.isDirectory()) return { existence: "present", nodeKind: "directory", byteSize: null };
  return { existence: "present", nodeKind: "other", byteSize: null };
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
    reason: plan.entry.reason,
    subjectPath: plan.entry.subjectPath,
    retention: plan.entry.retention ?? null
  });
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
  return join(dirname(ledgerPath), "trash", planId, `${id}-${basename(subjectPath)}`);
}
