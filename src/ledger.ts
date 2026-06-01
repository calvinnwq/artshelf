import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
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
  ShelfRecord
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

export function defaultLedgerPath(cwd = process.cwd()): string {
  const repoRoot = findGitRoot(cwd);
  if (repoRoot) return join(repoRoot, ".shelf", "ledger.jsonl");
  return join(homedir(), ".shelf", "ledger.jsonl");
}

export function normalizeLedgerPath(path?: string): string {
  return resolve(path ?? defaultLedgerPath());
}

export function putRecord(ledgerPath: string, input: PutInput): ShelfRecord {
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

  appendRecord(ledgerPath, record);
  return record;
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

export function dueEntries(records: ShelfRecord[], at = now()): DueEntry[] {
  return records.map((record) => {
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
    if (record.status !== "active") errors.push(`${label}: status must be active`);
    if (!validRetention(record)) errors.push(`${label}: invalid retention`);
    if (record.path && !existsSync(record.path)) warnings.push(`${label}: recorded path is missing`);
  }

  return { ok: errors.length === 0, errors, warnings, entries: records.length };
}

export function createCleanupPlan(ledgerPath: string): CleanupPlan {
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
  writeJson(planPath, plan);
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
  const results = [];

  for (const entry of plan.entries) {
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
  writeJson(receiptPath, { planId, executedAt: toIso(now()), results });
  return { planId, receiptPath, results };
}

function appendRecord(ledgerPath: string, record: ShelfRecord): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const previous = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
  writeFileSync(ledgerPath, `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${JSON.stringify(record)}\n`);
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
