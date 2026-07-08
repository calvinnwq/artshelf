import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withPathLock } from "../src/locks.js";
import {
  appendEvent,
  appendEvents,
  approvalSnapshotFingerprint,
  endSession,
  isUiDecisionIntent,
  listApprovalSnapshots,
  pollPendingEvents,
  readApprovalSnapshot,
  readReplies,
  readSession,
  readSessionEvents,
  readSessionHistory,
  replyToEvent,
  resolveUiHome,
  revalidateApprovalSnapshot,
  selectedApprovalTargets,
  startOrResumeSession,
  UI_DECISION_INTENTS,
  validateBrowserToken,
  writeApprovalSnapshot
} from "../src/session.js";
import type { UiApprovalTarget } from "../src/types.js";

const SESSION_MODULE = new URL("../src/session.js", import.meta.url);

function freshHome(): string {
  return join(mkdtempSync(join(tmpdir(), "artshelf-ui-")), "ui");
}

function startUserSession(home: string): ReturnType<typeof startOrResumeSession> {
  return startOrResumeSession({ home, scope: "user" });
}

function sampleTargets(): UiApprovalTarget[] {
  return [
    {
      targetId: "shf_a",
      ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl",
      registryPath: null,
      recordPath: "/tmp/a",
      planId: "plan_a",
      actionType: "trash-resolve",
      label: "trash scratch a"
    },
    {
      targetId: "shf_b",
      ledgerPath: "/ledgers/b/.artshelf/ledger.jsonl",
      registryPath: null,
      recordPath: "/tmp/b",
      planId: "plan_b",
      actionType: "trash-resolve",
      label: "trash scratch b"
    }
  ];
}

function waitUntil(predicate: () => boolean, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return predicate();
}

function childAppendEvent(home: string, sessionId: string, text: string): ReturnType<typeof spawn> {
  const script = `
    import { appendEvent } from ${JSON.stringify(SESSION_MODULE.href)};
    try {
      const event = appendEvent(process.env.ARTSHELF_TEST_UI_HOME, process.env.ARTSHELF_TEST_SESSION_ID, {
        type: "comment_added",
        target: { recordId: "shf_lock", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
        payload: { text: process.env.ARTSHELF_TEST_TEXT }
      });
      process.stdout.write(JSON.stringify({ ok: true, eventId: event.id }));
    } catch (error) {
      process.stderr.write((error && error.message) || String(error));
      process.exit(7);
    }
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ARTSHELF_TEST_UI_HOME: home,
      ARTSHELF_TEST_SESSION_ID: sessionId,
      ARTSHELF_TEST_TEXT: text
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function childPollPendingEvents(home: string, sessionId: string, markerPath: string): ReturnType<typeof spawn> {
  const script = `
    import { writeFileSync } from "node:fs";
    import { pollPendingEvents } from ${JSON.stringify(SESSION_MODULE.href)};
    try {
      const events = pollPendingEvents(process.env.ARTSHELF_TEST_UI_HOME, process.env.ARTSHELF_TEST_SESSION_ID);
      if (events.length > 0) writeFileSync(process.env.ARTSHELF_TEST_MARKER, "pending");
      process.stdout.write(JSON.stringify({ ok: true, pending: events.length }));
    } catch (error) {
      process.stderr.write((error && error.message) || String(error));
      process.exit(7);
    }
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ARTSHELF_TEST_UI_HOME: home,
      ARTSHELF_TEST_SESSION_ID: sessionId,
      ARTSHELF_TEST_MARKER: markerPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function childResult(child: ReturnType<typeof spawn>): Promise<{ status: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: unknown) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk: unknown) => {
    stderr += String(chunk);
  });
  return new Promise((resolve) => {
    child.on("close", (code: number | null) => resolve({ status: code ?? 1, stdout, stderr }));
  });
}

test("resolveUiHome defaults to the user-level ~/.artshelf/ui tree", () => {
  assert.equal(resolveUiHome(), join(homedir(), ".artshelf", "ui"));
  assert.equal(resolveUiHome({ scope: "user" }), join(homedir(), ".artshelf", "ui"));
});

test("resolveUiHome honors an explicit ARTSHELF_UI_HOME override for both scopes", () => {
  const override = "/custom/ui-home";
  assert.equal(resolveUiHome({ scope: "user", env: { ARTSHELF_UI_HOME: override } }), override);
  assert.equal(resolveUiHome({ scope: "repo", env: { ARTSHELF_UI_HOME: override } }), override);
});

test("resolveUiHome anchors repo scope at the enclosing git root", () => {
  const root = mkdtempSync(join(tmpdir(), "artshelf-ui-repo-"));
  mkdirSync(join(root, ".git"));
  const nested = join(root, "packages", "app");
  mkdirSync(nested, { recursive: true });

  assert.equal(resolveUiHome({ scope: "repo", cwd: nested, env: {} }), join(root, ".artshelf", "ui"));
});

test("startOrResumeSession creates a durable, token-protected user session", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.match(session.id, /^session_/);
  assert.equal(session.version, 1);
  assert.equal(session.scope, "user");
  assert.equal(session.status, "active");
  assert.equal(session.ledgerPath, null);
  assert.equal(session.endedAt, null);
  assert.ok(session.token.length >= 32, "token should be unguessable");
  assert.match(session.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  const persisted = join(home, "sessions", session.id, "session.json");
  assert.equal(existsSync(persisted), true);
  assert.deepEqual(readSession(home, session.id), session);
});

