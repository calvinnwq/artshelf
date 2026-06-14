import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const heldLocks = new Map<string, number>();

/**
 * Run `fn` while holding a cross-process advisory lock for `targetPath`.
 *
 * The lock is a sibling `${targetPath}.lock` directory; `mkdir` is atomic across
 * processes, so only one holder proceeds at a time. A stale lock is reclaimed
 * after `staleAfterMs`, and acquisition gives up after the deadline so a crashed
 * holder cannot block forever.
 *
 * Locks are re-entrant within a single process: nested calls for the same path
 * reuse the existing lock instead of deadlocking on the directory they created.
 */
export function withPathLock<T>(targetPath: string, fn: () => T, label = "Artshelf"): T {
  const key = resolve(targetPath);
  const depth = heldLocks.get(key) ?? 0;
  if (depth > 0) {
    heldLocks.set(key, depth + 1);
    try {
      return fn();
    } finally {
      const next = (heldLocks.get(key) ?? 1) - 1;
      if (next > 0) heldLocks.set(key, next);
      else heldLocks.delete(key);
    }
  }

  mkdirSync(dirname(key), { recursive: true });
  const lockPath = `${key}.lock`;
  const deadline = Date.now() + 5000;
  const staleAfterMs = 30_000;
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      if (isStaleLock(lockPath, staleAfterMs)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label} lock: ${key}`);
      sleep(25);
    }
  }

  heldLocks.set(key, 1);
  try {
    return fn();
  } finally {
    heldLocks.delete(key);
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isStaleLock(lockPath: string, staleAfterMs: number): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleAfterMs;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}
