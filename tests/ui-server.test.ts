import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createDisposePlan, disposePlanEntryDigest, readDisposePlanEntry } from "../src/dispose.js";
import { artifactIdentityFacts } from "../src/file-identity.js";
import { readLedger } from "../src/ledger.js";
import { escapeHtml, renderErrorPage } from "../src/renderers/ui-html.js";
import {
  appendEvent,
  endSession,
  listApprovalSnapshots,
  pollPendingEvents,
  readApprovalSnapshot,
  readSessionEvents,
  readSessionHistory,
  replyToEvent,
  startOrResumeSession,
  writeApprovalSnapshot
} from "../src/session.js";
import { createUiServer, startUiServer } from "../src/ui-server.js";
import { executeApprovedBundle } from "../src/ui-execute.js";

// Tests for the loopback browser surface (Artshelf UI v1 contract slice 2). NGX-535's
// dashboard, NGX-536's detail drawer, and NGX-537's needs-context presentation all named the
// actual browser-rendered experience as their missing acceptance area; this exercises it end to
// end. The server is started in-process on an ephemeral loopback port and driven over real HTTP,
// so the assertions cover the rendered HTML a browser would receive. The clock is pinned and the
// registry is always passed explicitly so ages/due classification stay deterministic and a real
// registry never leaks. The read surfaces never embed file contents, and the browser's only write
// path is capturing human triage intents (NGX-538); it must never mutate ledgers, files, trash, or
// plans directly.

process.env.ARTSHELF_NO_UPDATE_CHECK = "1";
process.env.ARTSHELF_NOW = "2026-06-25T12:00:00.000Z";
delete process.env.ARTSHELF_REGISTRY;

const PAST_DUE = "2026-06-20T00:00:00.000Z";
const CREATED = "2026-06-01T00:00:00.000Z";

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "artshelf-ui-server-"));
}

function writeLedgerFile(ledgerPath: string, records: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function writeRegistry(registryPath: string, ledgers: Array<{ name: string; path: string; scope?: string }>): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  const entries = ledgers.map((ledger) => ({
    name: ledger.name,
    path: ledger.path,
    scope: ledger.scope ?? "other",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  }));
  writeFileSync(registryPath, JSON.stringify({ version: 1, ledgers: entries }, null, 2) + "\n");
}

function baseRecord(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "shf_1",
    path: "/does/not/exist/file.txt",
    kind: "scratch",
    reason: "fixture artifact",
    createdAt: CREATED,
    retention: { mode: "manual-review" },
    cleanup: "review",
    owner: "manual",
    labels: [],
    status: "active",
    ...over
  };
}

function realFile(dir: string, name: string): string {
  const target = join(dir, name);
  writeFileSync(target, "x");
  return target;
}

function dueCleanupRecord(dir: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return baseRecord({
    id: "shf_cleanup",
    path: realFile(dir, "scratch.txt"),
    retention: { mode: "ttl", ttl: "1d" },
    retainUntil: PAST_DUE,
    cleanup: "trash",
    ...over
  });
}

// An already-trashed record, eligible for the purge-candidate lane. The target path is a plain
// fixture path: the dashboard purge preview only needs trash provenance, never a file on disk.
function trashedRecord(id: string, planId: string): Record<string, unknown> {
  return baseRecord({
    id,
    status: "trashed",
    path: `/orig/${id}.txt`,
    targetPath: `/trash/${planId}/${id}.txt`,
    cleanedAt: "2026-06-10T00:00:00.000Z",
    receiptPath: `/receipts/${planId}.json`,
    cleanupPlanId: planId
  });
}

// A single-ledger registry rooted in a fresh temp dir holding exactly the given records.
function singleLedger(records: Array<Record<string, unknown>>): { registryPath: string; ledgerPath: string; dir: string } {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, records);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);
  return { registryPath, ledgerPath, dir };
}

type TestResponse = {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

// GET reads only need a method/headers; the NGX-538 intent endpoint also needs a request body and
// manual redirect handling so the 303 PRG response can be asserted rather than transparently followed.
type RequestInit = { method?: string; headers?: Record<string, string>; body?: string; redirect?: string };

type ServerHandle = {
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
  request(path: string, init?: RequestInit): Promise<TestResponse>;
  requestRaw(path: string, init?: RequestInit): Promise<TestResponse>;
  // The session the server is bound to, so intent-write tests can assert the durable event log directly.
  home: string;
  sessionId: string;
  token: string;
};

type TestSession = {
  home: string;
  sessionId: string;
  token: string;
};

function createTestSession(registryPath?: string): TestSession {
  const home = join(fixtureDir(), "ui");
  const session = startOrResumeSession({ home, scope: "user", ledgerPath: null, registryPath: registryPath ?? null });
  return { home, sessionId: session.id, token: session.token };
}

// Start the read-only server on an ephemeral loopback port for one fixture, run the body, and
// always close so no test leaks a listening socket.
async function withServer(
  options: { registryPath: string; ledgerPath?: string },
  body: (handle: ServerHandle) => Promise<void>
): Promise<void> {
  const handle = await startTestServer(options);
  try {
    await body(handle);
  } finally {
    await handle.close();
  }
}

async function startTestServer(options: { registryPath: string; ledgerPath?: string }): Promise<ServerHandle> {
  const session = createTestSession(options.registryPath);
  try {
    const serverOptions = {
      port: 0,
      registryPath: options.registryPath,
      uiHome: session.home,
      sessionId: session.sessionId
    };
    if (options.ledgerPath !== undefined) Object.assign(serverOptions, { ledgerPath: options.ledgerPath });
    const handle = await startUiServer(serverOptions);
    return {
      ...handle,
      home: session.home,
      sessionId: session.sessionId,
      token: session.token,
      request: (path, init) => fetch(`${handle.url}${withToken(path, session.token)}`, init),
      requestRaw: (path, init) => fetch(`${handle.url}${path}`, init)
    };
  } catch (error) {
    if (!isListenPermissionError(error)) throw error;
    const serverOptions = {
      registryPath: options.registryPath,
      uiHome: session.home,
      sessionId: session.sessionId
    };
    if (options.ledgerPath !== undefined) Object.assign(serverOptions, { ledgerPath: options.ledgerPath });
    const server = createUiServer(serverOptions);
    return {
      url: "http://127.0.0.1:0",
      host: "127.0.0.1",
      port: 0,
      close: async () => undefined,
      home: session.home,
      sessionId: session.sessionId,
      token: session.token,
      request: (path, init) => requestInProcess(server, withToken(path, session.token), init),
      requestRaw: (path, init) => requestInProcess(server, path, init)
    };
  }
}

function withToken(path: string, token: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isListenPermissionError(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: string }).code === "EPERM";
}

function requestInProcess(server: any, path: string, init: RequestInit = {}): Promise<TestResponse> {
  return new Promise<TestResponse>((resolve) => {
    let status = 200;
    const headers = new Map<string, string>();
    let body = "";
    // The intent endpoint reads the request body off the stream, so the synthetic request must
    // replay a body to its data/end listeners after the handler has registered them.
    const dataListeners: Array<(chunk: string) => void> = [];
    const endListeners: Array<() => void> = [];
    const request = {
      method: init.method ?? "GET",
      url: path,
      headers: init.headers ?? {},
      on(event: string, callback: (arg?: any) => void) {
        if (event === "data") dataListeners.push(callback as (chunk: string) => void);
        else if (event === "end") endListeners.push(callback as () => void);
        return request;
      }
    };
    const response = {
      writeHead(nextStatus: number, nextHeaders: Record<string, string>) {
        status = nextStatus;
        for (const [name, value] of Object.entries(nextHeaders)) headers.set(name.toLowerCase(), value);
      },
      end(value: string) {
        body = value;
        resolve({
          status,
          headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
          text: async () => body
        });
      }
    };
    server.emit("request", request, response);
    if (init.body !== undefined) for (const listener of dataListeners) listener(init.body);
    for (const listener of endListeners) listener();
  });
}

function formBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function appendReviewedLaneRow(
  params: URLSearchParams,
  lane: "needs-review" | "needs-context" | "cleanup" | "resolve",
  recordId: string,
  ledgerPath: string
): void {
  params.append(`reviewed:${lane}`, `${encodeURIComponent(recordId)}:${encodeURIComponent(ledgerPath)}`);
}

function reviewedLaneRowValue(recordId: string, ledgerPath: string): string {
  return `${encodeURIComponent(recordId)}:${encodeURIComponent(ledgerPath)}`;
}

async function appendRenderedCleanupFacts(server: ServerHandle, params: URLSearchParams): Promise<void> {
  const response = await (await server.request(`/?token=${encodeURIComponent(server.token)}`)).text();
  const matches = [...response.matchAll(/name="reviewed:cleanup:facts" value="([^"]+)"/g)];
  assert.ok(matches.length > 0, "dashboard should render signed reviewed cleanup row facts");
  for (const match of matches) params.append("reviewed:cleanup:facts", match[1]!);
}

// Submit a browser triage intent exactly as the rendered HTML form would: a urlencoded POST to
// /intents carrying the capability token in the body. `noToken` drops it to exercise the write gate.
function postIntent(
  server: ServerHandle,
  fields: Record<string, string>,
  options: { noToken?: boolean } = {}
): Promise<TestResponse> {
  const body = formBody(options.noToken ? fields : { ...fields, token: server.token });
  return server.requestRaw("/intents", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual"
  });
}

function approvalBody(fields: {
  token?: string;
  sourceBundleId: string;
  selectedTargetIds: string[];
  actionType?: string;
  targets?: Array<Record<string, unknown>>;
  reviewed?: Record<string, unknown>;
}): string {
  const params = new URLSearchParams();
  if (fields.token !== undefined) params.append("token", fields.token);
  params.append("sourceBundleId", fields.sourceBundleId);
  if (fields.actionType !== undefined) params.append("actionType", fields.actionType);
  if (fields.reviewed !== undefined) params.append("reviewed", JSON.stringify(fields.reviewed));
  for (const target of fields.targets ?? []) params.append("target", JSON.stringify(target));
  for (const id of fields.selectedTargetIds) params.append("targetId", id);
  return params.toString();
}

function postApproval(
  server: ServerHandle,
  fields: {
    sourceBundleId: string;
    selectedTargetIds: string[];
    actionType?: string;
    targets?: Array<Record<string, unknown>>;
    reviewed?: Record<string, unknown>;
  },
  options: { noToken?: boolean } = {}
): Promise<TestResponse> {
  const bodyFields: {
    token?: string;
    sourceBundleId: string;
    selectedTargetIds: string[];
    actionType?: string;
    targets?: Array<Record<string, unknown>>;
    reviewed?: Record<string, unknown>;
  } = {
    ...fields
  };
  if (!options.noToken) bodyFields.token = server.token;
  return server.requestRaw("/approve", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: approvalBody(bodyFields),
    redirect: "manual"
  });
}

test("escapeHtml neutralizes the HTML metacharacters", () => {
  assert.equal(escapeHtml(`<script>"x"&'y'`), "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;");
});

test("renderErrorPage is a full, script-free HTML document carrying the status and message", () => {
  const page = renderErrorPage({ status: 404, title: "Not found", message: "no such record shf_missing" });
  assert.match(page, /^<!doctype html>/i);
  assert.match(page, /404/);
  assert.match(page, /no such record shf_missing/);
  assert.doesNotMatch(page, /<script/i);
});

test("GET / renders the eight buckets, ledger health, and a row that links to its detail drawer", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir)]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const response = await server.request("/");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();

    // First viewport: the non-empty cleanup lane and ledger health for the registered ledger.
    assert.match(html, /id="lane-cleanup"/, "dashboard should show the cleanup lane when it has rows");
    assert.doesNotMatch(html, /id="lane-recent-receipts"/, "dashboard should hide empty lanes");
    assert.match(html, /primary/, "ledger health should name the registered ledger");

    // The cleanup row exposes minimum human-judgment fields and links to the NGX-536 drawer.
    assert.match(html, /shf_cleanup/);
    assert.match(html, /fixture artifact/);
    assert.match(html, /scratch\.txt/, "dashboard row should show the recorded artifact path label");
    assert.match(html, /trash-safe/);
    assert.match(html, new RegExp(`/detail/shf_cleanup\\?ledger=`), "row should link to its detail drawer");
    assert.match(html, new RegExp(`token=${server.token}`), "served dashboard links should carry the explicit URL capability");
  });
});

test("plain ui serve omits managed close controls and rejects close posts", async () => {
  const { registryPath } = singleLedger([baseRecord({ id: "shf_known" })]);

  await withServer({ registryPath }, async (server) => {
    const response = await server.request("/");
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.doesNotMatch(html, /Close review/);
    assert.doesNotMatch(html, /managed-review-close-form/);

    const close = await server.requestRaw("/close", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ token: server.token }),
      redirect: "manual"
    });
    assert.equal(close.status, 405);
    assert.equal(readSessionEvents(server.home, server.sessionId).some((event) => event.type === "session_done" && event.source === "browser"), false);
  });
});

// Isolate the rendered purge-candidate lane: from its lane heading up to the next lane heading,
// so assertions about purge grouping and warning copy never collide with the plain trash lane
// (trashed records appear in both lanes).
function purgeLaneHtml(html: string): string {
  const start = html.indexOf('id="lane-purge-candidates"');
  assert.ok(start >= 0, "dashboard should render the purge-candidates lane");
  const rest = html.slice(start);
  const next = rest.indexOf('id="lane-registry-reconcile"');
  return next >= 0 ? rest.slice(0, next) : rest;
}

function requiredActionsHtml(html: string): string {
  const start = html.indexOf('id="required-actions"');
  assert.ok(start >= 0, "dashboard should render required actions");
  const rest = html.slice(start);
  const next = rest.indexOf("Status at a glance");
  return next >= 0 ? rest.slice(0, next) : rest;
}

function sessionActivityHtml(html: string): string {
  const start = html.indexOf('<section class="block session-activity" id="session-activity"');
  assert.ok(start >= 0, "dashboard should render session activity");
  const rest = html.slice(start);
  const end = rest.indexOf("</section>");
  assert.ok(end >= 0, "dashboard should close session activity");
  return rest.slice(0, end + "</section>".length);
}

function laneHtml(html: string, laneId: string): string {
  const start = html.indexOf(`id="${laneId}"`);
  assert.ok(start >= 0, `dashboard should render ${laneId}`);
  const rest = html.slice(start);
  const next = rest.indexOf("</details>");
  return next >= 0 ? rest.slice(0, next) : rest;
}

