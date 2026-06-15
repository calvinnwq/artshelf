import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { withPathLock } from "./locks.js";
import { computeProvenance, validateProvenance } from "./provenance.js";
import { addTtl, assertIsoDate, ageOf, now, ttlToMs, toIso } from "./time.js";
import type {
  CleanupAction,
  CleanupPlan,
  CleanupPlanEntry,
  DueEntry,
  DueStatus,
  TrashPurgePlan,
  Retention,
  ArtshelfKind,
  ArtshelfRecord,
  ArtshelfStatus
} from "./types.js";

const KINDS = new Set<ArtshelfKind>([
  "scratch",
  "backup",
  "run-artifact",
  "evidence",
  "cache",
  "quarantine",
  "other"
]);

const CLEANUP_ACTIONS = new Set<CleanupAction>(["trash", "review", "delete"]);
const STATUSES = new Set<ArtshelfStatus>(["active", "review-required", "trashed", "cleanup-refused", "resolved"]);
const RESOLVE_STATUSES = new Set<ArtshelfStatus>(["resolved"]);

export type PutInput = {
  path: string;
  reason: string;
  ttl?: string | undefined;
  retainUntil?: string | undefined;
  manualReview?: boolean | undefined;
  kind?: string | undefined;
  cleanup?: string | undefined;
  owner?: string | undefined;
  labels: string[];
};

export type ResolveInput = {
  id: string;
  status: string;
  reason: string;
};

export type FindInput = {
  path?: string | undefined;
  owner?: string | undefined;
  labels: string[];
  status?: string | undefined;
};

export type TrashedRecord = {
  id: string;
  targetPath: string;
  cleanedAt: string;
  receiptPath: string;
  cleanupPlanId: string;
  age: string;
};

export function defaultLedgerPath(cwd = process.cwd()): string {
  const repoRoot = findGitRoot(cwd);
  if (repoRoot) return join(repoRoot, ".artshelf", "ledger.jsonl");
  return join(homedir(), ".artshelf", "ledger.jsonl");
}

export function normalizeLedgerPath(path?: string): string {
  return resolve(path ?? defaultLedgerPath());
}

export function putRecord(ledgerPath: string, input: PutInput): ArtshelfRecord {
  const record = prepareRecord(input, ledgerPath);
  appendPreparedRecord(ledgerPath, record);
  return record;
}

export function prepareRecord(input: PutInput, ledgerPath: string): ArtshelfRecord {
  const artifactPath = resolve(input.path);
  if (!existsSync(artifactPath)) {
    throw new Error(`Path does not exist: ${input.path}`);
  }
  if (!input.reason || input.reason.trim().length === 0) {
    throw new Error("Missing required --reason");
  }

  const retentionCount = [input.ttl, input.retainUntil, input.manualReview].filter(Boolean).length;
  if (retentionCount !== 1) {
    throw new Error("Choose exactly one of --ttl, --retain-until, or --manual-review");
  }

  const kind = assertKind(input.kind ?? "other");
  const cleanup = assertCleanup(input.cleanup ?? "review");
  const createdAt = now();
  const retentionPlan = buildRetention(input, createdAt);

  const record: ArtshelfRecord = {
    id: makeId(createdAt),
    path: artifactPath,
    kind,
    reason: input.reason.trim(),
    createdAt: toIso(createdAt),
    ...(retentionPlan.retainUntil ? { retainUntil: retentionPlan.retainUntil } : {}),
    retention: retentionPlan.retention,
    cleanup,
    owner: input.owner ?? "manual",
    labels: input.labels,
    status: "active",
    provenance: computeProvenance(artifactPath, { ledgerPath })
  };

  return record;
}

export function appendPreparedRecord(ledgerPath: string, record: ArtshelfRecord): void {
  appendRecord(ledgerPath, record);
}

