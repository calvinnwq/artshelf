import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createDisposePlan, disposePlanEntryDigest, readDisposePlanEntry } from "../src/dispose.js";
import { artifactIdentityFacts } from "../src/file-identity.js";
import { groupPurgeCandidates, purgeApprovalTargets, PURGE_APPROVAL_ACTION } from "../src/dashboard.js";
import type { DashboardTrashRow } from "../src/dashboard.js";
import { readLedger } from "../src/ledger.js";
import { appendEvent, readApprovalSnapshot, readSession, readSessionHistory, replyToEvent, writeApprovalSnapshot } from "../src/session.js";
import type { UiApprovalTarget } from "../src/types.js";

// End-to-end tests for the Artshelf UI v1 AXI command surface (NGX-532). The agent loop -
// start/resume, poll, reply, end - is driven through the built CLI exactly as an agent would
// run it, with browser-submitted events simulated through the in-process session API. Each test
// uses an isolated ARTSHELF_UI_HOME so resume matching never leaks across cases.

const CLI = new URL("../src/cli.js", import.meta.url);

function freshHome(): string {
  return join(mkdtempSync(join(tmpdir(), "artshelf-ui-cmd-")), "ui");
}

function ui(home: string, args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI.pathname, ...args], {
    encoding: "utf8",
    env: { ...process.env, ARTSHELF_NO_UPDATE_CHECK: "1", ARTSHELF_UI_HOME: home, ...env }
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function serveSession(home: string, args: string[] = [], env: Record<string, string> = {}): Promise<any> {
  const child = spawn(process.execPath, [CLI.pathname, "ui", "serve", "--port", "0", ...args, "--json"], {
    env: { ...process.env, ARTSHELF_NO_UPDATE_CHECK: "1", ARTSHELF_UI_HOME: home, ...env }
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let settled = false;
  return new Promise((resolve, reject) => {
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`ui serve timed out before launch packet: ${stderr}`)));
    }, 5000);
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const line = stdout.split("\n").find((entry) => entry.trim().length > 0);
      if (!line) return;
      finish(() => resolve(JSON.parse(line)));
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => finish(() => reject(error)));
    child.on("exit", (code: number | null) => {
      if (!settled) finish(() => reject(new Error(`ui serve exited before launch packet (${code}): ${stderr}`)));
    });
  });
}

type ManagedReviewProcess = {
  child: any;
  packet: any;
  lines: () => string[];
  stderr: () => string;
  waitForExit: () => Promise<{ code: number | null; signal: string | null }>;
  stop: () => Promise<void>;
};

function managedReview(home: string, args: string[] = [], env: Record<string, string> = {}): Promise<ManagedReviewProcess> {
  const intervalArgs = args.includes("--poll-interval-ms") ? [] : ["--poll-interval-ms", "25"];
  const child = spawn(process.execPath, [CLI.pathname, "ui", "review", "--port", "0", ...intervalArgs, ...args, "--json"], {
    env: { ...process.env, ARTSHELF_NO_UPDATE_CHECK: "1", ARTSHELF_UI_HOME: home, ...env }
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let settled = false;
  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("exit", (code: number | null, signal: string | null) => resolve({ code, signal }));
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`ui review timed out before launch packet: ${stderr}`));
    }, 5000);
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const line = stdout.split("\n").find((entry) => entry.trim().length > 0);
      if (!line || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        child,
        packet: JSON.parse(line),
        lines: () => stdout.split("\n").filter((entry) => entry.trim().length > 0),
        stderr: () => stderr,
        waitForExit: () => exitPromise,
        stop: async () => {
          if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
          await exitPromise;
        }
      });
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code: number | null) => {
      if (!settled) {
        clearTimeout(timer);
        reject(new Error(`ui review exited before launch packet (${code}): ${stderr}`));
      }
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(predicate(), true, "condition was not met before timeout");
}

async function postClose(url: string, token: string): Promise<any> {
  return fetch(`${url}/close`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    redirect: "manual"
  });
}

