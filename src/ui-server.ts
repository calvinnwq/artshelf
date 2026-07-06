import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { BuildArtifactDetailOptions } from "./artifact-detail.js";
import { buildArtifactDetail } from "./artifact-detail.js";
import type { BuildDashboardOptions, DashboardArtifactRow, DashboardBucketKey, DashboardSnapshot } from "./dashboard.js";
import { buildApprovalWorkbenchView, buildDashboard } from "./dashboard.js";
import { disposePlanEntryDigest, readDisposePlanEntry } from "./dispose.js";
import { normalizeLedgerPath } from "./ledger.js";
import {
  renderApprovalWorkbenchPage,
  renderDashboardActivityFragment,
  renderDashboardPage,
  renderDetailPage,
  renderErrorPage
} from "./renderers/ui-html.js";
import { listRegisteredLedgers, normalizeRegistryPath } from "./registry.js";
import type { AppendEventInput, ApprovalSnapshotInput } from "./session.js";
import {
  appendEvent,
  appendEvents,
  readApprovalSnapshot,
  readSession,
  readSessionHistory,
  replyToEvent,
  UI_DASHBOARD_LANE_REQUESTS,
  UI_DECISION_INTENTS,
  validateBrowserToken,
  writeApprovalSnapshot
} from "./session.js";
import type { UiApprovalTarget, UiEventType, UiSessionHistoryEntry } from "./types.js";

// Loopback browser server for the Artshelf UI v1 review surface (NGX-535 dashboard, NGX-536 detail
// drawer, NGX-537 needs-context presentation, NGX-538 human triage intents, NGX-539 token-gated
// approval-bundle workbench). It binds to 127.0.0.1 only and answers safe GET/HEAD reads by
// recomputing live state from the read-only domain cores and rendering it as HTML. The read pages
// embed no file contents. The dashboard has a nonce-bound activity poller; the detail and bundle
// pages remain scriptless. The NGX-539 GET /bundle/<id> page renders one persisted immutable approval
// snapshot as selected vs reviewed rows and the exact action. Submitting a revised subset creates a
// new immutable approval snapshot for the agent to revalidate.
//
// The write paths are POST /intents for lightweight triage intents and POST /approve for immutable
// approval snapshots. Both are guarded by the session capability token and append pending events for
// the agent to poll. They execute nothing and mutate no ledger, file, trash, or plan.

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

const SCRIPTLESS_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'self'";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // Always recompute from live state; never let a browser serve a stale dashboard from cache.
  "Cache-Control": "no-store"
};

const DETAIL_PREFIX = "/detail/";
const BUNDLE_PREFIX = "/bundle/";
const INTENTS_PATH = "/intents";
const APPROVE_PATH = "/approve";
const ACTIVITY_PATH = "/activity";

// Detail-drawer intents are tiny, but the dashboard required-actions form also carries reviewed row
// targets so bulk approvals can be rejected if a lane changed since render. Keep the cap bounded but
// large enough for realistic multi-row local review dashboards.
const MAX_INTENT_BODY_BYTES = 256 * 1024;
const MAX_APPROVAL_BODY_BYTES = 256 * 1024;

