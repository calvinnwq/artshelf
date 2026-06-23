import * as fs from "node:fs";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { shellArg } from "./shared/shell-quote.js";
import { ageOf, now as currentTime } from "./time.js";
import type { ArtshelfKind, ArtshelfRecord, ArtshelfStatus, CleanupAction, DueStatus, Retention } from "./types.js";

export type InspectNodeKind = "file" | "directory" | "other";
export type InspectExistence = "present" | "missing";

// Read-only recommendation buckets surfaced by `artshelf get <id> --inspect`. They
// describe the next safe action without ever mutating the ledger or filesystem.
export type InspectRecommendation = "keep" | "snooze" | "trash-safe" | "resolve-only" | "blocked";

export type InspectReport = {
  schemaVersion: 1;
  id: string;
  // The record's recorded path (what `get` prints). For trashed records this is the
  // original, now-empty location; `subjectPath` is what existence and size describe.
  path: string;
  subjectPath: string;
  kind: ArtshelfKind;
  owner: string;
  labels: string[];
  status: ArtshelfStatus;
  cleanup: CleanupAction;
  reason: string;
  existence: InspectExistence;
  nodeKind: InspectNodeKind | null;
  byteSize: number | null;
  byteSizeTruncated: boolean;
  age: string;
  retention: Retention;
  retainUntil: string | null;
  // Due classification for active records; null for terminal states where it is moot.
  dueState: DueStatus | null;
  recommendation: InspectRecommendation;
  nextAction: string;
};

export type InspectOptions = {
  now?: Date;
  ledgerPath: string;
};

const DIRECTORY_SIZE_MAX_ENTRIES = 10_000;

type StreamingDirectory = {
  readSync(): { name: string } | null;
  closeSync(): void;
};

const openDirectorySync = (fs as unknown as { opendirSync(path: string): StreamingDirectory }).opendirSync;

export function buildInspectReport(record: ArtshelfRecord, options: InspectOptions): InspectReport {
  const at = options.now ?? currentTime();
  const subjectPath = subjectPathOf(record);
  const node = describeNode(subjectPath, record.status === "active");
  const dueState = classifyDueState(record, at, node.existence);
  const { recommendation, nextAction } = recommend(record, node.existence, dueState, options.ledgerPath);

  return {
    schemaVersion: 1,
    id: record.id,
    path: record.path,
    subjectPath,
    kind: record.kind,
    owner: record.owner,
    labels: record.labels,
    status: record.status,
    cleanup: record.cleanup,
    reason: record.reason,
    existence: node.existence,
    nodeKind: node.nodeKind,
    byteSize: node.byteSize,
    byteSizeTruncated: node.byteSizeTruncated,
    age: ageOf(at, record.createdAt),
    retention: record.retention,
    retainUntil: record.retainUntil ?? null,
    dueState,
    recommendation,
    nextAction
  };
}

function subjectPathOf(record: ArtshelfRecord): string {
  if (record.status === "trashed" && record.targetPath) return record.targetPath;
  return record.path;
}

type NodeDescription = {
  existence: InspectExistence;
  nodeKind: InspectNodeKind | null;
  byteSize: number | null;
  byteSizeTruncated: boolean;
};

function describeNode(subjectPath: string, followSymlinkExistence = false): NodeDescription {
  if (followSymlinkExistence && !existsSync(subjectPath)) {
    return { existence: "missing", nodeKind: null, byteSize: null, byteSizeTruncated: false };
  }

  let stat: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number };
  try {
    stat = lstatSync(subjectPath);
  } catch {
    return { existence: "missing", nodeKind: null, byteSize: null, byteSizeTruncated: false };
  }

  if (stat.isSymbolicLink()) return { existence: "present", nodeKind: "other", byteSize: null, byteSizeTruncated: false };
  if (stat.isFile()) return { existence: "present", nodeKind: "file", byteSize: stat.size, byteSizeTruncated: false };
  if (stat.isDirectory()) {
    const size = directorySize(subjectPath);
    return { existence: "present", nodeKind: "directory", byteSize: size.bytes, byteSizeTruncated: size.truncated };
  }
  return { existence: "present", nodeKind: "other", byteSize: null, byteSizeTruncated: false };
}

