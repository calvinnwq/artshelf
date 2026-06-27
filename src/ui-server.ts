import { createServer } from "node:http";
import type { BuildArtifactDetailOptions } from "./artifact-detail.js";
import { buildArtifactDetail } from "./artifact-detail.js";
import type { BuildDashboardOptions } from "./dashboard.js";
import { buildApprovalWorkbenchView, buildDashboard } from "./dashboard.js";
import { normalizeLedgerPath } from "./ledger.js";
import { renderApprovalWorkbenchPage, renderDashboardPage, renderDetailPage, renderErrorPage } from "./renderers/ui-html.js";
import { listRegisteredLedgers } from "./registry.js";
import type { AppendEventInput } from "./session.js";
import { appendEvent, readApprovalSnapshot, readSession, readSessionHistory, UI_DECISION_INTENTS, validateBrowserToken } from "./session.js";
import type { UiEventType, UiSessionHistoryEntry } from "./types.js";

// Loopback browser server for the Artshelf UI v1 review surface (NGX-535 dashboard, NGX-536 detail
// drawer, NGX-537 needs-context presentation, NGX-538 human triage intents, NGX-539 read-only
// approval-bundle workbench). It binds to 127.0.0.1 only and answers safe GET/HEAD reads by
// recomputing live state from the read-only domain cores and rendering it as HTML. The read pages
// carry no script and embed no file contents. The NGX-539 GET /bundle/<id> page renders one persisted
// immutable approval snapshot read-only (selected vs reviewed rows and the exact action), never a
// re-approval form - approval-bundle creation is a deliberate act owned by a later write slice.
//
// The single write path is POST /intents (NGX-538): a human records a lightweight triage intent
// (inspect / comment / keep / trash / resolve / defer / dry-run request) through the rendered form.
// That path is guarded by the session capability token, validates the exact record target through
// the durable session log's per-intent validators, and appends a pending event for the agent to
// poll. It still executes nothing and mutates no ledger, file, trash, or plan - the browser records
// intents; the agent (the `ui` command) remains the only place anything is acted on.

export type UiServerOptions = {
  // Registry whose ledgers are aggregated, and used to resolve a record's owning ledger name.
  registryPath?: string;
  // Fallback ledger for the detail drawer when a request omits an explicit `?ledger=` target.
  ledgerPath?: string;
  // Existing UI session that supplies the active browser capability token for read access.
  uiHome: string;
  sessionId: string;
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
  // Forbid everything but our own inline styles and same-origin form submission: no scripts, no
  // external fetches, no embedded file content can load - enforcing the no-preview, no-script
  // boundary at the browser. `form-action 'self'` opens exactly one write: the human triage intent
  // forms posting back to this server's /intents endpoint (NGX-538); the browser still executes
  // nothing and mutates no ledger, file, trash, or plan - it only records intents for the agent.
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // Always recompute from live state; never let a browser serve a stale dashboard from cache.
  "Cache-Control": "no-store"
};

const DETAIL_PREFIX = "/detail/";
const BUNDLE_PREFIX = "/bundle/";
const INTENTS_PATH = "/intents";

// Intents are tiny - a record id, a decision word, a short note - so the request body is capped well
// below anything a real submission needs; a larger body is a malformed or hostile client.
const MAX_INTENT_BODY_BYTES = 16 * 1024;

// The only event types a browser may create. The contract's decision intents (inspect, comment,
// keep/trash/resolve/defer, dry-run request) map onto exactly these four event types - keep/trash/
// resolve/defer are all decision_submitted discriminated by payload.decision. Agent/approval/session
// bookkeeping types (session_done, approval_bundle_submitted, session_note_added, ...) are NOT
// browser-creatable: the human records triage intents, never agent receipts or approval bundles.
const BROWSER_INTENT_TYPES: UiEventType[] = ["inspect_requested", "comment_added", "decision_submitted", "dry_run_requested"];

