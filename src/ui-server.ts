import { createServer } from "node:http";
import type { BuildArtifactDetailOptions } from "./artifact-detail.js";
import { buildArtifactDetail } from "./artifact-detail.js";
import type { BuildDashboardOptions } from "./dashboard.js";
import { buildDashboard } from "./dashboard.js";
import { renderDashboardPage, renderDetailPage, renderErrorPage } from "./renderers/ui-html.js";

// Read-only loopback browser server for the Artshelf UI v1 review surface (NGX-535 dashboard,
// NGX-536 detail drawer, NGX-537 needs-context presentation). It binds to 127.0.0.1 only and
// answers GET requests by recomputing live state from the existing read-only domain cores and
// rendering it as HTML. There is no mutation path: non-GET requests are refused, and the served
// pages carry no script and embed no file contents. The browser is purely a display surface; the
// agent-mediated session layer (the `ui` command) remains the only place review decisions are
// recorded.

export type UiServerOptions = {
  // Registry whose ledgers are aggregated, and used to resolve a record's owning ledger name.
  registryPath?: string;
  // Fallback ledger for the detail drawer when a request omits an explicit `?ledger=` target.
  ledgerPath?: string;
};

export type StartUiServerOptions = UiServerOptions & { port?: number };

export type UiServerHandle = {
  server: any;
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
};

// Loopback is the security boundary for v1: only same-machine clients can reach the surface. The
// contract reserves non-loopback binding for an explicit, warned, configured path, which this
// read-only slice does not open - so the host is fixed here.
const LOOPBACK_HOST = "127.0.0.1";

const SECURITY_HEADERS: Record<string, string> = {
  // Forbid everything but our own inline styles: no scripts, no external fetches, no embedded
  // file content can load - enforcing the read-only, no-preview boundary at the browser too.
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // Always recompute from live state; never let a browser serve a stale dashboard from cache.
  "Cache-Control": "no-store"
};

const DETAIL_PREFIX = "/detail/";

export function createUiServer(options: UiServerOptions = {}): any {
  return createServer((request: any, response: any) => {
    try {
      route(options, request, response);
    } catch (error) {
      sendHtml(response, 500, renderErrorPage({ status: 500, title: "Server error", message: errorMessage(error) }));
    }
  });
}

export function startUiServer(options: StartUiServerOptions = {}): Promise<UiServerHandle> {
  const server = createUiServer(options);
  return new Promise<UiServerHandle>((resolve, reject) => {
    const onError = (error: unknown): void => reject(error);
    server.once("error", onError);
    server.listen(options.port ?? 0, LOOPBACK_HOST, () => {
      server.removeListener("error", onError);
      const port = server.address().port as number;
      resolve({
        server,
        url: `http://${LOOPBACK_HOST}:${port}`,
        host: LOOPBACK_HOST,
        port,
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

function route(options: UiServerOptions, request: any, response: any): void {
  const method = typeof request.method === "string" ? request.method : "GET";
  if (method !== "GET" && method !== "HEAD") {
    sendHtml(response, 405, renderErrorPage({
      status: 405,
      title: "Method not allowed",
      message: "This review surface is read-only; only GET is supported. The browser records no decisions and executes nothing."
    }));
    return;
  }

  const rawUrl = typeof request.url === "string" ? request.url : "/";
  const queryStart = rawUrl.indexOf("?");
  const pathname = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const query = queryStart === -1 ? "" : rawUrl.slice(queryStart + 1);

  if (pathname === "/healthz") {
    sendText(response, 200, "ok");
    return;
  }

  if (pathname === "/" || pathname === "/dashboard") {
    sendHtml(response, 200, renderDashboardPage(buildDashboard(dashboardOptions(options))));
    return;
  }

  if (pathname.startsWith(DETAIL_PREFIX)) {
    routeDetail(options, decodeURIComponent(pathname.slice(DETAIL_PREFIX.length)), query, response);
    return;
  }

  sendHtml(response, 404, renderErrorPage({ status: 404, title: "Not found", message: `No review page at ${pathname}.` }));
}

function routeDetail(options: UiServerOptions, recordId: string, query: string, response: any): void {
  if (!recordId) {
    sendHtml(response, 404, renderErrorPage({ status: 404, title: "Record not found", message: "Missing record id." }));
    return;
  }
  const detailOptions: BuildArtifactDetailOptions = { recordId };
  const ledgerPath = getQueryParam(query, "ledger") ?? options.ledgerPath;
  if (ledgerPath !== undefined) detailOptions.ledgerPath = ledgerPath;
  if (options.registryPath !== undefined) detailOptions.registryPath = options.registryPath;

  try {
    sendHtml(response, 200, renderDetailPage(buildArtifactDetail(detailOptions)));
  } catch (error) {
    const message = errorMessage(error);
    // A missing record is an expected, non-crashing state; anything else is a real server error.
    if (/not found/i.test(message)) {
      sendHtml(response, 404, renderErrorPage({ status: 404, title: "Record not found", message }));
    } else {
      sendHtml(response, 500, renderErrorPage({ status: 500, title: "Server error", message }));
    }
  }
}

function dashboardOptions(options: UiServerOptions): BuildDashboardOptions {
  const dashboard: BuildDashboardOptions = {};
  if (options.registryPath !== undefined) dashboard.registryPath = options.registryPath;
  return dashboard;
}

// Minimal x-www-form-urlencoded query parsing, sufficient for the single `?ledger=` parameter the
// dashboard links carry. Avoids depending on a URL/URLSearchParams global that this codebase does
// not shim.
function getQueryParam(query: string, key: string): string | null {
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    if (decodeURIComponent(rawKey) === key) {
      return eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
    }
  }
  return null;
}

function sendHtml(response: any, status: number, html: string): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
  response.end(html);
}

function sendText(response: any, status: number, text: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
  response.end(text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
