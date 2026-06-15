import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { readLedger, registerArtshelfArtifact, writeLedger } from "./ledger.js";
import { withPathLock } from "./locks.js";
import { computeProvenance, resolveLedgerRoot, resolveRepoRoot } from "./provenance.js";
import { now, toIso } from "./time.js";
import type {
  ArtshelfRecord,
  PathProvenance,
  ReconcileCategory,
  ReconcileExecution,
  ReconcileField,
  ReconcileFinding,
  ReconcilePlan,
  ReconcileResult
} from "./types.js";

const RECONCILE_CATEGORIES: ReadonlySet<string> = new Set<ReconcileCategory>([
  "remap",
  "resolve-missing",
  "resolve-stale-trash",
  "registry-remap",
  "blocked"
]);

type Roots = {
  ledgerRoot: string;
  repoRoot: string | null;
};

// Classify path drift in a ledger into reconcile findings (NGX-437). This is the
// read-only engine the dry-run/execute workflow builds on: it never mutates the
// ledger or the filesystem, it only reads records and probes whether recorded paths
// still exist (and whether a renamed root can reconstruct them via provenance).
// Findings are returned in ledger order so downstream JSON output is deterministic.
export function classifyReconcileFindings(ledgerPath: string): ReconcileFinding[] {
  const records = readLedger(ledgerPath);
  const roots: Roots = {
    ledgerRoot: resolveLedgerRoot(ledgerPath),
    repoRoot: resolveRepoRoot(ledgerPath)
  };

  const findings: ReconcileFinding[] = [];
  for (const record of records) {
    const finding = classifyRecord(record, roots);
    if (finding) findings.push(finding);
  }
  return findings;
}

// Build the reconcile plan without persisting anything (NGX-437 dry-run preview).
// This is fully read-only: it classifies drift and returns the plan a `--dry-run`
// would create, but never writes a plan file or touches the ledger. An empty plan
// (no actionable entries) collapses to the not-created shape so callers can render
// "nothing to reconcile" the same way cleanup does.
export function previewReconcilePlan(ledgerPath: string): ReconcilePlan {
  const plan = buildReconcilePlan(ledgerPath);
  return plan.entries.length === 0 ? noCreatedReconcilePlan(plan) : plan;
}

// Create (or reuse) a reviewed reconcile plan (NGX-437 dry-run). This is the only
// part of dry-run that writes: it persists the plan JSON and registers it as an
// artshelf-owned artifact so the plan file is tracked and a later `--execute` can
// bind to an exact reviewed plan id. When an earlier plan already covers the same
// findings it is reused verbatim (stable plan id), and when nothing is actionable
// no plan artifact is created at all, keeping dry-run side-effect-free in that case.
export function createReconcilePlan(ledgerPath: string): ReconcilePlan {
  const plan = buildReconcilePlan(ledgerPath);
  if (plan.entries.length === 0) return noCreatedReconcilePlan(plan);

  const existing = matchingExistingReconcilePlan(ledgerPath, plan);
  const reviewed = existing ? { ...plan, planId: existing.planId, planPath: existing.planPath } : plan;
  if (!reviewed.planPath) throw new Error("reconcile plan path was not created");

  writeReconcilePlanFile(reviewed.planPath, reviewed);
  registerArtshelfArtifact(ledgerPath, reviewed.planPath, {
    reason: `Artshelf reconcile dry-run plan ${reviewed.planId}`,
    ttl: "14d",
    kind: "run-artifact",
    cleanup: "trash",
    labels: ["artshelf", "reconcile-plan", reviewed.planId]
  });
  return reviewed;
}

