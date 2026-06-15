import { existsSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { readLedger } from "./ledger.js";
import { resolveLedgerRoot, resolveRepoRoot } from "./provenance.js";
import type { ArtshelfRecord, PathProvenance, ReconcileCategory, ReconcileField, ReconcileFinding } from "./types.js";

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