// The only event types a browser may create through /intents. The contract's decision intents (inspect, comment,
// keep/trash/resolve/defer, dry-run request) map onto exactly these four event types - keep/trash/
// resolve/defer are all decision_submitted discriminated by payload.decision. Agent/approval/session
// bookkeeping types (session_done, approval_bundle_submitted, session_note_added, ...) are not
// creatable through /intents: approval bundles have their own token-gated /approve submission.
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

  if (method === "POST" && pathname === APPROVE_PATH) {
    // Approval submission is async for the same body-read reason as /intents. It records a durable
    // bundle and queues a pending agent event, but still executes no workflow itself.
    void routeApprovalSubmission(options, request, response).catch((error) => {
      tryServerError(response, error);
    });
    return;
  }

  // The dashboard and detail drawer answer reads only. Writes are refused on every read path; the
  // mutating routes are the explicit, token-guarded /intents and /approve endpoints handled above.
  sendHtml(response, 405, renderErrorPage({
    status: 405,
    title: "Method not allowed",
    message: "This review surface answers reads; human triage intents and approval bundles are recorded only through capability-token-guarded forms, and the browser executes nothing."
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
    const history = dashboardSessionHistory(options);
    const queued = parseQueuedNotice(query, history);
    const scriptNonce = uiScriptNonce();
    sendHtml(
      response,
      200,
      renderDashboardPage(buildDashboard(dashboardOptions(options)), access.token, {
        history,
        submittedCount: queued,
        activityHref: activityHref(access.token),
        scriptNonce
      }),
      { "Content-Security-Policy": dashboardContentSecurityPolicy(scriptNonce) }
    );
    return;
  }

  if (pathname === ACTIVITY_PATH) {
    sendHtml(response, 200, renderDashboardActivityFragment(dashboardSessionHistory(options), { activityHref: activityHref(access.token), includeScript: false }));
    return;
  }

  if (pathname.startsWith(DETAIL_PREFIX)) {
    routeDetail(options, decodeURIComponent(pathname.slice(DETAIL_PREFIX.length)), query, response, access.token);
    return;
  }

  if (pathname.startsWith(BUNDLE_PREFIX)) {
    routeBundle(options, decodeURIComponent(pathname.slice(BUNDLE_PREFIX.length)), response, access.token);
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
  let multiFields: Record<string, string[]>;
  try {
    const body = await readRequestBody(request, MAX_INTENT_BODY_BYTES);
    multiFields = parseFormUrlEncodedMulti(body);
    fields = flattenFormFields(multiFields);
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

  let submission;
  try {
    const cancellationIds = queuedCancellationEventIds(fields);
    if (cancellationIds.length > 0) {
      cancelQueuedBrowserEvents(options, cancellationIds);
      sendRedirect(response, 303, dashboardActivityRedirect(fields.token ?? ""));
      return;
    }

    submission = buildIntentSubmission(options, fields, multiFields);
    const validatedIntents = submission.intents.map((intent) => {
      const validated = validateIntentTarget(options, intent.type, intent.target ?? {}, intent.payload ?? {});
      return { ...intent, target: validated.target, payload: validated.payload };
    });
    const queued = appendEvents(options.uiHome, options.sessionId, validatedIntents);
    let queuedCount = queued.length;
    for (const approval of submission.approvalBundles ?? []) {
      const snapshot = writeApprovalSnapshot(options.uiHome, options.sessionId, approval.input);
      appendEvent(options.uiHome, options.sessionId, {
        type: "approval_bundle_submitted",
        target: { bundleId: snapshot.id },
        payload: {
          bundleId: snapshot.id,
          actionType: snapshot.actionType,
          fingerprint: snapshot.fingerprint,
          registryPath: normalizeRegistryPath(options.registryPath),
          ledgerPath: options.ledgerPath ? normalizeLedgerPath(options.ledgerPath) : null,
          selectedTargetIds: snapshot.selectedTargetIds,
          selectedCount: snapshot.selectedTargetIds.length,
          targetCount: snapshot.targets.length,
          preparedEventId: approval.preparedEventId
        }
      });
      queuedCount += 1;
    }
    submission = { ...submission, queuedCount };
  } catch (error) {
    sendIntentError(response, error);
    return;
  }

  sendRedirect(response, 303, intentRedirect(submission.redirectTarget, fields.token ?? "", submission.queuedCount));
}

function queuedCancellationEventIds(fields: Record<string, string>): string[] {
  const rawIds = [fields.cancelEventId ?? "", ...(fields.cancelEventIds ?? "").split(",")].map((value) => value.trim()).filter(isNonBlank);
  return [...new Set(rawIds)];
}

function cancelQueuedBrowserEvents(options: UiServerOptions, eventIds: string[]): void {
  if (eventIds.length === 0) return;
  if (eventIds.length > 50) {
    throw intentError(400, "Too many queued events selected for cancellation");
  }
  const history = readSessionHistory(options.uiHome, options.sessionId);
  const entries = eventIds.map((eventId) => {
    if (!/^event_\d{8}_\d{6}_[0-9a-f]{8}$/.test(eventId)) {
      throw intentError(400, `Invalid Artshelf UI queued event id "${eventId}"`);
    }
    const entry = history.find((candidate) => candidate.event.id === eventId);
    if (entry === undefined) {
      throw intentError(400, `Queued event ${eventId} was not found`);
    }
    if (entry.event.source !== "browser") {
      throw intentError(400, `Queued event ${eventId} was not submitted by the browser`);
    }
    if (entry.event.status !== "pending") {
      throw intentError(400, `Queued event ${eventId} is already ${entry.event.status}`);
    }
    return entry;
  });

  for (const entry of entries) {
    try {
      replyToEvent(options.uiHome, options.sessionId, entry.event.id, {
        status: "cancelled",
        expectedStatus: entry.event.status,
        payload: {
          title: "Unqueued by reviewer",
          note: "Removed from the agent queue before execution"
        }
      });
    } catch (error) {
      throw intentError(400, errorMessage(error));
    }
  }
}

// Record one reviewed approval bundle (NGX-539). The form carries the source immutable bundle id plus
// the human's checked target ids. The server rehydrates the reviewed candidate rows, action, and
// reviewed facts from the stored source bundle before persistence; hidden browser target JSON is not
// trusted as approval evidence. The follow-up event tells the agent a new bundle is ready for
// live-state revalidation; no execution happens in the browser server.
async function routeApprovalSubmission(options: UiServerOptions, request: any, response: any): Promise<void> {
  let fields: Record<string, string[]>;
  try {
    const body = await readRequestBody(request, MAX_APPROVAL_BODY_BYTES);
    fields = parseFormUrlEncodedMulti(body);
  } catch (error) {
    sendApprovalError(response, error);
    return;
  }

  const token = firstField(fields, "token");
  if (!authorizeBrowserWrite(options, token)) {
    sendHtml(response, 401, renderErrorPage({
      status: 401,
      title: "Capability token required",
      message: "Recording an approval bundle requires the active UI session token; reopen the review surface from the artshelf ui serve link. Ending the session revokes browser writes."
    }));
    return;
  }

  let snapshot;
  try {
    snapshot = writeApprovalSnapshot(options.uiHome, options.sessionId, buildApprovalInput(options, fields));
    appendEvent(options.uiHome, options.sessionId, {
      type: "approval_bundle_submitted",
      target: { bundleId: snapshot.id },
      payload: {
        bundleId: snapshot.id,
        actionType: snapshot.actionType,
        fingerprint: snapshot.fingerprint,
        registryPath: normalizeRegistryPath(options.registryPath),
        ledgerPath: options.ledgerPath ? normalizeLedgerPath(options.ledgerPath) : null,
        selectedTargetIds: snapshot.selectedTargetIds,
        selectedCount: snapshot.selectedTargetIds.length,
        targetCount: snapshot.targets.length
      }
    });
  } catch (error) {
    sendApprovalError(response, error);
    return;
  }

  sendRedirect(response, 303, bundleRedirect(snapshot.id, token));
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
type BuiltIntentSubmission = {
  intents: AppendEventInput[];
  approvalBundles?: BuiltApprovalBundleSubmission[];
  redirectTarget: Record<string, unknown>;
  queuedCount?: number;
};

type BuiltApprovalBundleSubmission = {
  preparedEventId: string;
  input: ApprovalSnapshotInput;
};

function buildIntentSubmission(
  options: UiServerOptions,
  fields: Record<string, string>,
  multiFields: Record<string, string[]> = {}
): BuiltIntentSubmission {
  if (fields.type === "required_actions_submitted") {
    return buildRequiredActionsSubmission(options, multiFields, approvalSelections(multiFields));
  }
  if (fields.type === "decision_submitted" && fields.lane !== undefined) {
    return buildBulkDecisionSubmission(options, fields, multiFields);
  }
  const intent = buildIntentInput(fields);
  return { intents: [intent], redirectTarget: intent.target ?? {} };
}

function approvalSelections(fields: Record<string, string[]>): string[] {
  const selections = fields.approval ? [...fields.approval] : [];
  for (const [key, values] of Object.entries(fields)) {
    if (!key.startsWith("approval:")) continue;
    const distinct = [...new Set(values.filter((value) => isNonBlank(value)))];
    if (key === "approval:ready-approval") {
      selections.push(...distinct);
      continue;
    }
    if (distinct.length > 1) {
      throw intentError(400, `Conflicting Artshelf UI approval values for ${key}`);
    }
    const selected = distinct[0];
    if (selected !== undefined) selections.push(selected);
  }
  return [...new Set(selections.filter((value) => isNonBlank(value)))];
}

function buildRequiredActionsSubmission(options: UiServerOptions, fields: Record<string, string[]>, approvals: string[]): BuiltIntentSubmission {
  if (approvals.length === 0) {
    throw intentError(400, "Select at least one required action before submitting to the agent");
  }
  const snapshot = buildDashboard(dashboardOptions(options));
  const visibleRows = visibleRequiredActionRows(options, snapshot);
  const approvablePreparedEvents = approvablePreparedPlanEventIds(options, snapshot);
  const intents: AppendEventInput[] = [];
  const approvalBundles: BuiltApprovalBundleSubmission[] = [];
  const rowDecisions = new Map<string, RowDecisionApproval>();
  const bulkDecisions = new Map<RowDecisionApproval["lane"], string>();
  for (const approval of approvals) {
    const [kind, lane, action, extra] = approval.split(":");
    if (kind === "approve-plan") {
      if (action !== undefined || extra !== undefined || !isNonBlank(lane)) {
        throw intentError(400, `Invalid Artshelf UI prepared plan approval "${approval}"`);
      }
      if (lane === "all") {
        approvalBundles.push(...buildAllPreparedPlanApprovalSubmissions(options, approvablePreparedEvents));
      } else {
        approvalBundles.push(buildPreparedPlanApprovalSubmission(options, lane, approvablePreparedEvents));
      }
      continue;
    }
    if (kind === "row-decision") {
      const parsed = parseRowDecisionApproval(approval);
      addRowDecisionApproval(rowDecisions, parsed);
      continue;
    }
    if (extra !== undefined || !isNonBlank(action)) {
      throw intentError(400, `Invalid Artshelf UI required action approval "${approval}"`);
    }
    if (kind === "decision") {
      if (!isBulkDecisionLane(lane)) {
        throw intentError(400, `Invalid Artshelf UI required action decision lane "${lane}"`);
      }
      addBulkDecisionApproval(bulkDecisions, lane, action);
    } else if (kind === "request") {
      if (!isDashboardRequestLane(lane)) {
        throw intentError(400, `Invalid Artshelf UI required action request lane "${String(lane)}"`);
      }
      const expectedRequest = UI_DASHBOARD_LANE_REQUESTS[lane];
      if (action !== expectedRequest) {
        throw intentError(400, `Invalid Artshelf UI required action request "${action}" for lane ${lane}`);
      }
      intents.push({ type: "dry_run_requested", target: { lane }, payload: { request: action, label: requiredActionRequestLabel(lane) } });
    } else {
      throw intentError(400, `Invalid Artshelf UI required action approval "${approval}"`);
    }
  }
  rejectConflictingRequiredActionSelections(bulkDecisions, rowDecisions);
  const seenPreparedApprovals = new Set<string>();
  const uniqueApprovalBundles = approvalBundles.filter((bundle) => {
    if (seenPreparedApprovals.has(bundle.preparedEventId)) return false;
    seenPreparedApprovals.add(bundle.preparedEventId);
    return true;
  });
  for (const [lane, decision] of bulkDecisions) {
    const rows = visibleRowsForLane(visibleRows, lane);
    validateReviewedBulkLaneRows(rows, fields, lane);
    intents.push(...buildBulkDecisionSubmissionFromRows(rows, lane, decision).intents);
  }
  for (const rowDecision of rowDecisions.values()) {
    intents.push(...buildRowDecisionSubmissionFromRows(visibleRowsForLane(visibleRows, rowDecision.lane), rowDecision).intents);
  }
  return { intents, approvalBundles: uniqueApprovalBundles, redirectTarget: { dashboard: "required-actions" } };
}

function buildAllPreparedPlanApprovalSubmissions(options: UiServerOptions, preparedEventIds: Set<string>): BuiltApprovalBundleSubmission[] {
  const bundles = [...preparedEventIds].map((eventId) => buildPreparedPlanApprovalSubmission(options, encodeURIComponent(eventId), preparedEventIds));
  if (bundles.length === 0) {
    throw intentError(400, "No prepared plans are ready for approval");
  }
  return bundles;
}

function submittedPreparedPlanEventIds(options: UiServerOptions): Set<string> {
  const submitted = new Set<string>();
  for (const entry of readSessionHistory(options.uiHome, options.sessionId)) {
    if (entry.event.type !== "approval_bundle_submitted") continue;
    if (!isQueuedForAgentStatus(entry.event.status)) continue;
    const preparedEventId = stringRecordValue(entry.event.payload, "preparedEventId");
    if (preparedEventId) submitted.add(preparedEventId);
  }
  return submitted;
}

function isQueuedForAgentStatus(status: string): boolean {
  return status === "pending" || status === "acknowledged" || status === "in_progress";
}

function buildPreparedPlanApprovalSubmission(options: UiServerOptions, encodedEventId: string, approvableEventIds?: Set<string>): BuiltApprovalBundleSubmission {
  let eventId: string;
  try {
    eventId = decodeURIComponent(encodedEventId);
  } catch {
    throw intentError(400, `Invalid Artshelf UI prepared plan approval "${encodedEventId}"`);
  }
  if (!/^event_\d{8}_\d{6}_[0-9a-f]{8}$/.test(eventId)) {
    throw intentError(400, `Invalid Artshelf UI prepared plan event id "${eventId}"`);
  }
  if (approvableEventIds !== undefined && !approvableEventIds.has(eventId)) {
    throw intentError(409, `Prepared plan event ${eventId} is no longer ready for approval`);
  }

  const entry = readSessionHistory(options.uiHome, options.sessionId).find((candidate) => candidate.event.id === eventId);
  if (entry === undefined || entry.event.type !== "decision_submitted" || entry.event.status !== "completed") {
    throw intentError(400, `Prepared plan event ${eventId} is not ready for approval`);
  }

  const recordId = stringRecordValue(entry.event.target, "recordId");
  const requestedLedgerPath = stringRecordValue(entry.event.target, "ledgerPath");
  if (!recordId || !requestedLedgerPath) {
    throw intentError(400, `Prepared plan event ${eventId} does not name an exact record target`);
  }
  const ledgerPath = scopedDetailLedgerPath(options, requestedLedgerPath);
  if (ledgerPath === null) {
    throw intentError(400, `Prepared plan event ${eventId} targets a ledger outside this served review scope`);
  }

  const reply = [...entry.replies].reverse().find((candidate) => stringRecordValue(candidate.payload, "planId") !== null);
  const planId = reply ? stringRecordValue(reply.payload, "planId") : null;
  if (!planId) {
    throw intentError(400, `Prepared plan event ${eventId} has no reviewed plan id`);
  }

  let planEntry;
  try {
    planEntry = readDisposePlanEntry(ledgerPath, planId);
  } catch (error) {
    throw intentError(409, `Prepared plan ${planId} is no longer reviewable: ${errorMessage(error)}`);
  }
  if (planEntry.id !== recordId) {
    throw intentError(409, `Prepared plan ${planId} no longer matches record ${recordId}`);
  }

  const target: UiApprovalTarget = {
    targetId: recordId,
    recordId,
    ledgerPath,
    registryPath: normalizeRegistryPath(options.registryPath),
    recordPath: planEntry.path,
    planId,
    planEntryDigest: disposePlanEntryDigest(planEntry),
    actionType: planEntry.action,
    label: `${planEntry.action} ${recordId}`
  };
  return {
    preparedEventId: eventId,
    input: {
      actionType: planEntry.action,
      targets: [target],
      selectedTargetIds: [recordId],
      reviewed: {}
    }
  };
}

type RowDecisionApproval = {
  lane: "needs-review" | "needs-context" | "cleanup" | "resolve";
  decision: string;
  recordId: string;
  ledgerPath: string;
};

function parseRowDecisionApproval(approval: string): RowDecisionApproval {
  const [kind, lane, decision, encodedRecordId, encodedLedgerPath, extra] = approval.split(":");
  if (
    kind !== "row-decision" ||
    extra !== undefined ||
    lane === undefined ||
    !isBulkDecisionLane(lane) ||
    decision === undefined ||
    !(UI_DECISION_INTENTS as string[]).includes(decision) ||
    !isNonBlank(encodedRecordId) ||
    !isNonBlank(encodedLedgerPath)
  ) {
    throw intentError(400, `Invalid Artshelf UI row approval "${approval}"`);
  }
  try {
    const recordId = decodeURIComponent(encodedRecordId);
    const ledgerPath = decodeURIComponent(encodedLedgerPath);
    if (!isNonBlank(recordId) || !isNonBlank(ledgerPath)) throw new Error("blank row target");
    return { lane, decision, recordId, ledgerPath };
  } catch {
    throw intentError(400, `Invalid Artshelf UI row approval "${approval}"`);
  }
}

function rowDecisionKey(row: Pick<RowDecisionApproval, "lane" | "recordId" | "ledgerPath">): string {
  return `${row.lane}\0${row.recordId}\0${row.ledgerPath}`;
}

function recordActivityKey(recordId: string, ledgerPath: string): string {
  return `${recordId}\0${ledgerPath}`;
}

function addBulkDecisionApproval(decisions: Map<RowDecisionApproval["lane"], string>, lane: RowDecisionApproval["lane"], decision: string): void {
  const existing = decisions.get(lane);
  if (existing !== undefined && existing !== decision) {
    throw intentError(400, `Conflicting Artshelf UI selections for ${lane}: choose one bulk decision`);
  }
  decisions.set(lane, decision);
}

function addRowDecisionApproval(decisions: Map<string, RowDecisionApproval>, decision: RowDecisionApproval): void {
  const key = rowDecisionKey(decision);
  const existing = decisions.get(key);
  if (existing !== undefined && existing.decision !== decision.decision) {
    throw intentError(400, `Conflicting Artshelf UI row selections for ${decision.lane}: choose one decision for ${decision.recordId}`);
  }
  decisions.set(key, decision);
}

function rejectConflictingRequiredActionSelections(
  bulkDecisions: Map<RowDecisionApproval["lane"], string>,
  rowDecisions: Map<string, RowDecisionApproval>
): void {
  const bulkLanes = new Set(bulkDecisions.keys());
  const conflictingLanes = [...new Set([...rowDecisions.values()].map((decision) => decision.lane).filter((lane) => bulkLanes.has(lane)))];
  if (conflictingLanes.length > 0) {
    throw intentError(
      400,
      `Conflicting Artshelf UI selections for ${conflictingLanes.join(", ")}: choose either the card/bulk approval or individual row choices, not both`
    );
  }
}

function validateReviewedBulkLaneRows(
  rows: DashboardArtifactRow[],
  fields: Record<string, string[]>,
  lane: "needs-review" | "needs-context" | "cleanup" | "resolve"
): void {
  const current = new Set(rows.map((row) => rowDecisionKey({ lane, recordId: row.recordId, ledgerPath: row.ledgerPath ?? "" })));
  const reviewed = reviewedBulkLaneRows(fields, lane);
  if (reviewed.size !== current.size || [...reviewed].some((key) => !current.has(key))) {
    throw intentError(409, `Dashboard lane ${lane} changed since this page loaded; reload the dashboard before submitting bulk approvals`);
  }
}

function reviewedBulkLaneRows(fields: Record<string, string[]>, lane: "needs-review" | "needs-context" | "cleanup" | "resolve"): Set<string> {
  const values = fields[`reviewed:${lane}`] ?? [];
  const rows = new Set<string>();
  for (const value of values) {
    const [encodedRecordId, encodedLedgerPath, extra] = value.split(":");
    if (extra !== undefined || !isNonBlank(encodedRecordId) || !isNonBlank(encodedLedgerPath)) {
      throw intentError(400, `Invalid Artshelf UI reviewed row target for lane ${lane}`);
    }
    try {
      const recordId = decodeURIComponent(encodedRecordId);
      const ledgerPath = decodeURIComponent(encodedLedgerPath);
      if (!isNonBlank(recordId) || !isNonBlank(ledgerPath)) throw new Error("blank reviewed target");
      rows.add(rowDecisionKey({ lane, recordId, ledgerPath }));
    } catch {
      throw intentError(400, `Invalid Artshelf UI reviewed row target for lane ${lane}`);
    }
  }
  return rows;
}

function requiredActionRequestLabel(lane: DashboardBucketKey): string {
  if (lane === "purge-candidates") return "Review delete";
  if (lane === "registry-reconcile") return "Check source";
  return UI_DASHBOARD_LANE_REQUESTS[lane] ?? lane;
}

function buildIntentInput(fields: Record<string, string>): AppendEventInput {
  const type = fields.type ?? "";
  if (!isBrowserIntentType(type)) {
    throw intentError(400, `Unsupported browser intent type "${type}"; the browser may only record inspect, comment, decision, and dry-run intents`);
  }

  const target: Record<string, unknown> = {};
  if (fields.recordId !== undefined) target.recordId = fields.recordId;
  if (fields.ledgerPath !== undefined) target.ledgerPath = fields.ledgerPath;
  if (fields.lane !== undefined) target.lane = fields.lane;

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
  } else if (type === "dry_run_requested") {
    if (isNonBlank(fields.request)) payload.request = fields.request;
    if (isNonBlank(fields.label)) payload.label = fields.label;
  }

  return { type, target, payload };
}

function buildBulkDecisionSubmission(options: UiServerOptions, fields: Record<string, string>, multiFields: Record<string, string[]>): BuiltIntentSubmission {
  const lane = fields.lane ?? "";
  if (!isBulkDecisionLane(lane)) {
    throw intentError(400, `Invalid Artshelf UI bulk decision lane "${lane}"`);
  }
  const decision = fields.decision;
  if (decision === undefined || !isDecisionAllowedForLane(lane, decision)) {
    throw intentError(
      400,
      `Invalid Artshelf UI decision intent "${String(decision)}"; expected one of: ${UI_DECISION_INTENTS.join(", ")}`
    );
  }

  const snapshot = buildDashboard(dashboardOptions(options));
  const rows = visibleRowsForLane(visibleRequiredActionRows(options, snapshot), lane);
  validateReviewedBulkLaneRows(rows, multiFields, lane);
  return buildBulkDecisionSubmissionFromRows(rows, lane, decision, undefined, fields.reason);
}

function buildBulkDecisionSubmissionFromRows(
  rows: DashboardArtifactRow[],
  lane: "needs-review" | "needs-context" | "cleanup" | "resolve",
  decision: string,
  rowDecision?: (row: DashboardArtifactRow) => string,
  reason?: string
): BuiltIntentSubmission {
  if (!isDecisionAllowedForLane(lane, decision)) {
    throw intentError(
      400,
      `Invalid Artshelf UI decision intent "${String(decision)}"; expected one of: ${UI_DECISION_INTENTS.join(", ")}`
    );
  }
  if (rows.length === 0) {
    throw intentError(400, `Dashboard lane ${lane} has no records for a bulk decision`);
  }

  return {
    intents: rows.map((row) => {
      const decisionForRow = rowDecision?.(row) ?? decision;
      if (!isDecisionAllowedForLane(lane, decisionForRow)) {
        throw intentError(400, `Invalid Artshelf UI decision intent "${decisionForRow}" for lane ${lane}`);
      }
      return {
        type: "decision_submitted",
        target: { recordId: row.recordId, ledgerPath: row.ledgerPath },
        payload: {
          decision: decisionForRow,
          lane,
          bulk: true,
          count: rows.length,
          ...(isNonBlank(reason) ? { reason } : {})
        }
      };
    }),
    redirectTarget: { lane }
  };
}

function buildRowDecisionSubmissionFromRows(rows: DashboardArtifactRow[], rowDecision: RowDecisionApproval): BuiltIntentSubmission {
  if (!isDecisionAllowedForLane(rowDecision.lane, rowDecision.decision)) {
    throw intentError(400, `Invalid Artshelf UI decision intent "${rowDecision.decision}" for lane ${rowDecision.lane}`);
  }
  const row = rows.find((candidate) => candidate.recordId === rowDecision.recordId && candidate.ledgerPath === rowDecision.ledgerPath);
  if (row === undefined) {
    throw intentError(400, `Dashboard lane ${rowDecision.lane} has no matching row ${rowDecision.recordId} for a row decision`);
  }
  return {
    intents: [
      {
        type: "decision_submitted",
        target: { recordId: row.recordId, ledgerPath: row.ledgerPath },
        payload: {
          decision: rowDecision.decision,
          lane: rowDecision.lane,
          bulk: false,
          count: 1
        }
      }
    ],
    redirectTarget: { lane: rowDecision.lane }
  };
}

type RequiredActionRows = {
  needsReview: DashboardArtifactRow[];
  needsContext: DashboardArtifactRow[];
  cleanup: DashboardArtifactRow[];
  resolve: DashboardArtifactRow[];
};

function visibleRequiredActionRows(options: UiServerOptions, snapshot: DashboardSnapshot): RequiredActionRows {
  const prepared = livePreparedRowKeys(options, snapshot);
  return {
    needsReview: filterPreparedRows(snapshot.buckets.needsReview, prepared),
    needsContext: filterPreparedRows(snapshot.buckets.needsContext, prepared),
    cleanup: filterPreparedRows(snapshot.buckets.cleanup, prepared),
    resolve: filterPreparedRows(snapshot.buckets.resolve, prepared)
  };
}

function visibleRowsForLane(rows: RequiredActionRows, lane: "needs-review" | "needs-context" | "cleanup" | "resolve"): DashboardArtifactRow[] {
  switch (lane) {
    case "needs-review":
      return rows.needsReview;
    case "needs-context":
      return rows.needsContext;
    case "cleanup":
      return rows.cleanup;
    case "resolve":
      return rows.resolve;
  }
}

function filterPreparedRows(rows: DashboardArtifactRow[], prepared: Set<string>): DashboardArtifactRow[] {
  return rows.filter((row) => !prepared.has(recordActivityKey(row.recordId, row.ledgerPath ?? "")));
}

function livePreparedRowKeys(options: UiServerOptions, snapshot: DashboardSnapshot): Set<string> {
  return new Set(livePreparedPlanEventIndex(options, snapshot).keys());
}

function approvablePreparedPlanEventIds(options: UiServerOptions, snapshot: DashboardSnapshot): Set<string> {
  const submitted = submittedPreparedPlanEventIds(options);
  return new Set([...livePreparedPlanEventIndex(options, snapshot).values()].filter((eventId) => !submitted.has(eventId)));
}

function livePreparedPlanEventIndex(options: UiServerOptions, snapshot: DashboardSnapshot): Map<string, string> {
  const liveActionKeys = new Set<string>();
  for (const row of [...snapshot.buckets.needsReview, ...snapshot.buckets.needsContext, ...snapshot.buckets.cleanup, ...snapshot.buckets.resolve]) {
    liveActionKeys.add(recordActivityKey(row.recordId, row.ledgerPath ?? ""));
  }

  const prepared = new Map<string, string>();
  for (const entry of readSessionHistory(options.uiHome, options.sessionId)) {
    if (entry.event.status !== "completed" || entry.event.type !== "decision_submitted") continue;
    const recordId = stringRecordValue(entry.event.target, "recordId");
    const ledgerPath = stringRecordValue(entry.event.target, "ledgerPath");
    if (!recordId || !ledgerPath) continue;
    const key = recordActivityKey(recordId, ledgerPath);
    if (!liveActionKeys.has(key)) continue;
    const hasPlan = [...entry.replies].reverse().some((candidate) => stringRecordValue(candidate.payload, "planId") !== null);
    if (hasPlan) prepared.set(key, entry.event.id);
  }
  return prepared;
}

function isDecisionAllowedForLane(lane: "needs-review" | "needs-context" | "cleanup" | "resolve", decision: string): boolean {
  return lane === "resolve" ? decision === "keep" || decision === "resolve" : decision === "keep" || decision === "trash";
}

function isBulkDecisionLane(value: unknown): value is "needs-review" | "needs-context" | "cleanup" | "resolve" {
  return value === "needs-review" || value === "needs-context" || value === "cleanup" || value === "resolve";
}

function buildApprovalInput(options: UiServerOptions, fields: Record<string, string[]>): ApprovalSnapshotInput {
  const sourceBundleId = firstField(fields, "sourceBundleId");
  if (!isNonBlank(sourceBundleId)) {
    throw intentError(400, "Invalid Artshelf UI approval sourceBundleId; expected the source approval bundle id");
  }
  const source = readApprovalSnapshot(options.uiHome, options.sessionId, sourceBundleId);
  const selectedTargetIds = fields.targetId ?? [];
  return {
    actionType: source.actionType,
    targets: source.targets,
    selectedTargetIds,
    reviewed: source.reviewed ?? {}
  };
}

function isBrowserIntentType(value: string): value is UiEventType {
  return (BROWSER_INTENT_TYPES as string[]).includes(value);
}

// Refuse forged or stale browser targets before the event reaches the durable log. The forms only
// render from a real detail drawer, but a same-machine client with the token could still POST by
// hand; the server therefore verifies that the record exists in a ledger inside this served scope and
// enriches the compact target with the human-readable ledger name when the registry knows one.
function validateIntentTarget(
  options: UiServerOptions,
  type: UiEventType,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): { target: Record<string, unknown>; payload: Record<string, unknown> } {
  if (typeof target.lane === "string" || target.lane !== undefined) {
    return validateDashboardLaneTarget(options, type, target, payload);
  }

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
    const validatedTarget = detail.ledgerName
      ? { ...target, recordId: detail.recordId, ledgerPath: detail.ledgerPath, ledgerName: detail.ledgerName }
      : { ...target, recordId: detail.recordId, ledgerPath: detail.ledgerPath };
    return { target: validatedTarget, payload };
  } catch (error) {
    throw intentError(400, `Invalid intent target: ${errorMessage(error)}`);
  }
}

function validateDashboardLaneTarget(
  options: UiServerOptions,
  type: UiEventType,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): { target: Record<string, unknown>; payload: Record<string, unknown> } {
  if (type !== "dry_run_requested") {
    throw intentError(400, "Dashboard lane buttons may only record dry-run request intents");
  }
  const lane = target.lane;
  if (!isDashboardRequestLane(lane)) {
    throw intentError(400, `Invalid Artshelf UI dashboard lane "${String(lane)}"`);
  }
  const expectedRequest = UI_DASHBOARD_LANE_REQUESTS[lane];
  if (payload.request !== expectedRequest) {
    throw intentError(400, `Invalid Artshelf UI dashboard request "${String(payload.request)}" for lane ${lane}`);
  }

  const snapshot = buildDashboard(dashboardOptions(options));
  const count = dashboardLaneCount(snapshot, lane);
  if (count <= 0) {
    throw intentError(400, `Dashboard lane ${lane} has no work to request`);
  }

  const validatedTarget: Record<string, unknown> = { lane, registryPath: normalizeRegistryPath(options.registryPath) };
  if (options.ledgerPath !== undefined) validatedTarget.ledgerPath = normalizeLedgerPath(options.ledgerPath);
  return {
    target: validatedTarget,
    payload: {
      request: expectedRequest,
      ...(typeof payload.label === "string" && payload.label.trim().length > 0 ? { label: payload.label } : {}),
      count
    }
  };
}

function isDashboardRequestLane(value: unknown): value is DashboardBucketKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(UI_DASHBOARD_LANE_REQUESTS, value);
}

function dashboardLaneCount(snapshot: DashboardSnapshot, lane: DashboardBucketKey): number {
  if (lane === "registry-reconcile") {
    return snapshot.counts["registry-reconcile"] + snapshot.ledgers.filter((ledger) => !ledger.ok).length;
  }
  return snapshot.counts[lane] ?? 0;
}

function isNonBlank(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringRecordValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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

function intentRedirect(target: Record<string, unknown>, token: string, queuedCount = 0): string {
  if (target.dashboard === "required-actions") {
    const params: string[] = [];
    if (token) params.push(`token=${encodeURIComponent(token)}`);
    if (queuedCount > 0) params.push(`queued=${encodeURIComponent(String(queuedCount))}`);
    const query = params.length > 0 ? `?${params.join("&")}` : "";
    return `/${query}${queuedCount > 0 ? "#session-activity" : "#required-actions"}`;
  }
  if (typeof target.lane === "string") {
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    return `/${query}#lane-${encodeURIComponent(target.lane)}`;
  }
  return detailRedirect(target, token);
}

function dashboardActivityRedirect(token: string): string {
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `/${query}#session-activity`;
}

function parseQueuedNotice(query: string, history: UiSessionHistoryEntry[]): number | null {
  const raw = getQueryParam(query, "queued");
  if (raw === null) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  const pending = history.filter((entry) => entry.event.source === "browser" && entry.event.status === "pending").length;
  if (pending <= 0) return null;
  return Math.min(parsed, pending);
}

function activityHref(token: string): string {
  return `${ACTIVITY_PATH}?token=${encodeURIComponent(token)}`;
}

function dashboardSessionHistory(options: UiServerOptions): UiSessionHistoryEntry[] {
  try {
    return readSessionHistory(options.uiHome, options.sessionId);
  } catch {
    return [];
  }
}

function bundleRedirect(bundleId: string, token: string): string {
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${BUNDLE_PREFIX}${encodeURIComponent(bundleId)}${query}`;
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

function flattenFormFields(multi: Record<string, string[]>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, values] of Object.entries(multi)) fields[key] = values[values.length - 1] ?? "";
  return fields;
}

function parseFormUrlEncodedMulti(body: string): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
    const key = decodeFormComponent(rawKey);
    const value = decodeFormComponent(rawValue);
    (fields[key] ??= []).push(value);
  }
  return fields;
}

function firstField(fields: Record<string, string[]>, key: string): string {
  const values = fields[key] ?? [];
  return values[values.length - 1] ?? "";
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

function sendApprovalError(response: any, error: unknown): void {
  const status =
    typeof (error as { httpStatus?: unknown }).httpStatus === "number"
      ? (error as { httpStatus: number }).httpStatus
      : isApprovalValidationError(error)
        ? 400
        : 500;
  const title = status === 413 ? "Approval too large" : status >= 500 ? "Server error" : "Approval rejected";
  sendHtml(response, status, renderErrorPage({ status, title, message: errorMessage(error) }));
}

function isApprovalValidationError(error: unknown): boolean {
  const message = errorMessage(error);
  return /^(Invalid|Duplicate) Artshelf UI approval/.test(message) || /approval selection id/.test(message);
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

// Render one persisted approval bundle as the browser workbench (NGX-539 AC4). An approval snapshot
// is immutable, so submitting a revised selection creates a new bundle instead of changing this one.
// The surface executes nothing and mutates no ledger, file, trash, or plan. The capability token
// already gated this read. A malformed or absent bundle id is an expected, non-crashing not-found
// state; anything else is a real server error.
function routeBundle(options: UiServerOptions, bundleId: string, response: any, token: string): void {
  if (!bundleId) {
    sendHtml(response, 404, renderErrorPage({ status: 404, title: "Bundle not found", message: "Missing approval bundle id." }));
    return;
  }
  try {
    const snapshot = readApprovalSnapshot(options.uiHome, options.sessionId, bundleId);
    const view = buildApprovalWorkbenchView(snapshot, options.registryPath !== undefined ? { registryPath: options.registryPath } : {});
    sendHtml(response, 200, renderApprovalWorkbenchPage(view, token));
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

function uiScriptNonce(): string {
  return randomBytes(16).toString("base64");
}

function dashboardContentSecurityPolicy(scriptNonce: string): string {
  return `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'self'`;
}

function sendHtml(response: any, status: number, html: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": SCRIPTLESS_CONTENT_SECURITY_POLICY, ...SECURITY_HEADERS, ...headers });
  response.end(html);
}

function sendText(response: any, status: number, text: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": SCRIPTLESS_CONTENT_SECURITY_POLICY, ...SECURITY_HEADERS });
  response.end(text);
}

function sendRedirect(response: any, status: number, location: string): void {
  response.writeHead(status, { Location: location, "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": SCRIPTLESS_CONTENT_SECURITY_POLICY, ...SECURITY_HEADERS });
  response.end(`Intent recorded. Continue at ${location}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