test("GET / renders the purge lane grouped by source with one-way-door warning copy (NGX-541)", async () => {
  const dir = fixtureDir();
  const primaryLedger = join(dir, "primary", "ledger.jsonl");
  const secondaryLedger = join(dir, "secondary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  // Two sources so the lane must group by ledger and show a per-source total.
  writeLedgerFile(primaryLedger, [trashedRecord("shf_a1", "plan_a"), trashedRecord("shf_a2", "plan_a")]);
  writeLedgerFile(secondaryLedger, [trashedRecord("shf_b1", "plan_b")]);
  writeRegistry(registryPath, [
    { name: "primary", path: primaryLedger },
    { name: "secondary", path: secondaryLedger }
  ]);

  await withServer({ registryPath }, async (server) => {
    const html = await (await server.request("/")).text();
    const lane = purgeLaneHtml(html);

    // One-way-door safety copy: irreversibility, no recovery, and nothing preselected.
    assert.match(lane, /one-way door/i, "purge lane should warn it is a one-way door");
    assert.match(lane, /no recovery/i, "purge lane should state there is no recovery path");
    assert.match(lane, /selected by default/i, "purge lane should state nothing is preselected");

    // Grouped by source with a per-group total, exact targets shown.
    assert.match(lane, /primary/, "purge lane should name the primary source group");
    assert.match(lane, /secondary/, "purge lane should name the secondary source group");
    assert.match(lane, /2 candidate/, "primary group should show its total of 2");
    assert.match(lane, /1 candidate/, "secondary group should show its total of 1");
    assert.match(lane, /shf_a1/);
    assert.match(lane, /shf_b1/);
    assert.match(lane, new RegExp("/trash/plan_a/shf_a1\\.txt"), "exact purge target path is shown before approval");

    // Read-only lane: nothing preselected and no browser-direct purge execution affordance. The lane
    // may record a review request for the agent, but permanent deletion still happens only through
    // the later approval workbench and ui execute path.
    assert.doesNotMatch(lane, /checked/i, "no purge candidate is selected by default");
    assert.doesNotMatch(lane, /trash purge --execute|ui execute/i, "purge lane must not expose direct execution controls");
    assert.match(lane, /data-approval-value="request:purge-candidates:review_delete_forever"/, "the card queues only an agent review request");
    assert.match(lane, /<span class="rec-action">Prepare delete review<\/span>/, "the card recommendation names the review request");
  });
});

test("GET / keeps non-action trash and receipt rows visible as read-only activity", async () => {
  const receipt = baseRecord({
    id: "shf_receipt",
    owner: "artshelf",
    labels: ["cleanup-receipt"],
    kind: "run-artifact",
    path: "/receipts/cleanup-plan.json",
    reason: "cleanup receipt for reviewed artifacts",
    createdAt: "2026-06-23T00:00:00.000Z"
  });
  const { registryPath } = singleLedger([trashedRecord("shf_trash", "plan_t"), receipt]);

  await withServer({ registryPath }, async (server) => {
    const html = await (await server.request("/")).text();
    const trash = laneHtml(html, "lane-trash");
    const receipts = laneHtml(html, "lane-recent-receipts");

    assert.match(trash, /In trash/, "trash lane should be visible when trash rows exist");
    assert.match(trash, /shf_trash/);
    assert.match(trash, /\/trash\/plan_t\/shf_trash\.txt/);
    assert.match(trash, /\/receipts\/plan_t\.json/);
    assert.match(trash, /quarantined/i);
    assert.doesNotMatch(trash, /name="approval:/, "trash activity rows are read-only and not queued approvals");

    assert.match(receipts, /Recent receipts/, "recent receipt lane should be visible when receipt rows exist");
    assert.match(receipts, /shf_receipt/);
    assert.match(receipts, /cleanup/);
    assert.match(receipts, /cleanup receipt for reviewed artifacts/);
    assert.match(receipts, /\/receipts\/cleanup-plan\.json/);
    assert.match(receipts, /Details/, "receipt rows still link to their detail drawer");
    assert.doesNotMatch(receipts, /name="approval:/, "recent receipt rows are read-only and not queued approvals");
  });
});

test("GET / routes a weak-reason record into needs-context and out of the cleanup lane (NGX-537)", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  // Blank reason makes this otherwise cleanup-ready row un-reviewable; the browser must present it
  // in the needs-context lane with its display copy, not offer a cleanup action.
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir, { id: "shf_weak", reason: "   " })]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const html = await (await server.request("/")).text();
    assert.match(html, /shf_weak/);
    assert.match(html, /add context/i, "needs-context display copy should be shown");
  });
});

test("GET / renders the redesigned top fold, queued actions, and non-empty review lanes", async () => {
  const dir = fixtureDir();
  const primaryLedger = join(dir, "primary", "ledger.jsonl");
  const secondaryLedger = join(dir, "secondary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  // A purge candidate (one-way door) and a cleanup candidate across two sources, so the top fold,
  // the source filter, and the per-stage grouping all have something to render.
  writeLedgerFile(primaryLedger, [dueCleanupRecord(dir), trashedRecord("shf_p1", "plan_p")]);
  writeLedgerFile(secondaryLedger, [trashedRecord("shf_s1", "plan_s")]);
  writeRegistry(registryPath, [
    { name: "primary", path: primaryLedger },
    { name: "secondary", path: secondaryLedger }
  ]);

  await withServer({ registryPath }, async (server) => {
    const html = await (await server.request("/")).text();
    const required = requiredActionsHtml(html);

    // Top fold: a required-actions section that stays terse and queues recommended actions for one
    // final submit,
    // plus an at-a-glance status summary.
    assert.match(required, /Required actions/i, "the top fold names the required actions");
    assert.doesNotMatch(required, /Why this is here/i, "required action cards should not repeat explanatory body copy");
    assert.doesNotMatch(required, /What the button does/i, "required action cards should not repeat explanatory body copy");
    assert.match(required, /Can delete forever/i, "the purge lane is named in human terms");
    assert.match(required, /Ready to clean up/i, "cleanup work is named in human terms");
    assert.doesNotMatch(required, /Needs your choice/i, "required action cards should not repeat the title in a second label");
    assert.match(required, /<span class="rec-label">Agent recommends<\/span> <span class="rec-action">Move to trash<\/span> because they are due and appear unused\./, "the top fold highlights the recommended action");
    assert.doesNotMatch(html, /\.act::before/, "required action cards should not use a left border rail");
    assert.match(required, /<summary>\s*<span class="toggle-copy">.*?<\/span>\s*<div class="n num">/s, "required action cards put the chevron at the left edge");
    assert.doesNotMatch(required, /Show items/, "required action cards should not show a separate item-toggle label");
    assert.doesNotMatch(required, />Rows</, "required actions should not use a separate rows button");
    assert.doesNotMatch(required, /\b\d+%/, "the top fold should not use vague confidence percentages");
    assert.match(html, /class="review-form review-shell" method="post" action="\/intents"/, "the dashboard shell is one global submit form");
    assert.match(html, /<form class="review-form review-shell"[\s\S]*?<main class="review-main"><header class="top">/, "the masthead lives in the left split pane");
    assert.match(html, /<aside class="agent-rail" aria-label="Agent loop">/, "the agent loop lives in the right rail");
    assert.match(html, /\.agent-rail\{[^}]*min-height:100vh/, "the agent rail spans the dashboard height");
    assert.match(html, /\.agent-rail-inner\{[^}]*height:100vh/, "the agent rail content is viewport-height and sticky");
    assert.match(html, /\.agent-rail \.required-submit\{[^}]*position:sticky/, "the queued-for-agent submit box stays pinned in the rail");
    assert.match(
      html,
      /<aside class="agent-rail"[\s\S]*?<div class="required-submit">[\s\S]*?<section class="block session-activity"/,
      "the queued-for-agent submit controls sit above the compact activity rail"
    );
    assert.match(html, /name="reviewed:cleanup"/, "bulk approval forms bind the reviewed cleanup row set");
    assert.match(required, /name="approval:cleanup" value="request:cleanup:prepare_cleanup_plan"/, "the top fold can queue a reviewed cleanup plan request");
    assert.match(required, /name="approval:cleanup" value="decision:cleanup:trash"/, "the top fold can queue a recommended bulk decision");
    assert.match(required, /name="approval:purge-candidates" value="request:purge-candidates:review_delete_forever"/, "the top fold can queue a review request");
    assert.match(
      required,
      /<summary>[\s\S]*?<label class="approve-choice" data-approval-value="request:cleanup:prepare_cleanup_plan"><input type="checkbox" name="approval:cleanup" value="request:cleanup:prepare_cleanup_plan"><span class="approve">Prepare<\/span><span class="queued">Queued<\/span><\/label>[\s\S]*?<\/summary>/,
      "the cleanup card exposes the reviewed cleanup-plan request in the visible summary"
    );
    assert.match(
      required,
      /<summary>[\s\S]*?<label class="approve-choice" data-approval-value="decision:cleanup:trash"><input type="checkbox" name="approval:cleanup" value="decision:cleanup:trash"><span class="approve">Approve<\/span><span class="queued">Queued<\/span><\/label>[\s\S]*?<\/summary>/,
      "the required action toggles between Approve and Queued in the always-visible summary control"
    );
    assert.doesNotMatch(required, /queued-pill/, "required actions should not use a separate queued status control");
    assert.equal(
      (html.match(/<label class="(?:approve-choice|bulk-choice[^"]*)" data-approval-value="decision:cleanup:trash"/g) ?? []).length,
      2,
      "the required action and the matching row bulk choice share one queued selection value"
    );
    assert.match(html, /Queued for agent/, "the global submit shows the queued actions area");
    assert.match(html, /Nothing selected yet\./, "the queued actions area is explicit before selection");
    assert.match(html, /Prepare delete review for 2 row\(s\)/, "the queued list describes the purge request");
    assert.match(html, /Prepare cleanup plan for 1 row\(s\)/, "the queued list describes the cleanup plan request");
    assert.match(html, /Trash 1 ready to clean up row\(s\)/, "the queued list describes cleanup decisions");
    assert.match(
      html,
      /<label class="bulk-choice danger" data-approval-value="decision:cleanup:trash"><input type="checkbox" name="approval:cleanup" value="decision:cleanup:trash"><span class="choose">Trash all<\/span><span class="queued">Queued<\/span><\/label>/,
      "review queue bulk choices toggle between the action and Queued in one control"
    );
    assert.match(
      html,
      /<label class="row-choice danger" data-approval-value="row-decision:cleanup:trash:shf_cleanup:[^"]+"><input type="checkbox" name="approval:cleanup:row:shf_cleanup:[^"]+" value="row-decision:cleanup:trash:shf_cleanup:[^"]+"><span class="choose">Trash<\/span><span class="queued">Queued<\/span><\/label>/,
      "expanded rows can queue an exact row-level trash decision"
    );
    assert.match(
      html,
      /\.act > summary:has\(\.approve-choice input:checked\) \.approve-choice:not\(:has\(input:checked\)\)/,
      "summary controls disable peer summary choices while one choice is queued"
    );
    assert.match(
      html,
      /\.choice-row:has\(\.bulk-choice input:checked\) \.bulk-choice:not\(:has\(input:checked\)\)/,
      "review queue choices disable the unselected peer while one choice is queued"
    );
    assert.match(
      html,
      /\.act-body:has\(\.row-choice input:checked\) \.lane-actions \.bulk-choice/,
      "row choices disable bulk choices while exact rows are queued"
    );
    assert.match(
      html,
      /\.act:has\(\.bulk-choice input:checked\) > summary \.approve-choice/,
      "bulk choices disable the always-visible card approval while a bulk choice is queued"
    );
    assert.match(
      html,
      /\.act:has\(> summary \.approve-choice input:checked\) \.lane-actions \.bulk-choice/,
      "the always-visible card approval disables expanded bulk choices while it is queued"
    );
    assert.doesNotMatch(html, /queued-pill|clear-choice|data-clear-lane/, "review queue choices should not need separate queued or remove controls");
    assert.match(html, /Submit selected to agent/, "the page has one final submit for queued approvals");
    assert.doesNotMatch(html, /name="lane" value="purge-candidates"/, "lane controls should not submit separately from the global form");
    assert.doesNotMatch(html, /Review queue &middot; across the workflow cycle/, "action rows should live inside required action cards, not a separate review queue");
    assert.match(html, /one-way door/i, "the purge action card carries the one-way-door warning");
    assert.match(html, /Status at a glance/i, "the status summary is present");

    // The required action cards now own the expandable row lists, so no separate filterable queue is rendered.
    assert.doesNotMatch(html, /name="flt-zone"/, "zone filters are not rendered");
    assert.doesNotMatch(html, /name="flt-led"/, "source filters are not rendered");
    assert.doesNotMatch(html, /id="lane-needs-review"/, "empty lanes are hidden");
    assert.doesNotMatch(html, /id="lane-needs-context"/, "empty lanes are hidden");
    assert.match(html, /<details class="act calm" id="lane-cleanup"[^>]*data-zone="action"/, "non-empty cleanup card is rendered");
    assert.match(html, /<details class="act danger" id="lane-purge-candidates"[^>]*data-zone="quarantine"/, "non-empty purge card is rendered");
    assert.match(html, /data-ledger="led-0"/, "rows carry stable ledger tokens without raw ledger names in selectors");

    // Queue selection remains CSS/form based; the only script is the token-scoped activity poller.
    assert.match(html, /data-activity-href="\/activity\?token=/, "the only progressive enhancement polls session activity");
    assert.doesNotMatch(html, /src=/i, "the dashboard must not load external scripts or assets");
  });
});

test("POST /intents records required-action approvals only after the final submit", async () => {
  const dir = fixtureDir();
  const primaryLedger = join(dir, "primary", "ledger.jsonl");
  const secondaryLedger = join(dir, "secondary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(primaryLedger, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeLedgerFile(secondaryLedger, [trashedRecord("shf_purge_a", "plan_p")]);
  writeRegistry(registryPath, [
    { name: "primary", path: primaryLedger },
    { name: "secondary", path: secondaryLedger }
  ]);

  await withServer({ registryPath }, async (server) => {
    await server.request("/");
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "loading and selecting in-page state does not queue agent work");

    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:cleanup", "decision:cleanup:trash");
    params.append("approval:cleanup", "decision:cleanup:trash");
    params.append("approval:purge-candidates", "request:purge-candidates:review_delete_forever");
    params.append("approval:needs-review", "");
    params.append("approval:registry-reconcile", "");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_a", primaryLedger);
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_b", primaryLedger);

    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `/?token=${encodeURIComponent(server.token)}&queued=3#session-activity`);

    const pending = pollPendingEvents(server.home, server.sessionId);
    assert.equal(pending.length, 3, "one final submit expands selected approvals into exact session events");
    assert.equal(pending.filter((event) => event.type === "decision_submitted").length, 2);
    assert.equal(pending.filter((event) => event.type === "dry_run_requested").length, 1);
    assert.deepEqual(
      pending
        .filter((event) => event.type === "decision_submitted")
        .map((event) => event.payload.decision),
      ["trash", "trash"],
      "duplicate identical lane-scoped values are tolerated"
    );
    assert.deepEqual(
      pending
        .filter((event) => event.type === "decision_submitted")
        .map((event) => event.target.recordId)
        .sort(),
      ["shf_cleanup_a", "shf_cleanup_b"]
    );
    const request = pending.find((event) => event.type === "dry_run_requested")!;
    assert.deepEqual(request.target, { lane: "purge-candidates", registryPath });
    assert.equal(request.payload.request, "review_delete_forever");
    assert.equal(request.payload.label, "Review delete");
  });
});

test("POST /intents redirects to a dashboard confirmation with visible queued activity", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:cleanup", "decision:cleanup:trash");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_a", ledgerPath);
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_b", ledgerPath);

    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `/?token=${encodeURIComponent(server.token)}&queued=2#session-activity`);

    const html = await (await server.request("/?queued=2")).text();
    assert.match(html, /2 decisions queued for agent/i, "dashboard should confirm the submitted batch immediately");
    assert.match(html, /Queue activity/i, "queued work should be visible without opening a detail drawer");
    assert.match(html, /Queued: <span class="num">2<\/span>/i, "activity should distinguish currently queued work from handled replies");
    assert.match(html, /cleanup/i, "activity should group queued work by lane/action");
    assert.match(html, /shf_cleanup_a/);
    assert.match(html, /shf_cleanup_b/);
    assert.match(html, /Sent to agent/i, "affected dashboard rows should be visibly marked after submit");
    assert.match(html, /No execution ran/i, "dry-run/queued states must carry the safety line");
    assert.match(
      html,
      /<button type="submit" disabled>Submit selected to agent<\/button>/,
      "a queued-only dashboard should not render an active empty submit"
    );
    const activity = sessionActivityHtml(html);
    assert.doesNotMatch(activity, /2 decisions queued for agent/i, "queued confirmation should stay outside the polled activity fragment");
    assert.equal(
      activity,
      await (await server.request("/activity")).text(),
      "queued confirmation should not make the poller refresh the shell repeatedly"
    );
    const required = requiredActionsHtml(html);
    assert.match(
      required,
      /class="approve-choice submitted" data-approval-value="decision:cleanup:trash"><input type="checkbox" name="approval:cleanup" value="decision:cleanup:trash" checked disabled><span class="approve">Approve<\/span><span class="queued">Queued<\/span>/,
      "a submitted lane approval should stay visibly queued after redirect"
    );
    assert.match(
      required,
      /class="bulk-choice danger submitted" data-approval-value="decision:cleanup:trash"><input type="checkbox" name="approval:cleanup" value="decision:cleanup:trash" checked disabled><span class="choose">Trash all<\/span><span class="queued">Queued<\/span>/,
      "the matching bulk control should stay queued while the agent has not replied"
    );
    assert.match(
      required,
      /class="row-choice danger submitted" data-approval-value="row-decision:cleanup:trash:shf_cleanup_a:[^"]+"><input type="checkbox" name="approval:cleanup:row:shf_cleanup_a:[^"]+" value="row-decision:cleanup:trash:shf_cleanup_a:[^"]+" checked disabled><span class="choose">Trash<\/span><span class="queued">Queued<\/span>/,
      "submitted row controls should not revert to their pre-submit action label"
    );

    const inflated = await (await server.request("/?queued=20")).text();
    assert.doesNotMatch(inflated, /20 decisions queued for agent/i, "a hand-edited query string must not fake the queued count");
    assert.match(inflated, /2 decisions queued for agent/i, "the confirmation is bounded by live pending session events");

    for (const event of pollPendingEvents(server.home, server.sessionId)) {
      replyToEvent(server.home, server.sessionId, event.id, {
        status: "completed",
        payload: { title: "Actioned", records: [String(event.target.recordId ?? "")] }
      });
    }
    const afterReply = requiredActionsHtml(await (await server.request("/")).text());
    assert.doesNotMatch(afterReply, / checked disabled/, "after the agent replies, the queued control state should clear");
    assert.match(
      afterReply,
      /class="approve-choice" data-approval-value="decision:cleanup:trash"><input type="checkbox" name="approval:cleanup" value="decision:cleanup:trash"><span class="approve">Approve<\/span><span class="queued">Queued<\/span>/,
      "after action, the lane approval can render as a normal available approval again if live state still needs it"
    );
  });
});