export function createUiServer(options: UiServerOptions): any {
  return createServer((request: any, response: any) => {
    try {
      route(options, request, response);
    } catch (error) {
      sendHtml(response, 500, renderErrorPage({ status: 500, title: "Server error", message: errorMessage(error) }));
    }
  });
}

export function startUiServer(options: StartUiServerOptions): Promise<UiServerHandle> {
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
  const rawUrl = typeof request.url === "string" ? request.url : "/";
  const queryStart = rawUrl.indexOf("?");
  const pathname = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const query = queryStart === -1 ? "" : rawUrl.slice(queryStart + 1);

  if (method === "GET" || method === "HEAD") {
    routeRead(options, pathname, query, request, response);
    return;
  }

  if (method === "POST" && pathname === INTENTS_PATH) {
    // Reading the request body is async; the handler owns its own error responses and must never
    // reject, but a defensive catch guards against a write after the response has already started.
    void routeIntentSubmission(options, request, response).catch((error) => {
      tryServerError(response, error);
    });
    return;
  }

  // The dashboard and detail drawer answer reads only. Writes are refused on every read path; the
  // sole mutating route is the explicit, token-guarded /intents intent endpoint handled above.
  sendHtml(response, 405, renderErrorPage({
    status: 405,
    title: "Method not allowed",
    message: "This review surface answers reads; human triage intents are recorded only through the capability-token-guarded /intents form, and the browser executes nothing."
  }));
}

function routeRead(options: UiServerOptions, pathname: string, query: string, request: any, response: any): void {
  if (pathname === "/healthz") {
    sendText(response, 200, "ok");
    return;
  }

  const access = authorizeBrowserRead(options, request, query);
  if (!access.ok) {
    sendHtml(response, 401, renderErrorPage({
      status: 401,
      title: "Capability token required",
      message: "Open this review surface from the artshelf ui serve link; dashboard and detail pages require the active UI session token."
    }));
    return;
  }

  if (pathname === "/" || pathname === "/dashboard") {
    sendHtml(response, 200, renderDashboardPage(buildDashboard(dashboardOptions(options)), access.token));
    return;
  }

  if (pathname.startsWith(DETAIL_PREFIX)) {
    routeDetail(options, decodeURIComponent(pathname.slice(DETAIL_PREFIX.length)), query, response, access.token);
    return;
  }

  if (pathname.startsWith(BUNDLE_PREFIX)) {
    routeBundle(options, decodeURIComponent(pathname.slice(BUNDLE_PREFIX.length)), response);
    return;
  }

  sendHtml(response, 404, renderErrorPage({ status: 404, title: "Not found", message: `No review page at ${pathname}.` }));
}

// Record one human triage intent (NGX-538). The flow is: read the urlencoded form body, validate the
// session capability token (a write the token only authorizes while the session is active), build a
// record-scoped intent, and append it through the durable session log - whose per-intent validators
// reject a missing exact target before it ever lands. On success we redirect (303 PRG) back to the
// record's detail drawer so a reload never re-submits. Nothing here executes a workflow or touches a
// ledger/file/trash/plan; it only queues a pending event for the agent to poll.
async function routeIntentSubmission(options: UiServerOptions, request: any, response: any): Promise<void> {
  let fields: Record<string, string>;
  try {
    const body = await readRequestBody(request, MAX_INTENT_BODY_BYTES);
    fields = parseFormUrlEncoded(body);
  } catch (error) {
    sendIntentError(response, error);
    return;
  }

  if (!authorizeBrowserWrite(options, fields.token ?? "")) {
    sendHtml(response, 401, renderErrorPage({
      status: 401,
      title: "Capability token required",
      message: "Recording a triage intent requires the active UI session token; reopen the review surface from the artshelf ui serve link. Ending the session revokes browser writes."
    }));
    return;
  }

  let event;
  try {
    const intent = buildIntentInput(fields);
    intent.target = validateIntentTarget(options, intent.target ?? {});
    event = appendEvent(options.uiHome, options.sessionId, intent);
  } catch (error) {
    sendIntentError(response, error);
    return;
  }

  sendRedirect(response, 303, detailRedirect(event.target, fields.token ?? ""));
}

