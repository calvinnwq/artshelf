import type { ArtifactProvenanceView, BuildArtifactDetailOptions } from "../artifact-detail.js";
import { buildArtifactDetail } from "../artifact-detail.js";
import { uiLinkBaseUrl } from "../config/env.js";
import type { BuildDashboardOptions, DashboardBucketKey, DashboardLastAction } from "../dashboard.js";
import { buildDashboard } from "../dashboard.js";
import { normalizeRegistryPath } from "../registry.js";
import { printCompactJson } from "../renderers/json.js";
import {
  endSession,
  isUiReplyStatus,
  listApprovalSnapshots,
  pollPendingEvents,
  readApprovalSnapshot,
  readSession,
  replyToEvent,
  resolveUiHome,
  selectedApprovalTargets,
  startOrResumeSession,
  UI_REPLY_STATUSES
} from "../session.js";
import type { ParsedArgs } from "../shared/cli-types.js";
import { boolFlag, requiredStringFlag, stringFlag } from "../shared/flags.js";
import { UI_HELP } from "../shared/help-text.js";
import type { UiApprovalSnapshot, UiApprovalTarget, UiEvent, UiSession, UiSessionScope } from "../types.js";
import { executeApprovedBundle } from "../ui-execute.js";
import type { StartUiServerOptions, UiServerHandle } from "../ui-server.js";
import { startUiServer } from "../ui-server.js";

// AXI-style command surface for the Artshelf UI v1 review session (NGX-532). This is the agent's
// side of the v1 boundary: `ui` starts or resumes a durable review session, and the poll/reply/end
// loop lets the agent drain browser-recorded triage intents and write back receipts. `dashboard` and
// `detail` are the read-only review surfaces (NGX-535/536/537): they recompute live multi-ledger
// state and the single-record detail drawer from existing read-only domain cores. `execute` is the
// only mutating UI subcommand, and it runs approved bundles through existing exact-target
// approval-gated paths after live revalidation. The browser records triage intents through the
// durable session layer and never reads or previews file contents. The browser's only write path is
// capturing human triage intents (NGX-538) as pending session events; it never mutates ledgers,
// files, trash, or plans directly.
// Output defaults to a human summary; `--json` emits a compact single-line packet for agents.
export async function handleUi(parsed: ParsedArgs, json: boolean): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === "help") {
    process.stdout.write(UI_HELP);
    return 0;
  }
  if (sub === "dashboard") return handleUiDashboard(parsed, json);
  if (sub === "detail") return handleUiDetail(parsed, json);
  if (sub === "serve") return handleUiServe(parsed, json);
  if (sub === "poll") return handleUiPoll(parsed, json);
  if (sub === "reply") return handleUiReply(parsed, json);
  if (sub === "bundle") return handleUiBundle(parsed, json);
  if (sub === "execute") return handleUiExecute(parsed, json);
  if (sub === "end") return handleUiEnd(parsed, json);
  if (sub === undefined) return handleUiStart(parsed, json);
  throw new Error(`Unknown ui subcommand: ${sub} (expected dashboard, detail, serve, poll, reply, bundle, execute, or end)`);
}

// `artshelf ui [--scope user|repo] [--ledger <path>] [--json]` - start or resume the session for
// this scope/ledger target. Defaults to user-level, multi-ledger review so it works regardless of
// the current working directory.
function handleUiStart(parsed: ParsedArgs, json: boolean): number {
  const scope = resolveScope(stringFlag(parsed, "scope"));
  const ledgerPath = stringFlag(parsed, "ledger") ?? null;
  const home = resolveUiHome({ scope, cwd: process.cwd() });
  const registryPath = ledgerPath === null ? normalizeRegistryPath() : null;
  const session = startOrResumeSession({ home, scope, ledgerPath, registryPath, cwd: process.cwd() });
  const link = buildLink(session);
  const scopeHint = session.scope === "user" ? "" : ` --scope ${session.scope}`;
  const pollHint = `artshelf ui poll ${session.id}${scopeHint} --json`;

  if (json) {
    return printCompactJson({
      ok: true,
      command: "ui",
      home,
      session: publicSession(session),
      token: session.token,
      link,
      poll: pollHint
    });
  }

  const ledgerLabel = session.ledgerPath ? `ledger ${session.ledgerPath}` : "multi-ledger";
  process.stdout.write(`artshelf ui: session ${session.id} (${session.status}, ${session.scope} scope, ${ledgerLabel})\n`);
  process.stdout.write(`token: ${session.token}\n`);
  process.stdout.write(`open: ${link.remote ?? link.note}\n`);
  process.stdout.write(`poll: ${pollHint}\n`);
  return 0;
}

