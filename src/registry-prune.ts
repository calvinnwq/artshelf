import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertSafeGeneratedId } from "./ledger.js";
import { withPathLock } from "./locks.js";
import { listRegisteredLedgers, normalizeRegistryPath, removeRegisteredLedgers } from "./registry.js";
import type { LedgerRegistryEntry, LedgerScope } from "./registry.js";
import { now, toIso } from "./time.js";

// A single read-only observation about one registered ledger during registry prune
// classification. `prune` entries are unambiguously removable (the registered ledger
// file is missing); `blocked` entries are surfaced for review but never auto-pruned
// (today: ambiguous duplicate registry paths).
export type RegistryPruneFindingStatus = "prune" | "blocked";

export type RegistryPruneFinding = {
  name: string;
  path: string;
  scope: LedgerScope;
  status: RegistryPruneFindingStatus;
  reason: string;
};

export type RegistryPrunePlanEntry = {
  name: string;
  path: string;
  scope: LedgerScope;
  reason: string;
};

// A reviewed registry-prune plan produced by `ledgers prune --dry-run`. Mirrors the
// cleanup/reconcile plan shape so a later `--execute` can bind to an exact reviewed
// plan id against an exact registry path. `entries` are the removable registrations;
// `skipped` carries findings surfaced for review but never auto-applied. `planPath` is
// null until the plan is persisted (and stays null for a no-op preview).
export type RegistryPrunePlan = {
  planId: string;
  generatedAt: string;
  registryPath: string;
  entries: RegistryPrunePlanEntry[];
  skipped: RegistryPrunePlanEntry[];
  planPath: string | null;
};

// One registration the execute step acted on. `removed` entries left the registry;
// `skipped` entries were in the reviewed plan but no longer classify as prunable at
// execute time (file reappeared, or the path became an ambiguous duplicate) and so
// are deliberately left registered.
export type RegistryPruneRemoval = {
  name: string;
  path: string;
  scope: LedgerScope;
};

// The post-mutation self-check recorded in the receipt: `ok` is true only when every
// removed registration is gone from a fresh re-scan. `remainingPrunable` reports how
// many prunable registrations still exist registry-wide (informational; other plans
// may cover them).
export type RegistryPruneVerification = {
  ok: boolean;
  remainingPrunable: number;
  detail: string;
};

// The receipt written after `ledgers prune --execute` mutates the registry. It records
// the removed registrations, the entries skipped as stale, the pre-mutation rollback
// copy, the bound plan id, when it ran, and the verification result — everything an
// audit needs to understand and, via the rollback copy, undo the prune.
export type RegistryPruneReceipt = {
  planId: string;
  registryPath: string;
  executedAt: string;
  rollbackPath: string;
  removed: RegistryPruneRemoval[];
  skipped: RegistryPruneRemoval[];
  verification: RegistryPruneVerification;
  receiptPath: string;
};

// Classify the registry into prune findings (read-only). A registration is prunable
// when its ledger file is missing — the same "missing/stale" signal `ledgers list`
// reports via existence of the ledger path. Registrations whose resolved path appears
// more than once are ambiguous: pruning one would silently drop a sibling, so they are
// blocked for manual resolution instead of pruned. Present ledger files yield nothing.
export function classifyRegistryPruneFindings(registryPath?: string): RegistryPruneFinding[] {
  const entries = listRegisteredLedgers(normalizeRegistryPath(registryPath));
  const pathCounts = new Map<string, number>();
  for (const entry of entries) {
    pathCounts.set(entry.path, (pathCounts.get(entry.path) ?? 0) + 1);
  }

  const findings: RegistryPruneFinding[] = [];
  for (const entry of entries) {
    if ((pathCounts.get(entry.path) ?? 0) > 1) {
      findings.push(finding(entry, "blocked", "ambiguous duplicate registry path; resolve manually before pruning"));
      continue;
    }
    if (existsSync(entry.path)) continue;
    findings.push(finding(entry, "prune", "registered ledger file is missing"));
  }
  return findings;
}

// Build the registry-prune plan without persisting anything (dry-run preview). Fully
// read-only: it classifies the registry and returns the plan a `--dry-run` would
// create, but never writes a plan file or mutates the registry. A plan with no
// actionable entries collapses to the not-created shape so callers can render
// "nothing to prune" the same way cleanup and reconcile do.
export function previewRegistryPrunePlan(registryPath?: string): RegistryPrunePlan {
  const plan = buildRegistryPrunePlan(normalizeRegistryPath(registryPath));
  return plan.entries.length === 0 ? noCreatedRegistryPrunePlan(plan) : plan;
}