test("session storage uses owner-only directory and token file permissions", () => {
  const home = freshHome();
  const processWithUmask = process as unknown as { umask(mask?: number): number };
  const previousUmask = processWithUmask.umask(0);
  let session: ReturnType<typeof startUserSession>;
  let eventId: string;
  let bundleId: string;
  try {
    session = startUserSession(home);
    eventId = appendEvent(home, session.id, {
      type: "comment_added",
      target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
      payload: { text: "private" }
    }).id;
    assert.match(eventId, /^event_/);
    bundleId = writeApprovalSnapshot(home, session.id, {
      actionType: "trash-resolve",
      targets: sampleTargets(),
      selectedTargetIds: ["shf_a", "shf_b"],
      reviewed: { planId: "plan_a" }
    }).id;
  } finally {
    processWithUmask.umask(previousUmask);
  }

  const sessionDir = join(home, "sessions", session.id);
  assert.equal(statSync(join(home, "sessions")).mode & 0o777, 0o700);
  assert.equal(statSync(sessionDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(sessionDir, "bundles")).mode & 0o777, 0o700);
  assert.equal(statSync(join(sessionDir, "session.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(sessionDir, "events.jsonl")).mode & 0o777, 0o600);
  assert.equal(statSync(join(sessionDir, "bundles", `${bundleId}.json`)).mode & 0o777, 0o600);
});

test("session storage does not chmod an existing configured UI home", () => {
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  chmodSync(home, 0o755);

  const session = startUserSession(home);

  assert.equal(statSync(home).mode & 0o777, 0o755);
  assert.equal(statSync(join(home, "sessions")).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, "sessions", session.id)).mode & 0o777, 0o700);
});

test("startOrResumeSession resumes the active session instead of creating a second one", () => {
  const home = freshHome();
  const first = startUserSession(home);
  const second = startUserSession(home);

  assert.equal(second.id, first.id);
  assert.equal(readdirSync(join(home, "sessions")).length, 1);
});

test("startOrResumeSession resumes legacy user sessions missing registry metadata", () => {
  const home = freshHome();
  const legacy = startUserSession(home);
  const sessionFile = join(home, "sessions", legacy.id, "session.json");
  const stored = JSON.parse(readFileSync(sessionFile, "utf8")) as Record<string, unknown>;
  delete stored.registryPath;
  delete stored.repoRoot;
  writeFileSync(sessionFile, `${JSON.stringify(stored, null, 2)}\n`);
  const registryPath = join(mkdtempSync(join(tmpdir(), "artshelf-ui-legacy-registry-")), "ledgers.json");

  const resumed = startOrResumeSession({ home, scope: "user", registryPath });

  assert.equal(resumed.id, legacy.id);
  assert.equal(resumed.registryPath, registryPath);
  assert.equal(readSession(home, legacy.id).registryPath, registryPath, "legacy metadata is migrated in place");
  assert.equal(readdirSync(join(home, "sessions")).length, 1);
});

test("startOrResumeSession resumes legacy repo sessions missing repoRoot metadata", () => {
  const home = freshHome();
  const repo = mkdtempSync(join(tmpdir(), "artshelf-ui-legacy-repo-"));
  mkdirSync(join(repo, ".git"));
  const legacy = startOrResumeSession({ home, scope: "repo", cwd: repo });
  const sessionFile = join(home, "sessions", legacy.id, "session.json");
  const stored = JSON.parse(readFileSync(sessionFile, "utf8")) as Record<string, unknown>;
  delete stored.repoRoot;
  writeFileSync(sessionFile, `${JSON.stringify(stored, null, 2)}\n`);

  const resumed = startOrResumeSession({ home, scope: "repo", cwd: repo });

  assert.equal(resumed.id, legacy.id);
  assert.equal(resumed.repoRoot, repo);
  assert.equal(readSession(home, legacy.id).repoRoot, repo, "legacy repo metadata is migrated in place");
  assert.equal(readdirSync(join(home, "sessions")).length, 1);
});

test("a ledger-scoped session is distinct from the multi-ledger default session", () => {
  const home = freshHome();
  const multi = startUserSession(home);
  const scoped = startOrResumeSession({ home, scope: "user", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" });

  assert.notEqual(scoped.id, multi.id);
  assert.equal(scoped.ledgerPath, "/ledgers/a/.artshelf/ledger.jsonl");
  assert.equal(readdirSync(join(home, "sessions")).length, 2);
});

test("readSession throws a clear error for an unknown session id", () => {
  const home = freshHome();
  const missing = "session_20260625_010203_deadbeef";
  assert.throws(() => readSession(home, missing), new RegExp(missing));
});

test("session and bundle ids cannot escape the session storage tree", () => {
  const home = freshHome();
  const escapedSession = join(home, "escaped-session", "session.json");
  mkdirSync(join(home, "escaped-session"), { recursive: true });
  writeFileSync(
    escapedSession,
    `${JSON.stringify({
      version: 1,
      id: "session_20260625_010203_deadbeef",
      scope: "user",
      status: "active",
      createdAt: "2026-06-25T01:02:03Z",
      updatedAt: "2026-06-25T01:02:03Z",
      endedAt: null,
      ledgerPath: null,
      token: "secret"
    })}\n`
  );

  assert.throws(() => readSession(home, "../escaped-session"), /session id/i);

  const session = startUserSession(home);
  const escapedBundle = join(home, "sessions", session.id, "escaped-bundle.json");
  writeFileSync(
    escapedBundle,
    `${JSON.stringify({
      id: "bundle_20260625_010203_deadbeef",
      sessionId: session.id,
      createdAt: "2026-06-25T01:02:03Z",
      actionType: "trash-resolve",
      targets: [],
      reviewed: {},
      fingerprint: "abc"
    })}\n`
  );

  assert.throws(() => readApprovalSnapshot(home, session.id, "../escaped-bundle"), /bundle id/i);
});

test("endSession marks the session ended and records a session_done event", () => {
  const home = freshHome();
  const session = startUserSession(home);

  const ended = endSession(home, session.id);
  assert.equal(ended.status, "ended");
  assert.match(ended.endedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(readSession(home, session.id).status, "ended");

  const events = readSessionEvents(home, session.id);
  assert.equal(events.some((event) => event.type === "session_done" && event.source === "agent"), true);
});

test("validateBrowserToken accepts the live token and rejects wrong or revoked tokens", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.equal(validateBrowserToken(session, session.token), true);
  assert.equal(validateBrowserToken(session, "not-the-token"), false);
  assert.equal(validateBrowserToken(session, ""), false);

  const ended = endSession(home, session.id);
  assert.equal(validateBrowserToken(ended, session.token), false, "ending a session must revoke browser writes");
});

test("appendEvent records a pending browser event surfaced by pollPendingEvents", () => {
  const home = freshHome();
  const session = startUserSession(home);

  const event = appendEvent(home, session.id, {
    type: "comment_added",
    target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
    payload: { text: "looks stale" }
  });

  assert.match(event.id, /^event_/);
  assert.equal(event.status, "pending");
  assert.equal(event.source, "browser");
  assert.equal(event.sessionId, session.id);

  const pending = pollPendingEvents(home, session.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.id, event.id);
});

test("appendEvents records a generated browser event batch in queue order", () => {
  const home = freshHome();
  const session = startUserSession(home);

  const events = appendEvents(home, session.id, [
    {
      type: "comment_added",
      target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
      payload: { text: "first" }
    },
    {
      type: "decision_submitted",
      target: { recordId: "shf_2", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
      payload: { decision: "keep" }
    }
  ]);

  assert.equal(events.length, 2);
  assert.deepEqual(
    pollPendingEvents(home, session.id).map((event) => event.id),
    events.map((event) => event.id)
  );
});

test("appendEvents rejects an invalid generated event before recording any batch entries", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(
    () =>
      appendEvents(home, session.id, [
        {
          type: "comment_added",
          target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
          payload: { text: "valid" }
        },
        { type: "unknown_event" as never }
      ]),
    /event type/i
  );
  assert.equal(pollPendingEvents(home, session.id).length, 0);
});

test("appendEvent keeps browser-submitted events pending even when input supplies another status", () => {
  const home = freshHome();
  const session = startUserSession(home);

  const event = appendEvent(home, session.id, {
    type: "comment_added",
    target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
    status: "completed",
    payload: { text: "do not hide this from poll" }
  });

  assert.equal(event.source, "browser");
  assert.equal(event.status, "pending");
  assert.deepEqual(pollPendingEvents(home, session.id).map((entry) => entry.id), [event.id]);
});

test("appendEvent treats caller-supplied agent source as browser input", () => {
  const home = freshHome();
  const session = startUserSession(home);

  const event = appendEvent(home, session.id, {
    type: "comment_added",
    target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
    source: "agent",
    status: "completed",
    payload: { text: "do not bypass browser normalization" }
  } as never);

  assert.equal(event.source, "browser");
  assert.equal(event.status, "pending");
  assert.deepEqual(pollPendingEvents(home, session.id).map((entry) => entry.id), [event.id]);
});

test("appendEvent refuses browser writes once the session has ended", () => {
  const home = freshHome();
  const session = startUserSession(home);
  endSession(home, session.id);

  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "comment_added",
        target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
        payload: { text: "too late" }
      }),
    /ended/i
  );
});

