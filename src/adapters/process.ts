import { spawnSync } from "node:child_process";

export type InstallMode = "pipe" | "inherit";

export function installGlobalNpmPackage(packageSpec: string, mode: InstallMode): ReturnType<typeof spawnSync> {
  if (mode === "pipe") {
    return spawnSync("npm", ["install", "-g", packageSpec], { encoding: "utf8" });
  }
  return spawnSync("npm", ["install", "-g", packageSpec], { encoding: "utf8", stdio: "inherit" });
}
