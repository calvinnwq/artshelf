import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertSafeGeneratedId } from "./ledger.js";
import { listRegisteredLedgers, normalizeRegistryPath } from "./registry.js";
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