// `artshelf ui poll <session-id> [--json]` - return pending actionable events compactly for the
// agent. Read-only: an ended session is still pollable for audit, it just has nothing pending.
function handleUiPoll(parsed: ParsedArgs, json: boolean): number {
  const sessionId = requireSessionId(parsed);
  const home = resolveHome(parsed);
  const session = readSession(home, sessionId);
  const events = pollPendingEvents(home, sessionId);

  if (json) {
    return printCompactJson({
      ok: true,
      command: "ui-poll",
      sessionId,
      status: session.status,
      pending: events.length,
      events: events.map(compactEvent)
    });
  }

  if (events.length === 0) {
    process.stdout.write(`artshelf ui poll: no pending events for ${sessionId}\n`);
    return 0;
  }
  process.stdout.write(`artshelf ui poll: ${events.length} pending event(s) for ${sessionId}\n`);
  for (const event of events) {
    process.stdout.write(`[${event.id}] ${event.type} - ${event.status}\n`);
  }
  return 0;
}

// `artshelf ui reply <session-id> --event <event-id> --status <status> [--payload <json>] [--json]`
// - append an agent reply that advances exactly one event and carries the receipt/result/note. The
// status must be a known event status, and the payload, when present, must be a JSON object.
function handleUiReply(parsed: ParsedArgs, json: boolean): number {
  const sessionId = requireSessionId(parsed);
  const home = resolveHome(parsed);
  const eventId = requiredStringFlag(parsed, "event");
  const status = requiredStringFlag(parsed, "status");
  if (!isUiReplyStatus(status)) {
    throw new Error(`Invalid --status "${status}"; expected one of: ${UI_REPLY_STATUSES.join(", ")}`);
  }
  const payload = parsePayload(stringFlag(parsed, "payload"));
  const { event, reply } = replyToEvent(home, sessionId, eventId, payload === null ? { status } : { status, payload });

  if (json) {
    return printCompactJson({
      ok: true,
      command: "ui-reply",
      sessionId,
      reply: { id: reply.id, eventId: reply.eventId, status: reply.status, createdAt: reply.createdAt },
      event: { id: event.id, type: event.type, status: event.status, updatedAt: event.updatedAt }
    });
  }

  process.stdout.write(`artshelf ui reply: ${event.id} → ${reply.status}\n`);
  return 0;
}

// `artshelf ui end <session-id> [--json]` - end the session, which revokes browser event writes
// while keeping the session readable for audit and resume.
function handleUiEnd(parsed: ParsedArgs, json: boolean): number {
  const sessionId = requireSessionId(parsed);
  const home = resolveHome(parsed);
  const session = endSession(home, sessionId);

  if (json) {
    return printCompactJson({ ok: true, command: "ui-end", session: publicSession(session) });
  }
  process.stdout.write(`artshelf ui end: session ${session.id} ended\n`);
  return 0;
}

