import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createDisposePlan } from "../src/dispose.js";
import { readLedger } from "../src/ledger.js";
import { appendEvent, writeApprovalSnapshot } from "../src/session.js";
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
  for (const sub of ["poll", "reply", "bundle", "execute", "end"]) assert.match(family.stdout, new RegExp(`\\b${sub}\\b`));

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

// Persist an approval bundle plus the approval_bundle_submitted event the browser would have appended
// for it, so the agent's execute path has a real event to reply receipts against.
function seedApprovedBundle(home: string, sessionId: string, targets: UiApprovalTarget[], selectedTargetIds: string[], registryPath: string) {
  const snapshot = writeApprovalSnapshot(home, sessionId, { actionType: "trash-resolve", targets, selectedTargetIds, reviewed: {} });
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
