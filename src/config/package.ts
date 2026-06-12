import { readFileSync } from "node:fs";

export const PACKAGE_NAME = "artshelf";
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const NO_UPDATE_CHECK_TTL_MS = 60 * 60 * 1000;
export const VERSION = readPackageVersion();

export function npmRegistryUrl(): string {
  return process.env.ARTSHELF_NPM_REGISTRY_URL ?? `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
}

export function readPackageVersion(): string {
  const packageJsonPath = decodeURIComponent(new URL("../../../package.json", import.meta.url).pathname);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json version must be a string");
  }
  return packageJson.version;
}