export function readLedger(ledgerPath: string): ArtshelfRecord[] {
  if (!existsSync(ledgerPath)) return [];
  const content = readFileSync(ledgerPath, "utf8").trim();
  if (!content) return [];

  return content.split(/\n+/).map((line, index) => {
    try {
      return JSON.parse(line) as ArtshelfRecord;
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${(error as Error).message}`);
    }
  });
}

export function listTrashedRecords(ledgerPath: string): TrashedRecord[] {
  const records = readLedger(ledgerPath).filter((record) => record.status === "trashed");
  const current = now();
  return records.map((record) => {
    if (!record.id || !record.targetPath || !record.cleanedAt || !record.receiptPath || !record.cleanupPlanId) {
      throw new Error(`trashed record ${record.id ?? "<missing id>"} missing cleanup metadata`);
    }
    return {
      id: record.id,
      targetPath: record.targetPath,
      cleanedAt: record.cleanedAt,
      receiptPath: record.receiptPath,
      cleanupPlanId: record.cleanupPlanId,
      age: ageOf(current, record.cleanedAt)
    };
  });
}

export function filterRecordsByStatus(records: ArtshelfRecord[], status?: string): ArtshelfRecord[] {
  if (!status) return records;
  const normalized = assertStatus(status);
  return records.filter((record) => record.status === normalized);
}

export function getRecord(records: ArtshelfRecord[], id: string): ArtshelfRecord {
  if (!id || id.trim().length === 0) throw new Error("get requires <id>");
  const record = records.find((entry) => entry.id === id);
  if (!record) throw new Error(`Artshelf record not found: ${id}`);
  return record;
}

export function findRecords(records: ArtshelfRecord[], input: FindInput): ArtshelfRecord[] {
  const hasQuery = Boolean(input.path || input.owner || input.labels.length > 0 || input.status);
  if (!hasQuery) {
    throw new Error("find requires at least one of --path, --owner, --label, or --status");
  }

  const normalizedPath = input.path ? resolve(input.path) : undefined;
  const normalizedStatus = input.status ? assertStatus(input.status) : undefined;
  return records.filter((record) => {
    if (normalizedPath && record.path !== normalizedPath) return false;
    if (input.owner && record.owner !== input.owner) return false;
    if (normalizedStatus && record.status !== normalizedStatus) return false;
    for (const label of input.labels) {
      if (!record.labels.includes(label)) return false;
    }
    return true;
  });
}

export function resolveRecord(ledgerPath: string, input: ResolveInput): ArtshelfRecord {
  if (!input.id || input.id.trim().length === 0) throw new Error("resolve requires <id>");
  if (!input.reason || input.reason.trim().length === 0) throw new Error("Missing required --reason");
  const status = assertResolveStatus(input.status);
  return withLedgerLock(ledgerPath, () => {
    const records = readLedger(ledgerPath);
    const index = records.findIndex((record) => record.id === input.id);
    if (index === -1) throw new Error(`Artshelf record not found: ${input.id}`);

    const current = records[index];
    if (!current) throw new Error(`Artshelf record not found: ${input.id}`);
    if (current.status === "resolved") {
      throw new Error(`Artshelf record is already resolved: ${input.id}`);
    }
    const updated: ArtshelfRecord = {
      ...current,
      status,
      resolvedAt: toIso(now()),
      resolutionReason: input.reason.trim()
    };
    records[index] = updated;
    writeLedger(ledgerPath, records);
    return updated;
  });
}

export function dueEntries(records: ArtshelfRecord[], at = now()): DueEntry[] {
  return records.filter((record) => record.status === "active").map((record) => {
    const dueStatus = classifyDue(record, at);
    return {
      id: record.id,
      path: record.path,
      reason: record.reason,
      cleanup: record.cleanup,
      dueStatus,
      ...(record.retainUntil ? { retainUntil: record.retainUntil } : {})
    };
  });
}

export function validateLedger(ledgerPath: string): {
  ok: boolean;
  errors: string[];
  warnings: string[];
  entries: number;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  let records: ArtshelfRecord[] = [];

  try {
    records = readLedger(ledgerPath);
  } catch (error) {
    errors.push((error as Error).message);
    return { ok: false, errors, warnings, entries: 0 };
  }

  const ids = new Set<string>();
  for (const [index, record] of records.entries()) {
    const label = record.id ?? `line ${index + 1}`;
    for (const field of ["id", "path", "kind", "reason", "createdAt", "retention", "cleanup", "owner", "labels", "status"]) {
      if (!(field in record)) errors.push(`${label}: missing ${field}`);
    }
    if (record.id) {
      if (ids.has(record.id)) errors.push(`${record.id}: duplicate id`);
      ids.add(record.id);
    }
    if (record.path && !isAbsolute(record.path)) errors.push(`${label}: path must be absolute`);
    if (record.kind && !KINDS.has(record.kind)) errors.push(`${label}: unknown kind ${record.kind}`);
    if (record.cleanup && !CLEANUP_ACTIONS.has(record.cleanup)) {
      errors.push(`${label}: unknown cleanup ${record.cleanup}`);
    }
    if (!Array.isArray(record.labels)) errors.push(`${label}: labels must be an array`);
    if (record.status && !STATUSES.has(record.status)) errors.push(`${label}: unknown status ${record.status}`);
    if (!validRetention(record)) errors.push(`${label}: invalid retention`);
    if ((record.status === "active" || record.status === "review-required") && record.path && !existsSync(record.path)) {
      warnings.push(`${label}: recorded path is missing`);
    }
    if (record.status === "trashed") {
      if (!record.cleanupPlanId) errors.push(`${label}: trashed record missing cleanupPlanId`);
      if (!record.receiptPath) errors.push(`${label}: trashed record missing receiptPath`);
      if (!record.cleanedAt) errors.push(`${label}: trashed record missing cleanedAt`);
      if (!record.targetPath) {
        errors.push(`${label}: trashed record missing targetPath`);
      } else if (!existsSync(record.targetPath)) {
        warnings.push(`${label}: trashed target path is missing`);
      }
    }
    if (record.status === "review-required" || record.status === "cleanup-refused") {
      if (!record.cleanupPlanId) errors.push(`${label}: ${record.status} record missing cleanupPlanId`);
      if (!record.receiptPath) errors.push(`${label}: ${record.status} record missing receiptPath`);
      if (!record.cleanedAt) errors.push(`${label}: ${record.status} record missing cleanedAt`);
    }
    if (record.status === "resolved") {
      if (!record.resolvedAt) errors.push(`${label}: resolved record missing resolvedAt`);
      if (!record.resolutionReason) errors.push(`${label}: resolved record missing resolutionReason`);
    }
    // Legacy rows simply omit provenance and are left alone; once a row carries
    // provenance it must be well-formed so future reconcile can trust it.
    if ("provenance" in record) {
      for (const problem of validateProvenance(record.provenance)) {
        errors.push(`${label}: ${problem}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, entries: records.length };
}

export function createCleanupPlan(ledgerPath: string): CleanupPlan {
  const plan = buildCleanupPlan(ledgerPath);
  if (plan.entries.length === 0) return noCreatedPlan(plan);
  const existingPlan = matchingExistingCleanupPlan(ledgerPath, plan);
  if (existingPlan) {
    const refreshedPlan = {
      ...plan,
      planId: existingPlan.planId,
      planPath: existingPlan.planPath
    };
    if (!refreshedPlan.planPath) throw new Error("cleanup plan path was not created");
    writeJson(refreshedPlan.planPath, refreshedPlan);
    registerArtshelfArtifact(ledgerPath, refreshedPlan.planPath, {
      reason: `Artshelf cleanup dry-run plan ${refreshedPlan.planId}`,
      ttl: "14d",
      kind: "run-artifact",
      cleanup: "trash",
      labels: ["artshelf", "cleanup-plan", refreshedPlan.planId]
    });
    return refreshedPlan;
  }
  if (!plan.planPath) throw new Error("cleanup plan path was not created");
  writeJson(plan.planPath, plan);
  registerArtshelfArtifact(ledgerPath, plan.planPath, {
    reason: `Artshelf cleanup dry-run plan ${plan.planId}`,
    ttl: "14d",
    kind: "run-artifact",
    cleanup: "trash",
    labels: ["artshelf", "cleanup-plan", plan.planId]
  });
  return plan;
}

export function previewCleanupPlan(ledgerPath: string): CleanupPlan {
  const plan = buildCleanupPlan(ledgerPath);
  return plan.entries.length === 0 ? noCreatedPlan(plan) : plan;
}

export function createTrashPurgePlan(ledgerPath: string, olderThan: string): TrashPurgePlan {
  const plan = buildTrashPurgePlan(ledgerPath, olderThan);
  if (plan.entries.length === 0) return noCreatedTrashPurgePlan(plan);
  if (!plan.planPath) throw new Error("trash purge plan path was not created");
  writeJson(plan.planPath, plan);
  registerArtshelfArtifact(ledgerPath, plan.planPath, {
    reason: `Artshelf trash purge dry-run plan ${plan.purgePlanId}`,
    ttl: "14d",
    kind: "run-artifact",
    cleanup: "review",
    labels: ["artshelf", "trash-purge-plan", plan.purgePlanId]
  });
  return plan;
}

export function previewTrashPurgePlan(ledgerPath: string, olderThan: string): TrashPurgePlan {
  const plan = buildTrashPurgePlan(ledgerPath, olderThan);
  return plan.entries.length === 0 ? noCreatedTrashPurgePlan(plan) : plan;
}

export function executeTrashPurgePlan(ledgerPath: string, purgePlanId: string): {
  purgePlanId: string;
  receiptPath: string;
  results: Array<{ id: string; status: string; targetPath: string; reason?: string }>;
} {
  if (!purgePlanId) throw new Error("trash purge --execute requires --plan-id");

  const planPath = trashPurgePlanPath(ledgerPath, purgePlanId);
  if (!existsSync(planPath)) throw new Error(`Trash purge plan not found: ${purgePlanId}`);
  const receiptPath = trashPurgeReceiptPath(ledgerPath, purgePlanId);
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as TrashPurgePlan;
  return withLedgerLock(ledgerPath, () => {
    const existingReceipt = existsSync(receiptPath) ? readTrashPurgeReceipt(receiptPath) : null;
    if (existingReceipt?.completedAt) throw new Error(`Trash purge receipt already exists: ${purgePlanId}`);
    const records = readLedger(ledgerPath);
    const recordsById = new Map(records.map((record) => [record.id, record]));
    const trashRoot = resolve(dirname(ledgerPath), "trash");
    const executedAt = existingReceipt?.executedAt ?? toIso(now());
    let results: Array<{ id: string; status: string; targetPath: string; reason?: string }> = existingReceipt?.results ?? [];
    const candidates: Array<{ id: string; targetPath: string }> = [];

    for (const entry of plan.entries) {
      const existingResult = results.find((result) => result.id === entry.id);
      if (existingResult && ["failed", "purged", "skipped"].includes(existingResult.status)) continue;

      const record = recordsById.get(entry.id);
      if (!record) {
        results.push({ id: entry.id, status: "skipped", targetPath: entry.targetPath, reason: "record is missing from ledger" });
        continue;
      }

      if (record.status !== "trashed") {
        results.push({ id: entry.id, status: "skipped", targetPath: entry.targetPath, reason: `record is ${record.status}` });
        continue;
      }

      if (
        record.targetPath !== entry.targetPath ||
        record.cleanedAt !== entry.cleanedAt ||
        record.receiptPath !== entry.receiptPath ||
        record.cleanupPlanId !== entry.cleanupPlanId
      ) {
        results.push({ id: entry.id, status: "skipped", targetPath: entry.targetPath, reason: "plan entry no longer matches ledger record" });
        continue;
      }

      const targetPath = resolve(entry.targetPath);
      const expectedPlanTrashRoot = resolve(trashRoot, record.cleanupPlanId);
      if (!isPathWithin(trashRoot, targetPath)) {
        results.push({ id: entry.id, status: "skipped", targetPath: entry.targetPath, reason: "target is outside Artshelf trash" });
        continue;
      }
      if (!isStrictPathWithin(expectedPlanTrashRoot, targetPath)) {
        results.push({ id: entry.id, status: "skipped", targetPath: entry.targetPath, reason: "target is not a trashed artifact path" });
        continue;
      }

      if (!pathExistsForPurge(entry.targetPath)) {
        if (existingResult?.status === "deleting") {
          results = upsertTrashPurgeResult(results, { id: entry.id, status: "purged", targetPath });
          continue;
        }
        results.push({ id: entry.id, status: "skipped", targetPath: entry.targetPath, reason: "target is missing" });
        continue;
      }
      try {
        if (resolvesOutsideLedgerTrash(dirname(ledgerPath), trashRoot, expectedPlanTrashRoot, targetPath)) {
          results.push({ id: entry.id, status: "skipped", targetPath: entry.targetPath, reason: "target resolves outside Artshelf trash" });
          continue;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        results.push({ id: entry.id, status: "skipped", targetPath: entry.targetPath, reason: `target cannot be validated: ${reason}` });
        continue;
      }

      candidates.push({ id: entry.id, targetPath });
    }

    writeTrashPurgeReceipt(receiptPath, {
      purgePlanId,
      executedAt,
      status: "started",
      results: [
        ...results,
        ...candidates.map((candidate) => ({ id: candidate.id, status: "pending", targetPath: candidate.targetPath }))
      ]
    });

    for (const candidate of candidates) {
      results = upsertTrashPurgeResult(results, { id: candidate.id, status: "deleting", targetPath: candidate.targetPath });
      writeTrashPurgeReceipt(receiptPath, {
        purgePlanId,
        executedAt,
        status: "started",
        results: [
          ...results,
          ...pendingTrashPurgeResults(candidates, results)
        ]
      });

      try {
        rmSync(candidate.targetPath, { recursive: true, force: true });
        results = upsertTrashPurgeResult(results, { id: candidate.id, status: "purged", targetPath: candidate.targetPath });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        results = upsertTrashPurgeResult(results, { id: candidate.id, status: "failed", targetPath: candidate.targetPath, reason });
      }
      writeTrashPurgeReceipt(receiptPath, {
        purgePlanId,
        executedAt,
        status: "started",
        results: [
          ...results,
          ...pendingTrashPurgeResults(candidates, results)
        ]
      });
    }

    updateLedgerAfterTrashPurge(ledgerPath, records, { purgePlanId, receiptPath, executedAt, results });
    writeTrashPurgeReceipt(receiptPath, { purgePlanId, executedAt, completedAt: toIso(now()), results });
    registerArtshelfArtifact(ledgerPath, receiptPath, {
      reason: `Artshelf trash purge receipt for plan ${purgePlanId}`,
      ttl: "30d",
      kind: "run-artifact",
      cleanup: "review",
      labels: ["artshelf", "trash-purge-receipt", purgePlanId]
    });
    return { purgePlanId, receiptPath, results };
  });
}

function readTrashPurgeReceipt(receiptPath: string): {
  purgePlanId?: string;
  executedAt?: string;
  completedAt?: string;
  results?: Array<{ id: string; status: string; targetPath: string; reason?: string }>;
} {
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
    purgePlanId?: string;
    executedAt?: string;
    completedAt?: string;
    results?: Array<{ id: string; status: string; targetPath: string; reason?: string }>;
  };
  return {
    ...(typeof receipt.purgePlanId === "string" ? { purgePlanId: receipt.purgePlanId } : {}),
    ...(typeof receipt.executedAt === "string" ? { executedAt: receipt.executedAt } : {}),
    ...(typeof receipt.completedAt === "string" ? { completedAt: receipt.completedAt } : {}),
    results: Array.isArray(receipt.results) ? receipt.results : []
  };
}

function writeTrashPurgeReceipt(
  receiptPath: string,
  receipt: {
    purgePlanId: string;
    executedAt: string;
    completedAt?: string;
    status?: string;
    results: Array<{ id: string; status: string; targetPath: string; reason?: string }>;
  }
): void {
  writeJson(receiptPath, receipt);
}

function pendingTrashPurgeResults(
  candidates: Array<{ id: string; targetPath: string }>,
  results: Array<{ id: string; status: string; targetPath: string; reason?: string }>
): Array<{ id: string; status: string; targetPath: string }> {
  return candidates
    .filter((pending) => !results.some((result) => result.id === pending.id))
    .map((pending) => ({ id: pending.id, status: "pending", targetPath: pending.targetPath }));
}

function upsertTrashPurgeResult(
  results: Array<{ id: string; status: string; targetPath: string; reason?: string }>,
  next: { id: string; status: string; targetPath: string; reason?: string }
): Array<{ id: string; status: string; targetPath: string; reason?: string }> {
  return [...results.filter((result) => result.id !== next.id), next];
}

function noCreatedPlan(plan: CleanupPlan): CleanupPlan {
  return {
    ...plan,
    planId: "not-created",
    planPath: null
  };
}

function noCreatedTrashPurgePlan(plan: TrashPurgePlan): TrashPurgePlan {
  return {
    ...plan,
    purgePlanId: "not-created",
    planPath: null
  };
}

function buildCleanupPlan(ledgerPath: string): CleanupPlan {
  const generatedAt = now();
  const records = readLedger(ledgerPath);
  const due = dueEntries(records, generatedAt);
  const entries: CleanupPlanEntry[] = [];
  const skipped: CleanupPlan["skipped"] = [];

  for (const item of due) {
    if (item.dueStatus === "kept") {
      skipped.push({ id: item.id, path: item.path, reason: "retention has not expired", dueStatus: item.dueStatus });
      continue;
    }
    if (item.dueStatus === "missing-path") {
      skipped.push({ id: item.id, path: item.path, reason: "path is missing", dueStatus: item.dueStatus });
      continue;
    }
    entries.push({ id: item.id, path: item.path, action: item.cleanup, dueStatus: item.dueStatus });
  }

  const planId = makePlanId(generatedAt);
  const planPath = cleanupPlanPath(ledgerPath, planId);
  const plan: CleanupPlan = {
    planId,
    generatedAt: toIso(generatedAt),
    ledgerPath,
    entries,
    skipped,
    planPath
  };
  return plan;
}

function buildTrashPurgePlan(ledgerPath: string, olderThan: string): TrashPurgePlan {
  const generatedAt = now();
  const olderThanMs = ttlToMs(olderThan);
  const cutoff = toIso(new Date(generatedAt.getTime() - olderThanMs));
  const records = readLedger(ledgerPath);
  const entries: TrashPurgePlan["entries"] = [];
  const skipped: TrashPurgePlan["skipped"] = [];

  for (const record of records) {
    if (record.status !== "trashed") continue;
    if (!record.id || !record.targetPath || !record.cleanedAt || !record.receiptPath || !record.cleanupPlanId) {
      skipped.push({
        id: record.id ?? "",
        targetPath: record.targetPath ?? "",
        reason: "trashed record missing cleanup metadata"
      });
      continue;
    }

    const cleanedAt = new Date(record.cleanedAt);
    if (Number.isNaN(cleanedAt.getTime())) {
      skipped.push({
        id: record.id,
        targetPath: record.targetPath,
        reason: "invalid cleanedAt value"
      });
      continue;
    }

    if (cleanedAt.getTime() > generatedAt.getTime() - olderThanMs) {
      skipped.push({ id: record.id, targetPath: record.targetPath, reason: `cleanedAt is newer than ${olderThan}` });
      continue;
    }

    entries.push({
      id: record.id,
      targetPath: record.targetPath,
      cleanedAt: record.cleanedAt,
      receiptPath: record.receiptPath,
      cleanupPlanId: record.cleanupPlanId
    });
  }

  const purgePlanId = makePurgePlanId(generatedAt);
  const planPath = trashPurgePlanPath(ledgerPath, purgePlanId);
  return {
    purgePlanId,
    generatedAt: toIso(generatedAt),
    ledgerPath,
    olderThan,
    cutoff,
    entries,
    skipped,
    planPath
  };
}

export function executeCleanupPlan(ledgerPath: string, planId: string): {
  planId: string;
  receiptPath: string;
  results: Array<{ id: string; action: CleanupAction; status: string; path: string; target?: string; reason?: string }>;
} {
  if (!planId) throw new Error("cleanup --execute requires --plan-id");

  const planPath = cleanupPlanPath(ledgerPath, planId);
  if (!existsSync(planPath)) throw new Error(`Cleanup plan not found: ${planId}`);
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as CleanupPlan;
  assertCleanupPlanExecutable(plan, planId, ledgerPath);
  const trashRoot = join(dirname(ledgerPath), "trash", planId);
  const receiptPath = receiptPathFor(ledgerPath, planId);
  return withLedgerLock(ledgerPath, () => {
    // Cleanup is the first operation that moves user artifacts, so it leaves a durable
    // receipt before the first move and reconciles a prior interrupted run on rerun:
    // an artifact already moved into trash must not be moved again, and the ledger is
    // only advanced on receipt/filesystem evidence. This mirrors trash purge resume.
    const existingReceipt = existsSync(receiptPath) ? readCleanupReceipt(receiptPath) : null;
    const priorResultById = new Map((existingReceipt?.results ?? []).map((result) => [result.id, result]));
    const records = readLedger(ledgerPath);
    const recordsById = new Map(records.map((record) => [record.id, record]));
    // Preserve the original execution timestamp so a resumed run records the moment the
    // artifact was actually moved, not the resume time.
    const executedAt = existingReceipt?.executedAt ?? toIso(now());

    const results: Array<{ id: string; action: CleanupAction; status: string; path: string; target?: string; reason?: string }> = [];
    const moves: Array<{ index: number; entry: CleanupPlanEntry; target: string }> = [];

    for (const entry of plan.entries) {
      const index = results.length;
      const record = recordsById.get(entry.id);
      if (!record) {
        results.push({ id: entry.id, action: entry.action, status: "skipped", path: entry.path, reason: "record is missing from ledger" });
        continue;
      }

      if (record.status !== "active") {
        results.push({ id: entry.id, action: entry.action, status: "skipped", path: entry.path, reason: `record is ${record.status}` });
        continue;
      }

      if (entry.action === "trash") {
        const target = join(trashRoot, `${entry.id}-${basename(entry.path)}`);
        if (existsSync(entry.path)) {
          // Defer the move so a started receipt lands before the first filesystem mutation.
          results.push({ id: entry.id, action: entry.action, status: "pending", path: entry.path, target });
          moves.push({ index, entry, target });
          continue;
        }
        // The original path is gone. Only treat it as already-trashed when the moved
        // trash target exists or a prior started receipt recorded the move; otherwise this
        // is a missing path, not a successful cleanup.
        const prior = priorResultById.get(entry.id);
        if (existsSync(target) || prior?.status === "trashed") {
          results.push({ id: entry.id, action: entry.action, status: "trashed", path: entry.path, target });
          continue;
        }
        results.push({ id: entry.id, action: entry.action, status: "skipped", path: entry.path, reason: "path is missing" });
        continue;
      }

      if (!existsSync(entry.path)) {
        results.push({ id: entry.id, action: entry.action, status: "skipped", path: entry.path, reason: "path is missing" });
        continue;
      }

      if (entry.action === "delete") {
        results.push({ id: entry.id, action: entry.action, status: "refused", path: entry.path, reason: "delete is disabled in v1" });
        continue;
      }

      // entry.action === "review"
      results.push({ id: entry.id, action: entry.action, status: "review-required", path: entry.path });
    }

    if (moves.length > 0) {
      // Durable started receipt before the first move, so an interrupted run is resumable.
      writeCleanupReceipt(receiptPath, { planId, executedAt, status: "started", results });
      for (const move of moves) {
        mkdirSync(trashRoot, { recursive: true });
        renameSync(move.entry.path, move.target);
        results[move.index] = { id: move.entry.id, action: move.entry.action, status: "trashed", path: move.entry.path, target: move.target };
        writeCleanupReceipt(receiptPath, { planId, executedAt, status: "started", results });
      }
    }

    updateLedgerAfterCleanup(ledgerPath, records, { planId, receiptPath, executedAt, results });
    writeCleanupReceipt(receiptPath, { planId, executedAt, completedAt: toIso(now()), results });
    registerArtshelfArtifact(ledgerPath, receiptPath, {
      reason: `Artshelf cleanup receipt for plan ${planId}`,
      ttl: "30d",
      kind: "run-artifact",
      cleanup: "review",
      labels: ["artshelf", "cleanup-receipt", planId]
    });
    return { planId, receiptPath, results };
  });
}

function readCleanupReceipt(receiptPath: string): {
  planId?: string;
  executedAt?: string;
  completedAt?: string;
  results: Array<{ id: string; action: CleanupAction; status: string; path: string; target?: string; reason?: string }>;
} {
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
    planId?: string;
    executedAt?: string;
    completedAt?: string;
    results?: Array<{ id: string; action: CleanupAction; status: string; path: string; target?: string; reason?: string }>;
  };
  return {
    ...(typeof receipt.planId === "string" ? { planId: receipt.planId } : {}),
    ...(typeof receipt.executedAt === "string" ? { executedAt: receipt.executedAt } : {}),
    ...(typeof receipt.completedAt === "string" ? { completedAt: receipt.completedAt } : {}),
    results: Array.isArray(receipt.results) ? receipt.results : []
  };
}

function writeCleanupReceipt(
  receiptPath: string,
  receipt: {
    planId: string;
    executedAt: string;
    completedAt?: string;
    status?: string;
    results: Array<{ id: string; action: CleanupAction; status: string; path: string; target?: string; reason?: string }>;
  }
): void {
  writeJson(receiptPath, receipt);
}

// Exported so the reconcile plan layer (src/reconcile.ts) registers its dry-run plan
// artifacts through the same upsert-by-path-and-labels path that cleanup plans use,
// keeping plan files tracked and reused under a stable plan id.
export function registerArtshelfArtifact(
  ledgerPath: string,
  path: string,
  input: Pick<PutInput, "reason" | "ttl" | "kind" | "cleanup" | "labels">
): void {
  const prepared = prepareRecord({
    path,
    reason: input.reason,
    ttl: input.ttl,
    kind: input.kind,
    cleanup: input.cleanup,
    owner: "artshelf",
    labels: input.labels
  }, ledgerPath);
  withLedgerLock(ledgerPath, () => {
    const records = readLedger(ledgerPath);
    const index = records.findIndex((record) => (
      isMatchingArtshelfArtifact(record, path, input.labels) &&
      record.status === "active" &&
      record.path === path
    ));

    if (index === -1) {
      appendPreparedRecord(ledgerPath, prepared);
      return;
    }

    const current = records[index];
    if (!current) return;
    records[index] = {
      ...current,
      reason: prepared.reason,
      createdAt: prepared.createdAt,
      ...(prepared.retainUntil ? { retainUntil: prepared.retainUntil } : {}),
      retention: prepared.retention,
      kind: prepared.kind,
      cleanup: prepared.cleanup,
      owner: prepared.owner,
      labels: prepared.labels
    };
    writeLedger(ledgerPath, records);
  });
}

function isMatchingArtshelfArtifact(record: ArtshelfRecord, path: string, labels: string[]): boolean {
  if (record.path !== path) return false;
  if (record.owner === "artshelf") return sameLabels(record.labels, labels);
  if (record.owner !== "shelf") return false;

  const legacyLabels = labels.map((label, index) => index === 0 && label === "artshelf" ? "shelf" : label);
  return sameLabels(record.labels, legacyLabels);
}

function sameLabels(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((label, index) => label === right[index]);
}

function matchingExistingCleanupPlan(ledgerPath: string, plan: CleanupPlan): CleanupPlan | null {
  const plansDir = join(dirname(ledgerPath), "plans");
  if (!existsSync(plansDir)) return null;

  const filenames = readdirSync(plansDir).filter((name) => name.endsWith(".json")).sort().reverse();
  for (const filename of filenames) {
    const planPath = join(plansDir, filename);
    try {
      const candidate = JSON.parse(readFileSync(planPath, "utf8")) as CleanupPlan;
      if (candidate.ledgerPath !== ledgerPath) continue;
      if (cleanupPlanEntriesFingerprint(candidate) !== cleanupPlanEntriesFingerprint(plan)) continue;
      return { ...candidate, planPath };
    } catch {
      continue;
    }
  }

  return null;
}

function cleanupPlanEntriesFingerprint(plan: CleanupPlan): string {
  return JSON.stringify(plan.entries.map((entry) => ({
    id: entry.id,
    path: entry.path,
    action: entry.action,
    dueStatus: entry.dueStatus
  })));
}

function withLedgerLock<T>(ledgerPath: string, fn: () => T): T {
  return withPathLock(ledgerPath, fn, "Artshelf ledger");
}

function atomicWriteFileSync(targetPath: string, content: string): void {
  const tmpPath = `${targetPath}.${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, targetPath);
}

function appendRecord(ledgerPath: string, record: ArtshelfRecord): void {
  withLedgerLock(ledgerPath, () => {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const previous = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
    atomicWriteFileSync(ledgerPath, `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${JSON.stringify(record)}\n`);
  });
}

// Exported so the reconcile execute layer (src/reconcile.ts) persists its mutated
// records through the canonical JSONL writer + ledger lock instead of duplicating the
// atomic-write format, keeping the reconcile -> ledger import direction one-way.
export function writeLedger(ledgerPath: string, records: ArtshelfRecord[]): void {
  withLedgerLock(ledgerPath, () => {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    atomicWriteFileSync(ledgerPath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""));
  });
}

function updateLedgerAfterCleanup(
  ledgerPath: string,
  records: ArtshelfRecord[],
  receipt: {
    planId: string;
    receiptPath: string;
    executedAt: string;
    results: Array<{ id: string; action: CleanupAction; status: string; path: string; target?: string; reason?: string }>;
  }
): void {
  const resultById = new Map(receipt.results.map((result) => [result.id, result]));
  const updated = records.map((record) => {
    const result = resultById.get(record.id);
    if (!result) return record;

    if (result.status === "trashed") {
      return {
        ...record,
        status: "trashed" as const,
        cleanupPlanId: receipt.planId,
        receiptPath: receipt.receiptPath,
        cleanedAt: receipt.executedAt,
        ...(result.target ? { targetPath: result.target } : {})
      };
    }

    if (result.status === "review-required") {
      return {
        ...record,
        status: "review-required" as const,
        cleanupPlanId: receipt.planId,
        receiptPath: receipt.receiptPath,
        cleanedAt: receipt.executedAt
      };
    }

    if (result.status === "refused") {
      return {
        ...record,
        status: "cleanup-refused" as const,
        cleanupPlanId: receipt.planId,
        receiptPath: receipt.receiptPath,
        cleanedAt: receipt.executedAt,
        ...(result.reason ? { cleanupReason: result.reason } : {})
      };
    }

    return record;
  });
  writeLedger(ledgerPath, updated);
}

function updateLedgerAfterTrashPurge(
  ledgerPath: string,
  records: ArtshelfRecord[],
  receipt: {
    purgePlanId: string;
    receiptPath: string;
    executedAt: string;
    results: Array<{ id: string; status: string; targetPath: string; reason?: string }>;
  }
): void {
  const resultById = new Map(receipt.results.map((result) => [result.id, result]));
  const updated = records.map((record) => {
    const result = resultById.get(record.id);
    if (!result || result.status !== "purged") return record;

    return {
      ...record,
      status: "resolved" as const,
      resolvedAt: receipt.executedAt,
      resolutionReason: "trash purge completed",
      purgedAt: receipt.executedAt,
      purgePlanId: receipt.purgePlanId,
      purgeReceiptPath: receipt.receiptPath
    };
  });
  writeLedger(ledgerPath, updated);
}

function buildRetention(input: PutInput, createdAt: Date): { retention: Retention; retainUntil?: string } {
  if (input.manualReview) return { retention: { mode: "manual-review" } };
  if (input.ttl) {
    return { retention: { mode: "ttl", ttl: input.ttl }, retainUntil: toIso(addTtl(createdAt, input.ttl)) };
  }
  if (input.retainUntil) {
    const retainUntil = assertIsoDate(input.retainUntil, "--retain-until");
    return { retention: { mode: "retain-until", retainUntil }, retainUntil };
  }
  throw new Error("Choose exactly one of --ttl, --retain-until, or --manual-review");
}

function classifyDue(record: ArtshelfRecord, at: Date): DueStatus {
  if (!existsSync(record.path)) return "missing-path";
  if (record.retention.mode === "manual-review") return "manual-review";
  if (!record.retainUntil) return "due";
  return new Date(record.retainUntil).getTime() <= at.getTime() ? "due" : "kept";
}

function validRetention(record: ArtshelfRecord): boolean {
  if (!record.retention || !("mode" in record.retention)) return false;
  if (record.retention.mode === "manual-review") return !record.retainUntil;
  if (record.retention.mode === "ttl") return Boolean(record.retention.ttl && record.retainUntil);
  if (record.retention.mode === "retain-until") return Boolean(record.retention.retainUntil && record.retainUntil);
  return false;
}

function findGitRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function assertKind(kind: string): ArtshelfKind {
  if (!KINDS.has(kind as ArtshelfKind)) throw new Error(`Unknown kind: ${kind}`);
  return kind as ArtshelfKind;
}

function assertCleanup(cleanup: string): CleanupAction {
  if (!CLEANUP_ACTIONS.has(cleanup as CleanupAction)) throw new Error(`Unknown cleanup action: ${cleanup}`);
  return cleanup as CleanupAction;
}

function assertStatus(status: string): ArtshelfStatus {
  if (!STATUSES.has(status as ArtshelfStatus)) throw new Error(`Unknown status: ${status}`);
  return status as ArtshelfStatus;
}

function assertResolveStatus(status: string): ArtshelfStatus {
  const normalized = assertStatus(status);
  if (!RESOLVE_STATUSES.has(normalized)) {
    throw new Error(`resolve currently supports --status resolved`);
  }
  return normalized;
}

function makeId(date: Date): string {
  return `shf_${toIso(date).replace(/[-:]/g, "").replace("T", "_").replace("Z", "")}_${randomBytes(2).toString("hex")}`;
}

function makePlanId(date: Date): string {
  return `plan_${toIso(date).replace(/[-:]/g, "").replace("T", "_").replace("Z", "")}_${randomBytes(2).toString("hex")}`;
}

function makePurgePlanId(date: Date): string {
  return `purge_${toIso(date).replace(/[-:]/g, "").replace("T", "_").replace("Z", "")}_${randomBytes(2).toString("hex")}`;
}

function cleanupPlanPath(ledgerPath: string, planId: string): string {
  assertSafeGeneratedId(planId, "cleanup plan id");
  return join(dirname(ledgerPath), "plans", `${planId}.json`);
}

function trashPurgePlanPath(ledgerPath: string, purgePlanId: string): string {
  assertSafeGeneratedId(purgePlanId, "trash purge plan id");
  return join(dirname(ledgerPath), "purge-plans", `${purgePlanId}.json`);
}

function receiptPathFor(ledgerPath: string, planId: string): string {
  assertSafeGeneratedId(planId, "cleanup plan id");
  return join(dirname(ledgerPath), "receipts", `${planId}.json`);
}

function trashPurgeReceiptPath(ledgerPath: string, purgePlanId: string): string {
  assertSafeGeneratedId(purgePlanId, "trash purge plan id");
  return join(dirname(ledgerPath), "purge-receipts", `${purgePlanId}.json`);
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const fromParent = relative(resolve(parentPath), resolve(childPath));
  return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
}

function isStrictPathWithin(parentPath: string, childPath: string): boolean {
  const fromParent = relative(resolve(parentPath), resolve(childPath));
  return fromParent !== "" && !fromParent.startsWith("..") && !isAbsolute(fromParent);
}

function resolvesOutsideLedgerTrash(ledgerDir: string, trashRoot: string, expectedPlanTrashRoot: string, targetPath: string): boolean {
  const realLedgerDir = realpathSync(ledgerDir);
  const realTrashRoot = realpathSync(trashRoot);
  const realExpectedPlanTrashRoot = realpathSync(expectedPlanTrashRoot);
  const targetStats = lstatSync(targetPath);
  const realTargetPath = targetStats.isSymbolicLink() ? realpathSync(dirname(targetPath)) : realpathSync(targetPath);
  const targetWithinExpectedRoot = targetStats.isSymbolicLink()
    ? isPathWithin(realExpectedPlanTrashRoot, realTargetPath)
    : isStrictPathWithin(realExpectedPlanTrashRoot, realTargetPath);
  return (
    !isStrictPathWithin(realLedgerDir, realTrashRoot) ||
    !isStrictPathWithin(realTrashRoot, realExpectedPlanTrashRoot) ||
    !targetWithinExpectedRoot
  );
}

function pathExistsForPurge(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function assertSafeGeneratedId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

// Bind a loaded cleanup plan to the request before any filesystem mutation: the
// plan must declare the requested id, belong to the executing ledger, and carry
// executable-looking entries. This keeps `cleanup --execute` plan-id bound, the
// same posture trash purge already enforces against ledger record metadata.
function assertCleanupPlanExecutable(plan: CleanupPlan, planId: string, ledgerPath: string): void {
  if (plan.planId !== planId) {
    throw new Error(`Cleanup plan id mismatch: plan file declares ${plan.planId}, requested ${planId}`);
  }
  if (plan.ledgerPath !== ledgerPath) {
    throw new Error(`Cleanup plan ledger mismatch: plan was created for ${plan.ledgerPath}, executing ${ledgerPath}`);
  }
  if (!Array.isArray(plan.entries)) {
    throw new Error(`Cleanup plan entries are malformed: ${planId}`);
  }
  for (const entry of plan.entries) {
    if (!entry || typeof entry.id !== "string" || typeof entry.path !== "string" || !CLEANUP_ACTIONS.has(entry.action)) {
      throw new Error(`Cleanup plan entries are malformed: ${planId}`);
    }
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