// Apply a reviewed reconcile plan (NGX-437 `reconcile --execute`). This is the only
// mutating reconcile entrypoint and it is deliberately conservative:
//   * It refuses up front when the plan id is missing, the plan file is absent, or the
//     plan file's declared id/ledger does not match the scoped request (no fresh plan,
//     no `--all`; the command layer enforces those, this binds to one exact plan id).
//   * Before applying any entry it re-classifies the live ledger and only acts when the
//     current finding still matches the reviewed entry, so a plan executed against a
//     drifted ledger refuses the stale entries instead of mutating the wrong rows.
// Reconcile is ledger/registry housekeeping only: it rewrites paths and resolves rows
// and writes a receipt; it never creates or deletes filesystem artifacts.
export function executeReconcilePlan(ledgerPath: string, planId: string): ReconcileExecution {
  if (!planId) throw new Error("reconcile --execute requires --plan-id");

  const planPath = reconcilePlanPath(ledgerPath, planId);
  if (!existsSync(planPath)) throw new Error(`Reconcile plan not found: ${planId}`);
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as ReconcilePlan;
  assertReconcilePlanExecutable(plan, planId, ledgerPath);

  const receiptPath = reconcileReceiptPath(ledgerPath, planId);
  return withPathLock(ledgerPath, () => {
    const records = readLedger(ledgerPath);
    const recordsById = new Map(records.map((record) => [record.id, record]));
    const liveById = new Map(classifyReconcileFindings(ledgerPath).map((finding) => [finding.id, finding]));
    const executedAt = toIso(now());
    const audit = { reconcilePlanId: planId, reconcileReceiptPath: receiptPath, reconciledAt: executedAt };
    const results: ReconcileResult[] = [];

    for (const entry of plan.entries) {
      const record = recordsById.get(entry.id);
      const live = liveById.get(entry.id);
      if (!record || !live || !sameReconcileTarget(live, entry)) {
        results.push(skippedResult(entry));
        continue;
      }
      const applied = applyReconcileEntry(record, entry, audit, ledgerPath);
      recordsById.set(entry.id, applied);
      results.push(appliedResult(entry, applied));
    }

    writeReconcileReceipt(receiptPath, { planId, ledgerPath, executedAt, results });
    writeLedger(ledgerPath, records.map((record) => recordsById.get(record.id) ?? record));
    registerArtshelfArtifact(ledgerPath, receiptPath, {
      reason: `Artshelf reconcile receipt for plan ${planId}`,
      ttl: "30d",
      kind: "run-artifact",
      cleanup: "review",
      labels: ["artshelf", "reconcile-receipt", planId]
    });
    return { planId, receiptPath, executedAt, results };
  }, "Artshelf ledger");
}

type ReconcileAudit = { reconcilePlanId: string; reconcileReceiptPath: string; reconciledAt: string };

// Produce the mutated record for one applicable entry. A remap rewrites the path and
// recomputes provenance against the new location (so the row is reconcile-healthy
// afterwards) while keeping the row's status; every resolve category archives the row
// ledger-only as `resolved`. previousPath always preserves the pre-action path.
function applyReconcileEntry(record: ArtshelfRecord, entry: ReconcileFinding, audit: ReconcileAudit, ledgerPath: string): ArtshelfRecord {
  if (entry.category === "remap" && entry.proposedPath) {
    return {
      ...record,
      path: entry.proposedPath,
      provenance: computeProvenance(entry.proposedPath, { ledgerPath }),
      previousPath: entry.currentPath,
      ...audit,
      reconcileReason: entry.reason
    };
  }
  return {
    ...record,
    status: "resolved",
    resolvedAt: audit.reconciledAt,
    resolutionReason: entry.reason,
    previousPath: entry.currentPath,
    ...audit,
    reconcileReason: entry.reason
  };
}

function appliedResult(entry: ReconcileFinding, applied: ArtshelfRecord): ReconcileResult {
  return {
    id: entry.id,
    category: entry.category,
    field: entry.field,
    status: applied.status === "resolved" ? "resolved" : "remapped",
    previousPath: entry.currentPath,
    newPath: entry.category === "remap" ? entry.proposedPath : null,
    reason: entry.reason
  };
}

function skippedResult(entry: ReconcileFinding): ReconcileResult {
  return {
    id: entry.id,
    category: entry.category,
    field: entry.field,
    status: "skipped",
    previousPath: entry.currentPath,
    newPath: null,
    reason: "live ledger state no longer matches the reviewed plan"
  };
}