function startSession(home: string, args: string[] = [], env: Record<string, string> = {}): any {
  const result = ui(home, ["ui", ...args, "--json"], env);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function sampleTargets(): UiApprovalTarget[] {
  return [
    {
      targetId: "shf_a",
      ledgerPath: "/srv/ledgers/a/.artshelf/ledger.jsonl",
      registryPath: null,
      recordPath: "/tmp/a",
      planId: "plan_a",
      actionType: "trash-resolve",
      label: "trash scratch a"
    },
    {
      targetId: "shf_b",
      ledgerPath: "/srv/ledgers/b/.artshelf/ledger.jsonl",
      registryPath: null,
      recordPath: "/tmp/b",
      planId: "plan_b",
      actionType: "trash-resolve",
      label: "trash scratch b"
    }
  ];
}

test("artshelf ui starts a durable, token-protected user session and prints a compact packet", () => {
  const home = freshHome();
  const packet = startSession(home);

  assert.equal(packet.ok, true);
  assert.equal(packet.command, "ui");
  assert.match(packet.session.id, /^session_/);
  assert.equal(packet.session.scope, "user");
  assert.equal(packet.session.status, "active");
  assert.equal(packet.session.ledgerPath, null);
  assert.ok(typeof packet.token === "string" && packet.token.length >= 32, "token should be unguessable");
  assert.match(packet.poll, /artshelf ui poll session_/);

  // Compact JSON is a single line (agent-optimized), not pretty-printed.
  const raw = ui(home, ["ui", "--json"]).stdout;
  assert.equal(raw.trim().split("\n").length, 1, "ui --json must emit one compact line");

  assert.equal(existsSync(join(home, "sessions", packet.session.id, "session.json")), true);
});

test("artshelf ui resumes the active session instead of creating a second one", () => {
  const home = freshHome();
  const first = startSession(home);
  const second = startSession(home);

  assert.equal(second.session.id, first.session.id);
  assert.equal(readdirSync(join(home, "sessions")).length, 1);
});

test("artshelf ui and ui serve share the default registry-scoped session", async () => {
  const home = freshHome();
  const registryPath = join(mkdtempSync(join(tmpdir(), "artshelf-ui-cmd-registry-")), "ledgers.json");
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify({ version: 1, ledgers: [] })}\n`);
  const env = { ARTSHELF_REGISTRY: registryPath };

  const started = startSession(home, [], env);
  assert.equal(started.session.registryPath, registryPath);
  const served = await serveSession(home, [], env);

  assert.equal(served.session.id, started.session.id);
  assert.equal(readdirSync(join(home, "sessions")).length, 1);
});

test("artshelf ui review owns the serve/poll/reply/end lifecycle", async () => {
  const home = freshHome();
  const managed = await managedReview(home);
  try {
    assert.equal(managed.packet.ok, true);
    assert.equal(managed.packet.command, "ui-review-start");
    assert.match(managed.packet.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    assert.match(managed.packet.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(managed.packet.session.status, "active");

    const sessionId = managed.packet.session.id;
    const event = appendEvent(home, sessionId, {
      type: "comment_added",
      target: { recordId: "shf_1", ledgerPath: "/srv/ledgers/a/.artshelf/ledger.jsonl" },
      payload: { text: "human note from managed review" }
    });

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id);
      return entry?.event.status === "completed" && entry.replies.some((reply) => reply.status === "in_progress");
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id)!;
    assert.deepEqual(entry.replies.map((reply) => reply.status), ["in_progress", "completed"]);
    assert.match(String(entry.replies.at(-1)?.payload.note), /recorded for audit/i);

    const close = await postClose(managed.packet.baseUrl, managed.packet.token);
    assert.equal(close.status, 303);

    const exit = await managed.waitForExit();
    assert.equal(exit.code, 0, managed.stderr());
    assert.equal(readSession(home, sessionId).status, "ended");

    const finalLine = managed.lines().map((line) => JSON.parse(line)).find((line) => line.command === "ui-review-end");
    assert.equal(finalLine.ok, true);
    assert.equal(finalLine.sessionId, sessionId);
    assert.equal(finalLine.processed.completed, 1);
    assert.equal(finalLine.processed.closed, 1);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review rejects broad execution-shaped browser requests without mutating", async () => {
  const home = freshHome();
  const managed = await managedReview(home);
  try {
    const sessionId = managed.packet.session.id;
    const event = appendEvent(home, sessionId, {
      type: "session_note_added",
      payload: { command: "artshelf cleanup --execute --all" }
    });

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id);
      return entry?.event.status === "rejected";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id)!;
    assert.deepEqual(entry.replies.map((reply) => reply.status), ["in_progress", "rejected"]);
    assert.match(String(entry.replies.at(-1)?.payload.reason), /exact approval/i);
    assert.match(String(entry.replies.at(-1)?.payload.refused), /--all/i);

    const close = await postClose(managed.packet.baseUrl, managed.packet.token);
    assert.equal(close.status, 303);
    const exit = await managed.waitForExit();
    assert.equal(exit.code, 0, managed.stderr());
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review refuses --all before starting a managed lifecycle", () => {
  const home = freshHome();
  const result = ui(home, ["ui", "review", "--all", "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ui review --all/i);
});

test("artshelf ui review executes a browser-approved exact bundle through the ui execute core", async () => {
  const home = freshHome();
  const { ledger, subject, trashTarget, planId } = repoWithReviewedTrashPlan("shf_managed");
  const registryPath = registryWithLedgers([ledger]);
  const managed = await managedReview(home, [], { ARTSHELF_REGISTRY: registryPath });
  try {
    const sessionId = managed.packet.session.id;
    const snapshot = seedApprovedBundle(home, sessionId, [bundleTarget("shf_managed", ledger, subject, { planId })], ["shf_managed"], registryPath);

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.target.bundleId === snapshot.id);
      return entry?.event.status === "completed";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.target.bundleId === snapshot.id)!;
    const receipts = entry.replies.at(-1)!.payload as Record<string, any>;
    assert.equal(receipts.executionStatus, "executed");
    assert.equal(receipts.receipts[0].targetId, "shf_managed");
    assert.equal(receipts.receipts[0].outcome, "executed");
    // The mutation ran through the approval-gated dispose path and live state confirms it.
    assert.equal(readLedger(ledger).find((record) => record.id === "shf_managed")?.status, "trashed");
    assert.equal(existsSync(subject), false);
    assert.equal(existsSync(trashTarget), true);

    const close = await postClose(managed.packet.baseUrl, managed.packet.token);
    assert.equal(close.status, 303);
    const exit = await managed.waitForExit();
    assert.equal(exit.code, 0, managed.stderr());
    const finalLine = managed.lines().map((line) => JSON.parse(line)).find((line) => line.command === "ui-review-end");
    assert.equal(finalLine.processed.completed, 1);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review replies stale with revalidation receipts for a drifted bundle", async () => {
  const home = freshHome();
  // The live ledger no longer holds either approved subject: the whole bundle is stale.
  const ledger = join(mkdtempSync(join(tmpdir(), "artshelf-ui-review-stale-")), ".artshelf", "ledger.jsonl");
  writeLedgerFile(ledger, [ledgerRecord("shf_keep", "/subjects/keep")]);
  const registryPath = registryWithLedgers([ledger]);
  const managed = await managedReview(home, [], { ARTSHELF_REGISTRY: registryPath });
  try {
    const sessionId = managed.packet.session.id;
    const targets = [bundleTarget("shf_a", ledger, "/subjects/a"), bundleTarget("shf_b", ledger, "/subjects/b")];
    const snapshot = seedApprovedBundle(home, sessionId, targets, ["shf_a", "shf_b"], registryPath);

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.target.bundleId === snapshot.id);
      return entry !== undefined && entry.event.status !== "pending" && entry.event.status !== "in_progress";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.target.bundleId === snapshot.id)!;
    assert.equal(entry.event.status, "stale");
    const payload = entry.replies.at(-1)!.payload as Record<string, any>;
    assert.equal(payload.executionStatus, "refused");
    assert.deepEqual(payload.receipts.map((receipt: { outcome: string }) => receipt.outcome), ["skipped_stale", "skipped_stale"]);
    // Nothing mutated: the unrelated live record is untouched.
    assert.equal(readLedger(ledger).find((record) => record.id === "shf_keep")?.status, "active");
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review turns an exact decision intent into a reviewed dry-run plan reply", async () => {
  const home = freshHome();
  const repo = mkdtempSync(join(tmpdir(), "artshelf-ui-review-decision-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const subject = join(repo, "shf_decision.tar");
  writeFileSync(subject, "payload");
  writeLedgerFile(ledger, [ledgerRecord("shf_decision", subject)]);
  const registryPath = registryWithLedgers([ledger]);
  const managed = await managedReview(home, [], { ARTSHELF_REGISTRY: registryPath });
  try {
    const sessionId = managed.packet.session.id;
    const event = appendEvent(home, sessionId, {
      type: "decision_submitted",
      target: { recordId: "shf_decision", ledgerPath: ledger },
      payload: { decision: "trash", reason: "superseded export" }
    });

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id);
      return entry?.event.status === "completed";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id)!;
    assert.deepEqual(entry.replies.map((reply) => reply.status), ["in_progress", "completed"]);
    const payload = entry.replies.at(-1)!.payload as Record<string, any>;
    assert.equal(payload.kind, "dispose_dry_run");
    const planId = String(payload.planId);
    assert.match(planId, /\S/);
    // The reviewed plan is real and binds the exact record + action; no mutation ran.
    const plan = readDisposePlanEntry(ledger, planId);
    assert.equal(plan.id, "shf_decision");
    assert.equal(plan.action, "trash-resolve");
    assert.equal(payload.action, "trash-resolve");
    assert.deepEqual(payload.records, ["shf_decision"]);
    assert.equal(payload.approvalTarget, `approve artshelf dispose ledger ${ledger} plan ${planId}`);
    assert.equal(readLedger(ledger).find((record) => record.id === "shf_decision")?.status, "active");
    assert.equal(existsSync(subject), true);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review prepares a reviewed plan from an exact dry-run request", async () => {
  const home = freshHome();
  const repo = mkdtempSync(join(tmpdir(), "artshelf-ui-review-dryrun-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const subject = join(repo, "shf_dryrun.tar");
  writeFileSync(subject, "payload");
  writeLedgerFile(ledger, [ledgerRecord("shf_dryrun", subject)]);
  const registryPath = registryWithLedgers([ledger]);
  const managed = await managedReview(home, [], { ARTSHELF_REGISTRY: registryPath });
  try {
    const sessionId = managed.packet.session.id;
    const event = appendEvent(home, sessionId, {
      type: "dry_run_requested",
      target: { recordId: "shf_dryrun", ledgerPath: ledger },
      payload: { request: "prepare a dispose plan" }
    });

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id);
      return entry?.event.status === "completed";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id)!;
    const payload = entry.replies.at(-1)!.payload as Record<string, any>;
    assert.equal(payload.kind, "dispose_dry_run");
    const planId = String(payload.planId);
    assert.match(planId, /\S/);
    const plan = readDisposePlanEntry(ledger, planId);
    assert.equal(plan.id, "shf_dryrun");
    assert.equal(plan.action, "keep");
    assert.equal(payload.action, "keep");
    assert.deepEqual(payload.records, ["shf_dryrun"]);
    assert.equal(payload.approvalTarget, `approve artshelf dispose ledger ${ledger} plan ${planId}`);
    assert.equal(readLedger(ledger).find((record) => record.id === "shf_dryrun")?.status, "active");
    assert.equal(existsSync(subject), true);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review reports the resolved snooze action for defer decisions", async () => {
  const home = freshHome();
  const repo = mkdtempSync(join(tmpdir(), "artshelf-ui-review-defer-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const subject = join(repo, "shf_defer.tar");
  writeFileSync(subject, "payload");
  writeLedgerFile(ledger, [ledgerRecord("shf_defer", subject, { reason: "review after migration completes" })]);
  const registryPath = registryWithLedgers([ledger]);
  const managed = await managedReview(home, [], { ARTSHELF_REGISTRY: registryPath });
  try {
    const sessionId = managed.packet.session.id;
    const event = appendEvent(home, sessionId, {
      type: "decision_submitted",
      target: { recordId: "shf_defer", ledgerPath: ledger },
      payload: { decision: "defer" }
    });

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id);
      return entry?.event.status === "completed";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id)!;
    const payload = entry.replies.at(-1)!.payload as Record<string, any>;
    const plan = readDisposePlanEntry(ledger, String(payload.planId));
    assert.equal(plan.action, "snooze");
    assert.equal(payload.action, "snooze");
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review prepares a purge approval workbench from a lane dry-run request", async () => {
  const home = freshHome();
  const repo = mkdtempSync(join(tmpdir(), "artshelf-ui-review-purge-lane-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const target = join(repo, ".artshelf", "trash", "shf_purge.tar");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "payload");
  writeLedgerFile(ledger, [
    ledgerRecord("shf_purge", join(repo, "shf_purge.tar"), {
      status: "trashed",
      targetPath: target,
      cleanedAt: "2026-01-02T00:00:00.000Z",
      cleanupPlanId: "plan_cleanup",
      receiptPath: join(repo, ".artshelf", "receipts", "plan_cleanup.json")
    })
  ]);
  const registryPath = registryWithLedgers([ledger]);
  const managed = await managedReview(home, [], { ARTSHELF_REGISTRY: registryPath });
  try {
    const sessionId = managed.packet.session.id;
    const event = appendEvent(home, sessionId, {
      type: "dry_run_requested",
      target: { lane: "purge-candidates", registryPath },
      payload: { request: "review_delete_forever", label: "Review delete", count: 1 }
    });

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id);
      return entry?.event.status === "completed";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id)!;
    const payload = entry.replies.at(-1)!.payload as Record<string, any>;
    assert.equal(payload.kind, "purge_review_prepared");
    assert.doesNotMatch(String(payload.next), /artshelf ui bundle/);
    assert.match(String(payload.next), /browser activity link/);
    const snapshot = readApprovalSnapshot(home, sessionId, String(payload.bundleId));
    assert.equal(snapshot.actionType, "trash-purge");
    assert.equal(snapshot.targets.length, 1);
    assert.deepEqual(snapshot.selectedTargetIds, []);
    assert.deepEqual(snapshot.reviewed, {});
    assert.equal(existsSync(target), true);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review cleanup lane plans only validated dashboard cleanup rows", async () => {
  const home = freshHome();
  const repo = mkdtempSync(join(tmpdir(), "artshelf-ui-review-cleanup-lane-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const subject = join(repo, "shf_cleanup.tar");
  const hiddenSubject = join(repo, "shf_hidden.tar");
  writeFileSync(subject, "payload");
  writeFileSync(hiddenSubject, "payload");
  writeLedgerFile(ledger, [
    ledgerRecord("shf_cleanup", subject, {
      reason: "release archive is no longer needed",
      retention: { mode: "ttl", ttl: "1d" },
      retainUntil: "2026-01-02T00:00:00.000Z",
      cleanup: "trash"
    })
  ]);
  const missingLedger = join(mkdtempSync(join(tmpdir(), "artshelf-ui-review-cleanup-missing-")), ".artshelf", "missing.jsonl");
  const registryPath = registryWithLedgers([ledger, missingLedger]);
  const managed = await managedReview(home, ["--poll-interval-ms", "1500"], { ARTSHELF_REGISTRY: registryPath });
  try {
    const sessionId = managed.packet.session.id;
    const event = appendEvent(home, sessionId, {
      type: "dry_run_requested",
      target: { lane: "cleanup", registryPath },
      payload: {
        request: "prepare_cleanup_plan",
        label: "Prepare cleanup",
        count: 1,
        reviewedRows: [reviewedCleanupRow("shf_cleanup", ledger, subject)]
      }
    });
    writeLedgerFile(ledger, [
      ledgerRecord("shf_cleanup", subject, {
        reason: "release archive is no longer needed",
        retention: { mode: "ttl", ttl: "1d" },
        retainUntil: "2026-01-02T00:00:00.000Z",
        cleanup: "trash"
      }),
      ledgerRecord("shf_hidden", hiddenSubject, {
        reason: "became due after the cleanup lane request was submitted",
        retention: { mode: "ttl", ttl: "1d" },
        retainUntil: "2026-01-02T00:00:00.000Z",
        cleanup: "trash"
      })
    ]);

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id);
      return entry?.event.status === "completed";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id)!;
    const payload = entry.replies.at(-1)!.payload as Record<string, any>;
    assert.equal(payload.kind, "cleanup_dry_run");
    assert.equal(payload.count, 1);
    assert.equal(payload.plans.length, 1);
    assert.equal(payload.plans[0].ledgerPath, ledger);
    assert.equal(payload.plans[0].count, 1);
    const planId = String(payload.plans[0].planId);
    const plan = JSON.parse(readFileSync(join(dirname(ledger), "plans", `${planId}.json`), "utf8"));
    assert.deepEqual(plan.entries.map((planEntry: Record<string, unknown>) => planEntry.id), ["shf_cleanup"]);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review validates all cleanup ledgers before writing plan artifacts", async () => {
  const home = freshHome();
  const firstRepo = mkdtempSync(join(tmpdir(), "artshelf-ui-review-cleanup-atomic-first-"));
  const secondRepo = mkdtempSync(join(tmpdir(), "artshelf-ui-review-cleanup-atomic-second-"));
  mkdirSync(join(firstRepo, ".git"), { recursive: true });
  mkdirSync(join(secondRepo, ".git"), { recursive: true });
  const firstLedger = join(firstRepo, ".artshelf", "ledger.jsonl");
  const secondLedger = join(secondRepo, ".artshelf", "ledger.jsonl");
  const firstSubject = join(firstRepo, "shf_first.tar");
  const secondSubject = join(secondRepo, "shf_second.tar");
  const changedSecondSubject = join(secondRepo, "shf_second_changed.tar");
  writeFileSync(firstSubject, "first");
  writeFileSync(secondSubject, "second");
  writeFileSync(changedSecondSubject, "changed");
  writeLedgerFile(firstLedger, [
    ledgerRecord("shf_first", firstSubject, {
      reason: "first reviewed cleanup row",
      retention: { mode: "ttl", ttl: "1d" },
      retainUntil: "2026-01-02T00:00:00.000Z",
      cleanup: "trash"
    })
  ]);
  writeLedgerFile(secondLedger, [
    ledgerRecord("shf_second", secondSubject, {
      reason: "second reviewed cleanup row",
      retention: { mode: "ttl", ttl: "1d" },
      retainUntil: "2026-01-02T00:00:00.000Z",
      cleanup: "trash"
    })
  ]);
  const registryPath = registryWithLedgers([firstLedger, secondLedger]);
  const managed = await managedReview(home, ["--poll-interval-ms", "1500"], { ARTSHELF_REGISTRY: registryPath });
  try {
    const sessionId = managed.packet.session.id;
    const event = appendEvent(home, sessionId, {
      type: "dry_run_requested",
      target: { lane: "cleanup", registryPath },
      payload: {
        request: "prepare_cleanup_plan",
        label: "Prepare cleanup",
        count: 2,
        reviewedRows: [
          reviewedCleanupRow("shf_first", firstLedger, firstSubject),
          reviewedCleanupRow("shf_second", secondLedger, secondSubject)
        ]
      }
    });
    writeLedgerFile(secondLedger, [
      ledgerRecord("shf_second", changedSecondSubject, {
        reason: "second reviewed cleanup row changed before handling",
        retention: { mode: "ttl", ttl: "1d" },
        retainUntil: "2026-01-02T00:00:00.000Z",
        cleanup: "trash"
      })
    ]);

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id);
      return entry?.event.status === "stale";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id)!;
    const payload = entry.replies.at(-1)!.payload as Record<string, any>;
    assert.match(String(payload.reason), /changed/i);
    assert.equal(existsSync(join(dirname(firstLedger), "plans")), false);
    assert.equal(existsSync(join(dirname(secondLedger), "plans")), false);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review rejects cleanup rows whose reviewed facts changed", async () => {
  const home = freshHome();
  const repo = mkdtempSync(join(tmpdir(), "artshelf-ui-review-cleanup-stale-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const subject = join(repo, "shf_cleanup.tar");
  const changedSubject = join(repo, "shf_cleanup_changed.tar");
  writeFileSync(subject, "payload");
  writeFileSync(changedSubject, "payload");
  writeLedgerFile(ledger, [
    ledgerRecord("shf_cleanup", subject, {
      reason: "release archive is no longer needed",
      retention: { mode: "ttl", ttl: "1d" },
      retainUntil: "2026-01-02T00:00:00.000Z",
      cleanup: "trash"
    })
  ]);
  const registryPath = registryWithLedgers([ledger]);
  const managed = await managedReview(home, ["--poll-interval-ms", "1500"], { ARTSHELF_REGISTRY: registryPath });
  try {
    const sessionId = managed.packet.session.id;
    const event = appendEvent(home, sessionId, {
      type: "dry_run_requested",
      target: { lane: "cleanup", registryPath },
      payload: {
        request: "prepare_cleanup_plan",
        label: "Prepare cleanup",
        count: 1,
        reviewedRows: [reviewedCleanupRow("shf_cleanup", ledger, subject)]
      }
    });
    writeLedgerFile(ledger, [
      ledgerRecord("shf_cleanup", changedSubject, {
        reason: "release archive is no longer needed",
        retention: { mode: "ttl", ttl: "1d" },
        retainUntil: "2026-01-02T00:00:00.000Z",
        cleanup: "trash"
      })
    ]);

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id);
      return entry?.event.status === "stale";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id)!;
    const payload = entry.replies.at(-1)!.payload as Record<string, any>;
    assert.match(String(payload.reason), /changed/i);
    assert.equal(existsSync(join(dirname(ledger), "plans")), false);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review rejects cleanup rows whose reviewed file identity changed", async () => {
  const home = freshHome();
  const repo = mkdtempSync(join(tmpdir(), "artshelf-ui-review-cleanup-file-stale-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const subject = join(repo, "shf_cleanup.tar");
  writeFileSync(subject, "payload");
  writeLedgerFile(ledger, [
    ledgerRecord("shf_cleanup", subject, {
      reason: "release archive is no longer needed",
      retention: { mode: "ttl", ttl: "1d" },
      retainUntil: "2026-01-02T00:00:00.000Z",
      cleanup: "trash"
    })
  ]);
  const registryPath = registryWithLedgers([ledger]);
  const managed = await managedReview(home, ["--poll-interval-ms", "1500"], { ARTSHELF_REGISTRY: registryPath });
  try {
    const sessionId = managed.packet.session.id;
    const event = appendEvent(home, sessionId, {
      type: "dry_run_requested",
      target: { lane: "cleanup", registryPath },
      payload: {
        request: "prepare_cleanup_plan",
        label: "Prepare cleanup",
        count: 1,
        reviewedRows: [reviewedCleanupRow("shf_cleanup", ledger, subject)]
      }
    });
    rmSync(subject);
    writeFileSync(subject, "replacement payload");

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id);
      return entry?.event.status === "stale";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id)!;
    const payload = entry.replies.at(-1)!.payload as Record<string, any>;
    assert.match(String(payload.reason), /changed/i);
    assert.equal(existsSync(join(dirname(ledger), "plans")), false);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review completes source-check lane dry-runs with problem details", async () => {
  const home = freshHome();
  const missingLedger = join(mkdtempSync(join(tmpdir(), "artshelf-ui-review-source-lane-")), ".artshelf", "missing.jsonl");
  const registryPath = registryWithLedgers([missingLedger]);
  const managed = await managedReview(home, [], { ARTSHELF_REGISTRY: registryPath });
  try {
    const sessionId = managed.packet.session.id;
    const event = appendEvent(home, sessionId, {
      type: "dry_run_requested",
      target: { lane: "registry-reconcile", registryPath },
      payload: { request: "check_source_problems", label: "Check sources", count: 1 }
    });

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id);
      return entry?.event.status === "completed";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id)!;
    const payload = entry.replies.at(-1)!.payload as Record<string, any>;
    assert.equal(payload.kind, "source_check");
    assert.equal(payload.count, 2);
    assert.equal(payload.invalidLedgers[0].path, missingLedger);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review completes resolve lane dry-runs with missing-file details", async () => {
  const home = freshHome();
  const repo = mkdtempSync(join(tmpdir(), "artshelf-ui-review-resolve-lane-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const missing = join(repo, "missing.tar");
  writeLedgerFile(ledger, [ledgerRecord("shf_missing", missing, { reason: "release archive can be resolved after upload" })]);
  const registryPath = registryWithLedgers([ledger]);
  const managed = await managedReview(home, [], { ARTSHELF_REGISTRY: registryPath });
  try {
    const sessionId = managed.packet.session.id;
    const event = appendEvent(home, sessionId, {
      type: "dry_run_requested",
      target: { lane: "resolve", registryPath },
      payload: { request: "check_missing_files", label: "Check missing files", count: 1 }
    });

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id);
      return entry?.event.status === "completed";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id)!;
    const payload = entry.replies.at(-1)!.payload as Record<string, any>;
    assert.equal(payload.kind, "missing_file_check");
    assert.equal(payload.count, 1);
    assert.equal(payload.records[0].recordId, "shf_missing");
    assert.equal(payload.records[0].ledgerPath, ledger);
    assert.equal(payload.records[0].path, missing);
    assert.equal(payload.records[0].recommendation, "resolve-only");
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review supplies a safe default reason for resolve decisions", async () => {
  const home = freshHome();
  // resolve-only without a reason is blocked by the dispose safety engine.
  const ledger = join(mkdtempSync(join(tmpdir(), "artshelf-ui-review-blocked-")), ".artshelf", "ledger.jsonl");
  writeLedgerFile(ledger, [ledgerRecord("shf_blocked", "/subjects/blocked")]);
  const registryPath = registryWithLedgers([ledger]);
  const managed = await managedReview(home, [], { ARTSHELF_REGISTRY: registryPath });
  try {
    const sessionId = managed.packet.session.id;
    const event = appendEvent(home, sessionId, {
      type: "decision_submitted",
      target: { recordId: "shf_blocked", ledgerPath: ledger },
      payload: { decision: "resolve" }
    });

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id);
      return entry?.event.status === "completed";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === event.id)!;
    const payload = entry.replies.at(-1)!.payload as Record<string, any>;
    const plan = readDisposePlanEntry(ledger, String(payload.planId));
    assert.equal(plan.action, "resolve-only");
    assert.match(plan.reason, /Artshelf UI review/i);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review resumes the existing session and drains the backlog", async () => {
  const home = freshHome();
  const session = startSession(home).session;
  // Submitted while no manager was attached: the backlog a resume must drain.
  const backlog = appendEvent(home, session.id, {
    type: "comment_added",
    target: { recordId: "shf_backlog", ledgerPath: "/srv/ledgers/a/.artshelf/ledger.jsonl" },
    payload: { text: "queued before the manager attached" }
  });

  const managed = await managedReview(home);
  try {
    assert.equal(managed.packet.session.id, session.id, "ui review must resume the active session, not mint a new one");
    await waitUntil(() => {
      const entry = readSessionHistory(home, session.id).find((item) => item.event.id === backlog.id);
      return entry?.event.status === "completed";
    });
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review close cancels still-pending work with visible cancelled replies", async () => {
  const home = freshHome();
  const managed = await managedReview(home, ["--poll-interval-ms", "1500"]);
  try {
    const sessionId = managed.packet.session.id;
    // Queue the close first, then more work behind it inside the same poll window: the close must
    // win and the trailing event must end cancelled, not silently stranded pending.
    const close = await postClose(managed.packet.baseUrl, managed.packet.token);
    assert.equal(close.status, 303);
    const trailing = appendEvent(home, sessionId, {
      type: "comment_added",
      target: { recordId: "shf_trailing", ledgerPath: "/srv/ledgers/a/.artshelf/ledger.jsonl" },
      payload: { text: "submitted while the close was queued" }
    });

    const exit = await managed.waitForExit();
    assert.equal(exit.code, 0, managed.stderr());
    assert.equal(readSession(home, sessionId).status, "ended");
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === trailing.id)!;
    assert.equal(entry.event.status, "cancelled");
    assert.match(String(entry.replies.at(-1)?.payload.reason), /clos/i);
    const finalLine = managed.lines().map((line) => JSON.parse(line)).find((line) => line.command === "ui-review-end");
    assert.equal(finalLine.processed.cancelled, 1);
    assert.equal(finalLine.processed.closed, 1);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review signal teardown cancels pending work and ends the session promptly", async () => {
  const home = freshHome();
  // A deliberately long poll interval: if the signal did NOT interrupt the sleep, teardown could not
  // finish until the interval elapsed. The generous threshold below still proves interruption while
  // tolerating CPU contention from the rest of the suite.
  const pollIntervalMs = 20_000;
  const session = startSession(home).session;
  const settled = appendEvent(home, session.id, {
    type: "comment_added",
    target: { recordId: "shf_settled", ledgerPath: "/srv/ledgers/a/.artshelf/ledger.jsonl" },
    payload: { text: "processed before the interrupt" }
  });
  const managed = await managedReview(home, ["--poll-interval-ms", String(pollIntervalMs)]);
  try {
    const sessionId = managed.packet.session.id;
    assert.equal(sessionId, session.id);
    await waitUntil(() => readSessionHistory(home, sessionId).find((item) => item.event.id === settled.id)?.event.status === "completed");

    const pending = appendEvent(home, sessionId, {
      type: "comment_added",
      target: { recordId: "shf_interrupted", ledgerPath: "/srv/ledgers/a/.artshelf/ledger.jsonl" },
      payload: { text: "submitted while the manager slept, right before the interrupt" }
    });

    const killedAt = Date.now();
    managed.child.kill("SIGTERM");
    const exit = await managed.waitForExit();
    assert.equal(exit.code, 0, managed.stderr());
    assert.ok(Date.now() - killedAt < pollIntervalMs / 2, "signal teardown must interrupt the poll sleep instead of waiting it out");
    assert.equal(readSession(home, sessionId).status, "ended");
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === pending.id)!;
    assert.equal(entry.event.status, "cancelled");
    const finalLine = managed.lines().map((line) => JSON.parse(line)).find((line) => line.command === "ui-review-end");
    assert.equal(finalLine.reason, "signal:SIGTERM");
    assert.equal(finalLine.processed.cancelled, 1);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review refuses to start when it cannot bind the requested port", async () => {
  const home = freshHome();
  const managed = await managedReview(home);
  try {
    const conflicting = ui(freshHome(), ["ui", "review", "--port", String(managed.packet.port), "--json"]);
    assert.notEqual(conflicting.status, 0, "a manager that cannot bind must refuse, not present the browser as live");
    assert.doesNotMatch(conflicting.stdout, /ui-review-start/);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review keeps handling submissions across multiple rounds in one session", async () => {
  const home = freshHome();
  const managed = await managedReview(home);
  try {
    const sessionId = managed.packet.session.id;
    const first = appendEvent(home, sessionId, {
      type: "comment_added",
      target: { recordId: "shf_first", ledgerPath: "/srv/ledgers/a/.artshelf/ledger.jsonl" },
      payload: { text: "first submission" }
    });
    await waitUntil(() => readSessionHistory(home, sessionId).find((item) => item.event.id === first.id)?.event.status === "completed");

    // A SECOND submission arrives only after the first was replied: the loop must keep polling and
    // handle it in the same live session, not stop after one round.
    const second = appendEvent(home, sessionId, {
      type: "comment_added",
      target: { recordId: "shf_second", ledgerPath: "/srv/ledgers/a/.artshelf/ledger.jsonl" },
      payload: { text: "second submission after the first reply" }
    });
    await waitUntil(() => readSessionHistory(home, sessionId).find((item) => item.event.id === second.id)?.event.status === "completed");
    const secondEntry = readSessionHistory(home, sessionId).find((item) => item.event.id === second.id)!;
    assert.deepEqual(secondEntry.replies.map((reply) => reply.status), ["in_progress", "completed"]);

    const close = await postClose(managed.packet.baseUrl, managed.packet.token);
    assert.equal(close.status, 303);
    const exit = await managed.waitForExit();
    assert.equal(exit.code, 0, managed.stderr());
    const finalLine = managed.lines().map((line) => JSON.parse(line)).find((line) => line.command === "ui-review-end");
    assert.equal(finalLine.processed.completed, 2);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review replies failed with per-target receipts on a partial bundle run", async () => {
  const home = freshHome();
  const { ledger, subject, planId } = repoWithReviewedTrashPlan("shf_live");
  const registryPath = registryWithLedgers([ledger]);
  const managed = await managedReview(home, [], { ARTSHELF_REGISTRY: registryPath });
  try {
    const sessionId = managed.packet.session.id;
    const liveTarget = bundleTarget("shf_live", ledger, subject, { planId });
    // shf_gone was approved but is no longer in the live ledger: the bundle runs partially.
    const goneTarget = bundleTarget("shf_gone", ledger, join(dirname(dirname(ledger)), "gone.tar"));
    const snapshot = seedApprovedBundle(home, sessionId, [liveTarget, goneTarget], ["shf_live", "shf_gone"], registryPath);

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.target.bundleId === snapshot.id);
      return entry !== undefined && entry.event.status !== "pending" && entry.event.status !== "in_progress";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.target.bundleId === snapshot.id)!;
    // A partial run is never presented as done: the rolled-up managed status is failed.
    assert.equal(entry.event.status, "failed");
    const payload = entry.replies.at(-1)!.payload as Record<string, any>;
    assert.equal(payload.executionStatus, "partial");
    const outcomes = Object.fromEntries(payload.receipts.map((receipt: { targetId: string; outcome: string }) => [receipt.targetId, receipt.outcome]));
    assert.equal(outcomes.shf_live, "executed");
    assert.equal(outcomes.shf_gone, "skipped_stale");
    // The still-exact target really executed; the stale one was left untouched.
    assert.equal(readLedger(ledger).find((record) => record.id === "shf_live")?.status, "trashed");
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review cancels an orphaned in_progress event at teardown instead of stranding it", async () => {
  const home = freshHome();
  const managed = await managedReview(home);
  try {
    const sessionId = managed.packet.session.id;
    // An event a crashed prior run left claimed but never finished: pollPendingEvents skips it
    // (in_progress, not pending), so only teardown can reach it. It must not be left dangling forever.
    const orphan = appendEvent(home, sessionId, {
      type: "comment_added",
      target: { recordId: "shf_orphan", ledgerPath: "/srv/ledgers/a/.artshelf/ledger.jsonl" },
      payload: { text: "claimed by a prior run that died before replying" }
    });
    replyToEvent(home, sessionId, orphan.id, {
      status: "in_progress",
      expectedStatus: "pending",
      payload: { note: "orphaned in_progress claim" }
    });

    const close = await postClose(managed.packet.baseUrl, managed.packet.token);
    assert.equal(close.status, 303);
    const exit = await managed.waitForExit();
    assert.equal(exit.code, 0, managed.stderr());
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.id === orphan.id)!;
    assert.equal(entry.event.status, "cancelled");
    assert.match(String(entry.replies.at(-1)?.payload.reason), /clos/i);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review tears down visibly when its session is ended out from under it", async () => {
  const home = freshHome();
  const managed = await managedReview(home, ["--poll-interval-ms", "1500"]);
  try {
    const sessionId = managed.packet.session.id;
    // Another process ends the session (e.g. `artshelf ui end`). The manager must stop presenting the
    // browser as live and tear down with an explicit reason rather than idling forever.
    const ended = ui(home, ["ui", "end", sessionId, "--json"]);
    assert.equal(ended.status, 0, ended.stderr);

    const exit = await managed.waitForExit();
    assert.equal(exit.code, 0, managed.stderr());
    assert.equal(readSession(home, sessionId).status, "ended");
    const finalLine = managed.lines().map((line) => JSON.parse(line)).find((line) => line.command === "ui-review-end");
    assert.equal(finalLine.reason, "session-ended");
    // The server is really gone after teardown.
    const reachable = await fetch(`${managed.packet.baseUrl}/healthz`).then(() => true).catch(() => false);
    assert.equal(reachable, false);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui review reserves a trash-purge bundle for explicit ui execute", async () => {
  const home = freshHome();
  const { ledger, targetPath } = repoWithPurgeCandidate("shf_purge");
  const registryPath = registryWithLedgers([ledger]);
  const managed = await managedReview(home, [], { ARTSHELF_REGISTRY: registryPath });
  try {
    const sessionId = managed.packet.session.id;
    const targets = purgeApprovalTargets(groupPurgeCandidates([purgeRow("shf_purge", ledger, targetPath)]));
    const selectedTargetId = targets[0]!.targetId;
    const snapshot = writeApprovalSnapshot(home, sessionId, { actionType: PURGE_APPROVAL_ACTION, targets, selectedTargetIds: [selectedTargetId], reviewed: {} });
    appendEvent(home, sessionId, {
      type: "approval_bundle_submitted",
      target: { bundleId: snapshot.id },
      payload: {
        bundleId: snapshot.id,
        actionType: snapshot.actionType,
        fingerprint: snapshot.fingerprint,
        registryPath,
        selectedTargetIds: snapshot.selectedTargetIds,
        selectedCount: 1,
        targetCount: 1
      }
    });

    await waitUntil(() => {
      const entry = readSessionHistory(home, sessionId).find((item) => item.event.target.bundleId === snapshot.id);
      return entry?.event.status === "in_progress";
    });
    const entry = readSessionHistory(home, sessionId).find((item) => item.event.target.bundleId === snapshot.id)!;
    assert.equal(entry.event.status, "in_progress");
    assert.equal(entry.replies.at(-1)?.payload.bundleId, snapshot.id);
    assert.equal(entry.replies.at(-1)?.payload.fingerprint, snapshot.fingerprint);
    assert.match(String(entry.replies.at(-1)?.payload.next), /ui execute/i);

    const close = await postClose(managed.packet.baseUrl, managed.packet.token);
    assert.equal(close.status, 303);
    const exit = await managed.waitForExit();
    assert.equal(exit.code, 0, managed.stderr());
    const reserved = readSessionHistory(home, sessionId).find((item) => item.event.target.bundleId === snapshot.id)!;
    assert.equal(reserved.event.status, "in_progress");

    const execute = ui(home, ["ui", "execute", sessionId, snapshot.id, "--json"], { ARTSHELF_REGISTRY: registryPath });
    assert.equal(execute.status, 0, execute.stderr);
    assert.doesNotMatch(execute.stderr, /requires a pending or in_progress event/i);
    assert.equal(existsSync(targetPath), false);
  } finally {
    await managed.stop();
  }
});

test("artshelf ui --scope repo and --ledger open sessions distinct from the multi-ledger default", () => {
  const home = freshHome();
  const multi = startSession(home);
  const repo = startSession(home, ["--scope", "repo"]);
  const scoped = startSession(home, ["--ledger", "/srv/ledgers/a/.artshelf/ledger.jsonl"]);

  assert.equal(repo.session.scope, "repo");
  assert.notEqual(repo.session.id, multi.session.id);
  assert.equal(repo.poll, `artshelf ui poll ${repo.session.id} --scope repo --json`);

  assert.equal(scoped.session.ledgerPath, "/srv/ledgers/a/.artshelf/ledger.jsonl");
  assert.notEqual(scoped.session.id, multi.session.id);
  assert.equal(readdirSync(join(home, "sessions")).length, 3);
});

test("artshelf ui rejects an unknown --scope value", () => {
  const home = freshHome();
  const result = ui(home, ["ui", "--scope", "global", "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /scope/i);
});

test("artshelf ui poll returns an empty queue for a session with no browser events", () => {
  const home = freshHome();
  const session = startSession(home).session;

  const result = ui(home, ["ui", "poll", session.id, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.ok, true);
  assert.equal(packet.command, "ui-poll");
  assert.equal(packet.sessionId, session.id);
  assert.equal(packet.pending, 0);
  assert.deepEqual(packet.events, []);
});

test("artshelf ui poll surfaces pending browser events compactly", () => {
  const home = freshHome();
  const session = startSession(home).session;

  // The browser records a decision through the durable session layer.
  const event = appendEvent(home, session.id, {
    type: "comment_added",
    target: { recordId: "shf_1", ledgerPath: "/srv/ledgers/a/.artshelf/ledger.jsonl" },
    payload: { text: "looks stale" }
  });

  const packet = JSON.parse(ui(home, ["ui", "poll", session.id, "--json"]).stdout);
  assert.equal(packet.pending, 1);
  assert.equal(packet.events.length, 1);
  assert.equal(packet.events[0].id, event.id);
  assert.equal(packet.events[0].type, "comment_added");
  assert.equal(packet.events[0].status, "pending");
  assert.equal(packet.events[0].target.recordId, "shf_1");
});

test("artshelf ui reply advances an event and clears it from the poll queue", () => {
  const home = freshHome();
  const session = startSession(home).session;
  const event = appendEvent(home, session.id, {
    type: "dry_run_requested",
    target: { recordId: "shf_plan", ledgerPath: "/srv/ledgers/a/.artshelf/ledger.jsonl" }
  });

  const reply = JSON.parse(
    ui(home, [
      "ui",
      "reply",
      session.id,
      "--event",
      event.id,
      "--status",
      "completed",
      "--payload",
      '{"receipt":"executed","planId":"plan_a"}',
      "--json"
    ]).stdout
  );

  assert.equal(reply.ok, true);
  assert.equal(reply.command, "ui-reply");
  assert.match(reply.reply.id, /^reply_/);
  assert.equal(reply.reply.eventId, event.id);
  assert.equal(reply.event.status, "completed");

  const after = JSON.parse(ui(home, ["ui", "poll", session.id, "--json"]).stdout);
  assert.equal(after.pending, 0);
});

test("artshelf ui reply rejects a missing --event, an invalid --status, and an unknown event", () => {
  const home = freshHome();
  const session = startSession(home).session;
  const event = appendEvent(home, session.id, {
    type: "comment_added",
    target: { recordId: "shf_1", ledgerPath: "/srv/ledgers/a/.artshelf/ledger.jsonl" },
    payload: { text: "hi" }
  });

  const missingEvent = ui(home, ["ui", "reply", session.id, "--status", "completed", "--json"]);
  assert.notEqual(missingEvent.status, 0);
  assert.match(missingEvent.stderr, /--event/);

  const badStatus = ui(home, ["ui", "reply", session.id, "--event", event.id, "--status", "donezo", "--json"]);
  assert.notEqual(badStatus.status, 0);
  assert.match(badStatus.stderr, /status/i);

  const pendingStatus = ui(home, ["ui", "reply", session.id, "--event", event.id, "--status", "pending", "--json"]);
  assert.notEqual(pendingStatus.status, 0);
  assert.match(pendingStatus.stderr, /acknowledged/);

  const unknownEvent = ui(home, ["ui", "reply", session.id, "--event", "event_nope", "--status", "completed", "--json"]);
  assert.notEqual(unknownEvent.status, 0);
  assert.match(unknownEvent.stderr, /event_nope/);
});

test("artshelf ui reply rejects a non-object --payload", () => {
  const home = freshHome();
  const session = startSession(home).session;
  const event = appendEvent(home, session.id, {
    type: "comment_added",
    target: { recordId: "shf_1", ledgerPath: "/srv/ledgers/a/.artshelf/ledger.jsonl" },
    payload: { text: "hi" }
  });

  const result = ui(home, ["ui", "reply", session.id, "--event", event.id, "--status", "completed", "--payload", "not-json", "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /payload/i);
});

test("artshelf ui end revokes the session and a fresh ui starts a new one", () => {
  const home = freshHome();
  const session = startSession(home).session;

  const ended = JSON.parse(ui(home, ["ui", "end", session.id, "--json"]).stdout);
  assert.equal(ended.ok, true);
  assert.equal(ended.command, "ui-end");
  assert.equal(ended.session.status, "ended");
  assert.match(ended.session.endedAt, /^\d{4}-\d{2}-\d{2}T/);

  // The ended session stays readable (audit/resume), so poll still answers.
  assert.equal(ui(home, ["ui", "poll", session.id, "--json"]).status, 0);

  // A new `ui` does not resume the ended session.
  const next = startSession(home);
  assert.notEqual(next.session.id, session.id);
});

test("artshelf ui prints a human summary without --json", () => {
  const home = freshHome();
  const start = ui(home, ["ui"]);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /session session_/);
  assert.match(start.stdout, /active/);

  const session = startSession(home).session;
  appendEvent(home, session.id, {
    type: "comment_added",
    target: { recordId: "shf_1", ledgerPath: "/srv/ledgers/a/.artshelf/ledger.jsonl" },
    payload: { text: "review me" }
  });
  const poll = ui(home, ["ui", "poll", session.id]);
  assert.equal(poll.status, 0, poll.stderr);
  assert.match(poll.stdout, /1 pending/);
});

test("artshelf ui rejects an unknown subcommand", () => {
  const home = freshHome();
  const result = ui(home, ["ui", "wat"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ui/);
});

test("artshelf ui help surfaces the agent loop and nested help is focused", () => {
  const home = freshHome();

  const family = ui(home, ["ui", "--help"]);
  assert.equal(family.status, 0, family.stderr);
  assert.match(family.stdout, /Usage:/);
  for (const sub of ["review", "poll", "reply", "bundle", "execute", "end"]) assert.match(family.stdout, new RegExp(`\\b${sub}\\b`));

  const execute = ui(home, ["ui", "execute", "--help"]);
  assert.equal(execute.status, 0, execute.stderr);
  assert.match(execute.stdout, /artshelf ui execute/);
  assert.match(execute.stdout, /revalidate/i);
  assert.doesNotMatch(execute.stdout, /Available Commands:/);

  const poll = ui(home, ["help", "ui", "poll"]);
  assert.equal(poll.status, 0, poll.stderr);
  assert.match(poll.stdout, /artshelf ui poll/);
  assert.doesNotMatch(poll.stdout, /Available Commands:/);

  const bundle = ui(home, ["ui", "bundle", "--help"]);
  assert.equal(bundle.status, 0, bundle.stderr);
  assert.match(bundle.stdout, /artshelf ui bundle/);
  assert.match(bundle.stdout, /revalidate live state before execution/);
  assert.doesNotMatch(bundle.stdout, /Available Commands:/);

  const reply = ui(home, ["ui", "reply", "--help"]);
  assert.equal(reply.status, 0, reply.stderr);
  assert.match(reply.stdout, /artshelf ui reply/);
  assert.match(reply.stdout, /--event/);
  assert.match(reply.stdout, /--status/);

  const review = ui(home, ["help", "ui", "review"]);
  assert.equal(review.status, 0, review.stderr);
  assert.match(review.stdout, /artshelf ui review/);
  assert.match(review.stdout, /in_progress/);
  assert.match(review.stdout, /ui review --all/);
  assert.doesNotMatch(review.stdout, /Available Commands:/);

  const top = ui(home, ["help"]);
  assert.match(top.stdout, /\n\s+ui\s+\S/);
});

test("artshelf ui bundle loads a persisted approval bundle as agent-facing JSON", () => {
  const home = freshHome();
  const session = startSession(home).session;
  // A reviewed bundle is approved in the browser and persisted via the session storage seam.
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: sampleTargets(),
    selectedTargetIds: ["shf_a"],
    reviewed: { planId: "plan_a", total: 2 }
  });

  const packet = JSON.parse(ui(home, ["ui", "bundle", session.id, snapshot.id, "--json"]).stdout);
  assert.equal(packet.ok, true);
  assert.equal(packet.command, "ui-bundle");
  assert.equal(packet.sessionId, session.id);
  // The full immutable snapshot is echoed unchanged: this is the agent's revalidation input.
  assert.deepEqual(packet.bundle, snapshot);
  // The deliberate selection is resolved to its exact target rows so the agent need not re-derive it.
  assert.equal(packet.selected.length, 1);
  assert.equal(packet.selected[0].targetId, "shf_a");
  assert.equal(packet.selected[0].recordPath, "/tmp/a");
});

test("artshelf ui bundle lists every approved bundle for a session and is empty when none exist", () => {
  const home = freshHome();
  const session = startSession(home).session;

  const empty = JSON.parse(ui(home, ["ui", "bundle", session.id, "--json"]).stdout);
  assert.equal(empty.ok, true);
  assert.equal(empty.command, "ui-bundle-list");
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.bundles, []);

  const first = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: sampleTargets(),
    selectedTargetIds: ["shf_a"],
    reviewed: { planId: "plan_a", total: 2 }
  });
  const second = writeApprovalSnapshot(home, session.id, {
    actionType: "resolve-only",
    targets: sampleTargets(),
    selectedTargetIds: ["shf_a", "shf_b"],
    reviewed: { planId: "plan_b", total: 2 }
  });

  const listed = JSON.parse(ui(home, ["ui", "bundle", session.id, "--json"]).stdout);
  assert.equal(listed.count, 2);
  const ids = listed.bundles.map((bundle: { id: string }) => bundle.id);
  assert.ok(ids.includes(first.id) && ids.includes(second.id));
  // The list is a compact discovery summary carrying selected/reviewed counts per bundle.
  const secondRow = listed.bundles.find((bundle: { id: string }) => bundle.id === second.id);
  assert.equal(secondRow.actionType, "resolve-only");
  assert.equal(secondRow.selectedCount, 2);
  assert.equal(secondRow.targetCount, 2);
  assert.equal(secondRow.fingerprint, second.fingerprint);
});

test("artshelf ui bundle prints a deliberate-approval human summary, not an execution", () => {
  const home = freshHome();
  const session = startSession(home).session;
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: sampleTargets(),
    selectedTargetIds: ["shf_a"],
    reviewed: { planId: "plan_a", total: 2 }
  });

  const out = ui(home, ["ui", "bundle", session.id, snapshot.id]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(snapshot.id));
  assert.match(out.stdout, /trash-resolve/);
  // The exact approved subset is stated as "N of M", never a blanket approve-all.
  assert.match(out.stdout, /1 of 2/);
  assert.match(out.stdout, /trash scratch a/);
  // It is an approval record, not an execution: the human surface says to revalidate first.
  assert.match(out.stdout, /revalidate/i);
});

test("artshelf ui bundle rejects a missing session id and an unknown bundle id", () => {
  const home = freshHome();
  const session = startSession(home).session;

  const missingSession = ui(home, ["ui", "bundle", "--json"]);
  assert.notEqual(missingSession.status, 0);
  assert.match(missingSession.stderr, /session/i);

  const unknownBundle = ui(home, ["ui", "bundle", session.id, "bundle_20260101_000000_deadbeef", "--json"]);
  assert.notEqual(unknownBundle.status, 0);
  assert.match(unknownBundle.stderr, /bundle_20260101_000000_deadbeef/);
});

// === NGX-540: artshelf ui execute <session-id> <bundle-id> ===
// The agent's mutating execution path for an approved bundle: it re-reads live state, executes only
// exact valid targets through the existing approval-gated dispose paths, verifies live state, and
// replies per-target receipts + aggregate state to the session. Seeding mirrors the loopback server's
// write path (ui-server.ts): a persisted approval snapshot plus its approval_bundle_submitted event.

function writeLedgerFile(ledgerPath: string, records: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function registryWithLedgers(ledgers: string[]): string {
  const registryPath = join(mkdtempSync(join(tmpdir(), "artshelf-ui-exec-registry-")), "ledgers.json");
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(
    registryPath,
    `${JSON.stringify(
      {
        version: 1,
        ledgers: ledgers.map((ledgerPath, index) => ({
          name: `ledger-${index}`,
          path: ledgerPath,
          scope: "other",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }))
      },
      null,
      2
    )}\n`
  );
  return registryPath;
}

function ledgerRecord(id: string, path: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    path,
    kind: "backup",
    reason: "fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    retention: { mode: "manual-review" },
    cleanup: "review",
    owner: "manual",
    labels: [],
    status: "active",
    ...over
  };
}

function reviewedCleanupRow(recordId: string, ledgerPath: string, path: string): Record<string, unknown> {
  return { recordId, ledgerPath, ledgerName: "ledger-0", path, cleanup: "trash", dueState: "due", fileFacts: artifactIdentityFacts(path) };
}

function bundleTarget(targetId: string, ledgerPath: string, recordPath: string, over: Partial<UiApprovalTarget> = {}): UiApprovalTarget {
  return {
    targetId,
    ledgerPath,
    registryPath: null,
    recordPath,
    planId: `plan_${targetId}`,
    actionType: "trash-resolve",
    label: `trash ${targetId}`,
    ...over
  };
}

function purgeRow(recordId: string, ledgerPath: string, targetPath: string): DashboardTrashRow {
  return {
    recordId,
    ledgerName: "primary",
    ledgerPath,
    targetPath,
    cleanedAt: "2026-02-01T00:00:00.000Z",
    age: "30d",
    cleanupPlanId: "plan_purge",
    receiptPath: "/receipts/plan_purge.json"
  };
}

// Persist an approval bundle plus the approval_bundle_submitted event the browser would have appended
// for it, so the agent's execute path has a real event to reply receipts against.
function seedApprovedBundle(home: string, sessionId: string, targets: UiApprovalTarget[], selectedTargetIds: string[], registryPath: string) {
  const snapshot = writeApprovalSnapshot(home, sessionId, { actionType: "trash-resolve", targets: targets.map(withPlanDigest), selectedTargetIds, reviewed: {} });
  appendEvent(home, sessionId, {
    type: "approval_bundle_submitted",
    target: { bundleId: snapshot.id },
    payload: {
      bundleId: snapshot.id,
      actionType: snapshot.actionType,
      fingerprint: snapshot.fingerprint,
      registryPath,
      selectedTargetIds: snapshot.selectedTargetIds,
      selectedCount: snapshot.selectedTargetIds.length,
      targetCount: snapshot.targets.length
    }
  });
  return snapshot;
}

function withPlanDigest(target: UiApprovalTarget): UiApprovalTarget {
  if (!target.planId) return target;
  try {
    return { ...target, planEntryDigest: disposePlanEntryDigest(readDisposePlanEntry(target.ledgerPath, target.planId)) };
  } catch {
    return target;
  }
}

// A repo whose recorded backup exists on disk, with a reviewed trash-resolve dispose plan: the safe
// approved-bundle path the CLI smoke runs end-to-end against temp ledgers/artifacts.
function repoWithReviewedTrashPlan(recordId: string): { ledger: string; subject: string; trashTarget: string; planId: string } {
  const repo = mkdtempSync(join(tmpdir(), "artshelf-ui-exec-repo-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const subject = join(repo, `${recordId}.tar`);
  writeFileSync(subject, "payload");
  writeLedgerFile(ledger, [ledgerRecord(recordId, subject)]);
  const plan = createDisposePlan(ledger, { id: recordId, action: "trash-resolve", reason: "reviewed" });
  return { ledger, subject, trashTarget: plan.entry?.targetPath as string, planId: plan.planId };
}

function repoWithPurgeCandidate(recordId: string): { ledger: string; targetPath: string } {
  const repo = mkdtempSync(join(tmpdir(), "artshelf-ui-purge-repo-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const targetPath = join(repo, ".artshelf", "trash", "plan_purge", recordId);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, "payload");
  writeLedgerFile(ledger, [
    ledgerRecord(recordId, join(repo, `${recordId}.tar`), {
      status: "trashed",
      targetPath,
      cleanedAt: "2026-02-01T00:00:00.000Z",
      cleanupPlanId: "plan_purge",
      receiptPath: "/receipts/plan_purge.json"
    })
  ]);
  return { ledger, targetPath };
}

test("artshelf ui execute runs an approved bundle end-to-end through the real dispose path and verifies live state", () => {
  const home = freshHome();
  const { ledger, subject, trashTarget, planId } = repoWithReviewedTrashPlan("shf_backup");
  const registryPath = registryWithLedgers([ledger]);
  const env = { ARTSHELF_REGISTRY: registryPath };
  const session = startSession(home, [], env).session;
  const snapshot = seedApprovedBundle(home, session.id, [bundleTarget("shf_backup", ledger, subject, { planId })], ["shf_backup"], registryPath);

  const result = ui(home, ["ui", "execute", session.id, snapshot.id, "--json"], env);
  assert.equal(result.status, 0, result.stderr);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.ok, true);
  assert.equal(packet.command, "ui-execute");
  assert.equal(packet.sessionId, session.id);
  assert.equal(packet.execution.status, "executed");
  assert.equal(packet.execution.receipts[0].targetId, "shf_backup");
  assert.equal(packet.execution.receipts[0].outcome, "executed");
  // The reply advanced the bundle's own submitted event to completed.
  assert.equal(packet.reply.status, "completed");
  assert.equal(packet.event.type, "approval_bundle_submitted");
  assert.equal(packet.event.status, "completed");
  // The agent verified live state, not just the command exit: the subject really moved to trash.
  assert.equal(readLedger(ledger).find((record) => record.id === "shf_backup")?.status, "trashed");
  assert.equal(existsSync(subject), false);
  assert.equal(existsSync(trashTarget), true);
});

test("artshelf ui execute refuses an all-stale bundle, executes nothing, exits non-zero, and replies stale", () => {
  const home = freshHome();
  // A live ledger that no longer holds either approved subject: the whole bundle is stale.
  const ledger = join(mkdtempSync(join(tmpdir(), "artshelf-ui-exec-stale-")), ".artshelf", "ledger.jsonl");
  writeLedgerFile(ledger, [ledgerRecord("shf_keep", "/subjects/keep")]);
  const registryPath = registryWithLedgers([ledger]);
  const env = { ARTSHELF_REGISTRY: registryPath };
  const session = startSession(home, [], env).session;
  const targets = [bundleTarget("shf_a", ledger, "/subjects/a"), bundleTarget("shf_b", ledger, "/subjects/b")];
  const snapshot = seedApprovedBundle(home, session.id, targets, ["shf_a", "shf_b"], registryPath);

  const result = ui(home, ["ui", "execute", session.id, snapshot.id, "--json"], env);
  assert.notEqual(result.status, 0);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.ok, false);
  assert.equal(packet.execution.status, "refused");
  assert.equal(packet.reply.status, "stale");
  // Partial failures never hide a target: both stale targets are reported as skipped_stale.
  assert.deepEqual(packet.execution.receipts.map((receipt: { outcome: string }) => receipt.outcome), ["skipped_stale", "skipped_stale"]);
});

test("artshelf ui execute reports a partial run with both the executed and skipped_stale targets visible and exits non-zero", () => {
  const home = freshHome();
  const { ledger, subject, planId } = repoWithReviewedTrashPlan("shf_live");
  const registryPath = registryWithLedgers([ledger]);
  const env = { ARTSHELF_REGISTRY: registryPath };
  const session = startSession(home, [], env).session;
  const liveTarget = bundleTarget("shf_live", ledger, subject, { planId });
  // shf_gone was approved but is no longer in the live ledger.
  const goneTarget = bundleTarget("shf_gone", ledger, join(dirname(dirname(ledger)), "gone.tar"));
  const snapshot = seedApprovedBundle(home, session.id, [liveTarget, goneTarget], ["shf_live", "shf_gone"], registryPath);

  const result = ui(home, ["ui", "execute", session.id, snapshot.id, "--json"], env);
  assert.notEqual(result.status, 0);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.ok, false);
  assert.equal(packet.execution.status, "partial");
  assert.equal(packet.reply.status, "failed");
  const outcomes: Record<string, string> = Object.fromEntries(
    packet.execution.receipts.map((receipt: { targetId: string; outcome: string }) => [receipt.targetId, receipt.outcome])
  );
  assert.equal(outcomes.shf_live, "executed");
  assert.equal(outcomes.shf_gone, "skipped_stale");
  assert.deepEqual(packet.execution.counts, { executed: 1, skipped_stale: 1, failed: 0, needs_manual_review: 0 });
  // The live target really executed; the stale one was left untouched.
  assert.equal(readLedger(ledger).find((record) => record.id === "shf_live")?.status, "trashed");
});

test("artshelf ui execute rejects a missing bundle id", () => {
  const home = freshHome();
  const session = startSession(home).session;

  const result = ui(home, ["ui", "execute", session.id, "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing bundle id/i);
});

test("artshelf ui execute rejects --all before loading a bundle", () => {
  const home = freshHome();
  const session = startSession(home).session;

  const result = ui(home, ["ui", "execute", "--all", session.id, "bundle_20260101_000000_deadbeef", "--json"]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /ui execute --all/i);
});

test("artshelf ui execute fails fast when the bundle has no approval_bundle_submitted event", () => {
  const home = freshHome();
  const session = startSession(home).session;
  // Persist a bundle WITHOUT appending its approval_bundle_submitted event.
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: [bundleTarget("shf_a", "/srv/ledgers/a/.artshelf/ledger.jsonl", "/tmp/a")],
    selectedTargetIds: ["shf_a"],
    reviewed: {}
  });

  const result = ui(home, ["ui", "execute", session.id, snapshot.id, "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approval_bundle_submitted/);
});

test("artshelf ui execute prints a per-target human receipt summary without --json", () => {
  const home = freshHome();
  const ledger = join(mkdtempSync(join(tmpdir(), "artshelf-ui-exec-human-")), ".artshelf", "ledger.jsonl");
  writeLedgerFile(ledger, [ledgerRecord("shf_keep", "/subjects/keep")]);
  const registryPath = registryWithLedgers([ledger]);
  const env = { ARTSHELF_REGISTRY: registryPath };
  const session = startSession(home, [], env).session;
  const snapshot = seedApprovedBundle(home, session.id, [bundleTarget("shf_a", ledger, "/subjects/a")], ["shf_a"], registryPath);

  const result = ui(home, ["ui", "execute", session.id, snapshot.id], env);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout, new RegExp(snapshot.id));
  assert.match(result.stdout, /refused/);
  assert.match(result.stdout, /shf_a/);
  assert.match(result.stdout, /skipped_stale/);
});