test("appendEvent refuses caller-supplied agent source once the session has ended", () => {
  const home = freshHome();
  const session = startUserSession(home);
  endSession(home, session.id);

  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "comment_added",
        target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
        source: "agent",
        status: "completed",
        payload: { text: "do not bypass revocation" }
      } as never),
    /ended/i
  );
});

test("pollPendingEvents returns no actionable browser events after the session ends", () => {
  const home = freshHome();
  const session = startUserSession(home);
  appendEvent(home, session.id, {
    type: "comment_added",
    target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
    payload: { text: "review me" }
  });

  endSession(home, session.id);

  assert.deepEqual(pollPendingEvents(home, session.id), []);
});

test("appendEvent rejects unknown types and non-object event bodies", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(() => appendEvent(home, session.id, { type: "unknown_event" as never }), /event type/i);
  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "comment_added",
        target: [] as never
      }),
    /target/i
  );
  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "comment_added",
        payload: null as never
      }),
    /payload/i
  );

  assert.equal(pollPendingEvents(home, session.id).length, 0);
});

test("isUiDecisionIntent recognizes exactly the keep/trash/resolve/defer triage set", () => {
  assert.deepEqual([...UI_DECISION_INTENTS].sort(), ["defer", "keep", "resolve", "trash"]);
  for (const decision of UI_DECISION_INTENTS) assert.equal(isUiDecisionIntent(decision), true);
  assert.equal(isUiDecisionIntent("purge"), false);
  assert.equal(isUiDecisionIntent("approve_all"), false);
  assert.equal(isUiDecisionIntent(""), false);
  assert.equal(isUiDecisionIntent(undefined), false);
});

