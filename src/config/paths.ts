import { homedir } from "node:os";
import { join } from "node:path";
import type { ArtshelfEnv } from "./env.js";

export function updateCachePath(env: ArtshelfEnv = process.env): string {
  return env.ARTSHELF_UPDATE_CACHE ?? join(homedir(), ".artshelf", "update-check.json");
}