// Write capability check, distinct from the read check: the token must match an ACTIVE session, so
// ending a session revokes browser writes regardless of the token presented (per the contract).
function authorizeBrowserWrite(options: UiServerOptions, token: string): boolean {
  try {
    return validateBrowserToken(readSession(options.uiHome, options.sessionId), token);
  } catch {
    return false;
  }
}

// Translate the flat form fields into a record-scoped AppendEventInput. Only the four browser intent
// types are accepted; the exact-target and payload-shape rules live in the session log's validators,
// so this stays a thin mapping. A blank optional decision reason is dropped rather than forwarded so
// the decision validator (which rejects a present-but-blank reason) still accepts the intent.
function buildIntentInput(fields: Record<string, string>): AppendEventInput {
  const type = fields.type ?? "";
  if (!isBrowserIntentType(type)) {
    throw intentError(400, `Unsupported browser intent type "${type}"; the browser may only record inspect, comment, decision, and dry-run intents`);
  }

  const target: Record<string, unknown> = {};
  if (fields.recordId !== undefined) target.recordId = fields.recordId;
  if (fields.ledgerPath !== undefined) target.ledgerPath = fields.ledgerPath;

  const payload: Record<string, unknown> = {};
  if (type === "comment_added") {
    if (!isNonBlank(fields.text)) {
      throw intentError(400, "Invalid Artshelf UI comment text; expected a non-empty string");
    }
    payload.text = fields.text;
  } else if (type === "decision_submitted") {
    if (fields.decision === undefined || !(UI_DECISION_INTENTS as string[]).includes(fields.decision)) {
      throw intentError(
        400,
        `Invalid Artshelf UI decision intent "${String(fields.decision)}"; expected one of: ${UI_DECISION_INTENTS.join(", ")}`
      );
    }
    payload.decision = fields.decision;
    if (isNonBlank(fields.reason)) payload.reason = fields.reason;
  }

  return { type, target, payload };
}

function isBrowserIntentType(value: string): value is UiEventType {
  return (BROWSER_INTENT_TYPES as string[]).includes(value);
}

// Refuse forged or stale browser targets before the event reaches the durable log. The forms only
// render from a real detail drawer, but a same-machine client with the token could still POST by
// hand; the server therefore verifies that the record exists in a ledger inside this served scope and
// enriches the compact target with the human-readable ledger name when the registry knows one.
function validateIntentTarget(options: UiServerOptions, target: Record<string, unknown>): Record<string, unknown> {
  const recordId = typeof target.recordId === "string" ? target.recordId : "";
  const requestedLedgerPath = typeof target.ledgerPath === "string" ? target.ledgerPath : "";
  if (!isNonBlank(recordId)) throw intentError(400, "Invalid Artshelf UI event target.recordId; expected a non-empty string");
  if (!isNonBlank(requestedLedgerPath)) {
    throw intentError(400, "Invalid Artshelf UI event target.ledgerPath; expected a non-empty string");
  }

  const ledgerPath = scopedDetailLedgerPath(options, requestedLedgerPath);
  if (ledgerPath === null) {
    throw intentError(400, "Intent target ledgerPath is outside this served review scope");
  }

  try {
    const detailOptions: BuildArtifactDetailOptions = { recordId, ledgerPath };
    if (options.registryPath !== undefined) detailOptions.registryPath = options.registryPath;
    const detail = buildArtifactDetail(detailOptions);
    return detail.ledgerName
      ? { ...target, recordId: detail.recordId, ledgerPath: detail.ledgerPath, ledgerName: detail.ledgerName }
      : { ...target, recordId: detail.recordId, ledgerPath: detail.ledgerPath };
  } catch (error) {
    throw intentError(400, `Invalid intent target: ${errorMessage(error)}`);
  }
}