test("appendEvent records each keep/trash/resolve/defer decision intent against its exact record target", () => {
  const home = freshHome();
  const session = startUserSession(home);

  for (const decision of UI_DECISION_INTENTS) {
    const event = appendEvent(home, session.id, {
      type: "decision_submitted",
      target: { recordId: `shf_${decision}`, ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
      payload: { decision }
    });
    assert.equal(event.type, "decision_submitted");
    assert.equal(event.status, "pending");
    assert.equal(event.source, "browser");
    assert.equal(event.payload.decision, decision);
    assert.equal(event.target.recordId, `shf_${decision}`);
  }

  assert.equal(pollPendingEvents(home, session.id).length, UI_DECISION_INTENTS.length);
});

test("a decision intent survives a fresh read with its compact target and payload intact", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const event = appendEvent(home, session.id, {
    type: "decision_submitted",
    target: { recordId: "shf_keep", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
    payload: { decision: "keep", reason: "still in active use" }
  });

  const reloaded = readSessionEvents(home, session.id).find((entry) => entry.id === event.id);
  assert.deepEqual(reloaded?.target, { recordId: "shf_keep", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" });
  assert.deepEqual(reloaded?.payload, { decision: "keep", reason: "still in active use" });
});

test("a decision intent flows through the agent poll/reply loop and leaves the queue", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const event = appendEvent(home, session.id, {
    type: "decision_submitted",
    target: { recordId: "shf_trash", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
    payload: { decision: "trash" }
  });

  assert.deepEqual(pollPendingEvents(home, session.id).map((entry) => entry.id), [event.id]);
  replyToEvent(home, session.id, event.id, { status: "completed", payload: { receipt: "trashed via dispose" } });
  assert.equal(pollPendingEvents(home, session.id).length, 0);

  const folded = readSessionEvents(home, session.id).find((entry) => entry.id === event.id);
  assert.equal(folded?.status, "completed");
});

test("readSessionHistory pairs each event with the agent replies that advanced it (NGX-538 history)", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const target = { recordId: "shf_keep", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" };
  const comment = appendEvent(home, session.id, { type: "comment_added", target, payload: { text: "needs a look" } });
  const decision = appendEvent(home, session.id, { type: "decision_submitted", target, payload: { decision: "keep" } });

  // Two replies advance the decision; both must survive in order so the agent's trail is visible.
  replyToEvent(home, session.id, decision.id, { status: "acknowledged", payload: { note: "queued" } });
  replyToEvent(home, session.id, decision.id, { status: "completed", payload: { receipt: "kept via dispose" } });

  const history = readSessionHistory(home, session.id);
  assert.deepEqual(history.map((entry) => entry.event.id), [comment.id, decision.id], "history preserves creation order");

  const commentEntry = history[0]!;
  assert.equal(commentEntry.event.status, "pending", "an unanswered intent stays pending in history");
  assert.equal(commentEntry.replies.length, 0, "an unanswered intent carries no replies");

  const decisionEntry = history[1]!;
  assert.equal(decisionEntry.event.status, "completed", "the event folds to its latest reply status");
  assert.deepEqual(
    decisionEntry.replies.map((reply) => reply.status),
    ["acknowledged", "completed"],
    "every reply is preserved in append order"
  );
  assert.equal(decisionEntry.replies[1]!.payload.receipt, "kept via dispose", "reply payloads survive so the agent's note stays visible");
});

test("appendEvent rejects a decision intent with an unknown decision before it enters the log", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "decision_submitted",
        target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
        payload: { decision: "purge" }
      }),
    /decision intent/i
  );
  // No vague global "approve all" action may be smuggled in as a decision intent.
  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "decision_submitted",
        target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
        payload: {}
      }),
    /decision intent/i
  );
  assert.equal(pollPendingEvents(home, session.id).length, 0);
});

test("appendEvent rejects a decision intent missing its exact record or ledger target", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "decision_submitted",
        target: { ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
        payload: { decision: "keep" }
      }),
    /recordId/i
  );
  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "decision_submitted",
        target: { recordId: "shf_1" },
        payload: { decision: "keep" }
      }),
    /ledgerPath/i
  );
  assert.equal(pollPendingEvents(home, session.id).length, 0);
});

test("appendEvent rejects a decision intent whose optional reason is present but blank", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "decision_submitted",
        target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
        payload: { decision: "resolve", reason: "   " }
      }),
    /reason/i
  );
  assert.equal(pollPendingEvents(home, session.id).length, 0);
});