test("prepared dry-run plans replace original required-action rows with plan approval", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:cleanup", "decision:cleanup:trash");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_a", ledgerPath);
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_b", ledgerPath);

    assert.equal(
      (
        await server.requestRaw("/intents", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          redirect: "manual"
        })
      ).status,
      303
    );

    const prepared = pollPendingEvents(server.home, server.sessionId).find((event) => event.target.recordId === "shf_cleanup_a");
    assert.ok(prepared, "fixture should queue cleanup_a for the agent");
    const disposePlan = createDisposePlan(ledgerPath, { id: "shf_cleanup_a", action: "trash-resolve", reason: "reviewed" });
    replyToEvent(server.home, server.sessionId, prepared!.id, {
      status: "completed",
      payload: {
        kind: "dispose_dry_run",
        title: "Dispose dry-run prepared",
        planId: disposePlan.planId,
        approvalTarget: `approve artshelf dispose ledger ${ledgerPath} plan ${disposePlan.planId}`,
        records: ["shf_cleanup_a"],
        action: "trash-resolve"
      }
    });

    const html = await (await server.request("/")).text();
    const required = requiredActionsHtml(html);
    assert.match(required, /Ready for approval/i, "prepared plans become the next required action");
    assert.match(required, new RegExp(escapeRegExp(disposePlan.planId)), "the prepared plan id is visible for approval");
    assert.match(required, /Trash and resolve/i, "the plan approval summarizes the action");
    assert.match(required, /class="queue-row r approval-row"/, "prepared plan rows use the wider approval-row layout");
    assert.match(required, /class="approval-target"/, "the long approval command is shown in a full-width target block");
    assert.match(
      required,
      /name="approval:ready-approval" value="approve-plan:event_[^"]+"/,
      "prepared plan approvals should be queueable from the required-actions form"
    );
    assert.match(required, new RegExp(escapeRegExp(`approve artshelf dispose ledger ${ledgerPath} plan ${disposePlan.planId}`)));
    assert.match(html, /\.approval-row\{ grid-template-columns:minmax\(0,1fr\) minmax\(160px,240px\); \}/);
    assert.match(html, /\.approval-target\{ grid-column:1 \/ -1;/);
    const cleanupLane = laneHtml(required, "lane-cleanup");
    assert.doesNotMatch(cleanupLane, /shf_cleanup_a/, "the prepared row should leave the original cleanup decision lane");
    assert.match(cleanupLane, /shf_cleanup_b/, "unprepared rows stay in their original required-action lane");

    const approvalValue = required.match(/name="approval:ready-approval" value="([^"]+)"/)?.[1];
    assert.ok(approvalValue, "prepared plan approval value should be present");
    const approvalParams = new URLSearchParams();
    approvalParams.append("token", server.token);
    approvalParams.append("type", "required_actions_submitted");
    approvalParams.append("approval:ready-approval", approvalValue!);

    const approvalResponse = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: approvalParams.toString(),
      redirect: "manual"
    });
    assert.equal(approvalResponse.status, 303);

    const approvalEvent = readSessionEvents(server.home, server.sessionId).find((event) => event.type === "approval_bundle_submitted");
    assert.ok(approvalEvent, "approving a prepared plan queues an executable approval bundle for the agent");
    assert.equal(approvalEvent!.status, "pending");
    const bundleId = approvalEvent!.target.bundleId as string;
    const bundle = readApprovalSnapshot(server.home, server.sessionId, bundleId);
    assert.equal(bundle.actionType, "trash-resolve");
    assert.deepEqual(bundle.selectedTargetIds, ["shf_cleanup_a"]);
    assert.equal(bundle.targets[0]!.targetId, "shf_cleanup_a");
    assert.equal(bundle.targets[0]!.recordId, "shf_cleanup_a");
    assert.equal(bundle.targets[0]!.ledgerPath, ledgerPath);
    assert.equal(bundle.targets[0]!.planId, disposePlan.planId);
    assert.equal(bundle.targets[0]!.planEntryDigest, disposePlanEntryDigest(readDisposePlanEntry(ledgerPath, disposePlan.planId)));

    const queuedHtml = await (await server.request("/")).text();
    const queuedRequired = requiredActionsHtml(queuedHtml);
    assert.match(queuedRequired, new RegExp(`value="${escapeRegExp(approvalValue!)}" checked disabled`), "queued prepared approvals render as submitted");
    assert.match(
      queuedHtml,
      /<button type="submit" disabled>Submit selected to agent<\/button>/,
      "a queued-only prepared approval should not render an active empty submit"
    );
    assert.match(queuedHtml, new RegExp(`name="cancelEventId" value="${escapeRegExp(approvalEvent!.id)}"`), "queued work can be unqueued from the activity rail");

    const cancelParams = new URLSearchParams();
    cancelParams.append("token", server.token);
    cancelParams.append("type", "required_actions_submitted");
    cancelParams.append("cancelEventId", approvalEvent!.id);
    cancelParams.append("approval:ready-approval", approvalValue!);
    const cancelResponse = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: cancelParams.toString(),
      redirect: "manual"
    });
    assert.equal(cancelResponse.status, 303);
    assert.equal(cancelResponse.headers.get("location"), `/?token=${encodeURIComponent(server.token)}#session-activity`);

    const cancelledEvent = readSessionEvents(server.home, server.sessionId).find((event) => event.id === approvalEvent!.id);
    assert.equal(cancelledEvent?.status, "cancelled", "unqueue records a cancellation reply on the queued event");
    assert.equal(pollPendingEvents(server.home, server.sessionId).some((event) => event.id === approvalEvent!.id), false, "unqueued events leave the agent poll queue");
    assert.equal(
      readSessionEvents(server.home, server.sessionId).filter((event) => event.type === "approval_bundle_submitted").length,
      1,
      "unqueue must not also resubmit checked approval fields"
    );

    const afterCancel = requiredActionsHtml(await (await server.request("/")).text());
    assert.match(afterCancel, new RegExp(`value="${escapeRegExp(approvalValue!)}"`), "the plan approval is still available after unqueue");
    assert.doesNotMatch(afterCancel, new RegExp(`value="${escapeRegExp(approvalValue!)}" checked disabled`), "unqueued approvals return to an available state");
  });
});

test("exact dry-run request prepared plans can be approved from required actions", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") })]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const event = appendEvent(server.home, server.sessionId, {
      type: "dry_run_requested",
      target: { recordId: "shf_cleanup_a", ledgerPath, ledgerName: "primary" },
      payload: { request: "trash-resolve" }
    });
    const disposePlan = createDisposePlan(ledgerPath, { id: "shf_cleanup_a", action: "trash-resolve", reason: "reviewed" });
    replyToEvent(server.home, server.sessionId, event.id, {
      status: "completed",
      payload: {
        kind: "dispose_dry_run",
        planId: disposePlan.planId,
        approvalTarget: `approve artshelf dispose ledger ${ledgerPath} plan ${disposePlan.planId}`,
        records: ["shf_cleanup_a"],
        action: "trash-resolve"
      }
    });

    const html = await (await server.request("/")).text();
    const required = requiredActionsHtml(html);
    assert.match(required, new RegExp(`approve-plan:${event.id}`));

    const approvalParams = new URLSearchParams();
    approvalParams.append("token", server.token);
    approvalParams.append("type", "required_actions_submitted");
    approvalParams.append("approval:ready-approval", `approve-plan:${event.id}`);
    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: approvalParams.toString(),
      redirect: "manual"
    });
    assert.equal(response.status, 303);
    const approvalEvent = readSessionEvents(server.home, server.sessionId).find((candidate) => candidate.type === "approval_bundle_submitted");
    assert.equal(approvalEvent?.payload.preparedEventId, event.id);
  });
});

test("prepared rows are excluded from reviewed bulk expansion", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const rowParams = new URLSearchParams();
    rowParams.append("token", server.token);
    rowParams.append("type", "required_actions_submitted");
    rowParams.append("approval:cleanup", `row-decision:cleanup:trash:${encodeURIComponent("shf_cleanup_a")}:${encodeURIComponent(ledgerPath)}`);

    const rowResponse = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: rowParams.toString(),
      redirect: "manual"
    });
    assert.equal(rowResponse.status, 303);

    const prepared = pollPendingEvents(server.home, server.sessionId)[0]!;
    assert.equal(prepared.target.recordId, "shf_cleanup_a");
    const disposePlan = createDisposePlan(ledgerPath, { id: "shf_cleanup_a", action: "trash-resolve", reason: "reviewed" });
    replyToEvent(server.home, server.sessionId, prepared.id, {
      status: "completed",
      payload: {
        kind: "dispose_dry_run",
        title: "Dispose dry-run prepared",
        planId: disposePlan.planId,
        approvalTarget: `approve artshelf dispose ledger ${ledgerPath} plan ${disposePlan.planId}`,
        records: ["shf_cleanup_a"],
        action: "trash-resolve"
      }
    });

    const html = await (await server.request("/")).text();
    const reviewedA = reviewedLaneRowValue("shf_cleanup_a", ledgerPath);
    const reviewedB = reviewedLaneRowValue("shf_cleanup_b", ledgerPath);
    assert.doesNotMatch(html, new RegExp(`name="reviewed:cleanup" value="${escapeRegExp(reviewedA)}"`));
    assert.match(html, new RegExp(`name="reviewed:cleanup" value="${escapeRegExp(reviewedB)}"`));

    const bulkParams = new URLSearchParams();
    bulkParams.append("token", server.token);
    bulkParams.append("type", "required_actions_submitted");
    bulkParams.append("approval:cleanup", "decision:cleanup:trash");
    appendReviewedLaneRow(bulkParams, "cleanup", "shf_cleanup_b", ledgerPath);

    const bulkResponse = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: bulkParams.toString(),
      redirect: "manual"
    });
    assert.equal(bulkResponse.status, 303);

    const pending = pollPendingEvents(server.home, server.sessionId);
    assert.equal(pending.length, 1, "bulk approval should expand only visible cleanup rows");
    assert.equal(pending[0]!.target.recordId, "shf_cleanup_b");
  });
});

test("browser unqueue only cancels pending work", async () => {
  const { registryPath, ledgerPath } = singleLedger([dueCleanupRecord(fixtureDir())]);

  await withServer({ registryPath }, async (server) => {
    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "decision_submitted");
    params.append("lane", "cleanup");
    params.append("decision", "trash");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup", ledgerPath);

    const queueResponse = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });
    assert.equal(queueResponse.status, 303);

    const event = pollPendingEvents(server.home, server.sessionId)[0]!;
    replyToEvent(server.home, server.sessionId, event.id, {
      status: "in_progress",
      expectedStatus: "pending",
      payload: { title: "Agent claimed work" }
    });

    const html = await (await server.request("/")).text();
    assert.match(html, /in_progress/i, "claimed work stays visible in queue activity");
    assert.doesNotMatch(html, new RegExp(`name="cancelEventId" value="${escapeRegExp(event.id)}"`), "claimed work is no longer browser-cancellable");

    const cancelParams = new URLSearchParams();
    cancelParams.append("token", server.token);
    cancelParams.append("type", "required_actions_submitted");
    cancelParams.append("cancelEventId", event.id);
    const cancelResponse = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: cancelParams.toString(),
      redirect: "manual"
    });

    assert.equal(cancelResponse.status, 400);
    assert.match(await cancelResponse.text(), /already in_progress/i);
    assert.equal(readSessionEvents(server.home, server.sessionId).find((entry) => entry.id === event.id)?.status, "in_progress");
  });
});

test("grouped unqueue can cancel more than fifty pending events", async () => {
  const { registryPath, ledgerPath } = singleLedger([dueCleanupRecord(fixtureDir())]);

  await withServer({ registryPath }, async (server) => {
    const events = Array.from({ length: 51 }, (_, index) =>
      appendEvent(server.home, server.sessionId, {
        type: "decision_submitted",
        target: { recordId: `shf_cleanup_${index}`, ledgerPath, ledgerName: "primary" },
        payload: { lane: "cleanup", decision: "trash" }
      })
    );

    const queuedHtml = await (await server.request("/")).text();
    const batchCancel = queuedHtml.match(/name="cancelEventIds" value="([^"]+)"/)?.[1];
    assert.ok(batchCancel, "large grouped queues should render one grouped unqueue action");
    assert.deepEqual(batchCancel!.split(",").sort(), events.map((event) => event.id).sort());
    assert.equal((queuedHtml.match(/name="cancelEventId"/g) ?? []).length, 0, "large grouped queues should not fall back to per-item buttons");

    const cancelParams = new URLSearchParams();
    cancelParams.append("token", server.token);
    cancelParams.append("type", "required_actions_submitted");
    cancelParams.append("cancelEventIds", batchCancel!);
    const cancelResponse = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: cancelParams.toString(),
      redirect: "manual"
    });

    assert.equal(cancelResponse.status, 303);
    assert.equal(
      readSessionEvents(server.home, server.sessionId).filter((event) => events.some((queued) => queued.id === event.id && event.status === "cancelled")).length,
      events.length,
      "grouped unqueue cancels every pending event in a large group"
    );
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "large grouped unqueue clears the agent poll queue");
  });
});

test("prepared dry-run plans can be approved all at once from required actions", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:cleanup", "decision:cleanup:trash");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_a", ledgerPath);
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_b", ledgerPath);

    assert.equal(
      (
        await server.requestRaw("/intents", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          redirect: "manual"
        })
      ).status,
      303
    );

    const plans = new Map<string, ReturnType<typeof createDisposePlan>>();
    for (const event of pollPendingEvents(server.home, server.sessionId)) {
      const recordId = event.target.recordId as string;
      const plan = createDisposePlan(ledgerPath, { id: recordId, action: "trash-resolve", reason: "reviewed" });
      plans.set(recordId, plan);
      replyToEvent(server.home, server.sessionId, event.id, {
        status: "completed",
        payload: {
          kind: "dispose_dry_run",
          title: "Dispose dry-run prepared",
          planId: plan.planId,
          approvalTarget: `approve artshelf dispose ledger ${ledgerPath} plan ${plan.planId}`,
          records: [recordId],
          action: "trash-resolve"
        }
      });
    }

    const html = await (await server.request("/")).text();
    const required = requiredActionsHtml(html);
    assert.match(required, /name="approval:ready-approval" value="approve-plan:all"/, "ready approval lane offers approve all");
    assert.match(required, />Approve all</, "approve all is visible as a queue control");

    const approvalParams = new URLSearchParams();
    approvalParams.append("token", server.token);
    approvalParams.append("type", "required_actions_submitted");
    approvalParams.append("approval:ready-approval", "approve-plan:all");
    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: approvalParams.toString(),
      redirect: "manual"
    });
    assert.equal(response.status, 303);

    const approvalEvents = readSessionEvents(server.home, server.sessionId).filter((event) => event.type === "approval_bundle_submitted");
    assert.equal(approvalEvents.length, 2, "approve all queues one executable bundle per prepared plan");
    assert.deepEqual(
      approvalEvents.map((event) => event.payload.selectedTargetIds).flat().sort(),
      ["shf_cleanup_a", "shf_cleanup_b"]
    );
    for (const event of approvalEvents) {
      const bundle = readApprovalSnapshot(server.home, server.sessionId, event.target.bundleId as string);
      const recordId = bundle.selectedTargetIds[0]!;
      const plan = plans.get(recordId)!;
      assert.equal(bundle.actionType, "trash-resolve");
      assert.equal(bundle.targets[0]!.planId, plan.planId);
      assert.equal(bundle.targets[0]!.planEntryDigest, disposePlanEntryDigest(readDisposePlanEntry(ledgerPath, plan.planId)));
    }

    const queuedHtml = await (await server.request("/")).text();
    const batchCancel = queuedHtml.match(/name="cancelEventIds" value="([^"]+)"/)?.[1];
    assert.ok(batchCancel, "approve all should render one grouped unqueue action, not one button per item");
    assert.deepEqual(batchCancel!.split(",").sort(), approvalEvents.map((event) => event.id).sort());
    assert.equal((queuedHtml.match(/name="cancelEventId"/g) ?? []).length, 0, "the grouped approval card should not show duplicate per-item unqueue buttons");

    const cancelParams = new URLSearchParams();
    cancelParams.append("token", server.token);
    cancelParams.append("type", "required_actions_submitted");
    cancelParams.append("cancelEventIds", batchCancel!);
    cancelParams.append("approval:ready-approval", "approve-plan:all");
    const cancelResponse = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: cancelParams.toString(),
      redirect: "manual"
    });
    assert.equal(cancelResponse.status, 303);
    assert.equal(
      readSessionEvents(server.home, server.sessionId).filter((event) => approvalEvents.some((approvalEvent) => approvalEvent.id === event.id && event.status === "cancelled")).length,
      2,
      "grouped unqueue cancels every queued approval event in the card"
    );
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "grouped unqueue clears the agent poll queue");
    assert.equal(
      readSessionEvents(server.home, server.sessionId).filter((event) => event.type === "approval_bundle_submitted").length,
      2,
      "grouped unqueue must not also resubmit checked approve-all fields"
    );
  });
});

