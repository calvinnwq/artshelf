import { lstatSync } from "node:fs";

export type ArtifactIdentityFacts =
  | {
      exists: true;
      nodeKind: "file" | "directory" | "symlink" | "other";
      dev: number;
      ino: number;
      mode: number;
      size: number;
      mtimeMs: number;
      ctimeMs: number;
    }
  | {
      exists: false;
      nodeKind: "missing";
    };

export function artifactIdentityFacts(path: string): ArtifactIdentityFacts {
  try {
    const stats = lstatSync(path);
    return {
      exists: true,
      nodeKind: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "other",
      dev: stats.dev,
      ino: stats.ino,
      mode: stats.mode,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs
    };
  } catch {
    return { exists: false, nodeKind: "missing" };
  }
}

export function sameArtifactIdentityFacts(left: ArtifactIdentityFacts, right: ArtifactIdentityFacts): boolean {
  if (left.exists !== right.exists || left.nodeKind !== right.nodeKind) return false;
  if (!left.exists || !right.exists) return true;
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