// `artshelf ui bundle <session-id> [<bundle-id>] [--scope user|repo] [--json]` - the agent's
// read surface over persisted approval bundles (NGX-539). With a bundle id it loads one immutable
// snapshot and resolves its deliberate selection to the exact per-target rows, emitting the
// agent-facing JSON the agent uses to revalidate live state before execution. With no bundle id it
// lists the session's approved bundles as a compact discovery summary. This never executes a bundle
// and never mutates anything - an approval record is not an execution.
function handleUiBundle(parsed: ParsedArgs, json: boolean): number {
  const sessionId = requireSessionId(parsed);
  const home = resolveHome(parsed);
  const session = readSession(home, sessionId);
  const bundleId = parsed.positionals[2];
  return bundleId === undefined
    ? printBundleList(home, session, json)
    : printBundleDetail(home, session, bundleId, json);
}

function printBundleDetail(home: string, session: UiSession, bundleId: string, json: boolean): number {
  const bundle = readApprovalSnapshot(home, session.id, bundleId);
  const selected = selectedApprovalTargets(bundle);

  if (json) {
    // The full immutable snapshot plus the resolved selection: everything an agent needs to
    // revalidate live state before execution, without re-deriving the approved subset.
    return printCompactJson({ ok: true, command: "ui-bundle", sessionId: session.id, bundle, selected });
  }

  process.stdout.write(`artshelf ui bundle: ${bundle.id} (${bundle.actionType}) in session ${session.id}\n`);
  process.stdout.write(`created: ${bundle.createdAt}\n`);
  process.stdout.write(`fingerprint: ${bundle.fingerprint}\n`);
  process.stdout.write(`selected: ${selected.length} of ${bundle.targets.length} reviewed target(s)\n`);
  for (const target of selected) {
    process.stdout.write(`  [${target.targetId}] ${target.label} -> ${targetSubject(target)}\n`);
  }
  process.stdout.write("revalidate live state before execution; this is an approval record, not an execution.\n");
  return 0;
}

function printBundleList(home: string, session: UiSession, json: boolean): number {
  const rows = listApprovalSnapshots(home, session.id).map(bundleSummary);

  if (json) {
    return printCompactJson({ ok: true, command: "ui-bundle-list", sessionId: session.id, count: rows.length, bundles: rows });
  }

  if (rows.length === 0) {
    process.stdout.write(`artshelf ui bundle: no approved bundles for ${session.id}\n`);
    return 0;
  }
  process.stdout.write(`artshelf ui bundle: ${rows.length} approved bundle(s) for ${session.id}\n`);
  for (const row of rows) {
    process.stdout.write(
      `[${row.id}] ${row.actionType} - ${row.selectedCount} of ${row.targetCount} selected (created ${row.createdAt})\n`
    );
  }
  return 0;
}

// Compact per-bundle row for the listing surface: identity, action, counts, and fingerprint so the
// agent can discover and audit approved bundles, then `ui bundle <session> <id>` for the full snapshot.
function bundleSummary(bundle: UiApprovalSnapshot): {
  id: string;
  actionType: string;
  createdAt: string;
  fingerprint: string;
  selectedCount: number;
  targetCount: number;
} {
  return {
    id: bundle.id,
    actionType: bundle.actionType,
    createdAt: bundle.createdAt,
    fingerprint: bundle.fingerprint,
    selectedCount: bundle.selectedTargetIds.length,
    targetCount: bundle.targets.length
  };
}

// The exact subject a selected target points at, for the human listing line. Every selected target
// names a concrete subject (recordPath, planId, or registryPath); the owning ledger is the last
// resort so the line is never blank.
function targetSubject(target: UiApprovalTarget): string {
  return target.recordPath ?? target.planId ?? target.registryPath ?? target.ledgerPath;
}