test("prepared approve all queues only the visible prepared event per live row", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") })]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const older = appendEvent(server.home, server.sessionId, {
      type: "decision_submitted",
      target: { recordId: "shf_cleanup_a", ledgerPath, ledgerName: "primary" },
      payload: { lane: "cleanup", decision: "trash", bulk: false, count: 1 }
    });
    const olderPlan = createDisposePlan(ledgerPath, { id: "shf_cleanup_a", action: "trash-resolve", reason: "older review" });
    replyToEvent(server.home, server.sessionId, older.id, {
      status: "completed",
      payload: {
        kind: "dispose_dry_run",
        title: "Dispose dry-run prepared",
        planId: olderPlan.planId,
        approvalTarget: `approve artshelf dispose ledger ${ledgerPath} plan ${olderPlan.planId}`,
        records: ["shf_cleanup_a"],
        action: "trash-resolve"
      }
    });

    const newer = appendEvent(server.home, server.sessionId, {
      type: "decision_submitted",
      target: { recordId: "shf_cleanup_a", ledgerPath, ledgerName: "primary" },
      payload: { lane: "cleanup", decision: "trash", bulk: false, count: 1 }
    });
    const newerPlan = createDisposePlan(ledgerPath, { id: "shf_cleanup_a", action: "trash-resolve", reason: "newer review" });
    replyToEvent(server.home, server.sessionId, newer.id, {
      status: "completed",
      payload: {
        kind: "dispose_dry_run",
        title: "Dispose dry-run prepared",
        planId: newerPlan.planId,
        approvalTarget: `approve artshelf dispose ledger ${ledgerPath} plan ${newerPlan.planId}`,
        records: ["shf_cleanup_a"],
        action: "trash-resolve"
      }
    });

    const required = requiredActionsHtml(await (await server.request("/")).text());
    assert.match(required, new RegExp(escapeRegExp(newerPlan.planId)), "the latest prepared event is visible");
    assert.doesNotMatch(required, new RegExp(escapeRegExp(olderPlan.planId)), "the older duplicate prepared event is hidden");

    const approvalParams = new URLSearchParams();
    approvalParams.append("token", server.token);
    approvalParams.append("type", "required_actions_submitted");
    approvalParams.append("approval:ready-approval", "approve-plan:all");
    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: approvalParams.toString(),
      redirect: "manual"
    });
    assert.equal(response.status, 303);

    const approvalEvents = readSessionEvents(server.home, server.sessionId).filter((event) => event.type === "approval_bundle_submitted");
    assert.equal(approvalEvents.length, 1, "approve all queues only the visible prepared event");
    assert.equal(approvalEvents[0]!.payload.preparedEventId, newer.id);
    const bundle = readApprovalSnapshot(server.home, server.sessionId, approvalEvents[0]!.target.bundleId as string);
    assert.equal(bundle.targets[0]!.planId, newerPlan.planId);

    const staleParams = new URLSearchParams();
    staleParams.append("token", server.token);
    staleParams.append("type", "required_actions_submitted");
    staleParams.append("approval:ready-approval", `approve-plan:${older.id}`);
    const staleResponse = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: staleParams.toString(),
      redirect: "manual"
    });
    assert.equal(staleResponse.status, 409);
    assert.match(await staleResponse.text(), /no longer ready for approval/i);
  });
});

test("invalid prepared plans restore the original required-action row", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") })]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const prepared = appendEvent(server.home, server.sessionId, {
      type: "decision_submitted",
      target: { recordId: "shf_cleanup_a", ledgerPath, ledgerName: "primary" },
      payload: { lane: "cleanup", decision: "trash", bulk: false, count: 1 }
    });
    const plan = createDisposePlan(ledgerPath, { id: "shf_cleanup_a", action: "trash-resolve", reason: "reviewed" });
    const planPath = plan.planPath;
    if (!planPath) throw new Error("fixture should create a persisted plan");
    replyToEvent(server.home, server.sessionId, prepared.id, {
      status: "completed",
      payload: {
        kind: "dispose_dry_run",
        title: "Dispose dry-run prepared",
        planId: plan.planId,
        approvalTarget: `approve artshelf dispose ledger ${ledgerPath} plan ${plan.planId}`,
        records: ["shf_cleanup_a"],
        action: "trash-resolve"
      }
    });
    rmSync(planPath);

    const required = requiredActionsHtml(await (await server.request("/")).text());
    assert.doesNotMatch(required, /Ready for approval/i, "unreviewable plans must not replace the original row");
    assert.match(required, /Ready to clean up/i, "the original cleanup row returns for review");
    assert.match(required, new RegExp(`name="reviewed:cleanup" value="${escapeRegExp(reviewedLaneRowValue("shf_cleanup_a", ledgerPath))}"`));

    const staleApprovalParams = new URLSearchParams();
    staleApprovalParams.append("token", server.token);
    staleApprovalParams.append("type", "required_actions_submitted");
    staleApprovalParams.append("approval:ready-approval", `approve-plan:${prepared.id}`);
    const staleApproval = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: staleApprovalParams.toString(),
      redirect: "manual"
    });
    assert.equal(staleApproval.status, 409);
    assert.match(await staleApproval.text(), /no longer ready for approval/i);

    const cleanupParams = new URLSearchParams();
    cleanupParams.append("token", server.token);
    cleanupParams.append("type", "required_actions_submitted");
    cleanupParams.append("approval:cleanup", "decision:cleanup:trash");
    appendReviewedLaneRow(cleanupParams, "cleanup", "shf_cleanup_a", ledgerPath);
    const cleanupResponse = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: cleanupParams.toString(),
      redirect: "manual"
    });
    assert.equal(cleanupResponse.status, 303, "the restored original row remains actionable");
  });
});

test("stale prepared dispose plans restore the original required-action row", async () => {
  const dir = fixtureDir();
  const artifactPath = realFile(dir, "cleanup-a.txt");
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir, { id: "shf_cleanup_a", path: artifactPath })]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const prepared = appendEvent(server.home, server.sessionId, {
      type: "decision_submitted",
      target: { recordId: "shf_cleanup_a", ledgerPath, ledgerName: "primary" },
      payload: { lane: "cleanup", decision: "trash", bulk: false, count: 1 }
    });
    const plan = createDisposePlan(ledgerPath, { id: "shf_cleanup_a", action: "trash-resolve", reason: "reviewed" });
    replyToEvent(server.home, server.sessionId, prepared.id, {
      status: "completed",
      payload: {
        kind: "dispose_dry_run",
        title: "Dispose dry-run prepared",
        planId: plan.planId,
        approvalTarget: `approve artshelf dispose ledger ${ledgerPath} plan ${plan.planId}`,
        records: ["shf_cleanup_a"],
        action: "trash-resolve"
      }
    });
    writeFileSync(artifactPath, "changed after dry-run");

    const required = requiredActionsHtml(await (await server.request("/")).text());
    assert.doesNotMatch(required, /Ready for approval/i, "stale plans must not replace the original row");
    assert.match(required, /Ready to clean up/i, "the original cleanup row returns for review");
    assert.match(required, new RegExp(`name="reviewed:cleanup" value="${escapeRegExp(reviewedLaneRowValue("shf_cleanup_a", ledgerPath))}"`));

    const staleApprovalParams = new URLSearchParams();
    staleApprovalParams.append("token", server.token);
    staleApprovalParams.append("type", "required_actions_submitted");
    staleApprovalParams.append("approval:ready-approval", `approve-plan:${prepared.id}`);
    const staleApproval = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: staleApprovalParams.toString(),
      redirect: "manual"
    });
    assert.equal(staleApproval.status, 409);
    assert.match(await staleApproval.text(), /no longer ready for approval/i);
  });
});

test("executed prepared approvals leave required actions instead of returning to ready approval", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") })]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:cleanup", "decision:cleanup:trash");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_a", ledgerPath);
    assert.equal(
      (
        await server.requestRaw("/intents", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          redirect: "manual"
        })
      ).status,
      303
    );

    const prepared = pollPendingEvents(server.home, server.sessionId)[0]!;
    const plan = createDisposePlan(ledgerPath, { id: "shf_cleanup_a", action: "trash-resolve", reason: "reviewed" });
    replyToEvent(server.home, server.sessionId, prepared.id, {
      status: "completed",
      payload: {
        kind: "dispose_dry_run",
        title: "Dispose dry-run prepared",
        planId: plan.planId,
        approvalTarget: `approve artshelf dispose ledger ${ledgerPath} plan ${plan.planId}`,
        records: ["shf_cleanup_a"],
        action: "trash-resolve"
      }
    });

    const readyHtml = requiredActionsHtml(await (await server.request("/")).text());
    assert.match(readyHtml, /Ready for approval/i, "prepared plans are shown while the live row is still actionable");

    const approvalParams = new URLSearchParams();
    approvalParams.append("token", server.token);
    approvalParams.append("type", "required_actions_submitted");
    approvalParams.append("approval:ready-approval", `approve-plan:${prepared.id}`);
    assert.equal(
      (
        await server.requestRaw("/intents", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: approvalParams.toString(),
          redirect: "manual"
        })
      ).status,
      303
    );

    const approvalEvent = readSessionEvents(server.home, server.sessionId).find((event) => event.type === "approval_bundle_submitted")!;
    const execution = executeApprovedBundle(server.home, server.sessionId, approvalEvent.target.bundleId as string);
    assert.equal(execution.execution.status, "executed");

    const afterExecution = requiredActionsHtml(await (await server.request("/")).text());
    assert.doesNotMatch(afterExecution, /Ready for approval/i, "executed prepared plans should leave required actions");
    assert.match(afterExecution, /Can delete forever/i, "the required-action section should reflect the live post-execution state");
  });
});

test("GET /activity is a token-gated read-only polling fragment that updates after agent replies", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:cleanup", "decision:cleanup:trash");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_a", ledgerPath);
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_b", ledgerPath);
    assert.equal(
      (
        await server.requestRaw("/intents", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          redirect: "manual"
        })
      ).status,
      303
    );

    const beforeEvents = readSessionEvents(server.home, server.sessionId).length;
    const beforeLedger = readLedger(ledgerPath).map((record) => ({ id: record.id, status: record.status, path: record.path }));
    const missing = await server.requestRaw("/activity");
    assert.equal(missing.status, 401, "polling without a token must be refused");
    const wrong = await server.requestRaw("/activity?token=wrong");
    assert.equal(wrong.status, 401, "polling with a wrong token must be refused");
    const cookieOnly = await server.requestRaw("/activity", { headers: { cookie: `artshelf_ui_token=${server.token}` } });
    assert.equal(cookieOnly.status, 401, "polling must not accept cookie-only tokens");

    let activity = await (await server.requestRaw(`/activity?token=${encodeURIComponent(server.token)}`)).text();
    assert.match(activity, /Queued: <span class="num">2<\/span>/i);
    assert.match(activity, /2 items: cleanup \/ trash/i);
    assert.match(activity, /data-activity-href="\/activity\?token=/, "replacement fragments must keep polling alive");
    assert.doesNotMatch(activity, /<script/i, "the activity fragment itself stays scriptless");
    assert.deepEqual(
      readLedger(ledgerPath).map((record) => ({ id: record.id, status: record.status, path: record.path })),
      beforeLedger,
      "polling activity must not mutate the ledger"
    );
    assert.equal(readSessionEvents(server.home, server.sessionId).length, beforeEvents, "polling activity must not append session events");

    const pending = pollPendingEvents(server.home, server.sessionId);
    assert.equal(pending.length, 2);
    replyToEvent(server.home, server.sessionId, pending[0]!.id, {
      status: "completed",
      payload: {
        kind: "dispose_dry_run",
        title: "Dispose dry-run prepared",
        planId: "dispose-plan-123",
        count: 2,
        records: ["shf_cleanup_a", "shf_cleanup_b"],
        approvalTarget: `approve artshelf dispose ledger ${ledgerPath} plan dispose-plan-123`
      }
    });

    activity = await (await server.requestRaw(`/activity?token=${encodeURIComponent(server.token)}`)).text();
    assert.match(activity, /Handled by agent/i);
    assert.match(activity, /Queued: <span class="num">1<\/span>/i);
    assert.match(activity, /Handled: <span class="num">1<\/span>/i);
    assert.match(activity, /shf_cleanup_a/);
    assert.match(activity, /shf_cleanup_b/);
    assert.match(activity, /dispose-plan-123/, "the dashboard rail should surface reviewed dry-run plan details");
    assert.match(activity, new RegExp(escapeRegExp(`approve artshelf dispose ledger ${ledgerPath} plan dispose-plan-123`)));
    assert.match(activity, /No execution ran/i);

    endSession(server.home, server.sessionId);
    const ended = await server.requestRaw(`/activity?token=${encodeURIComponent(server.token)}`);
    assert.equal(ended.status, 401, "after-end polling must be refused");
  });
});

test("dashboard activity links purge review replies to the approval workbench", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [trashedRecord("shf_purge", "plan_purge")]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const bundle = writeApprovalSnapshot(server.home, server.sessionId, {
      actionType: "trash-purge",
      targets: [
        {
          targetId: "shf_purge",
          recordId: "shf_purge",
          ledgerPath,
          registryPath,
          recordPath: "/trash/plan_purge/shf_purge.txt",
          planId: "plan_purge",
          actionType: "trash-purge",
          label: "Delete forever shf_purge"
        }
      ],
      selectedTargetIds: [],
      allowEmptySelection: true,
      reviewed: {}
    });
    const event = appendEvent(server.home, server.sessionId, {
      type: "dry_run_requested",
      target: { lane: "purge-candidates", registryPath },
      payload: { request: "review_delete_forever", count: 1 }
    });
    replyToEvent(server.home, server.sessionId, event.id, {
      status: "completed",
      payload: {
        kind: "purge_review_prepared",
        title: "Purge review prepared",
        bundleId: bundle.id,
        count: 1
      }
    });

    const activity = await (await server.requestRaw(`/activity?token=${encodeURIComponent(server.token)}`)).text();
    assert.match(activity, new RegExp(escapeRegExp(`/bundle/${bundle.id}?token=${server.token}`)));
    assert.match(activity, /Open approval workbench/);

    const workbench = await (await server.request(`/bundle/${bundle.id}`)).text();
    assert.match(workbench, /0 of 1 selected/);
    assert.match(workbench, /Delete forever shf_purge/);
  });
});

