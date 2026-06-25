import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendEvent,
  approvalSnapshotFingerprint,
  endSession,
  pollPendingEvents,
  readApprovalSnapshot,
  readReplies,
  readSession,
  readSessionEvents,
  replyToEvent,
  resolveUiHome,
  startOrResumeSession,
  validateBrowserToken,
  writeApprovalSnapshot
} from "../src/session.js";
import type { UiApprovalTarget } from "../src/types.js";

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

test("startOrResumeSession resumes the active session instead of creating a second one", () => {
  const home = freshHome();
  const first = startUserSession(home);
  const second = startUserSession(home);

  assert.equal(second.id, first.id);
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
  assert.throws(() => readSession(home, "session_missing"), /session_missing/);
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

test("appendEvent refuses browser writes once the session has ended", () => {
  const home = freshHome();
  const session = startUserSession(home);
  endSession(home, session.id);

  assert.throws(
    () => appendEvent(home, session.id, { type: "comment_added", payload: { text: "too late" } }),
    /ended/i
  );
});

test("replyToEvent advances event status, clears it from the poll queue, and is durable", () => {
  const home = freshHome();
  const session = startUserSession(home);
  const event = appendEvent(home, session.id, { type: "dry_run_requested", target: { planId: "plan_a" } });

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
    reviewed: { planId: "plan_a", total: 2 }
  });

  assert.match(snapshot.id, /^bundle_/);
  assert.equal(snapshot.sessionId, session.id);
  assert.equal(snapshot.fingerprint, approvalSnapshotFingerprint(targets, { planId: "plan_a", total: 2 }));

  const persisted = join(home, "sessions", session.id, "bundles", `${snapshot.id}.json`);
  assert.equal(existsSync(persisted), true);
  assert.deepEqual(readApprovalSnapshot(home, session.id, snapshot.id), snapshot);
});
