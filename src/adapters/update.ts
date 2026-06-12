import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  latestVersionOverride,
  noUpdateCheckTtlMs,
  updateCheckTtlMs,
  type ArtshelfEnv
} from "../config/env.js";
import { NO_UPDATE_CHECK_TTL_MS, UPDATE_CHECK_TTL_MS, VERSION, npmRegistryUrl } from "../config/package.js";
import { updateCachePath } from "../config/paths.js";

export type UpdateInfo = {
  current: string;
  latest: string;
  updateAvailable: boolean;
};

type UpdateCache = { latest: string | null };

export type UpdateAdapter = {
  getUpdateInfo(options: { force: boolean }): Promise<UpdateInfo | null>;
};

export type UpdateAdapterOptions = {
  currentVersion: string;
  registryUrl: string;
  env: ArtshelfEnv;
  now: () => number;
  cachePath: () => string;
  fileExists: (path: string) => boolean;
  readTextFile: (path: string) => string;
  writeTextFile: (path: string, contents: string) => void;
  ensureDirectory: (path: string) => void;
  fetchLatestVersion: (registryUrl: string) => Promise<string | null>;
};

export async function getUpdateInfo(options: { force: boolean }): Promise<UpdateInfo | null> {
  return createDefaultUpdateAdapter().getUpdateInfo(options);
}

export function createUpdateAdapter(options: UpdateAdapterOptions): UpdateAdapter {
  async function getUpdateInfo(optionsForCheck: { force: boolean }): Promise<UpdateInfo | null> {
    const latest = await getLatestVersion(optionsForCheck);
    if (!latest) return null;
    return {
      current: options.currentVersion,
      latest,
      updateAvailable: compareVersions(latest, options.currentVersion) > 0
    };
  }

  async function getLatestVersion(optionsForCheck: { force: boolean }): Promise<string | null> {
    const override = latestVersionOverride(options.env);
    if (override) return normalizeVersion(override);
    if (!optionsForCheck.force) {
      const cached = readUpdateCache();
      if (cached) return cached.latest;
    }
    const latest = await options.fetchLatestVersion(options.registryUrl);
    writeUpdateCache(latest);
    return latest;
  }

  function readUpdateCache(): UpdateCache | null {
    const cachePath = options.cachePath();
    if (!options.fileExists(cachePath)) return null;
    try {
      const cache = JSON.parse(options.readTextFile(cachePath));
      if (!("latest" in cache)) cache.latest = null;
      if (cache.latest !== null && typeof cache.latest !== "string") return null;
      if (typeof cache.checkedAt !== "number") return null;
      const latest = cache.latest === null ? null : normalizeVersion(cache.latest);
      const ttl = updateCacheTtlFor(latest);
      if (ttl < 0) return null;
      if (options.now() - cache.checkedAt > ttl) return null;
      return { latest };
    } catch {
      return null;
    }
  }

  function updateCacheTtlFor(latest: string | null): number {
    if (latest && compareVersions(latest, options.currentVersion) > 0) {
      return updateCheckTtlMs(options.env, UPDATE_CHECK_TTL_MS);
    }
    return noUpdateCheckTtlMs(options.env, NO_UPDATE_CHECK_TTL_MS);
  }

  function writeUpdateCache(latest: string | null): void {
    try {
      const cachePath = options.cachePath();
      const dir = dirname(cachePath);
      if (dir) {
        options.ensureDirectory(dir);
        options.writeTextFile(cachePath, `${JSON.stringify({ latest, checkedAt: options.now() }, null, 2)}\n`);
      }
    } catch {
      // Update checks should never affect normal CLI behavior.
    }
  }

  return { getUpdateInfo };
}

function createDefaultUpdateAdapter(): UpdateAdapter {
  const registryUrl = npmRegistryUrl();
  return createUpdateAdapter({
    currentVersion: VERSION,
    registryUrl,
    env: process.env,
    now: () => Date.now(),
    cachePath: () => updateCachePath(),
    fileExists: existsSync,
    readTextFile: (path) => readFileSync(path, "utf8"),
    writeTextFile: writeFileSync,
    ensureDirectory: (path) => mkdirSync(path, { recursive: true }),
    fetchLatestVersion: (url) => fetchLatestNpmVersion(url)
  });
}

async function fetchLatestNpmVersion(registryUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch(registryUrl, {
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
