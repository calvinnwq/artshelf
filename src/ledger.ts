import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { addTtl, assertIsoDate, now, toIso } from "./time.js";
import type {
  CleanupAction,
  CleanupPlan,
  CleanupPlanEntry,
  DueEntry,
  DueStatus,
  Retention,
  ShelfKind,
  ShelfRecord,
  ShelfStatus
} from "./types.js";

const KINDS = new Set<ShelfKind>([
  "scratch",
  "backup",
  "run-artifact",
  "evidence",
  "cache",
  "quarantine",
  "other"
]);

const CLEANUP_ACTIONS = new Set<CleanupAction>(["trash", "review", "delete"]);
const STATUSES = new Set<ShelfStatus>(["active", "review-required", "trashed", "cleanup-refused", "resolved"]);
const RESOLVE_STATUSES = new Set<ShelfStatus>(["resolved"]);

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

export function defaultLedgerPath(cwd = process.cwd()): string {
  const repoRoot = findGitRoot(cwd);
  if (repoRoot) return join(repoRoot, ".shelf", "ledger.jsonl");
  return join(homedir(), ".shelf", "ledger.jsonl");
}

export function normalizeLedgerPath(path?: string): string {
  return resolve(path ?? defaultLedgerPath());
}

export function putRecord(ledgerPath: string, input: PutInput): ShelfRecord {
  const record = prepareRecord(input);
  appendPreparedRecord(ledgerPath, record);
  return record;
}

export function prepareRecord(input: PutInput): ShelfRecord {
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

  const record: ShelfRecord = {
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
    status: "active"
  };

  return record;
}

export function appendPreparedRecord(ledgerPath: string, record: ShelfRecord): void {
  appendRecord(ledgerPath, record);
}

