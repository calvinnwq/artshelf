import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { escapeHtml, renderErrorPage } from "../src/renderers/ui-html.js";
import { endSession, startOrResumeSession } from "../src/session.js";
import { createUiServer, startUiServer } from "../src/ui-server.js";

// Tests for the read-only loopback browser surface (Artshelf UI v1 contract slice 2). NGX-535's
// dashboard, NGX-536's detail drawer, and NGX-537's needs-context presentation all named the
// actual browser-rendered experience as their missing acceptance area; this exercises it end to
// end. The server is started in-process on an ephemeral loopback port and driven over real HTTP,
// so the assertions cover the rendered HTML a browser would receive. The clock is pinned and the
// registry is always passed explicitly so ages/due classification stay deterministic and a real
// registry never leaks. Everything here is read-only: it must never mutate state or embed file
// contents, and there must be no browser-direct mutation path.

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

type ServerHandle = {
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
  request(path: string, init?: { method?: string; headers?: Record<string, string> }): Promise<TestResponse>;
  requestRaw(path: string, init?: { method?: string; headers?: Record<string, string> }): Promise<TestResponse>;
  token: string;
};

type TestSession = {
  home: string;
  sessionId: string;
  token: string;
};

function createTestSession(): TestSession {
  const home = join(fixtureDir(), "ui");
  const session = startOrResumeSession({ home, scope: "user", ledgerPath: null });
  return { home, sessionId: session.id, token: session.token };
}

// Start the read-only server on an ephemeral loopback port for one fixture, run the body, and
// always close so no test leaks a listening socket.
async function withServer(
  options: { registryPath: string },
  body: (handle: ServerHandle) => Promise<void>
): Promise<void> {
  const handle = await startTestServer({ registryPath: options.registryPath });
  try {
    await body(handle);
  } finally {
    await handle.close();
  }
}

async function startTestServer(options: { registryPath: string }): Promise<ServerHandle> {
  const session = createTestSession();
  try {
    const handle = await startUiServer({
      port: 0,
      registryPath: options.registryPath,
      uiHome: session.home,
      sessionId: session.sessionId
    });
    return {
      ...handle,
      token: session.token,
      request: (path, init) => fetch(`${handle.url}${withToken(path, session.token)}`, init),
      requestRaw: (path, init) => fetch(`${handle.url}${path}`, init)
    };
  } catch (error) {
    if (!isListenPermissionError(error)) throw error;
    const server = createUiServer({
      registryPath: options.registryPath,
      uiHome: session.home,
      sessionId: session.sessionId
    });
    return {
      url: "http://127.0.0.1:0",
      host: "127.0.0.1",
      port: 0,
      close: async () => undefined,
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

function requestInProcess(server: any, path: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<TestResponse> {
  return new Promise<TestResponse>((resolve) => {
    let status = 200;
    const headers = new Map<string, string>();
    let body = "";
    const request = { method: init.method ?? "GET", url: path, headers: init.headers ?? {} };
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

test("non-GET requests are rejected so there is no browser-direct mutation path", async () => {
  const { registryPath } = singleLedger([baseRecord({})]);

  await withServer({ registryPath }, async (server) => {
    const response = await server.request("/", { method: "POST" });
    assert.equal(response.status, 405);
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
