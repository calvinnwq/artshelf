export type ArtshelfEnv = Record<string, string | undefined>;

export function latestVersionOverride(env: ArtshelfEnv = process.env): string | undefined {
  return env.ARTSHELF_LATEST_VERSION;
}

export function npmRegistryUrlFromEnv(packageName: string, env: ArtshelfEnv = process.env): string {
  return env.ARTSHELF_NPM_REGISTRY_URL ?? `https://registry.npmjs.org/${packageName}/latest`;
}

export function updateCheckDisabled(env: ArtshelfEnv = process.env): boolean {
  return env.ARTSHELF_NO_UPDATE_CHECK === "1";
}

export function updateDryRunEnabled(env: ArtshelfEnv = process.env): boolean {
  return env.ARTSHELF_UPDATE_DRY_RUN === "1";
}

export function updateCheckTtlMs(env: ArtshelfEnv, fallback: number): number {
  return resolveTtlMs(env.ARTSHELF_UPDATE_CHECK_TTL_MS, fallback);
}

export function noUpdateCheckTtlMs(env: ArtshelfEnv, fallback: number): number {
  return resolveTtlMs(env.ARTSHELF_NO_UPDATE_CHECK_TTL_MS ?? env.ARTSHELF_UPDATE_CHECK_TTL_MS, fallback);
}

function resolveTtlMs(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
