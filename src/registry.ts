import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
  return process.env.ARTSHELF_REGISTRY ?? process.env.SHELF_REGISTRY ?? join(homedir(), ".shelf", "ledgers.json");
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

function writeRegistry(registryPath: string, registry: LedgerRegistry): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  const tmpPath = `${registryPath}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(tmpPath, registryPath);
}

function withRegistryLock<T>(registryPath: string, fn: () => T): T {
  mkdirSync(dirname(registryPath), { recursive: true });
  const lockPath = `${registryPath}.lock`;
  const deadline = Date.now() + 5000;
  const staleAfterMs = 30_000;
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      if (isStaleLock(lockPath, staleAfterMs)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for Artshelf ledger registry lock: ${registryPath}`);
      sleep(25);
    }
  }

  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isStaleLock(lockPath: string, staleAfterMs: number): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleAfterMs;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
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
  if (normalized === join(homedir(), ".shelf", "ledger.jsonl")) return "global";
  if (basename(dirname(normalized)) === ".shelf") return basename(dirname(dirname(normalized))) || "repo";
  return basename(dirname(normalized)) || "ledger";
}

function inferLedgerScope(ledgerPath: string): LedgerScope {
  const normalized = resolve(ledgerPath);
  if (normalized.startsWith(join(homedir(), ".shelf"))) return "user";
  if (basename(dirname(normalized)) === ".shelf") return "repo";
  return "other";
}

function assertScope(scope: string): LedgerScope {
  if (scope === "repo" || scope === "user" || scope === "other") return scope;
  throw new Error(`Unknown ledger scope: ${scope}`);
}