test("appendEvent records a dry_run_requested intent against its exact record target", () => {
  const home = freshHome();
  const session = startUserSession(home);

  const event = appendEvent(home, session.id, {
    type: "dry_run_requested",
    target: { recordId: "shf_dry_run", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" }
  });

  assert.equal(event.type, "dry_run_requested");
  assert.equal(event.status, "pending");
  assert.equal(event.source, "browser");
  assert.equal(event.target.recordId, "shf_dry_run");
  assert.deepEqual(pollPendingEvents(home, session.id).map((entry) => entry.id), [event.id]);
});

test("appendEvent records a dry_run_requested intent against a dashboard lane target", () => {
  const home = freshHome();
  const session = startUserSession(home);

  const event = appendEvent(home, session.id, {
    type: "dry_run_requested",
    target: { lane: "cleanup", registryPath: "/registries/ledgers.json" },
    payload: {
      request: "prepare_cleanup_plan",
      count: 2,
      reviewedRows: [
        { recordId: "shf_cleanup_a", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl", ledgerName: "primary", path: "/tmp/a.tgz", cleanup: "trash", dueState: "due" },
        { recordId: "shf_cleanup_b", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl", ledgerName: "primary", path: "/tmp/b.tgz", cleanup: "trash", dueState: "due" }
      ]
    }
  });

  assert.equal(event.type, "dry_run_requested");
  assert.equal(event.status, "pending");
  assert.equal(event.source, "browser");
  assert.deepEqual(event.target, { lane: "cleanup", registryPath: "/registries/ledgers.json" });
  assert.deepEqual(event.payload, {
    request: "prepare_cleanup_plan",
    count: 2,
    reviewedRows: [
      { recordId: "shf_cleanup_a", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl", ledgerName: "primary", path: "/tmp/a.tgz", cleanup: "trash", dueState: "due" },
      { recordId: "shf_cleanup_b", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl", ledgerName: "primary", path: "/tmp/b.tgz", cleanup: "trash", dueState: "due" }
    ]
  });
  assert.deepEqual(pollPendingEvents(home, session.id).map((entry) => entry.id), [event.id]);
});

test("appendEvent rejects a dry-run request missing its exact record or ledger target", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "dry_run_requested",
        target: { ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" }
      }),
    /recordId/i
  );
  assert.throws(
    () => appendEvent(home, session.id, { type: "dry_run_requested", target: { recordId: "shf_1" } }),
    /ledgerPath/i
  );
  assert.throws(
    () => appendEvent(home, session.id, { type: "dry_run_requested", target: { lane: "cleanup" } }),
    /registryPath/i
  );
  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "dry_run_requested",
        target: { lane: "cleanup", registryPath: "/registries/ledgers.json" },
        payload: { request: "prepare_cleanup_plan", count: 1 }
      }),
    /reviewedRows/i
  );
  assert.equal(pollPendingEvents(home, session.id).length, 0);
});

test("appendEvent rejects unsupported dashboard lane dry-run requests", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "dry_run_requested",
        target: { lane: "trash", registryPath: "/registries/ledgers.json" },
        payload: { request: "prepare_cleanup_plan", count: 1 }
      }),
    /target\.lane/
  );
  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "dry_run_requested",
        target: { lane: "cleanup", registryPath: "/registries/ledgers.json" },
        payload: { request: "review_delete_forever", count: 1 }
      }),
    /payload\.request/
  );
  assert.equal(pollPendingEvents(home, session.id).length, 0);
});

test("appendEvent records an inspect_requested intent against its exact record target", () => {
  const home = freshHome();
  const session = startUserSession(home);

  const event = appendEvent(home, session.id, {
    type: "inspect_requested",
    target: { recordId: "shf_inspect", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" }
  });

  assert.equal(event.type, "inspect_requested");
  assert.equal(event.status, "pending");
  assert.equal(event.source, "browser");
  assert.equal(event.target.recordId, "shf_inspect");
  assert.deepEqual(pollPendingEvents(home, session.id).map((entry) => entry.id), [event.id]);
});

test("appendEvent rejects an inspect request missing its exact record or ledger target", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "inspect_requested",
        target: { ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" }
      }),
    /recordId/i
  );
  assert.throws(
    () => appendEvent(home, session.id, { type: "inspect_requested", target: { recordId: "shf_1" } }),
    /ledgerPath/i
  );
  assert.equal(pollPendingEvents(home, session.id).length, 0);
});

test("appendEvent records a comment_added intent against its exact record target", () => {
  const home = freshHome();
  const session = startUserSession(home);

  const event = appendEvent(home, session.id, {
    type: "comment_added",
    target: { recordId: "shf_comment", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
    payload: { text: "looks stale, likely safe to trash" }
  });

  assert.equal(event.type, "comment_added");
  assert.equal(event.target.recordId, "shf_comment");
  assert.equal(event.payload.text, "looks stale, likely safe to trash");
  assert.deepEqual(pollPendingEvents(home, session.id).map((entry) => entry.id), [event.id]);
});

test("appendEvent rejects a comment missing its exact record or ledger target", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "comment_added",
        target: { ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
        payload: { text: "looks stale" }
      }),
    /recordId/i
  );
  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "comment_added",
        target: { recordId: "shf_1" },
        payload: { text: "looks stale" }
      }),
    /ledgerPath/i
  );
  assert.equal(pollPendingEvents(home, session.id).length, 0);
});

test("appendEvent rejects a comment whose text is missing or blank", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "comment_added",
        target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" }
      }),
    /comment text/i
  );
  assert.throws(
    () =>
      appendEvent(home, session.id, {
        type: "comment_added",
        target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
        payload: { text: "   " }
      }),
    /comment text/i
  );
  assert.equal(pollPendingEvents(home, session.id).length, 0);
});

test("appendEvent serializes browser writes against session end", async () => {
  const home = freshHome();
  const session = startUserSession(home);
  const sessionPath = join(home, "sessions", session.id, "session.json");
  const eventsPath = join(home, "sessions", session.id, "events.jsonl");
  const blockedText = "must wait for the session lock";
  let child: ReturnType<typeof spawn> | null = null;
  let appendedBeforeEnd = false;

  withPathLock(sessionPath, () => {
    child = childAppendEvent(home, session.id, blockedText);
    appendedBeforeEnd = waitUntil(
      () => existsSync(eventsPath) && readFileSync(eventsPath, "utf8").includes(blockedText),
      500
    );
    if (!appendedBeforeEnd) endSession(home, session.id);
  });

  assert.ok(child);
  const result = await childResult(child);
  assert.equal(appendedBeforeEnd, false, "browser events must not append while the session lock is held");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ended/i);
  const log = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
  assert.doesNotMatch(log, new RegExp(blockedText));
});