// Create (or reuse) a reviewed registry-prune plan (dry-run). This is the only part of
// dry-run that writes, and it only writes the plan file — never the registry. When an
// earlier plan already covers the same prunable entries it is reused verbatim (stable
// plan id), and when nothing is actionable no plan artifact is created at all, keeping
// dry-run side-effect-free in that case. The plan file lives next to the registry under
// `registry-prune-plans/` so a later `--execute` can discover it by exact plan id.
export function createRegistryPrunePlan(registryPath?: string): RegistryPrunePlan {
  const normalized = normalizeRegistryPath(registryPath);
  const plan = buildRegistryPrunePlan(normalized);
  if (plan.entries.length === 0) return noCreatedRegistryPrunePlan(plan);

  const existing = matchingExistingRegistryPrunePlan(normalized, plan);
  const reviewed = existing ? { ...plan, planId: existing.planId, planPath: existing.planPath } : plan;
  if (!reviewed.planPath) throw new Error("registry prune plan path was not created");

  writeRegistryPrunePlanFile(reviewed.planPath, reviewed);
  return reviewed;
}

// Apply a reviewed registry-prune plan (NGX-481 `ledgers prune --execute`). This is the
// only mutating registry-prune entrypoint and it is deliberately conservative:
//   * It refuses up front when the plan id is missing, the registry is absent, the plan
//     file is absent, or the plan file's declared id/registry does not match the scoped
//     request (no fresh plan, no `--all`; it binds to one exact reviewed plan id against
//     one exact registry path).
//   * Inside one registry lock it re-classifies the live registry and only removes a
//     planned entry that still classifies as prunable; entries whose ledger file
//     reappeared or whose path became an ambiguous duplicate are skipped, not removed.
//   * It writes a rollback copy of the registry before mutating and a receipt after,
//     then verifies the removed registrations are actually gone.
export function executeRegistryPrunePlan(registryPath: string | undefined, planId: string): RegistryPruneReceipt {
  if (!planId) throw new Error("ledgers prune --execute requires --plan-id");
  const normalized = normalizeRegistryPath(registryPath);
  if (!existsSync(normalized)) throw new Error(`Registry not found: ${normalized}`);

  const planPath = registryPrunePlanPath(normalized, planId);
  if (!existsSync(planPath)) throw new Error(`Registry prune plan not found: ${planId}`);
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as RegistryPrunePlan;
  assertRegistryPrunePlanExecutable(plan, planId, normalized);

  const receiptPath = registryPruneReceiptPath(normalized, planId);
  const rollbackPath = registryPruneRollbackPath(normalized, planId);

  return withPathLock(normalized, () => {
    const liveByKey = new Map(
      classifyRegistryPruneFindings(normalized).map((item) => [pruneKey(item.name, item.path), item])
    );
    const removable: RegistryPrunePlanEntry[] = [];
    const skipped: RegistryPruneRemoval[] = [];
    for (const entry of plan.entries) {
      if (liveByKey.get(pruneKey(entry.name, entry.path))?.status === "prune") removable.push(entry);
      else skipped.push(removal(entry.name, entry.path, entry.scope));
    }

    // Take the rollback copy immediately before mutating, and only when something is
    // actually removable. A no-op execute (everything skipped as stale) must not
    // overwrite a rollback left by an earlier real execute of this plan id.
    let removedEntries: LedgerRegistryEntry[] = [];
    if (removable.length > 0) {
      copyRegistrySnapshot(normalized, rollbackPath);
      removedEntries = removeRegisteredLedgers(normalized, removable.map((entry) => ({ name: entry.name, path: entry.path })));
    }
    const removed = removedEntries.map((entry) => removal(entry.name, entry.path, entry.scope));

    const verification = verifyRegistryPrune(normalized, removed);
    const receipt: RegistryPruneReceipt = {
      planId,
      registryPath: normalized,
      executedAt: toIso(now()),
      rollbackPath,
      removed,
      skipped,
      verification,
      receiptPath
    };
    writeRegistryPruneReceiptFile(receiptPath, receipt);
    return receipt;
  }, "Artshelf ledger registry");
}

function finding(entry: LedgerRegistryEntry, status: RegistryPruneFindingStatus, reason: string): RegistryPruneFinding {
  return { name: entry.name, path: entry.path, scope: entry.scope, status, reason };
}

function buildRegistryPrunePlan(registryPath: string): RegistryPrunePlan {
  const generatedAt = now();
  const findings = classifyRegistryPruneFindings(registryPath);
  const entries = findings.filter((item) => item.status === "prune").map(planEntry);
  const skipped = findings.filter((item) => item.status === "blocked").map(planEntry);
  const planId = makeRegistryPrunePlanId(generatedAt);
  return {
    planId,
    generatedAt: toIso(generatedAt),
    registryPath,
    entries,
    skipped,
    planPath: registryPrunePlanPath(registryPath, planId)
  };
}

function planEntry(item: RegistryPruneFinding): RegistryPrunePlanEntry {
  return { name: item.name, path: item.path, scope: item.scope, reason: item.reason };
}

function noCreatedRegistryPrunePlan(plan: RegistryPrunePlan): RegistryPrunePlan {
  return { ...plan, planId: "not-created", planPath: null };
}

