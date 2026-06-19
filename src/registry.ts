import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { withPathLock } from "./locks.js";
import { now, toIso } from "./time.js";

export type LedgerScope = "repo" | "user" | "other";

export type LedgerRegistryEntry = {
  name: string;
  path: string;
  scope: LedgerScope;
  createdAt: string;
  updatedAt: string;
};

export type LedgerRegistry = {
  version: 1;
  ledgers: LedgerRegistryEntry[];
};

export type RegisterLedgerInput = {
  ledgerPath: string;
  name?: string | undefined;
  scope?: string | undefined;
  registryPath?: string | undefined;
};

export function defaultRegistryPath(): string {
  return process.env.ARTSHELF_REGISTRY ?? process.env.SHELF_REGISTRY ?? join(homedir(), ".artshelf", "ledgers.json");
}

export function normalizeRegistryPath(path?: string): string {
  return resolve(path ?? defaultRegistryPath());
}

export function readRegistry(registryPath = normalizeRegistryPath()): LedgerRegistry {
  if (!existsSync(registryPath)) return { version: 1, ledgers: [] };
  const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as Partial<LedgerRegistry>;
  if (parsed.version !== 1 || !Array.isArray(parsed.ledgers)) {
    throw new Error(`Invalid Artshelf ledger registry: ${registryPath}`);
  }
  return {
    version: 1,
    ledgers: parsed.ledgers.map((entry) => normalizeEntry(entry))
  };
}

export function listRegisteredLedgers(registryPath = normalizeRegistryPath()): LedgerRegistryEntry[] {
  return readRegistry(registryPath).ledgers;
}

export function registerLedger(input: RegisterLedgerInput): LedgerRegistryEntry {
  const registryPath = normalizeRegistryPath(input.registryPath);
  const ledgerPath = resolve(input.ledgerPath);
  return withRegistryLock(registryPath, () => {
    const registry = readRegistry(registryPath);
    const timestamp = toIso(now());
    const existingIndex = registry.ledgers.findIndex((entry) => entry.path === ledgerPath);
    const existing = existingIndex >= 0 ? registry.ledgers[existingIndex] : undefined;
    const name = normalizeName(input.name);
    const entry: LedgerRegistryEntry = {
      name: name ?? existing?.name ?? inferLedgerName(ledgerPath),
      path: ledgerPath,
      scope: input.scope ? assertScope(input.scope) : existing?.scope ?? inferLedgerScope(ledgerPath),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    };

    if (existingIndex >= 0) {
      registry.ledgers[existingIndex] = entry;
    } else {
      registry.ledgers.push(entry);
    }
    registry.ledgers.sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
    writeRegistry(registryPath, registry);
    return entry;
  });
}

export type RegistryRemovalTarget = { name: string; path: string };

// Remove registrations matching the given (name, path) targets, returning the entries
// actually removed. The approval-gated registry prune execute composes this under its
// own registry lock (re-entrant), so classification, rollback copy, mutation, and
// verification all stay inside one critical section. Matching on both name and path
// keeps removal precise when two registrations happen to share a path. The registry is
// only rewritten when something is actually removed, so a no-op target list is inert.
export function removeRegisteredLedgers(registryPath: string, targets: RegistryRemovalTarget[]): LedgerRegistryEntry[] {
  const normalized = normalizeRegistryPath(registryPath);
  return withRegistryLock(normalized, () => {
    const registry = readRegistry(normalized);
    const wanted = new Set(targets.map((target) => removalKey(target.name, resolve(target.path))));
    const removed: LedgerRegistryEntry[] = [];
    const kept: LedgerRegistryEntry[] = [];
    for (const entry of registry.ledgers) {
      if (wanted.has(removalKey(entry.name, entry.path))) removed.push(entry);
      else kept.push(entry);
    }
    if (removed.length > 0) writeRegistry(normalized, { version: 1, ledgers: kept });
    return removed;
  });
}

function removalKey(name: string, path: string): string {
  return JSON.stringify([name, path]);
}

function writeRegistry(registryPath: string, registry: LedgerRegistry): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  const tmpPath = `${registryPath}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(tmpPath, registryPath);
}

function withRegistryLock<T>(registryPath: string, fn: () => T): T {
  return withPathLock(registryPath, fn, "Artshelf ledger registry");
}

function normalizeEntry(entry: Partial<LedgerRegistryEntry>): LedgerRegistryEntry {
  if (!entry.name || !entry.path || !entry.scope || !entry.createdAt || !entry.updatedAt) {
    throw new Error("Invalid Artshelf ledger registry entry");
  }
  return {
    name: entry.name,
    path: resolve(entry.path),
    scope: assertScope(entry.scope),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
}

function normalizeName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  return trimmed ? trimmed : undefined;
}

function inferLedgerName(ledgerPath: string): string {
  const normalized = resolve(ledgerPath);
  if (normalized === join(homedir(), ".artshelf", "ledger.jsonl")) return "global";
  if (basename(dirname(normalized)) === ".artshelf") return basename(dirname(dirname(normalized))) || "repo";
  return basename(dirname(normalized)) || "ledger";
}

function inferLedgerScope(ledgerPath: string): LedgerScope {
  const normalized = resolve(ledgerPath);
  if (normalized.startsWith(join(homedir(), ".artshelf"))) return "user";
  if (basename(dirname(normalized)) === ".artshelf") return "repo";
  return "other";
}

function assertScope(scope: string): LedgerScope {
  if (scope === "repo" || scope === "user" || scope === "other") return scope;
  throw new Error(`Unknown ledger scope: ${scope}`);
}
