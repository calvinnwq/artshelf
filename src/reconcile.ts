import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { readLedger, registerArtshelfArtifact } from "./ledger.js";
import { resolveLedgerRoot, resolveRepoRoot } from "./provenance.js";
import { now, toIso } from "./time.js";
import type { ArtshelfRecord, PathProvenance, ReconcileCategory, ReconcileField, ReconcileFinding, ReconcilePlan } from "./types.js";

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