function isNonBlank(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Redirect back to the record's detail drawer carrying its ledger scope and the capability token, so
// the followed GET is authorized and scoped exactly as the originating page was.
function detailRedirect(target: Record<string, unknown>, token: string): string {
  const recordId = typeof target.recordId === "string" ? target.recordId : "";
  const ledgerPath = typeof target.ledgerPath === "string" ? target.ledgerPath : "";
  const params: string[] = [];
  if (ledgerPath) params.push(`ledger=${encodeURIComponent(ledgerPath)}`);
  if (token) params.push(`token=${encodeURIComponent(token)}`);
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  return `${DETAIL_PREFIX}${encodeURIComponent(recordId)}${query}`;
}

// Collect the request body as a string, refusing anything past the intent size cap so a hostile or
// runaway client cannot exhaust memory. Resolves once exactly: the guard makes the data/end/error
// listeners idempotent.
function readRequestBody(request: any, limitBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    let settled = false;
    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      run();
    };
    request.on("data", (chunk: unknown) => {
      if (settled) return;
      body += typeof chunk === "string" ? chunk : String(chunk);
      if (body.length > limitBytes) settle(() => reject(intentError(413, "Intent submission body is too large")));
    });
    request.on("end", () => settle(() => resolve(body)));
    request.on("error", (error: unknown) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
  });
}

// Minimal application/x-www-form-urlencoded parsing for the flat intent fields, mirroring the read
// surface's query decoding (+ -> space, percent-decoding). Later duplicate keys win.
function parseFormUrlEncoded(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
    fields[decodeFormComponent(rawKey)] = decodeFormComponent(rawValue);
  }
  return fields;
}

function decodeFormComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    throw intentError(400, "Malformed intent submission encoding");
  }
}

// Attach an HTTP status to a rejection so the error responder can map validation (400), oversized
// body (413), and unexpected failures (500) without brittle message matching.
function intentError(status: number, message: string): Error {
  return Object.assign(new Error(message), { httpStatus: status });
}

function sendIntentError(response: any, error: unknown): void {
  const status = typeof (error as { httpStatus?: unknown }).httpStatus === "number" ? (error as { httpStatus: number }).httpStatus : 500;
  const title = status === 413 ? "Intent too large" : status >= 500 ? "Server error" : "Intent rejected";
  sendHtml(response, status, renderErrorPage({ status, title, message: errorMessage(error) }));
}

function tryServerError(response: any, error: unknown): void {
  try {
    sendHtml(response, 500, renderErrorPage({ status: 500, title: "Server error", message: errorMessage(error) }));
  } catch {
    // The response has already begun; nothing more can be sent.
  }
}