// Reuse an earlier plan whose prunable entries match this one's, so repeated dry-runs
// converge on a single stable plan id (mirrors cleanup/reconcile plan reuse). Only the
// structural entry fields are fingerprinted; volatile fields (generatedAt) and the
// review-only skipped list do not affect reuse.
function matchingExistingRegistryPrunePlan(registryPath: string, plan: RegistryPrunePlan): RegistryPrunePlan | null {
  const plansDir = join(dirname(registryPath), "registry-prune-plans");
  if (!existsSync(plansDir)) return null;

  const filenames = readdirSync(plansDir).filter((name) => name.endsWith(".json")).sort().reverse();
  for (const filename of filenames) {
    const planPath = join(plansDir, filename);
    try {
      const candidate = JSON.parse(readFileSync(planPath, "utf8")) as RegistryPrunePlan;
      if (candidate.registryPath !== registryPath) continue;
      if (registryPrunePlanFingerprint(candidate) !== registryPrunePlanFingerprint(plan)) continue;
      return { ...candidate, planPath };
    } catch {
      continue;
    }
  }
  return null;
}

function registryPrunePlanFingerprint(plan: RegistryPrunePlan): string {
  return JSON.stringify(plan.entries.map((entry) => ({ name: entry.name, path: entry.path, scope: entry.scope })));
}

function writeRegistryPrunePlanFile(planPath: string, plan: RegistryPrunePlan): void {
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
}

function makeRegistryPrunePlanId(date: Date): string {
  return `registry-prune_${toIso(date).replace(/[-:]/g, "").replace("T", "_").replace("Z", "")}_${randomBytes(2).toString("hex")}`;
}

function registryPrunePlanPath(registryPath: string, planId: string): string {
  assertSafeGeneratedId(planId, "registry prune plan id");
  return join(dirname(registryPath), "registry-prune-plans", `${planId}.json`);
}

// Bind a loaded registry-prune plan to the request before any registry mutation,
// mirroring reconcile's assertReconcilePlanExecutable: the plan must declare the
// requested id, belong to the executing registry, and carry well-formed entries.
function assertRegistryPrunePlanExecutable(plan: RegistryPrunePlan, planId: string, registryPath: string): void {
  if (plan.planId !== planId) {
    throw new Error(`Registry prune plan id mismatch: plan file declares ${plan.planId}, requested ${planId}`);
  }
  if (plan.registryPath !== registryPath) {
    throw new Error(`Registry prune plan registry mismatch: plan was created for ${plan.registryPath}, executing ${registryPath}`);
  }
  if (!Array.isArray(plan.entries)) {
    throw new Error(`Registry prune plan entries are malformed: ${planId}`);
  }
  for (const entry of plan.entries) {
    if (!entry || typeof entry.name !== "string" || typeof entry.path !== "string") {
      throw new Error(`Registry prune plan entries are malformed: ${planId}`);
    }
  }
}

// Re-scan the registry after mutation and confirm every removed registration is gone.
// `ok` stays true only when none of them resurface; `remainingPrunable` counts any
// prunable registrations left registry-wide so the receipt reflects whether the
// registry is fully clean or other plans still have work.
function verifyRegistryPrune(registryPath: string, removed: RegistryPruneRemoval[]): RegistryPruneVerification {
  const live = classifyRegistryPruneFindings(registryPath);
  const stillPresent = removed.filter((entry) => live.some((item) => item.name === entry.name && item.path === entry.path));
  const remainingPrunable = live.filter((item) => item.status === "prune").length;
  return {
    ok: stillPresent.length === 0,
    remainingPrunable,
    detail:
      stillPresent.length === 0
        ? "removed registrations are gone; registry re-scan is clean of them"
        : `still registered after prune: ${stillPresent.map((entry) => entry.name).join(", ")}`
  };
}

// Snapshot the registry verbatim before mutation so the receipt's rollbackPath points
// at a restorable copy. The registry is always UTF-8 JSON, so a read/write round-trip
// reproduces it byte-for-byte and keeps file I/O consistent with the rest of the code.
function copyRegistrySnapshot(registryPath: string, rollbackPath: string): void {
  mkdirSync(dirname(rollbackPath), { recursive: true });
  writeFileSync(rollbackPath, readFileSync(registryPath, "utf8"));
}

function removal(name: string, path: string, scope: LedgerScope): RegistryPruneRemoval {
  return { name, path, scope };
}

function pruneKey(name: string, path: string): string {
  return JSON.stringify([name, path]);
}

function registryPruneReceiptPath(registryPath: string, planId: string): string {
  assertSafeGeneratedId(planId, "registry prune plan id");
  return join(dirname(registryPath), "registry-prune-receipts", `${planId}.json`);
}

function registryPruneRollbackPath(registryPath: string, planId: string): string {
  assertSafeGeneratedId(planId, "registry prune plan id");
  return join(dirname(registryPath), "registry-prune-rollbacks", `${planId}.json`);
}

function writeRegistryPruneReceiptFile(receiptPath: string, receipt: RegistryPruneReceipt): void {
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}