// Two findings describe the same drift only when every structural field agrees; this
// is the execute-time safety check that refuses entries whose live state has moved on.
function sameReconcileTarget(live: ReconcileFinding, entry: ReconcileFinding): boolean {
  return (
    live.category === entry.category &&
    live.field === entry.field &&
    live.status === entry.status &&
    live.currentPath === entry.currentPath &&
    live.proposedPath === entry.proposedPath
  );
}

// Bind a loaded reconcile plan to the request before any ledger mutation, mirroring
// cleanup's assertCleanupPlanExecutable: the plan must declare the requested id, belong
// to the executing ledger, and carry well-formed entries.
function assertReconcilePlanExecutable(plan: ReconcilePlan, planId: string, ledgerPath: string): void {
  if (plan.planId !== planId) {
    throw new Error(`Reconcile plan id mismatch: plan file declares ${plan.planId}, requested ${planId}`);
  }
  if (plan.ledgerPath !== ledgerPath) {
    throw new Error(`Reconcile plan ledger mismatch: plan was created for ${plan.ledgerPath}, executing ${ledgerPath}`);
  }
  if (!Array.isArray(plan.entries)) {
    throw new Error(`Reconcile plan entries are malformed: ${planId}`);
  }
  for (const entry of plan.entries) {
    if (!entry || typeof entry.id !== "string" || typeof entry.currentPath !== "string" || !RECONCILE_CATEGORIES.has(entry.category)) {
      throw new Error(`Reconcile plan entries are malformed: ${planId}`);
    }
  }
}

function reconcileReceiptPath(ledgerPath: string, planId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(planId)) throw new Error(`Invalid reconcile plan id: ${planId}`);
  return join(dirname(ledgerPath), "reconcile-receipts", `${planId}.json`);
}