test("dashboard activity renders cleanup lane plan approval targets", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  const cleanupPath = realFile(dir, "cleanup-a.txt");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir, { id: "shf_cleanup_a", path: cleanupPath })]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const event = appendEvent(server.home, server.sessionId, {
      type: "dry_run_requested",
      target: { lane: "cleanup", registryPath },
      payload: {
        request: "prepare_cleanup_plan",
        count: 1,
        reviewedRows: [{ recordId: "shf_cleanup_a", ledgerPath, ledgerName: "primary", path: cleanupPath, cleanup: "trash", dueState: "due", fileFacts: artifactIdentityFacts(cleanupPath) }]
      }
    });
    replyToEvent(server.home, server.sessionId, event.id, {
      status: "completed",
      payload: {
        kind: "cleanup_dry_run",
        title: "Cleanup dry-run prepared",
        count: 1,
        plans: [
          {
            ledgerName: "primary",
            ledgerPath,
            planId: "plan_cleanup_123",
            count: 1,
            approvalTarget: `approve artshelf cleanup ledger ${ledgerPath} plan plan_cleanup_123`
          }
        ]
      }
    });

    const activity = await (await server.requestRaw(`/activity?token=${encodeURIComponent(server.token)}`)).text();
    assert.match(activity, /Cleanup dry-run prepared/);
    assert.match(activity, /plan_cleanup_123/);
    assert.match(activity, new RegExp(escapeRegExp(`approve artshelf cleanup ledger ${ledgerPath} plan plan_cleanup_123`)));
  });
});

test("dashboard progressive enhancement keeps activity polling alive and refreshes action state", async () => {
  const { registryPath } = singleLedger([dueCleanupRecord(fixtureDir())]);

  await withServer({ registryPath }, async (server) => {
    const response = await server.request("/");
    const csp = response.headers.get("content-security-policy") ?? "";
    const html = await response.text();

    assert.match(html, /id="session-activity"/);
    assert.match(html, /review-shell/, "the dashboard keeps the work surface and agent loop split");
    assert.match(html, /agent-rail-inner/, "the right rail has its own sticky inner column");
    assert.match(html, /data-activity-href="\/activity\?token=/, "the browser should poll the same-origin token-scoped path");
    assert.match(html, /setInterval\([^)]*2500/, "JS-enabled browsers should refresh every ~2-3s");
    assert.match(html, /refreshReviewShell/, "activity changes should refresh the review shell without a manual reload");
    assert.match(html, /DOMParser/, "the poller should parse a read-only dashboard response for live row state");
    assert.match(html, /querySelector\("\.review-shell"\)/, "the action cards and agent rail should refresh together");
    assert.match(html, /input\[name\^="approval:"\]:checked/, "the poller should preserve unsent reviewer selections");
    assert.match(csp, /connect-src 'self'/, "polling must be limited to same-origin reads");
    const nonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1] ?? "";
    assert.match(csp, /script-src 'nonce-[^']+'/);
    assert.doesNotMatch(csp, /script-src 'unsafe-inline'/, "dashboard script execution is bound to the poller nonce");
    assert.match(html, new RegExp(`<script nonce="${escapeRegExp(nonce)}"`), "the poller carries the CSP nonce");
    assert.doesNotMatch(html, /document\.cookie|localStorage|sessionStorage/, "the token must not move into cross-port browser storage");
    assert.equal(response.headers.get("set-cookie"), null);
  });
});

test("non-dashboard responses keep the scriptless content policy", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({ id: "shf_a" })]);

  await withServer({ registryPath }, async (server) => {
    const bundle = writeApprovalSnapshot(server.home, server.sessionId, {
      actionType: "trash-resolve",
      targets: [
        {
          targetId: "shf_a",
          ledgerPath,
          registryPath: null,
          recordPath: "/tmp/shf_a",
          planId: null,
          actionType: "trash-resolve",
          label: "trash shf_a"
        }
      ],
      selectedTargetIds: ["shf_a"],
      reviewed: {}
    });

    for (const path of [`/detail/shf_a?ledger=${encodeURIComponent(ledgerPath)}`, `/bundle/${bundle.id}`, "/activity", "/missing"]) {
      const response = await server.request(path);
      const csp = response.headers.get("content-security-policy") ?? "";
      const html = await response.text();
      assert.match(csp, /script-src 'none'/, `${path} must not allow script execution`);
      assert.match(csp, /connect-src 'none'/, `${path} must not allow browser fetches`);
      assert.doesNotMatch(csp, /script-src 'unsafe-inline'/, `${path} must not allow inline scripts`);
      assert.doesNotMatch(html, /<script/i, `${path} must not render executable script`);
    }
  });
});

test("activity renders stale and rejected states as compact re-review rows", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({ id: "shf_a" }), baseRecord({ id: "shf_b" })]);

  await withServer({ registryPath }, async (server) => {
    assert.equal((await postIntent(server, { type: "inspect_requested", recordId: "shf_a", ledgerPath })).status, 303);
    assert.equal((await postIntent(server, { type: "dry_run_requested", recordId: "shf_b", ledgerPath })).status, 303);

    const pending = pollPendingEvents(server.home, server.sessionId);
    replyToEvent(server.home, server.sessionId, pending[0]!.id, { status: "stale", payload: { reason: "record changed; reload and re-review" } });
    replyToEvent(server.home, server.sessionId, pending[1]!.id, { status: "rejected", payload: { reason: "approval target no longer matches" } });

    const activity = await (await server.requestRaw(`/activity?token=${encodeURIComponent(server.token)}`)).text();
    assert.match(activity, /stale/i);
    assert.match(activity, /rejected/i);
    assert.match(activity, /Needs review: <span class="num">2<\/span>/i);
    assert.match(activity, /Needs re-review/i);
    assert.match(activity, /shf_a/);
    assert.match(activity, /shf_b/);
    assert.doesNotMatch(activity, /record changed; reload and re-review/i, "the dashboard rail should not dump reply payload details");
    assert.doesNotMatch(activity, /approval target no longer matches/i);
  });
});

test("POST /intents rejects conflicting repeated required-action approval values", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    await server.request("/");

    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:cleanup", "decision:cleanup:keep");
    params.append("approval:cleanup", "decision:cleanup:trash");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_a", ledgerPath);
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_b", ledgerPath);

    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /Conflicting Artshelf UI approval values for approval:cleanup/i);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "conflicting repeated approvals must not enter the agent queue");
  });
});

test("POST /intents rejects semantically conflicting bulk approvals under different field names", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    await server.request("/");

    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:crafted-keep", "decision:cleanup:keep");
    params.append("approval:crafted-trash", "decision:cleanup:trash");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_a", ledgerPath);
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_b", ledgerPath);

    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /Conflicting Artshelf UI selections for cleanup/i);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "conflicting semantic approvals must not enter the agent queue");
  });
});

test("POST /intents accepts reviewed-row bulk approvals larger than the old tiny intent cap", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  const rows = Array.from({ length: 180 }, (_, index) =>
    dueCleanupRecord(dir, {
      id: `shf_cleanup_${String(index).padStart(3, "0")}`,
      path: realFile(dir, `cleanup-${index}.txt`)
    })
  );
  writeLedgerFile(ledgerPath, rows);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    await server.request("/");

    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:cleanup", "decision:cleanup:trash");
    for (const row of rows) appendReviewedLaneRow(params, "cleanup", row.id as string, ledgerPath);
    assert.ok(params.toString().length > 16 * 1024, "fixture should exceed the old 16 KiB /intents body cap");

    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(response.status, 303);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, rows.length);
  });
});

test("POST /intents rejects stale required-action bulk approvals when a lane changed since render", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  const original = dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") });
  const added = dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") });
  writeLedgerFile(ledgerPath, [original]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    await server.request("/");
    writeLedgerFile(ledgerPath, [original, added]);

    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:cleanup", "decision:cleanup:trash");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_a", ledgerPath);

    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(response.status, 409);
    assert.match(await response.text(), /changed since this page loaded/i);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "stale bulk approvals must not queue a partial lane");
  });
});

test("POST /intents rejects stale required-action approvals already queued for agent", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:cleanup", "decision:cleanup:trash");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_a", ledgerPath);
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_b", ledgerPath);
    const first = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });
    assert.equal(first.status, 303);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 2);

    const duplicate = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(duplicate.status, 409);
    assert.match(await duplicate.text(), /already queued for the agent/i);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 2, "duplicate stale submissions must not add agent work");
  });
});

test("POST /intents rejects dashboard approvals already queued from the detail drawer", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const detail = await postIntent(server, {
      type: "decision_submitted",
      recordId: "shf_cleanup_a",
      ledgerPath,
      decision: "trash"
    });
    assert.equal(detail.status, 303);

    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:cleanup", "decision:cleanup:trash");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_a", ledgerPath);
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_b", ledgerPath);

    const duplicate = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(duplicate.status, 409);
    assert.match(await duplicate.text(), /already queued for the agent/i);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 1, "detail-originated decisions must block duplicate dashboard work");
  });
});

test("POST /intents rejects conflicting card and row-level required-action approvals", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    await server.request("/");

    const params = new URLSearchParams();
    const rowValue = `row-decision:cleanup:keep:${encodeURIComponent("shf_cleanup_a")}:${encodeURIComponent(ledgerPath)}`;
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:cleanup", "decision:cleanup:trash");
    params.append(`approval:cleanup:row:${encodeURIComponent("shf_cleanup_a")}:${encodeURIComponent(ledgerPath)}`, rowValue);

    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /Conflicting Artshelf UI selections for cleanup/i);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "conflicting approvals must not enter the agent queue");
  });
});

test("POST /intents rejects conflicting cleanup requests and cleanup decisions", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:crafted-request", "request:cleanup:prepare_cleanup_plan");
    params.append("approval:crafted-decision", "decision:cleanup:trash");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_a", ledgerPath);
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_b", ledgerPath);
    await appendRenderedCleanupFacts(server, params);

    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /choose either the dashboard request or row decisions/i);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "conflicting cleanup plan requests and decisions must not enter the agent queue");
  });
});

test("POST /intents records needs-review and needs-context required-action bulk approvals", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    baseRecord({
      id: "shf_review",
      path: realFile(dir, "review.txt"),
      retention: { mode: "manual-review" },
      cleanup: "review"
    }),
    baseRecord({
      id: "shf_context",
      path: realFile(dir, "context.txt"),
      reason: "   ",
      retention: { mode: "manual-review" },
      cleanup: "review"
    })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    await server.request("/");

    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:needs-review", "decision:needs-review:trash");
    params.append("approval:needs-context", "decision:needs-context:trash");
    appendReviewedLaneRow(params, "needs-review", "shf_review", ledgerPath);
    appendReviewedLaneRow(params, "needs-context", "shf_context", ledgerPath);

    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(response.status, 303);
    const pending = pollPendingEvents(server.home, server.sessionId);
    assert.deepEqual(
      pending.map((event) => [event.target.recordId, event.payload.lane, event.payload.decision]).sort(),
      [
        ["shf_context", "needs-context", "trash"],
        ["shf_review", "needs-review", "trash"]
      ],
      "visible required-action approvals for needs-review and needs-context should queue exact decisions"
    );
  });
});

test("POST /intents rejects semantically conflicting row approvals under different field names", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    await server.request("/");

    const keep = `row-decision:cleanup:keep:${encodeURIComponent("shf_cleanup_a")}:${encodeURIComponent(ledgerPath)}`;
    const trash = `row-decision:cleanup:trash:${encodeURIComponent("shf_cleanup_a")}:${encodeURIComponent(ledgerPath)}`;
    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:crafted-keep", keep);
    params.append("approval:crafted-trash", trash);

    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /Conflicting Artshelf UI row selections for cleanup/i);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "conflicting row approvals must not enter the agent queue");
  });
});

test("POST /intents records row-level required-action approvals as exact pending events", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    await server.request("/");

    const params = new URLSearchParams();
    const rowValue = `row-decision:cleanup:keep:${encodeURIComponent("shf_cleanup_a")}:${encodeURIComponent(ledgerPath)}`;
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append(`approval:cleanup:row:${encodeURIComponent("shf_cleanup_a")}:${encodeURIComponent(ledgerPath)}`, rowValue);

    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `/?token=${encodeURIComponent(server.token)}&queued=1#session-activity`);

    const pending = pollPendingEvents(server.home, server.sessionId);
    assert.equal(pending.length, 1, "one selected row creates one exact pending event");
    assert.equal(pending[0]!.type, "decision_submitted");
    assert.deepEqual(pending[0]!.target, { recordId: "shf_cleanup_a", ledgerPath, ledgerName: "primary" });
    assert.deepEqual(pending[0]!.payload, {
      decision: "keep",
      lane: "cleanup",
      bulk: false,
      count: 1
    });
  });
});

test("GET / disables lane-level approvals when part of a lane is already queued", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const rowValue = `row-decision:cleanup:trash:${encodeURIComponent("shf_cleanup_a")}:${encodeURIComponent(ledgerPath)}`;
    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append(`approval:cleanup:row:${encodeURIComponent("shf_cleanup_a")}:${encodeURIComponent(ledgerPath)}`, rowValue);

    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });
    assert.equal(response.status, 303);

    const required = requiredActionsHtml(await (await server.request("/")).text());
    assert.match(
      required,
      /class="approve-choice disabled" data-approval-value="decision:cleanup:trash"><input type="checkbox" name="approval:cleanup" value="decision:cleanup:trash" disabled><span class="approve">Approve<\/span><span class="queued">Queued<\/span>/,
      "partially queued lanes should not expose an active card approval"
    );
    assert.match(
      required,
      /class="bulk-choice danger disabled" data-approval-value="decision:cleanup:trash"><input type="checkbox" name="approval:cleanup" value="decision:cleanup:trash" disabled><span class="choose">Trash all<\/span><span class="queued">Queued<\/span>/,
      "partially queued lanes should not expose active bulk approvals"
    );
    assert.match(
      required,
      /class="row-choice danger submitted" data-approval-value="row-decision:cleanup:trash:shf_cleanup_a:[^"]+"><input type="checkbox" name="approval:cleanup:row:shf_cleanup_a:[^"]+" value="row-decision:cleanup:trash:shf_cleanup_a:[^"]+" checked disabled>/,
      "the queued row-level choice stays visibly queued"
    );
    assert.match(
      required,
      /class="row-choice danger" data-approval-value="row-decision:cleanup:trash:shf_cleanup_b:[^"]+"><input type="checkbox" name="approval:cleanup:row:shf_cleanup_b:[^"]+" value="row-decision:cleanup:trash:shf_cleanup_b:[^"]+"><span class="choose">Trash<\/span><span class="queued">Queued<\/span>/,
      "the unqueued row-level choice remains available"
    );
  });
});

test("GET / disables required-action approvals queued from the detail drawer", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "primary", "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const response = await postIntent(server, {
      type: "decision_submitted",
      recordId: "shf_cleanup_a",
      ledgerPath,
      decision: "trash"
    });
    assert.equal(response.status, 303);

    const required = requiredActionsHtml(await (await server.request("/")).text());
    assert.match(
      required,
      /class="approve-choice disabled" data-approval-value="decision:cleanup:trash"><input type="checkbox" name="approval:cleanup" value="decision:cleanup:trash" disabled><span class="approve">Approve<\/span><span class="queued">Queued<\/span>/,
      "detail-queued rows should disable card approvals for their lane"
    );
    assert.match(
      required,
      /class="bulk-choice danger disabled" data-approval-value="decision:cleanup:trash"><input type="checkbox" name="approval:cleanup" value="decision:cleanup:trash" disabled><span class="choose">Trash all<\/span><span class="queued">Queued<\/span>/,
      "detail-queued rows should disable bulk approvals for their lane"
    );
    assert.match(
      required,
      /class="row-choice danger submitted" data-approval-value="row-decision:cleanup:trash:shf_cleanup_a:[^"]+"><input type="checkbox" name="approval:cleanup:row:shf_cleanup_a:[^"]+" value="row-decision:cleanup:trash:shf_cleanup_a:[^"]+" checked disabled>/,
      "the detail-queued row-level choice stays visibly queued"
    );
    assert.match(
      required,
      /class="row-choice danger" data-approval-value="row-decision:cleanup:trash:shf_cleanup_b:[^"]+"><input type="checkbox" name="approval:cleanup:row:shf_cleanup_b:[^"]+" value="row-decision:cleanup:trash:shf_cleanup_b:[^"]+"><span class="choose">Trash<\/span><span class="queued">Queued<\/span>/,
      "unqueued row-level choices remain available"
    );
  });
});

