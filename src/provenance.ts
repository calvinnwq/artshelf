import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PathFingerprint, PathNodeKind, PathProvenance, PathRootKind } from "./types.js";

export type ProvenanceContext = {
  ledgerPath: string;
};

// Capture reconcile-safe provenance for an absolute artifact path. The matched root
// plus the relative path against it is what survives a `shelf` -> `artshelf` or
// `.shelf` -> `.artshelf` rename: a future reconcile can rebuild the current path
// from the current root without Artshelf watching the filesystem. This reads the
// filesystem to classify the node and fingerprint files; it never mutates anything.
export function computeProvenance(targetPath: string, context: ProvenanceContext): PathProvenance {
  const absolute = resolve(targetPath);
  const ledgerRoot = resolve(dirname(context.ledgerPath));
  const repoRoot = findRepoRoot(ledgerRoot);
  const node = classifyNode(absolute);

  // Ledger-owned paths are the most specific root, so they win over the repo root:
  // trash/, plans/, and receipts/ all live under the ledger directory.
  if (isWithin(ledgerRoot, absolute)) {
    return reconstructable("ledger", ledgerRoot, absolute, node);
  }
  if (repoRoot && isWithin(repoRoot, absolute)) {
    return reconstructable("repo", repoRoot, absolute, node);
  }
  return {
    root: "external",
    rootPath: null,
    relativePath: null,
    basename: basename(absolute),
    pathKind: node.kind,
    ...(node.fingerprint ? { fingerprint: node.fingerprint } : {})
  };
}

function reconstructable(
  root: PathRootKind,
  rootPath: string,
  absolute: string,
  node: { kind: PathNodeKind; fingerprint?: PathFingerprint }
): PathProvenance {
  return {
    root,
    rootPath,
    relativePath: toPosix(relative(rootPath, absolute)),
    basename: basename(absolute),
    pathKind: node.kind,
    ...(node.fingerprint ? { fingerprint: node.fingerprint } : {})
  };
}

function findRepoRoot(ledgerRoot: string): string | null {
  const gitRoot = findGitRoot(ledgerRoot);
  if (gitRoot) return gitRoot;
  // No git checkout: a dotted ledger directory (.artshelf / .shelf) sits directly
  // inside its repo/folder, so the parent is the best repo-root candidate.
  if (basename(ledgerRoot).startsWith(".")) {
    const parent = dirname(ledgerRoot);
    return parent === ledgerRoot ? null : parent;
  }
  return null;
}

function findGitRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function classifyNode(absolute: string): { kind: PathNodeKind; fingerprint?: PathFingerprint } {
  try {
    const stats = statSync(absolute);
    if (stats.isFile()) return { kind: "file", fingerprint: { byteSize: stats.size } };
    if (stats.isDirectory()) return { kind: "directory" };
    return { kind: "other" };
  } catch {
    return { kind: "other" };
  }
}

function isWithin(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