export function readLedger(ledgerPath: string): ShelfRecord[] {
  if (!existsSync(ledgerPath)) return [];
  const content = readFileSync(ledgerPath, "utf8").trim();
  if (!content) return [];

  return content.split(/\n+/).map((line, index) => {
    try {
      return JSON.parse(line) as ShelfRecord;
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${(error as Error).message}`);
    }
  });
}

export function filterRecordsByStatus(records: ShelfRecord[], status?: string): ShelfRecord[] {
  if (!status) return records;
  const normalized = assertStatus(status);
  return records.filter((record) => record.status === normalized);
}

export function getRecord(records: ShelfRecord[], id: string): ShelfRecord {
  if (!id || id.trim().length === 0) throw new Error("get requires <id>");
  const record = records.find((entry) => entry.id === id);
  if (!record) throw new Error(`Shelf record not found: ${id}`);
  return record;
}

export function findRecords(records: ShelfRecord[], input: FindInput): ShelfRecord[] {
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

export function resolveRecord(ledgerPath: string, input: ResolveInput): ShelfRecord {
  if (!input.id || input.id.trim().length === 0) throw new Error("resolve requires <id>");
  if (!input.reason || input.reason.trim().length === 0) throw new Error("Missing required --reason");
  const status = assertResolveStatus(input.status);
  const records = readLedger(ledgerPath);
  const index = records.findIndex((record) => record.id === input.id);
  if (index === -1) throw new Error(`Shelf record not found: ${input.id}`);

  const current = records[index];
  if (!current) throw new Error(`Shelf record not found: ${input.id}`);
  if (current.status === "resolved") {
    throw new Error(`Shelf record is already resolved: ${input.id}`);
  }
  const updated: ShelfRecord = {
    ...current,
    status,
    resolvedAt: toIso(now()),
    resolutionReason: input.reason.trim()
  };
  records[index] = updated;
  writeLedger(ledgerPath, records);
  return updated;
}

export function dueEntries(records: ShelfRecord[], at = now()): DueEntry[] {
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
  let records: ShelfRecord[] = [];

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
  }

  return { ok: errors.length === 0, errors, warnings, entries: records.length };
}

export function createCleanupPlan(ledgerPath: string): CleanupPlan {
  const plan = buildCleanupPlan(ledgerPath);
  if (plan.entries.length === 0) {
    return {
      ...plan,
      planId: "not-created",
      planPath: null
    };
  }
  const existingPlan = matchingExistingCleanupPlan(ledgerPath, plan);
  if (existingPlan) {
    const refreshedPlan = {
      ...plan,
      planId: existingPlan.planId,
      planPath: existingPlan.planPath
    };
    if (!refreshedPlan.planPath) throw new Error("cleanup plan path was not created");
    writeJson(refreshedPlan.planPath, refreshedPlan);
    refreshShelfPlanArtifact(ledgerPath, refreshedPlan.planId, refreshedPlan.planPath);
    return refreshedPlan;
  }
  if (!plan.planPath) throw new Error("cleanup plan path was not created");
  writeJson(plan.planPath, plan);
  registerShelfArtifact(ledgerPath, plan.planPath, {
    reason: `Shelf cleanup dry-run plan ${plan.planId}`,
    ttl: "14d",
    kind: "run-artifact",
    cleanup: "trash",
    labels: ["shelf", "cleanup-plan", plan.planId]
  });
  return plan;
}

export function previewCleanupPlan(ledgerPath: string): CleanupPlan {
  return buildCleanupPlan(ledgerPath);
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

export function executeCleanupPlan(ledgerPath: string, planId: string): {
  planId: string;
  receiptPath: string;
  results: Array<{ id: string; action: CleanupAction; status: string; path: string; target?: string; reason?: string }>;
} {
  if (!planId) throw new Error("cleanup --execute requires --plan-id");

  const planPath = cleanupPlanPath(ledgerPath, planId);
  if (!existsSync(planPath)) throw new Error(`Cleanup plan not found: ${planId}`);
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as CleanupPlan;
  const trashRoot = join(dirname(ledgerPath), "trash", planId);
  const records = readLedger(ledgerPath);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const results = [];

  for (const entry of plan.entries) {
    const record = recordsById.get(entry.id);
    if (!record) {
      results.push({ id: entry.id, action: entry.action, status: "skipped", path: entry.path, reason: "record is missing from ledger" });
      continue;
    }

    if (record.status !== "active") {
      results.push({ id: entry.id, action: entry.action, status: "skipped", path: entry.path, reason: `record is ${record.status}` });
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

    if (entry.action === "review") {
      results.push({ id: entry.id, action: entry.action, status: "review-required", path: entry.path });
      continue;
    }

    mkdirSync(trashRoot, { recursive: true });
    const target = join(trashRoot, `${entry.id}-${basename(entry.path)}`);
    renameSync(entry.path, target);
    results.push({ id: entry.id, action: entry.action, status: "trashed", path: entry.path, target });
  }

  const receiptPath = receiptPathFor(ledgerPath, planId);
  const executedAt = toIso(now());
  writeJson(receiptPath, { planId, executedAt, results });
  updateLedgerAfterCleanup(ledgerPath, records, { planId, receiptPath, executedAt, results });
  registerShelfArtifact(ledgerPath, receiptPath, {
    reason: `Shelf cleanup receipt for plan ${planId}`,
    ttl: "30d",
    kind: "run-artifact",
    cleanup: "review",
    labels: ["shelf", "cleanup-receipt", planId]
  });
  return { planId, receiptPath, results };
}

function registerShelfArtifact(
  ledgerPath: string,
  path: string,
  input: Pick<PutInput, "reason" | "ttl" | "kind" | "cleanup" | "labels">
): void {
  const record = prepareRecord({
    path,
    reason: input.reason,
    ttl: input.ttl,
    kind: input.kind,
    cleanup: input.cleanup,
    owner: "shelf",
    labels: input.labels
  });
  appendPreparedRecord(ledgerPath, record);
}

function refreshShelfPlanArtifact(ledgerPath: string, planId: string, path: string): void {
  const records = readLedger(ledgerPath);
  const index = records.findIndex((record) => (
    record.owner === "shelf" &&
    record.status === "active" &&
    record.path === path &&
    record.labels.includes("cleanup-plan") &&
    record.labels.includes(planId)
  ));

  if (index === -1) {
    registerShelfArtifact(ledgerPath, path, {
      reason: `Shelf cleanup dry-run plan ${planId}`,
      ttl: "14d",
      kind: "run-artifact",
      cleanup: "trash",
      labels: ["shelf", "cleanup-plan", planId]
    });
    return;
  }

  const current = records[index];
  if (!current) return;
  const refreshedAt = now();
  records[index] = {
    ...current,
    reason: `Shelf cleanup dry-run plan ${planId}`,
    createdAt: toIso(refreshedAt),
    retainUntil: toIso(addTtl(refreshedAt, "14d")),
    retention: { mode: "ttl", ttl: "14d" },
    kind: "run-artifact",
    cleanup: "trash",
    labels: ["shelf", "cleanup-plan", planId]
  };
  writeLedger(ledgerPath, records);
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

function appendRecord(ledgerPath: string, record: ShelfRecord): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const previous = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
  writeFileSync(ledgerPath, `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${JSON.stringify(record)}\n`);
}

function writeLedger(ledgerPath: string, records: ShelfRecord[]): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const tmpPath = `${ledgerPath}.tmp`;
  writeFileSync(tmpPath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""));
  renameSync(tmpPath, ledgerPath);
}

function updateLedgerAfterCleanup(
  ledgerPath: string,
  records: ShelfRecord[],
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

function classifyDue(record: ShelfRecord, at: Date): DueStatus {
  if (!existsSync(record.path)) return "missing-path";
  if (record.retention.mode === "manual-review") return "manual-review";
  if (!record.retainUntil) return "due";
  return new Date(record.retainUntil).getTime() <= at.getTime() ? "due" : "kept";
}

function validRetention(record: ShelfRecord): boolean {
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

function assertKind(kind: string): ShelfKind {
  if (!KINDS.has(kind as ShelfKind)) throw new Error(`Unknown kind: ${kind}`);
  return kind as ShelfKind;
}

function assertCleanup(cleanup: string): CleanupAction {
  if (!CLEANUP_ACTIONS.has(cleanup as CleanupAction)) throw new Error(`Unknown cleanup action: ${cleanup}`);
  return cleanup as CleanupAction;
}

function assertStatus(status: string): ShelfStatus {
  if (!STATUSES.has(status as ShelfStatus)) throw new Error(`Unknown status: ${status}`);
  return status as ShelfStatus;
}

function assertResolveStatus(status: string): ShelfStatus {
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

function cleanupPlanPath(ledgerPath: string, planId: string): string {
  return join(dirname(ledgerPath), "plans", `${planId}.json`);
}

function receiptPathFor(ledgerPath: string, planId: string): string {
  return join(dirname(ledgerPath), "receipts", `${planId}.json`);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