test("pollPendingEvents serializes pending queue reads against session end", async () => {
  const home = freshHome();
  const session = startUserSession(home);
  appendEvent(home, session.id, {
    type: "comment_added",
    target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
    payload: { text: "review me before close" }
  });
  const sessionPath = join(home, "sessions", session.id, "session.json");
  const markerPath = join(home, "sessions", session.id, "poll-marker");
  let child: ReturnType<typeof spawn> | null = null;
  let polledBeforeEnd = false;

  withPathLock(sessionPath, () => {
    child = childPollPendingEvents(home, session.id, markerPath);
    polledBeforeEnd = waitUntil(() => existsSync(markerPath), 500);
    if (!polledBeforeEnd) endSession(home, session.id);
  });

  assert.ok(child);
  const result = await childResult(child);
  assert.equal(polledBeforeEnd, false, "poll must not return pending events while the session lock is held");
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, pending: 0 });
  assert.equal(existsSync(markerPath), false);
});

test("replyToEvent advances event status, clears it from the poll queue, and is durable", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const event = appendEvent(home, session.id, {
    type: "dry_run_requested",
    target: { recordId: "shf_plan", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" }
  });

  const { reply } = replyToEvent(home, session.id, event.id, {
    status: "completed",
    payload: { receipt: "executed", planId: "plan_a" }
  });

  assert.match(reply.id, /^reply_/);
  assert.equal(reply.eventId, event.id);
  assert.equal(pollPendingEvents(home, session.id).length, 0);

  const folded = readSessionEvents(home, session.id).find((entry) => entry.id === event.id);
  assert.equal(folded?.status, "completed");
  assert.equal(readReplies(home, session.id).some((entry) => entry.id === reply.id), true);

  // The durable log keeps both the original event and the reply as separate lines.
  const logLines = readFileSync(join(home, "sessions", session.id, "events.jsonl"), "utf8").trim().split("\n");
  assert.ok(logLines.length >= 2);
  for (const line of logLines) JSON.parse(line);
});

test("replyToEvent rejects a reply that targets an unknown event", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(() => replyToEvent(home, session.id, "event_missing", { status: "completed" }), /event_missing/);
});

test("replyToEvent rejects pending and unknown reply statuses at the storage boundary", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const event = appendEvent(home, session.id, {
    type: "comment_added",
    target: { recordId: "shf_1", ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl" },
    payload: { text: "reviewed" }
  });

  assert.throws(
    () => replyToEvent(home, session.id, event.id, { status: "pending" as never }),
    /expected one of/i
  );
  assert.throws(() => replyToEvent(home, session.id, event.id, { status: "donezo" as never }), /expected one of/i);
});

test("approvalSnapshotFingerprint is deterministic, order-independent, and drift-sensitive", () => {
  const targets = sampleTargets();
  const reviewed = { planId: "plan_a", total: 2 };

  const base = approvalSnapshotFingerprint(targets, reviewed);
  assert.equal(approvalSnapshotFingerprint(targets, reviewed), base);
  assert.equal(approvalSnapshotFingerprint([...targets].reverse(), reviewed), base, "target order must not change the fingerprint");

  const mutated = sampleTargets();
  mutated[0]!.actionType = "resolve-only";
  assert.notEqual(approvalSnapshotFingerprint(mutated, reviewed), base);
  assert.notEqual(approvalSnapshotFingerprint(targets, { planId: "plan_a", total: 3 }), base);
});

test("writeApprovalSnapshot persists a fingerprinted bundle that readApprovalSnapshot round-trips", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const targets = sampleTargets();

  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets,
    selectedTargetIds: ["shf_a", "shf_b"],
    reviewed: { planId: "plan_a", total: 2 }
  });

  assert.match(snapshot.id, /^bundle_/);
  assert.equal(snapshot.sessionId, session.id);
  assert.deepEqual(snapshot.selectedTargetIds, ["shf_a", "shf_b"]);
  assert.equal(snapshot.fingerprint, approvalSnapshotFingerprint(targets, { planId: "plan_a", total: 2 }));

  const persisted = join(home, "sessions", session.id, "bundles", `${snapshot.id}.json`);
  assert.equal(existsSync(persisted), true);
  assert.deepEqual(readApprovalSnapshot(home, session.id, snapshot.id), snapshot);
});

test("writeApprovalSnapshot persists the full candidate pool and the partial selected subset", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const targets = sampleTargets();

  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets,
    selectedTargetIds: ["shf_a"],
    reviewed: { planId: "plan_a", total: 2 }
  });

  // The reviewed candidate pool (selected + unselected rows) is persisted intact so the
  // approval workbench can distinguish what was offered from what the human approved.
  assert.deepEqual(snapshot.targets, targets);
  assert.deepEqual(snapshot.selectedTargetIds, ["shf_a"]);
  // The fingerprint covers only the selected target, so a partial selection produces a
  // different bundle identity than approving both rows.
  assert.equal(snapshot.fingerprint, approvalSnapshotFingerprint([targets[0]!], { planId: "plan_a", total: 2 }));
  assert.notEqual(snapshot.fingerprint, approvalSnapshotFingerprint(targets, { planId: "plan_a", total: 2 }));
  assert.deepEqual(readApprovalSnapshot(home, session.id, snapshot.id), snapshot);
});

test("deselecting a target changes the persisted bundle fingerprint", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const targets = sampleTargets();

  const both = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets,
    selectedTargetIds: ["shf_a", "shf_b"],
    reviewed: {}
  });
  const onlyA = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets,
    selectedTargetIds: ["shf_a"],
    reviewed: {}
  });

  assert.notEqual(onlyA.fingerprint, both.fingerprint);
});

test("selectedTargetIds order does not change the persisted bundle fingerprint", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const targets = sampleTargets();

  const ab = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets,
    selectedTargetIds: ["shf_a", "shf_b"],
    reviewed: {}
  });
  const ba = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets,
    selectedTargetIds: ["shf_b", "shf_a"],
    reviewed: {}
  });

  assert.equal(ab.fingerprint, ba.fingerprint);
});