test("POST /intents records a dashboard lane request as a pending poll event", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  const cleanupPath = realFile(dir, "scratch.txt");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir, { path: cleanupPath })]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:cleanup", "request:cleanup:prepare_cleanup_plan");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup", ledgerPath);
    await appendRenderedCleanupFacts(server, params);
    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(response.status, 303, "a successful lane request should redirect back to the dashboard lane");
    assert.equal(response.headers.get("location"), `/?token=${encodeURIComponent(server.token)}&queued=1#session-activity`);

    const pending = pollPendingEvents(server.home, server.sessionId);
    assert.equal(pending.length, 1, "the lane request should be queued for the agent as a pending event");
    const event = pending[0]!;
    assert.equal(event.type, "dry_run_requested");
    assert.equal(event.source, "browser");
    assert.equal(event.status, "pending");
    assert.deepEqual(event.target, { lane: "cleanup", registryPath });
    assert.deepEqual(event.payload, {
      request: "prepare_cleanup_plan",
      label: "prepare_cleanup_plan",
      count: 1,
      reviewedRows: [{ recordId: "shf_cleanup", ledgerPath, ledgerName: "primary", path: cleanupPath, cleanup: "trash", dueState: "due", fileFacts: artifactIdentityFacts(cleanupPath) }]
    });

    const duplicateParams = new URLSearchParams();
    duplicateParams.append("token", server.token);
    duplicateParams.append("type", "required_actions_submitted");
    duplicateParams.append("approval:cleanup", "request:cleanup:prepare_cleanup_plan");
    appendReviewedLaneRow(duplicateParams, "cleanup", "shf_cleanup", ledgerPath);
    await appendRenderedCleanupFacts(server, duplicateParams);
    const duplicate = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: duplicateParams.toString(),
      redirect: "manual"
    });
    assert.equal(duplicate.status, 409);
    assert.match(await duplicate.text(), /already queued for the agent/i);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 1, "duplicate lane requests must not add agent work");
  });
});

test("POST /intents rejects cleanup lane requests when rendered file facts drift before submit", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  const cleanupPath = realFile(dir, "scratch.txt");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir, { path: cleanupPath })]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "required_actions_submitted");
    params.append("approval:cleanup", "request:cleanup:prepare_cleanup_plan");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup", ledgerPath);
    await appendRenderedCleanupFacts(server, params);
    writeFileSync(cleanupPath, "changed after dashboard render");

    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(response.status, 409);
    assert.match(await response.text(), /changed since this page loaded/i);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "stale rendered cleanup facts must not enter the agent queue");
  });
});

test("POST /intents records a bulk lane decision with reviewed targets as exact per-record pending events", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "loading the dashboard does not queue agent work");

    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "decision_submitted");
    params.append("lane", "cleanup");
    params.append("decision", "trash");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_a", ledgerPath);
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_b", ledgerPath);

    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(response.status, 303, "a successful bulk decision should redirect back to the dashboard lane");
    assert.equal(response.headers.get("location"), `/?token=${encodeURIComponent(server.token)}#lane-cleanup`);

    const pending = pollPendingEvents(server.home, server.sessionId);
    assert.equal(pending.length, 2, "the bulk decision expands into exact record-level events");
    assert.deepEqual(
      pending.map((event) => event.target.recordId).sort(),
      ["shf_cleanup_a", "shf_cleanup_b"]
    );
    for (const event of pending) {
      assert.equal(event.type, "decision_submitted");
      assert.equal(event.source, "browser");
      assert.equal(event.status, "pending");
      assert.equal(event.target.ledgerPath, ledgerPath);
      assert.equal(event.target.ledgerName, "primary");
      assert.equal(event.payload.decision, "trash");
      assert.equal(event.payload.lane, "cleanup");
      assert.equal(event.payload.bulk, true);
      assert.equal(event.payload.count, 2);
    }
  });
});

test("POST /intents rejects a legacy bulk lane decision without reviewed targets", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [
    dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") }),
    dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") })
  ]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const response = await postIntent(server, {
      type: "decision_submitted",
      lane: "cleanup",
      decision: "trash"
    });

    assert.equal(response.status, 409);
    assert.match(await response.text(), /changed since this page loaded/i);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "bulk decisions without reviewed rows must not enter the agent queue");
  });
});

test("POST /intents rejects a legacy bulk lane decision when reviewed targets are stale", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  const original = dueCleanupRecord(dir, { id: "shf_cleanup_a", path: realFile(dir, "cleanup-a.txt") });
  const added = dueCleanupRecord(dir, { id: "shf_cleanup_b", path: realFile(dir, "cleanup-b.txt") });
  writeLedgerFile(ledgerPath, [original]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    await server.request("/");
    writeLedgerFile(ledgerPath, [original, added]);

    const params = new URLSearchParams();
    params.append("token", server.token);
    params.append("type", "decision_submitted");
    params.append("lane", "cleanup");
    params.append("decision", "trash");
    appendReviewedLaneRow(params, "cleanup", "shf_cleanup_a", ledgerPath);

    const response = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });

    assert.equal(response.status, 409);
    assert.match(await response.text(), /changed since this page loaded/i);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "stale legacy bulk decisions must not queue a partial lane");
  });
});

test("POST /intents rejects a dashboard lane request when that lane has no work", async () => {
  const { registryPath } = singleLedger([]);

  await withServer({ registryPath }, async (server) => {
    const response = await postIntent(server, {
      type: "dry_run_requested",
      lane: "cleanup",
      request: "prepare_cleanup_plan"
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /no work/i);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "an empty lane request must never enter the log");
  });
});

test("GET / shows an explicit all-clear top fold when nothing needs review", async () => {
  // A registry with only a healthy, empty ledger: no lane has work, so the required-actions fold must
  // be an explicit all-clear rather than an empty panel or a wall of zero-count cards.
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, []);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const html = await (await server.request("/")).text();
    assert.match(html, /Required actions/i);
    assert.match(html, /caught up/i, "an empty review queue reads as an explicit all-clear");
  });
});

test("GET /detail/<id> renders the minimum human-judgment fields with a back link and no file content", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir)]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const response = await server.request(`/detail/shf_cleanup?ledger=${encodeURIComponent(ledgerPath)}`);
    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /shf_cleanup/);
    assert.match(html, /primary/);
    assert.match(html, /fixture artifact/);
    assert.match(html, /scratch\.txt/, "drawer should show the recorded path label");
    assert.match(html, /trash-safe/);
    assert.match(html, /due/i, "review due reason should be shown");
    assert.match(html, /created/i, "audit trail should include creation");
    assert.match(html, new RegExp(`href="/\\?token=${server.token}"`), "drawer should link back to the authorized dashboard URL");
    // No file contents: the artifact is a one-byte "x" file; it must never appear.
    assert.doesNotMatch(html, /\bcontents?\s*:\s*x\b/i);
  });
});

test("GET /detail/<id> displays a purged record's no-recovery receipt in its audit trail (NGX-541 AC6)", async () => {
  // A record permanently purged through the one-way-door path. The detail drawer must surface the
  // purge in its audit trail, explicitly stating there is no recovery path and carrying the receipt,
  // so the irreversible deletion is visible in detail history.
  const { registryPath, ledgerPath } = singleLedger([
    baseRecord({
      id: "shf_purged",
      status: "resolved",
      path: "/orig/secret.log",
      targetPath: "/trash/plan_a/secret.log",
      cleanedAt: "2026-06-10T00:00:00.000Z",
      receiptPath: "/receipts/plan_a.json",
      cleanupPlanId: "plan_a",
      resolvedAt: "2026-06-15T00:00:00.000Z",
      resolutionReason: "trash purge completed",
      purgedAt: "2026-06-15T00:00:01.000Z",
      purgePlanId: "purge_a",
      purgeReceiptPath: "/receipts/purge_a.json"
    })
  ]);

  await withServer({ registryPath }, async (server) => {
    const html = await (await server.request(`/detail/shf_purged?ledger=${encodeURIComponent(ledgerPath)}`)).text();
    assert.match(html, /last action/i, "the detail facts should keep the latest audited action visible");
    assert.match(html, /purge at 2026-06-15T00:00:01\.000Z; receipt \/receipts\/purge_a\.json/);
    assert.match(html, /purge/, "the audit trail should show the purge event");
    assert.match(html, /no recovery path/i, "the receipt must explicitly state there is no recovery path");
    assert.match(html, new RegExp("/receipts/purge_a\\.json"), "the no-recovery purge receipt path is shown");
  });
});

test("GET / shows last action receipt metadata on review rows", async () => {
  const { registryPath } = singleLedger([
    baseRecord({
      id: "shf_reviewed",
      status: "review-required",
      cleanedAt: "2026-06-10T00:00:00.000Z",
      cleanupPlanId: "plan_a",
      receiptPath: "/tmp/receipt.json",
      cleanupReason: "flagged for manual review"
    })
  ]);

  await withServer({ registryPath }, async (server) => {
    const html = await (await server.request("/")).text();
    assert.match(html, /last action/i);
    assert.match(html, /cleanup at 2026-06-10T00:00:00\.000Z; receipt \/tmp\/receipt\.json/);
  });
});

test("GET /detail/<id> shows the needs-context badge for insufficient provenance (NGX-537 drawer)", async () => {
  const { registryPath, ledgerPath } = singleLedger([
    baseRecord({
      id: "shf_external",
      path: "/does/not/exist/external.bin",
      reason: "exported analytics dump pending review",
      provenance: { root: "external", rootPath: null, relativePath: null, basename: "external.bin", pathKind: "other" }
    })
  ]);

  await withServer({ registryPath }, async (server) => {
    const html = await (await server.request(`/detail/shf_external?ledger=${encodeURIComponent(ledgerPath)}`)).text();
    assert.match(html, /provenance/i);
    assert.match(html, /add context/i);
  });
});

test("GET /detail/<unknown> returns a non-crashing 404 error state", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({ id: "shf_known" })]);

  await withServer({ registryPath }, async (server) => {
    const response = await server.request(`/detail/shf_missing?ledger=${encodeURIComponent(ledgerPath)}`);
    assert.equal(response.status, 404);
    const html = await response.text();
    assert.match(html, /not found/i);
    assert.doesNotMatch(html, /<script/i);
  });
});

test("GET / surfaces a bad/missing ledger as an explicit problem without crashing the page", async () => {
  const dir = fixtureDir();
  const registryPath = join(dir, "ledgers.json");
  // Registered but the ledger file never exists: it must show as a problem, not a blank/500.
  writeRegistry(registryPath, [{ name: "ghost", path: join(dir, "missing-ledger.jsonl") }]);

  await withServer({ registryPath }, async (server) => {
    const response = await server.request("/");
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /ghost/, "the unhealthy ledger should be named");
    assert.match(html, /missing/i, "the ledger problem should be described");
  });
});

test("read paths reject non-GET methods so the dashboard and detail surface stay read-only", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({})]);

  // The dashboard and detail drawer answer reads only; the sole write path is the explicit,
  // token-guarded /intents intent endpoint, never the read URLs.
  await withServer({ registryPath }, async (server) => {
    for (const path of ["/", "/dashboard", `/detail/shf_1?ledger=${encodeURIComponent(ledgerPath)}`]) {
      const response = await server.request(path, { method: "POST" });
      assert.equal(response.status, 405, `${path} must reject POST`);
    }
  });
});

test("detail requests reject ledgers outside the served dashboard scope", async () => {
  const dir = fixtureDir();
  const primaryLedger = join(dir, "primary.jsonl");
  const outsideLedger = join(dir, "outside.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(primaryLedger, [baseRecord({ id: "shf_primary" })]);
  writeLedgerFile(outsideLedger, [baseRecord({ id: "shf_outside", reason: "outside ledger secret" })]);
  writeRegistry(registryPath, [{ name: "primary", path: primaryLedger }]);

  await withServer({ registryPath }, async (server) => {
    const response = await server.request(`/detail/shf_outside?ledger=${encodeURIComponent(outsideLedger)}`);
    assert.equal(response.status, 403);
    const html = await response.text();
    assert.match(html, /part of this served review scope/i);
    assert.doesNotMatch(html, /shf_outside/);
    assert.doesNotMatch(html, /outside ledger secret/);
  });
});

test("ledger-scoped serve renders only the selected ledger and refuses other registered ledgers", async () => {
  const dir = fixtureDir();
  const primaryLedger = join(dir, "primary.jsonl");
  const outsideLedger = join(dir, "outside.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(primaryLedger, [baseRecord({ id: "shf_primary", reason: "primary ledger review" })]);
  writeLedgerFile(outsideLedger, [baseRecord({ id: "shf_outside", reason: "outside ledger secret" })]);
  writeRegistry(registryPath, [
    { name: "primary", path: primaryLedger },
    { name: "outside", path: outsideLedger }
  ]);

  await withServer({ registryPath, ledgerPath: primaryLedger }, async (server) => {
    const dashboard = await (await server.request("/")).text();
    assert.match(dashboard, /shf_primary/);
    assert.doesNotMatch(dashboard, /shf_outside/);
    assert.doesNotMatch(dashboard, /outside ledger secret/);

    const response = await server.request(`/detail/shf_outside?ledger=${encodeURIComponent(outsideLedger)}`);
    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /outside ledger secret/);
  });
});

test("dashboard and detail pages require the active UI session capability token", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({ id: "shf_known" })]);

  await withServer({ registryPath }, async (server) => {
    const dashboardWithoutToken = await server.requestRaw("/");
    assert.equal(dashboardWithoutToken.status, 401);
    assert.doesNotMatch(await dashboardWithoutToken.text(), /shf_known/);

    const dashboardWithBadToken = await server.requestRaw("/?token=wrong");
    assert.equal(dashboardWithBadToken.status, 401);
    assert.doesNotMatch(await dashboardWithBadToken.text(), /shf_known/);

    const dashboardWithToken = await server.requestRaw(`/?token=${encodeURIComponent(server.token)}`);
    assert.equal(dashboardWithToken.status, 200);
    assert.match(await dashboardWithToken.text(), /shf_known/);

    const detailWithoutToken = await server.requestRaw(`/detail/shf_known?ledger=${encodeURIComponent(ledgerPath)}`);
    assert.equal(detailWithoutToken.status, 401);
    assert.doesNotMatch(await detailWithoutToken.text(), /shf_known/);

    const detailWithToken = await server.requestRaw(
      `/detail/shf_known?ledger=${encodeURIComponent(ledgerPath)}&token=${encodeURIComponent(server.token)}`
    );
    assert.equal(detailWithToken.status, 200);
    assert.match(await detailWithToken.text(), /shf_known/);
  });
});

test("served browser navigation keeps the token in same-app links without setting a localhost-wide cookie", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({ id: "shf_known" })]);
  const session = createTestSession();
  const server = createUiServer({ registryPath, uiHome: session.home, sessionId: session.sessionId });

  const dashboard = await requestInProcess(server, `/?token=${encodeURIComponent(session.token)}`);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.headers.get("set-cookie"), null);
  const dashboardHtml = await dashboard.text();
  assert.match(dashboardHtml, new RegExp(`/detail/shf_known\\?ledger=${escapeRegExp(encodeURIComponent(ledgerPath))}&token=${session.token}`));

  const detail = await requestInProcess(
    server,
    `/detail/shf_known?ledger=${encodeURIComponent(ledgerPath)}&token=${encodeURIComponent(session.token)}`
  );
  assert.equal(detail.status, 200);
  const detailHtml = await detail.text();
  assert.match(detailHtml, /shf_known/);
  assert.match(detailHtml, new RegExp(`href="/\\?token=${session.token}"`));
});

test("cookie-only access is rejected so the token cannot leak to unrelated localhost services", async () => {
  const { registryPath } = singleLedger([baseRecord({ id: "shf_known" })]);
  const session = createTestSession();
  const server = createUiServer({ registryPath, uiHome: session.home, sessionId: session.sessionId });

  const response = await requestInProcess(server, "/", {
    headers: { cookie: `artshelf_ui_token_${session.sessionId}=${session.token}` }
  });
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /shf_known/);
});

test("ending the UI session revokes served browser page access", async () => {
  const { registryPath } = singleLedger([baseRecord({ id: "shf_known" })]);
  const session = createTestSession();
  const server = createUiServer({ registryPath, uiHome: session.home, sessionId: session.sessionId });

  const beforeEnd = await requestInProcess(server, `/?token=${encodeURIComponent(session.token)}`);
  assert.equal(beforeEnd.status, 200);

  endSession(session.home, session.sessionId);

  const afterEnd = await requestInProcess(server, `/?token=${encodeURIComponent(session.token)}`);
  assert.equal(afterEnd.status, 401);
  assert.doesNotMatch(await afterEnd.text(), /shf_known/);
});

