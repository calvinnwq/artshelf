export type ArtshelfEnv = Record<string, string | undefined>;

export function latestVersionOverride(env: ArtshelfEnv = process.env): string | undefined {
  return env.ARTSHELF_LATEST_VERSION;
}

// Optional configured trusted base URL for Artshelf UI review links (Artshelf UI v1 contract).
// When set, `artshelf ui` surfaces a capability-protected remote link agents can post to their
// own channel; when unset, the command states the dashboard must be opened on the host machine
// rather than emitting a dead localhost link. Trailing slashes are trimmed for clean joins.
export function uiLinkBaseUrl(env: ArtshelfEnv = process.env): string | null {
  const raw = (env.ARTSHELF_UI_URL ?? "").trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
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