// `artshelf ui execute <session-id> <bundle-id> [--scope user|repo] [--json]` - the agent's mutating
// execution path for an approved bundle (NGX-540), and the one `ui` subcommand that changes live
// state. It loads the immutable reviewed snapshot, re-reads live ledger/registry/trash state, runs the
// revalidate -> execute -> verify loop through the existing approval-gated dispose paths, and replies
// per-target receipts plus aggregate state to the session by advancing the bundle's
// approval_bundle_submitted event. Execution is exact-target only: a stale, missing, mismatched, or
// unapproved target is refused or skipped, never force-applied, and the agent confirms live state
// rather than trusting the command exit. A clean run (every selected target executed) exits 0; a
// partial or refused run exits non-zero so the agent loop notices, while every target's receipt is
// still recorded in the session so no outcome is hidden.
function handleUiExecute(parsed: ParsedArgs, json: boolean): number {
  if (boolFlag(parsed, "all")) {
    throw new Error("ui execute --all is not supported; execute one approved bundle id");
  }
  const sessionId = requireSessionId(parsed);
  const home = resolveHome(parsed);
  const bundleId = parsed.positionals[2];
  if (!bundleId) {
    throw new Error("Missing bundle id; usage: artshelf ui execute <session-id> <bundle-id> [--json]");
  }
  const { execution, event, reply } = executeApprovedBundle(home, sessionId, bundleId);
  const clean = execution.status === "executed";

  if (json) {
    printCompactJson({
      ok: clean,
      command: "ui-execute",
      sessionId,
      execution,
      event: { id: event.id, type: event.type, status: event.status, updatedAt: event.updatedAt },
      reply: { id: reply.id, eventId: reply.eventId, status: reply.status, createdAt: reply.createdAt }
    });
    return clean ? 0 : 1;
  }

  const counts = execution.counts;
  process.stdout.write(`artshelf ui execute: bundle ${execution.bundleId} ${execution.status} in session ${sessionId} (reply ${reply.status})\n`);
  process.stdout.write(
    `  ${counts.executed} executed, ${counts.skipped_stale} skipped_stale, ${counts.failed} failed, ${counts.needs_manual_review} needs_manual_review\n`
  );
  for (const receipt of execution.receipts) {
    process.stdout.write(`  [${receipt.targetId}] ${receipt.outcome} - ${receipt.detail}\n`);
  }
  return clean ? 0 : 1;
}

// `artshelf ui dashboard [--registry <path>] [--json]` - the read-only multi-ledger review
// dashboard (NGX-535). It recomputes live state across registered ledgers into the eight UI v1
// lanes (including the NGX-537 needs-context bucket) without mutating anything or reading file
// contents. No session is needed: this is live truth, not session-scoped state.
function handleUiDashboard(parsed: ParsedArgs, json: boolean): number {
  const options: BuildDashboardOptions = {};
  const registryPath = stringFlag(parsed, "registry");
  if (registryPath !== undefined) options.registryPath = registryPath;
  const dashboard = buildDashboard(options);

  if (json) {
    return printCompactJson({ ok: true, command: "ui-dashboard", dashboard });
  }

  const okLedgers = dashboard.ledgers.filter((ledger) => ledger.ok).length;
  process.stdout.write(
    `artshelf ui dashboard: ${dashboard.ledgers.length} ledger(s) (${okLedgers} ok), generated ${dashboard.generatedAt}\n`
  );
  process.stdout.write(`registry: ${dashboard.registryPath}\n`);
  for (const lane of DASHBOARD_LANES) {
    process.stdout.write(`  ${lane.padEnd(LANE_LABEL_WIDTH)}${dashboard.counts[lane]}\n`);
  }
  // Surface unhealthy ledgers so a missing/invalid ledger is visible, not silently empty.
  for (const ledger of dashboard.ledgers) {
    if (!ledger.ok) process.stdout.write(`! ${ledger.name} (${ledger.path}): ${ledger.errors[0] ?? "unavailable"}\n`);
  }
  return 0;
}