test("the server binds only to loopback", async () => {
  const { registryPath } = singleLedger([baseRecord({})]);

  await withServer({ registryPath }, async ({ host }) => {
    assert.equal(host, "127.0.0.1");
  });
});

test("the dashboard recomputes from live state on reload", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir)]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const first = await (await server.request("/")).text();
    assert.doesNotMatch(first, /shf_second/);

    // Mutate the ledger underneath a running server, then reload: the new row must appear, proving
    // the page is recomputed per request rather than served from a stale in-memory snapshot.
    writeLedgerFile(ledgerPath, [dueCleanupRecord(dir), dueCleanupRecord(dir, { id: "shf_second" })]);
    const second = await (await server.request("/")).text();
    assert.match(second, /shf_second/);
  });
});

test("responses escape record text and keep polling under a strict read-only content policy", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir, { id: "shf_xss", reason: "<script>alert(1)</script>" })]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const response = await server.request("/");
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/, "a strict CSP keeps the read-only page from loading anything external");
    assert.match(csp, /connect-src 'self'/, "activity polling is same-origin only");

    const html = await response.text();
    assert.doesNotMatch(html, /src=/i, "the read-only surface must not load external executable code or assets");
    assert.doesNotMatch(html, /document\.cookie|localStorage|sessionStorage/, "the capability token must not move into browser storage");
    assert.match(html, /&lt;script&gt;/, "record-supplied text must be HTML-escaped, not rendered as markup");
  });
});

test("dashboard and drawer stay usable at desktop and narrow widths (NGX-535/536)", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir)]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const dashboard = await (await server.request("/")).text();
    const drawer = await (await server.request(`/detail/shf_cleanup?ledger=${encodeURIComponent(ledgerPath)}`)).text();

    // Both NGX-535's dashboard and NGX-536's drawer name desktop-and-narrow usability as a
    // verification point. Each surface must declare a mobile-aware viewport and carry a narrow-width
    // breakpoint that collapses the field/lane grid to a single column instead of overflowing.
    for (const [surface, html] of [["dashboard", dashboard], ["drawer", drawer]] as const) {
      assert.match(
        html,
        /<meta name="viewport" content="width=device-width, initial-scale=1">/,
        `${surface} should declare a mobile-aware viewport`
      );
      assert.match(html, /@media \(max-width: 560px\)/, `${surface} should adapt its layout at narrow widths`);
    }
  });
});

// NGX-538: a human creates lightweight triage intents from the browser. The POST /intents endpoint
// records each intent through the durable session event log (where it appears in `ui poll`) and
// never executes anything itself. These exercise the write path end to end over real HTTP.

test("POST /intents records a browser comment intent that lands as a pending poll event", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({})]);

  await withServer({ registryPath }, async (server) => {
    const response = await postIntent(server, {
      type: "comment_added",
      recordId: "shf_1",
      ledgerPath,
      text: "looks stale, please inspect"
    });

    assert.equal(response.status, 303, "a successful intent should redirect back to the record (PRG)");
    const location = response.headers.get("location") ?? "";
    assert.match(location, /\/detail\/shf_1\?/, "redirect should return to the record's detail drawer");
    assert.match(location, new RegExp(`token=${server.token}`), "redirect should carry the capability token");

    const pending = pollPendingEvents(server.home, server.sessionId);
    assert.equal(pending.length, 1, "the intent should be queued for the agent as a pending event");
    const event = pending[0]!;
    assert.equal(event.type, "comment_added");
    assert.equal(event.source, "browser");
    assert.equal(event.status, "pending");
    assert.equal(event.target.recordId, "shf_1");
    assert.equal(event.target.ledgerPath, ledgerPath);
    assert.equal(event.target.ledgerName, "primary");
    assert.equal(event.payload.text, "looks stale, please inspect");
  });
});

test("POST /intents records a keep/trash/resolve/defer decision intent with its reason", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({})]);

  await withServer({ registryPath }, async (server) => {
    const response = await postIntent(server, {
      type: "decision_submitted",
      recordId: "shf_1",
      ledgerPath,
      decision: "trash",
      reason: "superseded by newer export"
    });

    assert.equal(response.status, 303);
    const pending = pollPendingEvents(server.home, server.sessionId);
    assert.equal(pending.length, 1);
    const event = pending[0]!;
    assert.equal(event.type, "decision_submitted");
    assert.equal(event.payload.decision, "trash");
    assert.equal(event.payload.reason, "superseded by newer export");
  });
});

test("POST /intents records inspect-request and dry-run-request intents", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({})]);

  await withServer({ registryPath }, async (server) => {
    assert.equal((await postIntent(server, { type: "inspect_requested", recordId: "shf_1", ledgerPath })).status, 303);
    assert.equal((await postIntent(server, { type: "dry_run_requested", recordId: "shf_1", ledgerPath })).status, 303);

    const types = pollPendingEvents(server.home, server.sessionId)
      .map((event) => event.type)
      .sort();
    assert.deepEqual(types, ["dry_run_requested", "inspect_requested"]);
  });
});

test("POST /intents drops a blank decision reason so validation still accepts the intent", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({})]);

  await withServer({ registryPath }, async (server) => {
    const response = await postIntent(server, {
      type: "decision_submitted",
      recordId: "shf_1",
      ledgerPath,
      decision: "keep",
      reason: "   "
    });

    assert.equal(response.status, 303);
    const pending = pollPendingEvents(server.home, server.sessionId);
    assert.equal(pending.length, 1);
    const event = pending[0]!;
    assert.equal(event.payload.decision, "keep");
    assert.equal("reason" in event.payload, false, "a blank reason must be dropped, never stored");
  });
});

test("POST /intents rejects an intent with a target outside the served review scope and records nothing", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const outsideLedgerPath = join(dir, "outside.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [baseRecord({})]);
  writeLedgerFile(outsideLedgerPath, [baseRecord({ id: "shf_outside" })]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const response = await postIntent(server, { type: "dry_run_requested", recordId: "shf_outside", ledgerPath: outsideLedgerPath });

    assert.equal(response.status, 400);
    const html = await response.text();
    assert.match(html, /outside this served review scope/i);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "an out-of-scope target must never enter the log");
  });
});

test("POST /intents rejects an unknown record target and records nothing", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({})]);

  await withServer({ registryPath }, async (server) => {
    const response = await postIntent(server, { type: "inspect_requested", recordId: "shf_missing", ledgerPath });

    assert.equal(response.status, 400);
    const html = await response.text();
    assert.match(html, /not found/i);
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "an unknown record target must never enter the log");
  });
});

test("POST /intents rejects an intent with no record target and records nothing", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({})]);

  await withServer({ registryPath }, async (server) => {
    const response = await postIntent(server, { type: "comment_added", ledgerPath, text: "no record id" });

    assert.equal(response.status, 400);
    const html = await response.text();
    assert.match(html, /recordId/, "the rejection should name the missing exact-target field");
    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0, "an invalid intent must never enter the log");
  });
});

test("POST /intents rejects a missing or invalid capability token and records nothing", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({})]);

  await withServer({ registryPath }, async (server) => {
    const missing = await postIntent(server, { type: "inspect_requested", recordId: "shf_1", ledgerPath }, { noToken: true });
    assert.equal(missing.status, 401, "a tokenless write must be refused");

    const forged = await server.requestRaw("/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ type: "inspect_requested", recordId: "shf_1", ledgerPath, token: "deadbeefdeadbeef" }),
      redirect: "manual"
    });
    assert.equal(forged.status, 401, "a wrong token must be refused");

    assert.equal(pollPendingEvents(server.home, server.sessionId).length, 0);
  });
});

test("POST /intents refuses writes after the session has ended (token revoked)", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({})]);

  await withServer({ registryPath }, async (server) => {
    endSession(server.home, server.sessionId);

    const response = await postIntent(server, { type: "inspect_requested", recordId: "shf_1", ledgerPath });
    assert.equal(response.status, 401, "ending a session must invalidate browser event writes");

    const events = readSessionEvents(server.home, server.sessionId);
    assert.equal(events.some((event) => event.type === "inspect_requested"), false, "no browser write may land after end");
  });
});

test("POST /intents rejects a non-intent event type so the browser cannot forge agent or approval events", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({})]);

  await withServer({ registryPath }, async (server) => {
    for (const type of ["session_done", "approval_bundle_submitted", "session_note_added"]) {
      const response = await postIntent(server, { type, recordId: "shf_1", ledgerPath });
      assert.equal(response.status, 400, `${type} must not be browser-creatable`);
    }
    assert.equal(readSessionEvents(server.home, server.sessionId).length, 0);
  });
});

test("POST /intents rejects incomplete browser intent payloads as validation errors", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({})]);

  await withServer({ registryPath }, async (server) => {
    const missingComment = await postIntent(server, { type: "comment_added", recordId: "shf_1", ledgerPath });
    assert.equal(missingComment.status, 400);
    assert.match(await missingComment.text(), /comment text/i);

    const missingDecision = await postIntent(server, { type: "decision_submitted", recordId: "shf_1", ledgerPath });
    assert.equal(missingDecision.status, 400);
    assert.match(await missingDecision.text(), /decision intent/i);

    assert.equal(readSessionEvents(server.home, server.sessionId).length, 0);
  });
});

test("POST /intents reports append storage failures as server errors", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({})]);

  await withServer({ registryPath }, async (server) => {
    mkdirSync(join(server.home, "sessions", server.sessionId, "events.jsonl"));

    const response = await postIntent(server, { type: "inspect_requested", recordId: "shf_1", ledgerPath });

    assert.equal(response.status, 500);
    const html = await response.text();
    assert.match(html, /Server error/i);
  });
});

test("the served detail page exposes token-bound intent forms under a form-action 'self' policy", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [baseRecord({})]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const response = await server.request(`/detail/shf_1?ledger=${encodeURIComponent(ledgerPath)}`);
    assert.equal(response.status, 200);

    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/, "the strict read-only base policy stays in force");
    assert.match(csp, /form-action 'self'/, "intent forms must be allowed to post to the same origin");

    const html = await response.text();
    assert.match(html, /<form[^>]+method="post"[^>]+action="\/intents"/i, "intents post to the dedicated endpoint");
    for (const type of ["inspect_requested", "comment_added", "decision_submitted", "dry_run_requested"]) {
      assert.match(html, new RegExp(`name="type"[^>]*value="${type}"`), `the ${type} intent must be offered`);
    }
    for (const decision of ["keep", "trash", "resolve", "defer"]) {
      assert.match(html, new RegExp(`name="decision"[^>]*value="${decision}"`), `the ${decision} decision must be offered`);
    }
    assert.match(html, /name="recordId"[^>]*value="shf_1"/, "forms carry the exact record target");
    assert.match(html, new RegExp(`value="${server.token}"`), "forms carry the capability token as a hidden field");
    assert.doesNotMatch(html, /<script/i, "intent affordances must not introduce executable script");
  });
});

// NGX-538 acceptance criterion 5: agent replies update the event projection and are visible in the
// session/dashboard history. The detail drawer must surface this record's queued triage intents and,
// after the agent replies, the reply's status and note - the browser half of the poll/reply loop.
test("the detail drawer shows this record's triage intents and the agent's reply in history (NGX-538 criterion 5)", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({})]);

  await withServer({ registryPath }, async (server) => {
    // A human records a decision intent from the browser.
    const submitted = await postIntent(server, {
      type: "decision_submitted",
      recordId: "shf_1",
      ledgerPath,
      decision: "trash",
      reason: "superseded by newer export"
    });
    assert.equal(submitted.status, 303);

    // Before any agent reply, the detail history shows the pending intent and its reason.
    const detailHref = `/detail/shf_1?ledger=${encodeURIComponent(ledgerPath)}`;
    let html = await (await server.request(detailHref)).text();
    assert.match(html, /Session activity/i, "the detail drawer should carry a session activity section");
    assert.match(html, /Decision:\s*trash/i, "the queued decision intent should appear in history");
    assert.match(html, /superseded by newer export/, "the intent's reason should be visible in history");
    assert.match(html, /pending/i, "an unanswered intent should read as pending");

    // The agent polls and replies; criterion 5 requires the reply to be visible on reload.
    const pending = pollPendingEvents(server.home, server.sessionId);
    assert.equal(pending.length, 1, "the intent is queued for the agent");
    replyToEvent(server.home, server.sessionId, pending[0]!.id, {
      status: "completed",
      payload: { receipt: "trashed via dispose" }
    });

    html = await (await server.request(detailHref)).text();
    assert.match(html, /completed/i, "the agent's reply status must be visible in the browser history");
    assert.match(html, /trashed via dispose/i, "the agent's reply note must be visible in the browser history");
  });
});

test("the detail drawer carries dry-run plan continuity for the exact record", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({ id: "shf_a" }), baseRecord({ id: "shf_b" })]);

  await withServer({ registryPath }, async (server) => {
    assert.equal(
      (
        await postIntent(server, {
          type: "decision_submitted",
          recordId: "shf_a",
          ledgerPath,
          decision: "trash",
          reason: "superseded export"
        })
      ).status,
      303
    );

    const [event] = pollPendingEvents(server.home, server.sessionId);
    replyToEvent(server.home, server.sessionId, event!.id, {
      status: "completed",
      payload: {
        kind: "dispose_dry_run",
        title: "Dispose dry-run prepared",
        planId: "dispose-plan-detail",
        count: 1,
        records: ["shf_a"],
        approvalTarget: `approve artshelf dispose ledger ${ledgerPath} plan dispose-plan-detail`
      }
    });

    const aHtml = await (await server.request(`/detail/shf_a?ledger=${encodeURIComponent(ledgerPath)}`)).text();
    assert.match(aHtml, /Session activity/i);
    assert.match(aHtml, /Decision:\s*trash/i);
    assert.match(aHtml, /completed dry-run|awaiting approval/i, "detail should state the continuity status after a dry-run reply");
    assert.match(aHtml, /dispose-plan-detail/);
    assert.match(aHtml, new RegExp(escapeRegExp(`approve artshelf dispose ledger ${ledgerPath} plan dispose-plan-detail`)));
    assert.match(aHtml, /No execution ran/i);

    const bHtml = await (await server.request(`/detail/shf_b?ledger=${encodeURIComponent(ledgerPath)}`)).text();
    assert.doesNotMatch(bHtml, /dispose-plan-detail/, "another record must not inherit this record's reply card");
  });
});

test("the detail history is scoped to its record so intents never leak across drawers (NGX-538 exact target)", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({ id: "shf_a" }), baseRecord({ id: "shf_b" })]);

  await withServer({ registryPath }, async (server) => {
    assert.equal(
      (await postIntent(server, { type: "comment_added", recordId: "shf_a", ledgerPath, text: "only-on-a note" })).status,
      303
    );

    const aHtml = await (await server.request(`/detail/shf_a?ledger=${encodeURIComponent(ledgerPath)}`)).text();
    assert.match(aHtml, /only-on-a note/, "the record's own intent appears on its drawer");

    const bHtml = await (await server.request(`/detail/shf_b?ledger=${encodeURIComponent(ledgerPath)}`)).text();
    assert.doesNotMatch(bHtml, /only-on-a note/, "another record's intent must not leak into this drawer");
    assert.match(bHtml, /No triage intents recorded/i, "a record with no intents shows the empty history state");
  });
});

// NGX-539: the browser exposes a persisted approval bundle as a token-gated workbench page. A
// reviewer can reopen it to see exactly which exact targets were selected vs merely reviewed, then
// submit a revised subset as a new immutable approval snapshot. The browser still executes nothing.
test("GET /bundle/<id> renders a persisted approval bundle with token-gated partial selection (NGX-539 AC4)", async () => {
  const ledger = singleLedger([baseRecord({ id: "shf_a" })]);

  await withServer({ registryPath: ledger.registryPath }, async (server) => {
    const snapshot = writeApprovalSnapshot(server.home, server.sessionId, {
      actionType: "trash-resolve",
      targets: [
        {
          targetId: "t_keep",
          ledgerPath: ledger.ledgerPath,
          registryPath: null,
          recordPath: "/tmp/keep",
          planId: null,
          actionType: "trash",
          label: "trash keep me"
        },
        {
          targetId: "t_skip",
          ledgerPath: ledger.ledgerPath,
          registryPath: null,
          recordPath: "/tmp/skip",
          planId: null,
          actionType: "trash",
          label: "trash skip me"
        }
      ],
      selectedTargetIds: ["t_keep"],
      reviewed: { planId: "plan_x" }
    });

    const response = await server.request(`/bundle/${snapshot.id}`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Artshelf approval workbench/);
    assert.match(body, /1 of 2 selected/, "the deliberate subset is summarized, never a vague approve-all");
    assert.match(body, /action trash-resolve/, "the exact bundle action is shown");
    assert.match(body, new RegExp(escapeRegExp("primary")), "rows group under the human ledger name");
    assert.match(body, /trash keep me/);
    assert.match(body, /trash skip me/);
    assert.match(body, /Selected/, "the selected row carries its state badge");
    assert.match(body, /Not selected/, "the merely-reviewed row is clearly distinguished");
    assert.match(body, /<form[^>]*method="post"[^>]*action="\/approve"/, "the token-gated bundle page can record a revised partial approval");
    assert.match(body, new RegExp(`name="sourceBundleId" value="${snapshot.id}"`), "approval posts only the source bundle id");
    assert.doesNotMatch(body, /name="target"/, "the workbench never posts hidden target JSON");
    assert.match(body, /type="checkbox"/, "selection inputs let the reviewer deselect rows before approval");
    assert.match(body, /Approve 1 selected/, "the submit names the exact selected count");
  });
});