function routeDetail(options: UiServerOptions, recordId: string, query: string, response: any, token: string): void {
  if (!recordId) {
    sendHtml(response, 404, renderErrorPage({ status: 404, title: "Record not found", message: "Missing record id." }));
    return;
  }
  const detailOptions: BuildArtifactDetailOptions = { recordId };
  const requestedLedgerPath = getQueryParam(query, "ledger") ?? options.ledgerPath;
  const ledgerPath = requestedLedgerPath === undefined ? null : scopedDetailLedgerPath(options, requestedLedgerPath);
  if (ledgerPath === null) {
    sendHtml(response, 403, renderErrorPage({
      status: 403,
      title: "Ledger not in scope",
      message: "Detail requests must target a ledger that is part of this served review scope."
    }));
    return;
  }
  detailOptions.ledgerPath = ledgerPath;
  if (options.registryPath !== undefined) detailOptions.registryPath = options.registryPath;

  try {
    const detail = buildArtifactDetail(detailOptions);
    const history = recordSessionHistory(options, detail.recordId, detail.ledgerPath);
    sendHtml(response, 200, renderDetailPage(detail, token, history));
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

// Render one persisted approval bundle as the read-only browser workbench (NGX-539 AC4). An approval
// snapshot is immutable, so the page shows exactly which exact targets were selected versus merely
// reviewed and the exact action being approved, but carries no re-approval form - the surface
// executes nothing and mutates nothing. The capability token already gated this read. A malformed or
// absent bundle id is an expected, non-crashing not-found state; anything else is a real server error.
function routeBundle(options: UiServerOptions, bundleId: string, response: any): void {
  if (!bundleId) {
    sendHtml(response, 404, renderErrorPage({ status: 404, title: "Bundle not found", message: "Missing approval bundle id." }));
    return;
  }
  try {
    const snapshot = readApprovalSnapshot(options.uiHome, options.sessionId, bundleId);
    const view = buildApprovalWorkbenchView(snapshot, options.registryPath !== undefined ? { registryPath: options.registryPath } : {});
    // No token is passed to the renderer on purpose: a persisted bundle is immutable, so it renders
    // read-only (no selection inputs, no submit) even though the reader is authorized.
    sendHtml(response, 200, renderApprovalWorkbenchPage(view));
  } catch (error) {
    const message = errorMessage(error);
    if (/not found/i.test(message) || /invalid Artshelf UI bundle id/i.test(message)) {
      sendHtml(response, 404, renderErrorPage({ status: 404, title: "Bundle not found", message }));
    } else {
      sendHtml(response, 500, renderErrorPage({ status: 500, title: "Server error", message }));
    }
  }
}

function scopedDetailLedgerPath(options: UiServerOptions, requestedLedgerPath: string): string | null {
  if (requestedLedgerPath.length === 0) return null;
  const normalized = normalizeLedgerPath(requestedLedgerPath);
  if (options.ledgerPath !== undefined) {
    const scopedLedgerPath = normalizeLedgerPath(options.ledgerPath);
    return normalized === scopedLedgerPath ? scopedLedgerPath : null;
  }
  const allowed = new Set<string>();
  for (const ledger of listRegisteredLedgers(options.registryPath)) allowed.add(ledger.path);
  return allowed.has(normalized) ? normalized : null;
}

// The session intent history for exactly one record, folded with the agent's replies, for the detail
// drawer (NGX-538 criterion 5: agent replies are visible in the session history). Entries are matched
// on the same exact record + ledger target the intent forms submit, so one record's intents never
// leak onto another's drawer. The session log is supplementary to the read-only artifact detail, so a
// read failure degrades to an empty history rather than breaking the primary page.
function recordSessionHistory(options: UiServerOptions, recordId: string, ledgerPath: string): UiSessionHistoryEntry[] {
  try {
    return readSessionHistory(options.uiHome, options.sessionId).filter(
      (entry) => entry.event.target.recordId === recordId && entry.event.target.ledgerPath === ledgerPath
    );
  } catch {
    return [];
  }
}

function dashboardOptions(options: UiServerOptions): BuildDashboardOptions {
  const dashboard: BuildDashboardOptions = {};
  if (options.registryPath !== undefined) dashboard.registryPath = options.registryPath;
  if (options.ledgerPath !== undefined) dashboard.ledgerPath = options.ledgerPath;
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

type BrowserAccess = { ok: true; token: string } | { ok: false };

function authorizeBrowserRead(options: UiServerOptions, _request: any, query: string): BrowserAccess {
  const queryToken = getQueryParam(query, "token");
  const token = queryToken ?? "";
  try {
    const session = readSession(options.uiHome, options.sessionId);
    if (!validateBrowserToken(session, token)) return { ok: false };
  } catch {
    return { ok: false };
  }
  return { ok: true, token };
}

function sendHtml(response: any, status: number, html: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...headers });
  response.end(html);
}

function sendText(response: any, status: number, text: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
  response.end(text);
}

function sendRedirect(response: any, status: number, location: string): void {
  response.writeHead(status, { Location: location, "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
  response.end(`Intent recorded. Continue at ${location}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
