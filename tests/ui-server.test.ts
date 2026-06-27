import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createDisposePlan } from "../src/dispose.js";
import { readLedger } from "../src/ledger.js";
import { escapeHtml, renderErrorPage } from "../src/renderers/ui-html.js";
import {
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

function approvalBody(fields: { token?: string; actionType: string; targets: Array<Record<string, unknown>>; selectedTargetIds: string[]; reviewed?: Record<string, unknown> }): string {
  const params = new URLSearchParams();
  if (fields.token !== undefined) params.append("token", fields.token);
  params.append("actionType", fields.actionType);
  params.append("reviewed", JSON.stringify(fields.reviewed ?? {}));
  for (const target of fields.targets) params.append("target", JSON.stringify(target));
  for (const id of fields.selectedTargetIds) params.append("targetId", id);
  return params.toString();
}

function postApproval(
  server: ServerHandle,
  fields: { actionType: string; targets: Array<Record<string, unknown>>; selectedTargetIds: string[]; reviewed?: Record<string, unknown> },
  options: { noToken?: boolean } = {}
): Promise<TestResponse> {
  const bodyFields: { token?: string; actionType: string; targets: Array<Record<string, unknown>>; selectedTargetIds: string[]; reviewed?: Record<string, unknown> } = {
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

    // First viewport: every UI v1 lane label and the ledger health for the registered ledger.
    for (const lane of ["needs-review", "needs-context", "cleanup", "resolve", "trash", "purge-candidates", "registry-reconcile", "recent-receipts"]) {
      assert.match(html, new RegExp(lane), `dashboard should show the ${lane} lane`);
    }
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

test("responses are script-free, escape record text, and set a strict read-only content policy", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir, { id: "shf_xss", reason: "<script>alert(1)</script>" })]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async (server) => {
    const response = await server.request("/");
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/, "a strict CSP keeps the read-only page from loading anything external");

    const html = await response.text();
    assert.doesNotMatch(html, /<script/i, "the read-only surface must not ship executable script");
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
    assert.match(body, /type="checkbox"/, "selection inputs let the reviewer deselect rows before approval");
    assert.match(body, /Approve 1 selected/, "the submit names the exact selected count");
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

    const response = await postApproval(server, {
      actionType: "trash-resolve",
      targets,
      selectedTargetIds: ["t_keep"],
      reviewed: { planId: "plan_x", total: 2 }
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
    assert.deepEqual(listApprovalSnapshots(server.home, server.sessionId).map((bundle) => bundle.id), [bundleId]);

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
    // Hop 1 - the human approves exactly this one target through the real browser write path. reviewed
    // stays empty so the live re-read gates purely on exact-target liveness rather than refusing the
    // whole bundle on a reviewed-fact mismatch.
    const approveResponse = await postApproval(server, {
      actionType: "trash-resolve",
      targets: [
        {
          targetId: "shf_backup",
          ledgerPath,
          registryPath: null,
          recordPath: subject,
          planId: plan.planId,
          actionType: "trash-resolve",
          label: "trash backup.tar"
        }
      ],
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
    const receipts = entry!.replies[1]!.payload.receipts as Array<{ targetId: string; outcome: string }>;
    assert.deepEqual(receipts.map((r) => r.targetId), ["shf_backup"]);
    assert.deepEqual(receipts.map((r) => r.outcome), ["executed"]);
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
    const approveResponse = await postApproval(server, {
      actionType: "trash-resolve",
      targets: [
        {
          targetId: "shf_outside",
          ledgerPath: outsiderLedger,
          registryPath: null,
          recordPath: outsiderSubject,
          planId: outsiderPlan.planId,
          actionType: "trash-resolve",
          label: "trash outside"
        }
      ],
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
