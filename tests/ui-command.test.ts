import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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

function ui(home: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI.pathname, ...args], {
    encoding: "utf8",
    env: { ...process.env, ARTSHELF_NO_UPDATE_CHECK: "1", ARTSHELF_UI_HOME: home }
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function startSession(home: string, args: string[] = []): any {
  const result = ui(home, ["ui", ...args, "--json"]);
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
  for (const sub of ["poll", "reply", "bundle", "end"]) assert.match(family.stdout, new RegExp(`\\b${sub}\\b`));

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