function writeReconcileReceipt(receiptPath: string, value: unknown): void {
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(value, null, 2)}\n`);
}

function classifyRecord(record: ArtshelfRecord, roots: Roots): ReconcileFinding | null {
  // A trashed row's original path is expected to be empty (it was moved to trash),
  // so the only path that matters is the trash target.
  if (record.status === "trashed") return classifyTrashTarget(record);
  // Live rows are the ones whose recorded artifact path should still exist. This
  // mirrors validateLedger's "recorded path is missing" warning surface.
  if (record.status === "active" || record.status === "review-required") {
    return classifyActivePath(record, roots);
  }
  // resolved / cleanup-refused rows are terminal for reconcile purposes.
  return null;
}

function classifyActivePath(record: ArtshelfRecord, roots: Roots): ReconcileFinding | null {
  if (!record.path || existsSync(record.path)) return null;

  const provenance = record.provenance;
  const candidate = reconstructPath(provenance, roots);
  if (provenance && candidate && existsSync(candidate)) {
    if (isSafeMatch(provenance, candidate)) {
      return finding(record, "remap", "path", record.path, candidate, `recorded path is missing; reconstructed at ${candidate}`);
    }
    return finding(
      record,
      "blocked",
      "path",
      record.path,
      null,
      `a candidate exists at ${candidate} but its name or fingerprint does not match the recorded artifact`
    );
  }

  return finding(record, "resolve-missing", "path", record.path, null, "recorded path is missing and no safe remap target was found");
}

function classifyTrashTarget(record: ArtshelfRecord): ReconcileFinding | null {
  // Missing cleanup metadata on a trashed row is validateLedger's concern, not ours.
  if (!record.targetPath || existsSync(record.targetPath)) return null;
  return finding(
    record,
    "resolve-stale-trash",
    "targetPath",
    record.targetPath,
    null,
    "trashed target is missing; resolve the ledger row without touching the filesystem"
  );
}

// Re-root a provenance-relative path under the current ledger/repo root. Only
// reconstructable roots (repo/ledger) with a stored relative path can be rebuilt;
// external paths and legacy rows without provenance return null.
function reconstructPath(provenance: PathProvenance | undefined, roots: Roots): string | null {
  if (!provenance || provenance.relativePath === null) return null;
  if (provenance.root === "repo") {
    return roots.repoRoot ? join(roots.repoRoot, fromPosix(provenance.relativePath)) : null;
  }
  if (provenance.root === "ledger") {
    return join(roots.ledgerRoot, fromPosix(provenance.relativePath));
  }
  return null;
}

// A reconstructed candidate is only trusted when its basename matches and, for
// files with a captured fingerprint, its byte size matches too. Directories and
// fingerprint-less rows fall back to name plus existence as the evidence.
function isSafeMatch(provenance: PathProvenance, candidate: string): boolean {
  if (basename(candidate) !== provenance.basename) return false;
  if (provenance.pathKind === "file" && provenance.fingerprint) {
    try {
      return statSync(candidate).size === provenance.fingerprint.byteSize;
    } catch {
      return false;
    }
  }
  return true;
}

function finding(
  record: ArtshelfRecord,
  category: ReconcileCategory,
  field: ReconcileField,
  currentPath: string,
  proposedPath: string | null,
  reason: string
): ReconcileFinding {
  return { id: record.id, category, field, status: record.status, currentPath, proposedPath, reason };
}

function fromPosix(path: string): string {
  return sep === "/" ? path : path.split("/").join(sep);
}

// Split classified findings into a plan: actionable entries (everything a scoped
// `--execute` may apply) versus blocked findings (surfaced for review only). The
// plan id/path are computed up front so a dry-run can persist deterministically.
function buildReconcilePlan(ledgerPath: string): ReconcilePlan {
  const generatedAt = now();
  const findings = classifyReconcileFindings(ledgerPath);
  const entries = findings.filter((finding) => finding.category !== "blocked");
  const blocked = findings.filter((finding) => finding.category === "blocked");
  const planId = makeReconcilePlanId(generatedAt);
  return {
    planId,
    generatedAt: toIso(generatedAt),
    ledgerPath,
    entries,
    blocked,
    planPath: reconcilePlanPath(ledgerPath, planId)
  };
}

function noCreatedReconcilePlan(plan: ReconcilePlan): ReconcilePlan {
  return { ...plan, planId: "not-created", planPath: null };
}

// Reuse an earlier plan whose actionable entries match this one's, so repeated
// dry-runs converge on a single stable plan id (mirrors cleanup plan reuse). Only
// the structural entry fields are fingerprinted; volatile fields (generatedAt) and
// the review-only blocked list do not affect reuse.
function matchingExistingReconcilePlan(ledgerPath: string, plan: ReconcilePlan): ReconcilePlan | null {
  const plansDir = join(dirname(ledgerPath), "reconcile-plans");
  if (!existsSync(plansDir)) return null;

  const filenames = readdirSync(plansDir).filter((name) => name.endsWith(".json")).sort().reverse();
  for (const filename of filenames) {
    const planPath = join(plansDir, filename);
    try {
      const candidate = JSON.parse(readFileSync(planPath, "utf8")) as ReconcilePlan;
      if (candidate.ledgerPath !== ledgerPath) continue;
      if (reconcilePlanFingerprint(candidate) !== reconcilePlanFingerprint(plan)) continue;
      return { ...candidate, planPath };
    } catch {
      continue;
    }
  }
  return null;
}

function reconcilePlanFingerprint(plan: ReconcilePlan): string {
  return JSON.stringify(plan.entries.map((entry) => ({
    id: entry.id,
    category: entry.category,
    field: entry.field,
    currentPath: entry.currentPath,
    proposedPath: entry.proposedPath
  })));
}

function writeReconcilePlanFile(planPath: string, plan: ReconcilePlan): void {
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
}

function makeReconcilePlanId(date: Date): string {
  return `reconcile_${toIso(date).replace(/[-:]/g, "").replace("T", "_").replace("Z", "")}_${randomBytes(2).toString("hex")}`;
}

function reconcilePlanPath(ledgerPath: string, planId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(planId)) throw new Error(`Invalid reconcile plan id: ${planId}`);
  return join(dirname(ledgerPath), "reconcile-plans", `${planId}.json`);
}