// `artshelf ui detail <record-id> [--ledger <path>] [--registry <path>] [--json]` - the read-only
// artifact detail drawer (NGX-536). It composes the inspect decision card with provenance, the
// audit trail, the last action, and the NGX-537 needs-context badge into the contract's Minimum
// Human-Judgment Fields. File contents are never read or previewed.
function handleUiDetail(parsed: ParsedArgs, json: boolean): number {
  const recordId = parsed.positionals[1];
  if (!recordId) {
    throw new Error("Missing record id; usage: artshelf ui detail <record-id> [--ledger <path>] [--json]");
  }
  const options: BuildArtifactDetailOptions = { recordId };
  const ledgerPath = stringFlag(parsed, "ledger");
  if (ledgerPath !== undefined) options.ledgerPath = ledgerPath;
  const registryPath = stringFlag(parsed, "registry");
  if (registryPath !== undefined) options.registryPath = registryPath;
  const detail = buildArtifactDetail(options);

  if (json) {
    return printCompactJson({ ok: true, command: "ui-detail", detail });
  }

  const inspect = detail.inspect;
  const field = (label: string, value: string): string => `  ${`${label}:`.padEnd(DETAIL_LABEL_WIDTH)}${value}\n`;
  process.stdout.write(`artshelf ui detail: ${detail.recordId} (${inspect.status}) in ${detail.ledgerName ?? detail.ledgerPath}\n`);
  process.stdout.write(field("reason", inspect.reason.trim() ? inspect.reason : "(none recorded)"));
  process.stdout.write(field("age", `${inspect.age} (created ${detail.createdAt})`));
  process.stdout.write(field("retention", retentionLabel(inspect.retention.mode, inspect.retainUntil)));
  process.stdout.write(field("cleanup", inspect.cleanup));
  process.stdout.write(field("existence", existenceLabel(inspect.existence, inspect.nodeKind, inspect.byteSize)));
  process.stdout.write(field("recommendation", inspect.recommendation));
  process.stdout.write(field("due", detail.dueReason ?? "not due"));
  process.stdout.write(field("provenance", provenanceLabel(detail.provenance)));
  if (detail.needsContext) process.stdout.write(field("needs-context", detail.needsContext.label));
  process.stdout.write(field("last action", lastActionLabel(detail.lastAction)));
  process.stdout.write(field("next", inspect.nextAction));
  return 0;
}

// `artshelf ui serve [--port <port>] [--registry <path>] [--ledger <path>]` - host the dashboard
// (NGX-535) and artifact detail drawers (NGX-536/538) as a local browser surface. It binds to
// loopback only, recomputes live state per request, and never reads file contents. The dashboard
// is display-only; the detail drawer also captures human triage intents (NGX-538) as pending
// session events but never mutates ledgers, files, trash, or plans directly. The process runs in
// the foreground until interrupted, so this is the one `ui` subcommand that does not return
// immediately.
async function handleUiServe(parsed: ParsedArgs, json: boolean): Promise<number> {
  const portRaw = stringFlag(parsed, "port");
  let port: number | undefined;
  if (portRaw !== undefined) {
    const parsedPort = Number(portRaw);
    if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
      throw new Error(`Invalid --port "${portRaw}"; expected an integer between 0 and 65535`);
    }
    port = parsedPort;
  }
  const registryPath = stringFlag(parsed, "registry");
  const ledgerPath = stringFlag(parsed, "ledger");
  const scope = resolveScope(stringFlag(parsed, "scope"));
  const home = resolveUiHome({ scope, cwd: process.cwd() });
  const sessionRegistryPath = ledgerPath === undefined ? normalizeRegistryPath(registryPath) : registryPath ?? null;
  const session = startOrResumeSession({ home, scope, ledgerPath: ledgerPath ?? null, registryPath: sessionRegistryPath, cwd: process.cwd() });
  const options: StartUiServerOptions = { uiHome: home, sessionId: session.id };
  if (port !== undefined) options.port = port;
  if (session.registryPath !== null) options.registryPath = session.registryPath;
  if (ledgerPath !== undefined) options.ledgerPath = ledgerPath;

  const handle = await startUiServer(options);
  const accessUrl = `${handle.url}/?token=${encodeURIComponent(session.token)}`;
  if (json) {
    printCompactJson({
      ok: true,
      command: "ui-serve",
      url: accessUrl,
      baseUrl: handle.url,
      host: handle.host,
      port: handle.port,
      session: publicSession(session),
      token: session.token
    });
  } else {
    process.stdout.write(`artshelf ui serve: review dashboard and triage drawer on ${handle.url}\n`);
    process.stdout.write(`session: ${session.id}\n`);
    process.stdout.write(`open ${accessUrl} in a browser on this machine; treat the token as secret.\n`);
    process.stdout.write("press Ctrl-C to stop.\n");
  }
  // Keep the foreground process alive while the loopback server runs. SIGINT/SIGTERM terminate it;
  // captured intents are durably appended per request, so nothing here needs a graceful flush.
  await waitForServerClose(handle);
  return 0;
}

