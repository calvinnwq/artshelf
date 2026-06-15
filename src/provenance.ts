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

const ROOT_KINDS: ReadonlySet<string> = new Set<PathRootKind>(["repo", "ledger", "external"]);
const NODE_KINDS: ReadonlySet<string> = new Set<PathNodeKind>(["file", "directory", "other"]);

// Validate a provenance value carried on a record. Returns a list of problems
// (empty means well-formed). This is the line between a legacy row (no provenance
// field at all, which callers skip) and a malformed one: once provenance is present
// it must conform to the PathProvenance contract, including the rule that only
// `external` roots drop the reconstruct data (rootPath/relativePath).
export function validateProvenance(provenance: unknown): string[] {
  if (typeof provenance !== "object" || provenance === null) {
    return ["provenance must be an object"];
  }
  const value = provenance as Record<string, unknown>;
  const problems: string[] = [];

  if (typeof value.root !== "string" || !ROOT_KINDS.has(value.root)) {
    problems.push(`provenance.root is invalid: ${String(value.root)}`);
  }
  if (typeof value.basename !== "string" || value.basename.length === 0) {
    problems.push("provenance.basename must be a non-empty string");
  }
  if (typeof value.pathKind !== "string" || !NODE_KINDS.has(value.pathKind)) {
    problems.push(`provenance.pathKind is invalid: ${String(value.pathKind)}`);
  }
  if (value.rootPath !== null && typeof value.rootPath !== "string") {
    problems.push("provenance.rootPath must be a string or null");
  }
  if (value.relativePath !== null && typeof value.relativePath !== "string") {
    problems.push("provenance.relativePath must be a string or null");
  }

  // Reconstruct-data consistency: external paths cannot be rebuilt, so they carry
  // null rootPath/relativePath; repo/ledger paths must carry both to be remappable.
  if (value.root === "external") {
    if (value.rootPath !== null || value.relativePath !== null) {
      problems.push("provenance with external root must have null rootPath and relativePath");
    }
  } else if (value.root === "repo" || value.root === "ledger") {
    if (typeof value.rootPath !== "string" || typeof value.relativePath !== "string") {
      problems.push(`provenance with ${value.root} root requires rootPath and relativePath`);
    }
  }

  if (value.fingerprint !== undefined) {
    const fingerprint = value.fingerprint as Record<string, unknown> | null;
    if (typeof fingerprint !== "object" || fingerprint === null || typeof fingerprint.byteSize !== "number") {
      problems.push("provenance.fingerprint must have a numeric byteSize");
    }
  }

  return problems;
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
