import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { escapeHtml, renderErrorPage } from "../src/renderers/ui-html.js";
import { startUiServer } from "../src/ui-server.js";

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

type ServerHandle = { url: string; host: string; port: number; close: () => Promise<void> };

// Start the read-only server on an ephemeral loopback port for one fixture, run the body, and
// always close so no test leaks a listening socket.
async function withServer(
  options: { registryPath: string },
  body: (handle: ServerHandle) => Promise<void>
): Promise<void> {
  const handle = await startUiServer({ port: 0, registryPath: options.registryPath });
  try {
    await body(handle);
  } finally {
    await handle.close();
  }
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

  await withServer({ registryPath }, async ({ url }) => {
    const response = await fetch(`${url}/`);
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
    assert.match(html, /trash-safe/);
    assert.match(html, new RegExp(`/detail/shf_cleanup\\?ledger=`), "row should link to its detail drawer");
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

  await withServer({ registryPath }, async ({ url }) => {
    const html = await (await fetch(`${url}/`)).text();
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

  await withServer({ registryPath }, async ({ url }) => {
    const response = await fetch(`${url}/detail/shf_cleanup?ledger=${encodeURIComponent(ledgerPath)}`);
    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /shf_cleanup/);
    assert.match(html, /primary/);
    assert.match(html, /fixture artifact/);
    assert.match(html, /trash-safe/);
    assert.match(html, /due/i, "review due reason should be shown");
    assert.match(html, /created/i, "audit trail should include creation");
    assert.match(html, /href="\/"/, "drawer should link back to the dashboard");
    // No file contents: the artifact is a one-byte "x" file; it must never appear.
    assert.doesNotMatch(html, /\bcontents?\s*:\s*x\b/i);
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

  await withServer({ registryPath }, async ({ url }) => {
    const html = await (await fetch(`${url}/detail/shf_external?ledger=${encodeURIComponent(ledgerPath)}`)).text();
    assert.match(html, /provenance/i);
    assert.match(html, /add context/i);
  });
});

test("GET /detail/<unknown> returns a non-crashing 404 error state", async () => {
  const { registryPath, ledgerPath } = singleLedger([baseRecord({ id: "shf_known" })]);

  await withServer({ registryPath }, async ({ url }) => {
    const response = await fetch(`${url}/detail/shf_missing?ledger=${encodeURIComponent(ledgerPath)}`);
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

  await withServer({ registryPath }, async ({ url }) => {
    const response = await fetch(`${url}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /ghost/, "the unhealthy ledger should be named");
    assert.match(html, /missing/i, "the ledger problem should be described");
  });
});

test("non-GET requests are rejected so there is no browser-direct mutation path", async () => {
  const { registryPath } = singleLedger([baseRecord({})]);

  await withServer({ registryPath }, async ({ url }) => {
    const response = await fetch(`${url}/`, { method: "POST" });
    assert.equal(response.status, 405);
  });
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

  await withServer({ registryPath }, async ({ url }) => {
    const first = await (await fetch(`${url}/`)).text();
    assert.doesNotMatch(first, /shf_second/);

    // Mutate the ledger underneath a running server, then reload: the new row must appear, proving
    // the page is recomputed per request rather than served from a stale in-memory snapshot.
    writeLedgerFile(ledgerPath, [dueCleanupRecord(dir), dueCleanupRecord(dir, { id: "shf_second" })]);
    const second = await (await fetch(`${url}/`)).text();
    assert.match(second, /shf_second/);
  });
});

test("responses are script-free, escape record text, and set a strict read-only content policy", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "ledger.jsonl");
  const registryPath = join(dir, "ledgers.json");
  writeLedgerFile(ledgerPath, [dueCleanupRecord(dir, { id: "shf_xss", reason: "<script>alert(1)</script>" })]);
  writeRegistry(registryPath, [{ name: "primary", path: ledgerPath }]);

  await withServer({ registryPath }, async ({ url }) => {
    const response = await fetch(`${url}/`);
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

  await withServer({ registryPath }, async ({ url }) => {
    const dashboard = await (await fetch(`${url}/`)).text();
    const drawer = await (await fetch(`${url}/detail/shf_cleanup?ledger=${encodeURIComponent(ledgerPath)}`)).text();

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