function waitForServerClose(handle: UiServerHandle): Promise<void> {
  return new Promise<void>((resolve) => {
    handle.server.once("close", () => resolve());
  });
}

// Display order for the eight dashboard lanes, matching the UI v1 contract bucket order.
const DASHBOARD_LANES: DashboardBucketKey[] = [
  "needs-review",
  "needs-context",
  "cleanup",
  "resolve",
  "trash",
  "purge-candidates",
  "registry-reconcile",
  "recent-receipts"
];
const LANE_LABEL_WIDTH = 20;
const DETAIL_LABEL_WIDTH = 16;

function retentionLabel(mode: string, retainUntil: string | null): string {
  return retainUntil ? `${mode} (until ${retainUntil})` : mode;
}

function existenceLabel(existence: string, nodeKind: string | null, byteSize: number | null): string {
  if (existence !== "present") return existence;
  const facts = [nodeKind, byteSize === null ? null : `${byteSize} B`].filter((fact): fact is string => fact !== null);
  return facts.length > 0 ? `present (${facts.join(", ")})` : "present";
}

function provenanceLabel(view: ArtifactProvenanceView): string {
  if (!view.present || !view.provenance) return "none recorded";
  const provenance = view.provenance;
  const place = provenance.relativePath ? `${provenance.root}:${provenance.relativePath}` : provenance.root;
  return provenance.fingerprint ? `${place} (fingerprinted)` : place;
}

function lastActionLabel(lastAction: DashboardLastAction | null): string {
  if (!lastAction) return "none";
  return lastAction.receiptPath
    ? `${lastAction.kind} at ${lastAction.at} (receipt ${lastAction.receiptPath})`
    : `${lastAction.kind} at ${lastAction.at}`;
}

function resolveHome(parsed: ParsedArgs): string {
  return resolveUiHome({ scope: resolveScope(stringFlag(parsed, "scope")), cwd: process.cwd() });
}

function resolveScope(value: string | undefined): UiSessionScope {
  if (value === undefined) return "user";
  if (value === "user" || value === "repo") return value;
  throw new Error(`Invalid --scope "${value}"; expected user or repo`);
}

function requireSessionId(parsed: ParsedArgs): string {
  const id = parsed.positionals[1];
  if (!id) throw new Error("Missing session id; usage: artshelf ui <poll|reply|bundle|execute|end> <session-id>");
  return id;
}

// Drop the capability token from the session view echoed to the agent loop; `ui` surfaces the token
// once, explicitly, at start.
function publicSession(session: UiSession): Omit<UiSession, "token"> {
  const { token: _token, ...rest } = session;
  return rest;
}

function compactEvent(event: UiEvent): Pick<UiEvent, "id" | "type" | "status" | "source" | "createdAt" | "target" | "payload"> {
  return {
    id: event.id,
    type: event.type,
    status: event.status,
    source: event.source,
    createdAt: event.createdAt,
    target: event.target,
    payload: event.payload
  };
}

function buildLink(session: UiSession): { remote: string | null; note: string } {
  const base = uiLinkBaseUrl();
  if (base) {
    return {
      remote: `${base}/ui/${session.id}?token=${session.token}`,
      note: "Remote review link is capability-protected; treat the session token as a secret."
    };
  }
  return {
    remote: null,
    note: "No remote UI URL configured (set ARTSHELF_UI_URL). Open the review dashboard on the host machine; do not share a localhost link with another host."
  };
}

function parsePayload(raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid --payload JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