test("selectedApprovalTargets resolves the selected subset in selection order", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const targets = sampleTargets();

  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets,
    selectedTargetIds: ["shf_b"],
    reviewed: {}
  });

  assert.deepEqual(selectedApprovalTargets(snapshot), [targets[1]]);
});

test("selectedApprovalTargets rejects loaded snapshots with corrupt selections", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const targets = sampleTargets();
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets,
    selectedTargetIds: ["shf_a"],
    reviewed: {}
  });

  assert.throws(() => selectedApprovalTargets({ ...snapshot, selectedTargetIds: ["shf_a", "shf_missing"] }), /shf_missing/);
  assert.throws(() => selectedApprovalTargets({ ...snapshot, selectedTargetIds: ["shf_a", "shf_a"] }), /duplicate/i);
});

test("writeApprovalSnapshot refuses an empty selection so approval cannot be a vague approve-all", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(
    () =>
      writeApprovalSnapshot(home, session.id, {
        actionType: "trash-resolve",
        targets: sampleTargets(),
        selectedTargetIds: []
      }),
    /at least one|deliberate|select/i
  );
});

test("writeApprovalSnapshot refuses a blank bundle actionType", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(
    () =>
      writeApprovalSnapshot(home, session.id, {
        actionType: "  ",
        targets: sampleTargets(),
        selectedTargetIds: ["shf_a"]
      }),
    /actionType/i
  );
});

test("writeApprovalSnapshot refuses an empty candidate pool", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(
    () =>
      writeApprovalSnapshot(home, session.id, {
        actionType: "trash-resolve",
        targets: [],
        selectedTargetIds: []
      }),
    /target/i
  );
});

test("writeApprovalSnapshot refuses a selection that names a target outside the pool", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(
    () =>
      writeApprovalSnapshot(home, session.id, {
        actionType: "trash-resolve",
        targets: sampleTargets(),
        selectedTargetIds: ["shf_a", "shf_missing"]
      }),
    /shf_missing/
  );
});

test("writeApprovalSnapshot refuses duplicate selected target ids", () => {
  const home = freshHome();
  const session = startUserSession(home);

  assert.throws(
    () =>
      writeApprovalSnapshot(home, session.id, {
        actionType: "trash-resolve",
        targets: sampleTargets(),
        selectedTargetIds: ["shf_a", "shf_a"]
      }),
    /duplicate/i
  );
});

test("writeApprovalSnapshot refuses duplicate target ids in the candidate pool", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const targets = sampleTargets();
  targets[1]!.targetId = "shf_a";

  assert.throws(
    () =>
      writeApprovalSnapshot(home, session.id, {
        actionType: "trash-resolve",
        targets,
        selectedTargetIds: ["shf_a"]
      }),
    /duplicate/i
  );
});

test("writeApprovalSnapshot refuses a selected target with no exact subject context (no vague global approval)", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const vague: UiApprovalTarget = {
    targetId: "shf_vague",
    ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl",
    registryPath: null,
    recordPath: null,
    planId: null,
    actionType: "trash-resolve",
    label: "everything on ledger a"
  };

  assert.throws(
    () =>
      writeApprovalSnapshot(home, session.id, {
        actionType: "trash-resolve",
        targets: [vague],
        selectedTargetIds: ["shf_vague"]
      }),
    /exact|context|recordPath|planId|registryPath/i
  );
});

test("writeApprovalSnapshot refuses a target missing its owning ledger path", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const noLedger: UiApprovalTarget = {
    targetId: "shf_x",
    ledgerPath: "",
    registryPath: null,
    recordPath: "/tmp/x",
    planId: null,
    actionType: "trash-resolve",
    label: "missing ledger"
  };

  assert.throws(
    () =>
      writeApprovalSnapshot(home, session.id, {
        actionType: "trash-resolve",
        targets: [noLedger],
        selectedTargetIds: ["shf_x"]
      }),
    /ledgerPath/i
  );
});

test("revalidateApprovalSnapshot reports a fresh verdict when live facts reproduce the approved selection", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: sampleTargets(),
    selectedTargetIds: ["shf_a", "shf_b"],
    reviewed: { planId: "plan_a", total: 2 }
  });

  const verdict = revalidateApprovalSnapshot(snapshot, {
    targets: sampleTargets(),
    reviewed: { planId: "plan_a", total: 2 }
  });

  assert.equal(verdict.status, "fresh");
  assert.deepEqual(verdict.missingTargetIds, []);
  assert.deepEqual(verdict.changedTargetIds, []);
  assert.deepEqual(verdict.reviewedKeysDrifted, []);
  assert.equal(verdict.expectedFingerprint, snapshot.fingerprint);
  assert.equal(verdict.liveFingerprint, snapshot.fingerprint);
});

test("revalidateApprovalSnapshot flags a stored fingerprint mismatch as stale", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: sampleTargets(),
    selectedTargetIds: ["shf_a"],
    reviewed: { total: 1 }
  });

  const tamperedSnapshot = { ...snapshot, fingerprint: "0".repeat(64) };
  const verdict = revalidateApprovalSnapshot(tamperedSnapshot, {
    targets: sampleTargets(),
    reviewed: { total: 1 }
  });

  assert.equal(verdict.status, "stale");
  assert.equal(verdict.expectedFingerprint, tamperedSnapshot.fingerprint);
  assert.notEqual(verdict.liveFingerprint, tamperedSnapshot.fingerprint);
  assert.deepEqual(verdict.missingTargetIds, []);
  assert.deepEqual(verdict.changedTargetIds, []);
  assert.deepEqual(verdict.reviewedKeysDrifted, []);
});