// Bounded recursive size: sums regular-file bytes, never follows symlinks, and stops at
// a fixed entry budget so a pathological tree cannot stall a read-only inspect.
function directorySize(root: string): { bytes: number; truncated: boolean } {
  let total = 0;
  let visited = 0;
  let incomplete = false;
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;

    let entries: StreamingDirectory;
    try {
      entries = openDirectorySync(dir);
    } catch {
      incomplete = true;
      continue;
    }

    try {
      while (true) {
        let entry: { name: string } | null;
        try {
          entry = entries.readSync();
        } catch {
          incomplete = true;
          break;
        }
        if (entry === null) break;
        if (visited >= DIRECTORY_SIZE_MAX_ENTRIES) return { bytes: total, truncated: true };
        visited += 1;
        const child = join(dir, entry.name);
        let stat: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number };
        try {
          stat = lstatSync(child);
        } catch {
          incomplete = true;
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          stack.push(child);
          continue;
        }
        if (stat.isFile()) total += stat.size;
      }
    } finally {
      try {
        entries.closeSync();
      } catch {
        incomplete = true;
      }
    }
  }

  return { bytes: total, truncated: incomplete };
}

// Mirrors ledger due classification, but reuses the existence already observed so a
// trashed/terminal record never re-stats. Only active records carry a due state.
function classifyDueState(record: ArtshelfRecord, at: Date, existence: InspectExistence): DueStatus | null {
  if (record.status !== "active") return null;
  if (existence === "missing") return "missing-path";
  if (record.disposeAction === "keep" && record.disposePlanId && record.disposeReceiptPath && record.disposedAt) return "kept";
  if (record.retention.mode === "manual-review") return "manual-review";
  if (!record.retainUntil) return "due";
  return new Date(record.retainUntil).getTime() <= at.getTime() ? "due" : "kept";
}

function recommend(
  record: ArtshelfRecord,
  existence: InspectExistence,
  dueState: DueStatus | null,
  ledgerPath: string
): { recommendation: InspectRecommendation; nextAction: string } {
  const idArg = shellArg(record.id);
  const ledgerArg = shellArg(ledgerPath);
  const disposeDryRun = (action: string, extra = ""): string => `artshelf dispose --id ${idArg} --action ${action} --dry-run${extra} --ledger ${ledgerArg}`;
  if (record.status === "resolved") {
    return { recommendation: "keep", nextAction: "Already resolved — no action needed." };
  }
  if (record.status === "trashed") {
    if (existence === "missing") {
      return {
        recommendation: "resolve-only",
        nextAction: `Trashed target is missing — confirm the artifact is gone, then run \`artshelf resolve ${idArg} --ledger ${ledgerArg} --status resolved --reason '<why>'\` (ledger-only).`
      };
    }
    return {
      recommendation: "keep",
      nextAction: "Already trashed — permanent removal is the separate approval-gated `artshelf trash purge` flow."
    };
  }
  if (record.status === "review-required") {
    return {
      recommendation: "blocked",
      nextAction: "A cleanup run flagged this for manual review — inspect the artifact, then resolve or re-plan deliberately."
    };
  }
  if (record.status === "cleanup-refused") {
    return {
      recommendation: "blocked",
      nextAction: "A prior cleanup refused this record — handle it manually; Artshelf will not retry automatically."
    };
  }

  if (existence === "missing" || dueState === "missing-path") {
    return {
      recommendation: "resolve-only",
      nextAction: `Path is missing — confirm the artifact is gone, then run \`${disposeDryRun("resolve-only", " --reason '<why>'")}\`, then approve the reviewed plan id.`
    };
  }
  if (dueState === "kept") {
    return {
      recommendation: "snooze",
      nextAction: `Retention holds until ${record.retainUntil ?? "the configured date"} — re-inspect after it expires; nothing is due now.`
    };
  }
  if (dueState === "manual-review") {
    return {
      recommendation: "keep",
      nextAction: `Held for manual review — run \`${disposeDryRun("keep", " --reason '<why>'")}\` to keep it quiet through a reviewed decision, or choose resolve-only/snooze deliberately.`
    };
  }
  if (record.cleanup === "trash") {
    return {
      recommendation: "trash-safe",
      nextAction: `Due and disposable after review — run \`${disposeDryRun("trash-resolve", " --reason '<why>'")}\`, then approve the reviewed plan id.`
    };
  }
  if (record.cleanup === "delete") {
    return {
      recommendation: "blocked",
      nextAction: "Due with cleanup=delete, which Artshelf refuses — switch it to cleanup=trash and plan a cleanup, or resolve it manually."
    };
  }
  return {
    recommendation: "keep",
    nextAction: `Due and held for review — run \`${disposeDryRun("keep", " --reason '<why>'")}\`, or choose resolve-only/snooze deliberately.`
  };
}