test("GET /bundle/<id> keeps an empty purge review selectable without preselecting targets", async () => {
  const ledger = singleLedger([baseRecord({ id: "shf_a" })]);

  await withServer({ registryPath: ledger.registryPath }, async (server) => {
    const snapshot = writeApprovalSnapshot(server.home, server.sessionId, {
      actionType: "trash-purge",
      targets: [
        {
          targetId: "t_purge",
          ledgerPath: ledger.ledgerPath,
          registryPath: null,
          recordPath: "/tmp/purge",
          planId: null,
          actionType: "trash-purge",
          label: "purge archived tarball"
        }
      ],
      selectedTargetIds: [],
      allowEmptySelection: true,
      reviewed: { request: "review_delete_forever" }
    });

    const response = await server.request(`/bundle/${snapshot.id}`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /0 of 1 selected/, "the empty starting selection is visible");
    assert.match(body, /name="targetId" value="t_purge"/, "the reviewer can explicitly select the purge target");
    assert.doesNotMatch(body, /name="targetId" value="t_purge" checked/, "purge targets are not preselected");
    assert.match(body, /<button type="submit">Approve selected targets<\/button>/, "the submit path stays available after selecting a row");
    assert.doesNotMatch(body, /Approve 0 selected targets/, "the only submit is not disabled by the starting count");
  });
});

test("POST /approve records a selected approval bundle and pending agent event", async () => {
  const ledger = singleLedger([baseRecord({ id: "shf_a" })]);

  await withServer({ registryPath: ledger.registryPath }, async (server) => {
    const targets = [
      {
        targetId: "t_keep",
        ledgerPath: ledger.ledgerPath,
        registryPath: null,
        recordPath: "/tmp/keep",
        planId: null,
        actionType: "trash",
        label: "trash keep me"
      },
      {
        targetId: "t_skip",
        ledgerPath: ledger.ledgerPath,
        registryPath: null,
        recordPath: "/tmp/skip",
        planId: null,
        actionType: "trash",
        label: "trash skip me"
      }
    ];
    const source = writeApprovalSnapshot(server.home, server.sessionId, {
      actionType: "trash-resolve",
      targets,
      selectedTargetIds: ["t_keep"],
      reviewed: { planId: "plan_x", total: 2 }
    });

    const response = await postApproval(server, {
      sourceBundleId: source.id,
      selectedTargetIds: ["t_keep"]
    });

    assert.equal(response.status, 303);
    const location = response.headers.get("location") ?? "";
    assert.match(location, /^\/bundle\/bundle_\d{8}_\d{6}_[0-9a-f]{8}\?token=/);

    const bundleId = location.slice("/bundle/".length, location.indexOf("?"));
    const snapshot = readApprovalSnapshot(server.home, server.sessionId, bundleId);
    assert.equal(snapshot.actionType, "trash-resolve");
    assert.deepEqual(snapshot.selectedTargetIds, ["t_keep"]);
    assert.deepEqual(snapshot.targets, targets);
    assert.deepEqual(snapshot.reviewed, { planId: "plan_x", total: 2 });
    assert.deepEqual(new Set(listApprovalSnapshots(server.home, server.sessionId).map((bundle) => bundle.id)), new Set([source.id, bundleId]));

    const events = readSessionEvents(server.home, server.sessionId);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "approval_bundle_submitted");
    assert.equal(events[0]!.status, "pending");
    assert.deepEqual(events[0]!.target, { bundleId });
    assert.equal(events[0]!.payload.bundleId, bundleId);
    assert.equal(events[0]!.payload.selectedCount, 1);
    assert.equal(events[0]!.payload.targetCount, 2);
  });
});

test("POST /approve rehydrates targets from the stored source bundle instead of trusting hidden target JSON", async () => {
  const ledger = singleLedger([baseRecord({ id: "shf_a" })]);
  const outsider = singleLedger([baseRecord({ id: "shf_outside", path: "/tmp/outside" })]);

  await withServer({ registryPath: ledger.registryPath }, async (server) => {
    const reviewedTargets = [
      {
        targetId: "t_keep",
        ledgerPath: ledger.ledgerPath,
        registryPath: null,
        recordPath: "/tmp/keep",
        planId: null,
        actionType: "trash",
        label: "trash keep me"
      },
      {
        targetId: "t_skip",
        ledgerPath: ledger.ledgerPath,
        registryPath: null,
        recordPath: "/tmp/skip",
        planId: null,
        actionType: "trash",
        label: "trash skip me"
      }
    ];
    const source = writeApprovalSnapshot(server.home, server.sessionId, {
      actionType: "trash-resolve",
      targets: reviewedTargets,
      selectedTargetIds: ["t_keep"],
      reviewed: { planId: "plan_x", total: 2 }
    });

    const forgedTarget = {
      targetId: "shf_outside",
      ledgerPath: outsider.ledgerPath,
      registryPath: null,
      recordPath: "/tmp/outside",
      planId: "dispose_forged",
      actionType: "trash-resolve",
      label: "forged target"
    };
    const response = await postApproval(server, {
      sourceBundleId: source.id,
      selectedTargetIds: ["t_keep"],
      actionType: "purge",
      targets: [forgedTarget],
      reviewed: { forged: true }
    });

    assert.equal(response.status, 303);
    const location = response.headers.get("location") ?? "";
    const bundleId = location.slice("/bundle/".length, location.indexOf("?"));
    const snapshot = readApprovalSnapshot(server.home, server.sessionId, bundleId);
    assert.equal(snapshot.actionType, "trash-resolve", "the stored source action wins over posted form fields");
    assert.deepEqual(snapshot.targets, reviewedTargets, "the posted target JSON is ignored");
    assert.deepEqual(snapshot.reviewed, { planId: "plan_x", total: 2 }, "the stored reviewed facts win over posted form fields");
    assert.deepEqual(snapshot.selectedTargetIds, ["t_keep"]);
  });
});

test("GET /bundle/<id> requires the capability token", async () => {
  const ledger = singleLedger([baseRecord({ id: "shf_a" })]);

  await withServer({ registryPath: ledger.registryPath }, async (server) => {
    const snapshot = writeApprovalSnapshot(server.home, server.sessionId, {
      actionType: "trash-resolve",
      targets: [
        {
          targetId: "t_keep",
          ledgerPath: ledger.ledgerPath,
          registryPath: null,
          recordPath: "/tmp/keep",
          planId: null,
          actionType: "trash",
          label: "trash keep me"
        }
      ],
      selectedTargetIds: ["t_keep"],
      reviewed: {}
    });

    const response = await server.requestRaw(`/bundle/${snapshot.id}`);
    assert.equal(response.status, 401, "an untokened bundle read is refused like every other read surface");
  });
});

test("GET /bundle/<id> reports an unknown bundle as not found", async () => {
  const ledger = singleLedger([baseRecord({ id: "shf_a" })]);

  await withServer({ registryPath: ledger.registryPath }, async (server) => {
    const absent = await server.request("/bundle/bundle_20260625_120000_deadbeef");
    assert.equal(absent.status, 404, "a well-formed but absent bundle id is a 404, not a server error");

    const malformed = await server.request("/bundle/not-a-real-bundle-id");
    assert.equal(malformed.status, 404, "a malformed bundle id is a 404, not a 500 server error");
  });
});

// NGX-540 browser/session smoke: the full mutating round-trip the contract demands - a human approves
// exactly one target through the real browser write path (POST /approve), the agent then revalidates
// live state, executes only that exact target through the existing approval-gated dispose path,
// verifies the live result, and writes per-target receipts back to the session. The browser still
// executes nothing itself; the agent's executeApprovedBundle is the only thing that mutates a ledger,
// file, or trash. The assertions span all three hops: the browser-created bundle event, the genuine
// live-state change, and the UI receipt update the review surface reads back from the durable session.
test("browser approves a bundle, the agent executes it, and the receipt lands in the UI session (NGX-540)", async () => {
  // A real repo whose recorded backup exists on disk, with a reviewed trash-resolve dispose plan -
  // exactly the approval-gated CLI path the agent binds to by plan id, never minting a fresh plan.
  const repo = mkdtempSync(join(tmpdir(), "artshelf-ui-smoke-repo-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledgerPath = join(repo, ".artshelf", "ledger.jsonl");
  const subject = join(repo, "backup.tar");
  writeFileSync(subject, "payload");
  writeLedgerFile(ledgerPath, [baseRecord({ id: "shf_backup", path: subject, kind: "backup" })]);
  const plan = createDisposePlan(ledgerPath, { id: "shf_backup", action: "trash-resolve", reason: "reviewed" });
  const trashTarget = plan.entry?.targetPath as string;

  // The server's registry includes the real ledger so the served scope and the approved target agree.
  const registryPath = join(repo, "ledgers.json");
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const source = writeApprovalSnapshot(server.home, server.sessionId, {
      actionType: "trash-resolve",
      targets: [
        {
          targetId: "shf_backup",
          ledgerPath,
          registryPath: null,
          recordPath: subject,
          planId: plan.planId,
          planEntryDigest: disposePlanEntryDigest(readDisposePlanEntry(ledgerPath, plan.planId)),
          actionType: "trash-resolve",
          label: "trash backup.tar"
        }
      ],
      selectedTargetIds: ["shf_backup"],
      reviewed: {}
    });
    // Hop 1 - the human approves exactly this one target through the real browser write path. reviewed
    // stays empty so the live re-read gates purely on exact-target liveness rather than refusing the
    // whole bundle on a reviewed-fact mismatch.
    const approveResponse = await postApproval(server, {
      sourceBundleId: source.id,
      selectedTargetIds: ["shf_backup"]
    });
    assert.equal(approveResponse.status, 303);
    const location = approveResponse.headers.get("location") ?? "";
    const redirectBundleId = location.slice("/bundle/".length, location.indexOf("?"));
    assert.match(redirectBundleId, /^bundle_\d{8}_\d{6}_[0-9a-f]{8}$/, "the browser persisted a real approval bundle");

    // The browser executed nothing: the bundle event is pending and live state is untouched. The agent
    // discovers the bundle the way it really would - from the pending event's target.bundleId, the
    // browser -> agent handoff - not from the browser's own redirect URL.
    const pending = readSessionEvents(server.home, server.sessionId).find((e) => e.type === "approval_bundle_submitted");
    assert.equal(pending?.status, "pending", "the browser only queues the bundle for the agent");
    const bundleId = pending?.target.bundleId as string;
    assert.equal(bundleId, redirectBundleId, "the queued event carries the exact bundle the browser created");
    assert.equal(readLedger(ledgerPath).find((r) => r.id === "shf_backup")?.status, "active");
    assert.equal(existsSync(subject), true, "the browser never touches the subject file");

    // Hop 2 - the agent handles the approved bundle end to end: revalidate -> execute -> verify -> reply.
    const outcome = executeApprovedBundle(server.home, server.sessionId, bundleId);
    assert.equal(outcome.execution.status, "executed");
    assert.equal(outcome.reply.status, "completed");

    // Hop 2 verification - live state really changed, confirmed by re-reading the ledger and filesystem
    // rather than trusting the command's exit: the subject moved to trash and its row is trashed.
    assert.equal(readLedger(ledgerPath).find((r) => r.id === "shf_backup")?.status, "trashed");
    assert.equal(existsSync(subject), false, "the approved target's subject moved to trash");
    assert.equal(existsSync(trashTarget), true, "the trashed subject is recoverable at its trash path");

    // Hop 3 - UI receipt update: the bundle's session event is claimed in-progress before mutation,
    // then completed with a per-target receipt the review surface reads back from the durable session
    // history, so the approved target ends with a visible, audit-ready result and nothing is hidden.
    const entry = readSessionHistory(server.home, server.sessionId).find((h) => h.event.type === "approval_bundle_submitted");
    assert.ok(entry, "the approved bundle's event is in the session history the UI renders");
    assert.equal(entry!.event.status, "completed");
    assert.equal(entry!.replies.length, 2);
    assert.equal(entry!.replies[0]?.status, "in_progress");
    assert.equal(entry!.replies[1]?.status, "completed");
    const receipts = entry!.replies[1]!.payload.receipts as Array<{ targetId: string; outcome: string; label: string; detail: string }>;
    assert.deepEqual(receipts.map((r) => r.targetId), ["shf_backup"]);
    assert.deepEqual(receipts.map((r) => r.outcome), ["executed"]);

    const activityHtml = await (await server.request("/activity")).text();
    assert.match(activityHtml, /Execution receipt received/i);
    assert.match(activityHtml, /Handled: <span class="num">1<\/span>/i);
    assert.match(activityHtml, /Handled by agent/i);
    assert.match(activityHtml, /completed/i);
    assert.doesNotMatch(activityHtml, /Final execution receipt/i);
    assert.doesNotMatch(activityHtml, /counts<\/dt>/);
    assert.doesNotMatch(activityHtml, new RegExp(escapeRegExp(receipts[0]!.detail)));
    assert.doesNotMatch(activityHtml, new RegExp(escapeRegExp(ledgerPath)));
  });
});

test("browser-approved bundles cannot execute ledgers outside the served registry", async () => {
  const repo = mkdtempSync(join(tmpdir(), "artshelf-ui-scope-repo-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const allowedLedger = join(repo, ".artshelf", "ledger.jsonl");
  writeLedgerFile(allowedLedger, [baseRecord({ id: "shf_allowed", path: join(repo, "allowed.tar") })]);

  const outsider = mkdtempSync(join(tmpdir(), "artshelf-ui-scope-outsider-"));
  const outsiderLedger = join(outsider, ".artshelf", "ledger.jsonl");
  const outsiderSubject = join(outsider, "secret.tar");
  writeFileSync(outsiderSubject, "payload");
  writeLedgerFile(outsiderLedger, [baseRecord({ id: "shf_outside", path: outsiderSubject, kind: "backup" })]);
  const outsiderPlan = createDisposePlan(outsiderLedger, { id: "shf_outside", action: "trash-resolve", reason: "reviewed" });

  const registryPath = join(repo, "ledgers.json");
  writeRegistry(registryPath, [{ name: "primary", path: allowedLedger }]);

  await withServer({ registryPath }, async (server) => {
    const source = writeApprovalSnapshot(server.home, server.sessionId, {
      actionType: "trash-resolve",
      targets: [
        {
          targetId: "shf_outside",
          ledgerPath: outsiderLedger,
          registryPath: null,
          recordPath: outsiderSubject,
          planId: outsiderPlan.planId,
          planEntryDigest: disposePlanEntryDigest(readDisposePlanEntry(outsiderLedger, outsiderPlan.planId)),
          actionType: "trash-resolve",
          label: "trash outside"
        }
      ],
      selectedTargetIds: ["shf_outside"],
      reviewed: {}
    });
    const approveResponse = await postApproval(server, {
      sourceBundleId: source.id,
      selectedTargetIds: ["shf_outside"]
    });
    assert.equal(approveResponse.status, 303);
    const pending = readSessionEvents(server.home, server.sessionId).find((e) => e.type === "approval_bundle_submitted");
    const bundleId = pending?.target.bundleId as string;

    assert.throws(() => executeApprovedBundle(server.home, server.sessionId, bundleId), /outside.*registry|scope/i);
    assert.equal(readLedger(outsiderLedger).find((r) => r.id === "shf_outside")?.status, "active");
    assert.equal(existsSync(outsiderSubject), true);
  });
});