test("revalidateApprovalSnapshot flags a vanished selected target as stale", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: sampleTargets(),
    selectedTargetIds: ["shf_a", "shf_b"],
    reviewed: { total: 2 }
  });

  // The agent re-reads live state and shf_b's subject is gone (already resolved out-of-band).
  const verdict = revalidateApprovalSnapshot(snapshot, {
    targets: [sampleTargets()[0]!],
    reviewed: { total: 2 }
  });

  assert.equal(verdict.status, "stale");
  assert.deepEqual(verdict.missingTargetIds, ["shf_b"]);
  assert.deepEqual(verdict.changedTargetIds, []);
  assert.notEqual(verdict.liveFingerprint, snapshot.fingerprint);
});

test("revalidateApprovalSnapshot flags a selected target whose exact subject drifted as stale", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: sampleTargets(),
    selectedTargetIds: ["shf_a", "shf_b"],
    reviewed: {}
  });

  // shf_a now points at a different record path than the human reviewed.
  const live = sampleTargets();
  live[0]!.recordPath = "/tmp/a-moved";
  const verdict = revalidateApprovalSnapshot(snapshot, { targets: live, reviewed: {} });

  assert.equal(verdict.status, "stale");
  assert.deepEqual(verdict.changedTargetIds, ["shf_a"]);
  assert.deepEqual(verdict.missingTargetIds, []);
  assert.notEqual(verdict.liveFingerprint, snapshot.fingerprint);
});

test("revalidateApprovalSnapshot flags drifted reviewed facts as stale", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: sampleTargets(),
    selectedTargetIds: ["shf_a"],
    reviewed: { planId: "plan_a", total: 2 }
  });

  // The live plan now reports a different total than what the human reviewed.
  const verdict = revalidateApprovalSnapshot(snapshot, {
    targets: sampleTargets(),
    reviewed: { planId: "plan_a", total: 5 }
  });

  assert.equal(verdict.status, "stale");
  assert.deepEqual(verdict.reviewedKeysDrifted, ["total"]);
  assert.deepEqual(verdict.changedTargetIds, []);
  assert.deepEqual(verdict.missingTargetIds, []);
});

test("revalidateApprovalSnapshot ignores drift in unselected candidate rows", () => {
  const home = freshHome();
  const session = startUserSession(home);
  // Only shf_a is approved; shf_b is an unselected candidate that was merely shown.
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: sampleTargets(),
    selectedTargetIds: ["shf_a"],
    reviewed: {}
  });

  // shf_b drifts in live state, but it was never part of the approved action.
  const live = [sampleTargets()[0]!, { ...sampleTargets()[1]!, recordPath: "/tmp/b-moved" }];
  const verdict = revalidateApprovalSnapshot(snapshot, { targets: live, reviewed: {} });

  assert.equal(verdict.status, "fresh");
  assert.deepEqual(verdict.changedTargetIds, []);
  assert.deepEqual(verdict.missingTargetIds, []);
  assert.equal(verdict.liveFingerprint, snapshot.fingerprint);
});

test("revalidateApprovalSnapshot ignores property order in live targets and reviewed facts", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const snapshot = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: sampleTargets(),
    selectedTargetIds: ["shf_a"],
    reviewed: { planId: "plan_a", total: 2 }
  });

  // Same facts, different property insertion order in both the target row and the reviewed map.
  const reordered: UiApprovalTarget = {
    label: "trash scratch a",
    actionType: "trash-resolve",
    planId: "plan_a",
    recordPath: "/tmp/a",
    registryPath: null,
    ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl",
    targetId: "shf_a"
  };
  const verdict = revalidateApprovalSnapshot(snapshot, {
    targets: [reordered],
    reviewed: { total: 2, planId: "plan_a" }
  });

  assert.equal(verdict.status, "fresh");
  assert.deepEqual(verdict.changedTargetIds, []);
  assert.deepEqual(verdict.reviewedKeysDrifted, []);
});

test("listApprovalSnapshots returns every persisted bundle for a session and is empty when none exist", () => {
  const home = freshHome();
  const session = startUserSession(home);

  // A session with no approved bundles lists nothing, even before any bundles dir is created.
  assert.deepEqual(listApprovalSnapshots(home, session.id), []);

  const first = writeApprovalSnapshot(home, session.id, {
    actionType: "trash-resolve",
    targets: sampleTargets(),
    selectedTargetIds: ["shf_a"],
    reviewed: { planId: "plan_a", total: 2 }
  });
  const second = writeApprovalSnapshot(home, session.id, {
    actionType: "resolve-only",
    targets: sampleTargets(),
    selectedTargetIds: ["shf_b"],
    reviewed: { planId: "plan_b", total: 2 }
  });

  const listed = listApprovalSnapshots(home, session.id);
  // Every persisted bundle is returned, each an exact round-trip of its stored snapshot.
  assert.equal(listed.length, 2);
  const byId = new Map(listed.map((bundle) => [bundle.id, bundle]));
  assert.deepEqual(byId.get(first.id), readApprovalSnapshot(home, session.id, first.id));
  assert.deepEqual(byId.get(second.id), readApprovalSnapshot(home, session.id, second.id));
  // Listing is deterministic: a second call yields the same bundles in the same order.
  assert.deepEqual(
    listApprovalSnapshots(home, session.id).map((bundle) => bundle.id),
    listed.map((bundle) => bundle.id)
  );
});
