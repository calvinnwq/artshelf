import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { NO_UPDATE_CHECK_TTL_MS, UPDATE_CHECK_TTL_MS, VERSION, npmRegistryUrl } from "../config/package.js";

export type UpdateInfo = {
  current: string;
  latest: string;
  updateAvailable: boolean;
};

export async function getUpdateInfo(options: { force: boolean }): Promise<UpdateInfo | null> {
  const latest = await getLatestVersion(options);
  if (!latest) return null;
  return {
    current: VERSION,
    latest,
    updateAvailable: compareVersions(latest, VERSION) > 0
  };
}

async function getLatestVersion(options: { force: boolean }): Promise<string | null> {
  const override = process.env.ARTSHELF_LATEST_VERSION;
  if (override) return normalizeVersion(override);
  if (!options.force) {
    const cached = readUpdateCache();
    if (cached) return cached.latest;
  }
  const latest = await fetchLatestNpmVersion();
  writeUpdateCache(latest);
  return latest;
}

function readUpdateCache(): { latest: string | null } | null {
  const cachePath = updateCachePath();
  if (!existsSync(cachePath)) return null;
  try {
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    if (!("latest" in cache)) cache.latest = null;
    if (cache.latest !== null && typeof cache.latest !== "string") return null;
    if (typeof cache.checkedAt !== "number") return null;
    const latest = cache.latest === null ? null : normalizeVersion(cache.latest);
    const ttl = updateCacheTtlFor(latest);
    if (ttl < 0) return null;
    if (Date.now() - cache.checkedAt > ttl) return null;
    return { latest };
  } catch {
    return null;
  }
}

function updateCacheTtlFor(latest: string | null): number {
  if (latest && compareVersions(latest, VERSION) > 0) {
    return resolveTtlMs(process.env.ARTSHELF_UPDATE_CHECK_TTL_MS, UPDATE_CHECK_TTL_MS);
  }
  return resolveTtlMs(
    process.env.ARTSHELF_NO_UPDATE_CHECK_TTL_MS ?? process.env.ARTSHELF_UPDATE_CHECK_TTL_MS,
    NO_UPDATE_CHECK_TTL_MS
  );
}

function resolveTtlMs(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function writeUpdateCache(latest: string | null): void {
  try {
    const cachePath = updateCachePath();
    const dir = dirname(cachePath);
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(cachePath, `${JSON.stringify({ latest, checkedAt: Date.now() }, null, 2)}\n`);
    }
  } catch {
    // Update checks should never affect normal CLI behavior.
  }
}

async function fetchLatestNpmVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch(npmRegistryUrl(), {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": `artshelf/${VERSION}` }
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body || typeof body !== "object" || typeof (body as { version?: unknown }).version !== "string") return null;
    return normalizeVersion((body as { version: string }).version);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function updateCachePath(): string {
  return process.env.ARTSHELF_UPDATE_CACHE ?? join(homedir(), ".artshelf", "update-check.json");
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const diff = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function parseVersion(version: string): { numbers: number[]; prerelease: string } {
  const [main = "", prerelease = ""] = normalizeVersion(version).split("-", 2);
  return {
    numbers: main.split(".").map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }),
    prerelease
  };
}
