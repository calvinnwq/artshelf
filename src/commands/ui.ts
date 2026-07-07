import type { ArtifactProvenanceView, BuildArtifactDetailOptions } from "../artifact-detail.js";
import { buildArtifactDetail } from "../artifact-detail.js";
import { uiLinkBaseUrl } from "../config/env.js";
import type { BuildDashboardOptions, DashboardArtifactRow, DashboardBucketKey, DashboardLastAction } from "../dashboard.js";
import { buildDashboard, groupPurgeCandidates, purgeApprovalTargets, PURGE_APPROVAL_ACTION } from "../dashboard.js";
import type { DisposeRequest } from "../dispose.js";
import { createDisposePlan } from "../dispose.js";
import { createCleanupPlan } from "../ledger.js";
import { normalizeRegistryPath } from "../registry.js";
import { printCompactJson } from "../renderers/json.js";
import {
  endSession,
  isUiDecisionIntent,
  isUiReplyStatus,
  listApprovalSnapshots,
  pollPendingEvents,
  readApprovalSnapshot,
  readSession,
  readSessionEvents,
  replyToEvent,
  resolveUiHome,
  selectedApprovalTargets,
  startOrResumeSession,
  UI_REPLY_STATUSES,
  writeApprovalSnapshot
} from "../session.js";
import type { ParsedArgs } from "../shared/cli-types.js";
import { boolFlag, requiredStringFlag, stringFlag } from "../shared/flags.js";
import { UI_HELP } from "../shared/help-text.js";
import type { DisposeAction, UiApprovalSnapshot, UiApprovalTarget, UiDecisionIntent, UiEvent, UiSession, UiSessionScope } from "../types.js";
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
  if (sub === "review") return handleUiReview(parsed, json);
  if (sub === "poll") return handleUiPoll(parsed, json);
  if (sub === "reply") return handleUiReply(parsed, json);
  if (sub === "bundle") return handleUiBundle(parsed, json);
  if (sub === "execute") return handleUiExecute(parsed, json);
  if (sub === "end") return handleUiEnd(parsed, json);
  if (sub === undefined) return handleUiStart(parsed, json);
  throw new Error(`Unknown ui subcommand: ${sub} (expected dashboard, detail, serve, review, poll, reply, bundle, execute, or end)`);
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
// revalidate -> execute -> verify loop through the existing approval-gated dispose paths or the
// exact-target one-way-door purge path, and replies per-target receipts plus aggregate state to the
// session by advancing the bundle's
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
// loopback only, recomputes live state per request, and never reads file contents. Dashboard and
// detail forms capture token-bound session events for the agent, including queued dashboard
// required actions and record-level triage intents, but never mutate ledgers, files, trash, or plans
// directly. The process runs in the foreground until interrupted, so this is the one `ui` subcommand
// that does not return immediately.
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

// `artshelf ui review [--scope user|repo] [--port <port>] [--registry <path>] [--ledger <path>]`
// - managed foreground lifecycle that owns the loopback server plus the agent poll/reply loop.
// It is deliberately conservative: the browser queues events, this agent-side loop immediately
// claims them as in_progress, then either handles read-only work, executes already-approved exact
// bundles through ui-execute's core, or rejects unsupported/broad requests with visible reasons.
async function handleUiReview(parsed: ParsedArgs, json: boolean): Promise<number> {
  if (boolFlag(parsed, "all")) {
    throw new Error("ui review --all is not supported; managed review handles only token-bound session events and exact approved bundles");
  }
  const port = parsePort(stringFlag(parsed, "port"));
  const pollIntervalMs = parsePollInterval(stringFlag(parsed, "poll-interval-ms"));
  const registryPath = stringFlag(parsed, "registry");
  const ledgerPath = stringFlag(parsed, "ledger");
  const scope = resolveScope(stringFlag(parsed, "scope"));
  const home = resolveUiHome({ scope, cwd: process.cwd() });
  const sessionRegistryPath = ledgerPath === undefined ? normalizeRegistryPath(registryPath) : registryPath ?? null;
  const session = startOrResumeSession({ home, scope, ledgerPath: ledgerPath ?? null, registryPath: sessionRegistryPath, cwd: process.cwd() });
  const options: StartUiServerOptions = { uiHome: home, sessionId: session.id };
  options.managedReview = true;
  if (port !== undefined) options.port = port;
  if (session.registryPath !== null) options.registryPath = session.registryPath;
  if (ledgerPath !== undefined) options.ledgerPath = ledgerPath;

  const handle = await startUiServer(options);
  const accessUrl = `${handle.url}/?token=${encodeURIComponent(session.token)}`;
  const processed: ManagedReviewCounts = emptyManagedCounts();
  let stopReason: string | null = null;
  let wakeSleep: (() => void) | null = null;

  const signalHandler = (signal: string): void => {
    stopReason = `signal:${signal}`;
    wakeSleep?.();
  };
  signalProcess().once("SIGINT", signalHandler);
  signalProcess().once("SIGTERM", signalHandler);

  printManagedStart({ json, home, session, handle, accessUrl, pollIntervalMs });
  let failure: unknown = null;
  try {
    while (stopReason === null) {
      // If the session was ended out from under this manager (e.g. another process ran `ui end`),
      // stop presenting the browser as live and tear down cleanly. A read that throws instead
      // (session file missing/corrupt) is an abnormal condition surfaced by the catch below as an
      // error exit, not this clean session-ended path.
      if (readSession(home, session.id).status !== "active") {
        stopReason = "session-ended";
        break;
      }
      const pending = pollPendingEvents(home, session.id);
      for (const event of pending) {
        const result = processManagedUiEvent(home, session, event);
        processed[result] += 1;
        if (result === "closed") {
          stopReason = "browser-close";
          break;
        }
        if (stopReason !== null) break;
      }
      if (stopReason !== null) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), pollIntervalMs);
        wakeSleep = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wakeSleep = null;
    }
  } catch (error) {
    // Never leave the browser presented as live after an unexpected loop failure: record it, tear
    // down below, and surface it in the final summary with a non-zero exit.
    failure = error;
    if (stopReason === null) stopReason = `error:${errorMessage(error)}`;
  } finally {
    signalProcess().removeListener("SIGINT", signalHandler);
    signalProcess().removeListener("SIGTERM", signalHandler);
    try {
      processed.cancelled += shutdownManagedSession(home, session.id, stopReason ?? "stopped");
    } catch (error) {
      if (failure === null) failure = error;
    }
    await handle.close();
  }

  // The summary always prints, even on error, so the caller gets accurate counts and a reason
  // instead of a bare stack trace with the server already gone.
  printManagedEnd({ json, sessionId: session.id, reason: stopReason ?? "stopped", processed, failure });
  return failure === null ? 0 : 1;
}

// Close/end teardown. No browser work is stranded in a non-terminal state: everything still pending
// is cancelled with a visible reply while the session can still say why, then the session ends
// (revoking the browser token), then one post-end sweep cancels anything left non-terminal - a
// pending event a browser write raced in, or an in_progress event orphaned by a crashed prior run
// that would otherwise sit in_progress forever with no path to a terminal reply.
function shutdownManagedSession(home: string, sessionId: string, reason: string): number {
  let cancelled = 0;
  if (readSession(home, sessionId).status === "active") {
    cancelled += cancelUnfinishedEvents(home, sessionId, pollPendingEvents(home, sessionId), reason);
    endSession(home, sessionId);
  }
  const stragglers = readSessionEvents(home, sessionId).filter(
    (event) => event.status === "pending" || event.status === "in_progress"
  );
  return cancelled + cancelUnfinishedEvents(home, sessionId, stragglers, reason);
}

function cancelUnfinishedEvents(home: string, sessionId: string, events: UiEvent[], reason: string): number {
  let cancelled = 0;
  for (const event of events) {
    if (event.status !== "pending" && event.status !== "in_progress") continue;
    if (isReservedPurgeBundleEvent(home, sessionId, event)) continue;
    try {
      replyToEvent(home, sessionId, event.id, {
        status: "cancelled",
        expectedStatus: event.status,
        payload: {
          reason: `Managed review is closing (${reason}) before this event reached a terminal state.`,
          next: "Start or resume a review session and resubmit if this work is still needed."
        }
      });
      cancelled += 1;
    } catch {
      // Another attached agent advanced it concurrently; leave that state alone.
    }
  }
  return cancelled;
}

function isReservedPurgeBundleEvent(home: string, sessionId: string, event: UiEvent): boolean {
  if (event.type !== "approval_bundle_submitted" || event.status !== "in_progress") return false;
  const bundleId = eventBundleId(event);
  if (!bundleId) return false;
  try {
    return readApprovalSnapshot(home, sessionId, bundleId).actionType === PURGE_APPROVAL_ACTION;
  } catch {
    return false;
  }
}

function waitForServerClose(handle: UiServerHandle): Promise<void> {
  return new Promise<void>((resolve) => {
    handle.server.once("close", () => resolve());
  });
}

type ManagedReviewOutcome = "completed" | "rejected" | "stale" | "failed" | "cancelled" | "closed";
type ManagedReviewCounts = Record<ManagedReviewOutcome, number>;

function emptyManagedCounts(): ManagedReviewCounts {
  return { completed: 0, rejected: 0, stale: 0, failed: 0, cancelled: 0, closed: 0 };
}

function processManagedUiEvent(home: string, session: UiSession, event: UiEvent): ManagedReviewOutcome {
  // Approved bundles keep their own claim protocol: executeApprovedBundle claims the pending event
  // with the bundle id + fingerprint witness and replies per-target receipts itself. A generic
  // pickup claim here would make the execute core refuse the bundle as a mismatched claim.
  if (event.type === "approval_bundle_submitted") return processManagedBundleEvent(home, session, event);

  try {
    replyToEvent(home, session.id, event.id, {
      status: "in_progress",
      expectedStatus: "pending",
      payload: { note: "Managed review picked up this browser event." }
    });
  } catch {
    return "stale";
  }

  try {
    if (event.type === "session_done") {
      replyToEvent(home, session.id, event.id, {
        status: "completed",
        expectedStatus: "in_progress",
        payload: { note: "Managed review close requested; cancelling queued work, ending the UI session, and stopping the attached server." }
      });
      return "closed";
    }

    const refused = broadExecutionRequest(event);
    if (refused) {
      return replyFailure(home, session.id, event, "rejected", {
        reason: "Managed review refuses broad or execution-shaped browser requests; mutations require exact approval bundles and existing approval-gated paths.",
        refused,
        next: "Run a reviewed dry-run first, then approve one exact target or bundle."
      });
    }

    if (event.type === "inspect_requested") {
      const recordId = stringFrom(event.target.recordId);
      if (!recordId) {
        return replyFailure(home, session.id, event, "rejected", {
          reason: "Inspect requests require an exact record id.",
          next: "Open a dashboard/detail row and resubmit the inspect request."
        });
      }
      const detailOptions: BuildArtifactDetailOptions = { recordId };
      const ledgerPath = stringFrom(event.target.ledgerPath);
      if (ledgerPath !== null) detailOptions.ledgerPath = ledgerPath;
      if (session.registryPath !== null) detailOptions.registryPath = session.registryPath;
      const detail = buildArtifactDetail(detailOptions);
      replyToEvent(home, session.id, event.id, {
        status: "completed",
        expectedStatus: "in_progress",
        payload: {
          recordId,
          status: detail.inspect.status,
          recommendation: detail.inspect.recommendation,
          nextAction: detail.inspect.nextAction
        }
      });
      return "completed";
    }

    if (event.type === "decision_submitted") {
      const recordId = stringFrom(event.target.recordId);
      const ledgerPath = stringFrom(event.target.ledgerPath);
      const decision = event.payload.decision;
      if (!recordId || !ledgerPath || !isUiDecisionIntent(decision)) {
        return replyFailure(home, session.id, event, "rejected", {
          reason: "Decision intents require an exact record id, ledger path, and a keep/trash/resolve/defer decision.",
          next: "Reopen the record's detail drawer and resubmit the decision."
        });
      }
      const action = DECISION_DISPOSE_ACTIONS[decision];
      return replyManagedDryRunPlan(home, session.id, event, {
        recordId,
        ledgerPath,
        action,
        reason: managedDisposeReason(action, stringFrom(event.payload.reason)),
        note: `Prepared a reviewed ${action} dry-run plan from the ${decision} decision (a plan artifact, registered for retention); no disposition was executed. Approve the plan to run it through the exact-target execute path.`
      });
    }

    if (event.type === "dry_run_requested") {
      const recordId = stringFrom(event.target.recordId);
      const ledgerPath = stringFrom(event.target.ledgerPath);
      if (recordId && ledgerPath) {
        const action = managedDryRunDisposeAction(event, recordId, ledgerPath);
        if (!action) {
          return replyFailure(home, session.id, event, "rejected", {
            reason: "The requested record dry-run does not map to an approval-gated dispose action.",
            next: "Choose keep, trash, resolve, or defer from the record detail drawer."
          });
        }
        return replyManagedDryRunPlan(home, session.id, event, {
          recordId,
          ledgerPath,
          action,
          reason: managedDisposeReason(action, stringFrom(event.payload.reason)),
          note: `Prepared a reviewed ${action} dry-run plan from the browser dry-run request (a plan artifact, registered for retention); no disposition was executed. Approve the plan to run it through the exact-target execute path.`
        });
      }
      return replyManagedLaneDryRun(home, session, event);
    }

    if (event.type === "comment_added" || event.type === "question_answered" || event.type === "filter_saved" || event.type === "session_note_added") {
      replyToEvent(home, session.id, event.id, {
        status: "completed",
        expectedStatus: "in_progress",
        payload: {
          note: "Browser intent recorded for audit; no ledger, file, trash, or plan mutation was executed.",
          target: event.target
        }
      });
      return "completed";
    }

    return replyFailure(home, session.id, event, "rejected", {
      reason: `Managed review does not handle browser event type ${event.type}.`,
      next: "Refresh the dashboard and use an explicit approval-gated CLI path if this work is still needed."
    });
  } catch (error) {
    return replyFailure(home, session.id, event, "failed", {
      reason: errorMessage(error),
      next: "Refresh the dashboard and retry after checking the attached agent output."
    });
  }
}

// The 1:1 decision-intent translation documented on UiDecisionIntent: the managed loop prepares the
// matching reviewed dispose dry-run plan; execution still requires the human to approve that exact
// plan through the bundle workbench.
const DECISION_DISPOSE_ACTIONS: Record<UiDecisionIntent, DisposeAction> = {
  keep: "keep",
  trash: "trash-resolve",
  resolve: "resolve-only",
  defer: "snooze"
};

const MANAGED_RESOLVE_REASON = "Resolved from Artshelf UI review";

// The browser cannot name a snooze horizon, so managed defer/snooze plans use one default review
// horizon. The exact retainUntil lands in the reviewed plan the human approves before execution.
const MANAGED_SNOOZE_TTL = "7d";

function managedDisposeReason(action: DisposeAction, reason: string | null): string | undefined {
  if (reason !== null && reason.trim().length > 0) return reason;
  if (action === "resolve-only") return MANAGED_RESOLVE_REASON;
  return undefined;
}

function managedDryRunDisposeAction(event: UiEvent, recordId: string, ledgerPath: string): DisposeAction | null {
  const requested = stringFrom(event.payload.action) ?? stringFrom(event.payload.request);
  if (requested === "trash-resolve" || requested === "resolve-only" || requested === "snooze" || requested === "keep") {
    return requested;
  }
  const detail = buildArtifactDetail({ recordId, ledgerPath });
  if (detail.inspect.recommendation === "trash-safe") return "trash-resolve";
  if (detail.inspect.recommendation === "resolve-only") return "resolve-only";
  if (detail.inspect.recommendation === "snooze") return "snooze";
  if (detail.inspect.recommendation === "keep") return "keep";
  return null;
}

// Create (or reuse) the reviewed dispose dry-run plan for one exact record and reply its identity -
// planId, records, and the exact approval target phrase - so the dashboard's prepared-plan approval
// row can carry the workflow to the approve -> execute half. Blocked classifications reply rejected
// with the safety engine's detail; nothing is mutated either way.
function replyManagedDryRunPlan(
  home: string,
  sessionId: string,
  event: UiEvent,
  input: { recordId: string; ledgerPath: string; action: DisposeAction; reason?: string | undefined; note: string }
): ManagedReviewOutcome {
  const request: DisposeRequest = { id: input.recordId, action: input.action };
  if (input.reason !== undefined) request.reason = input.reason;
  if (input.action === "snooze") request.ttl = MANAGED_SNOOZE_TTL;
  const plan = createDisposePlan(input.ledgerPath, request);
  if (!plan.entry) {
    return replyFailure(home, sessionId, event, "rejected", {
      reason: `Dispose safety engine blocked this ${input.action} dry-run: ${plan.blocked?.detail ?? "no actionable plan entry"}`,
      next: "Resolve the block (or pick another decision) in the record's detail drawer, then resubmit."
    });
  }
  replyToEvent(home, sessionId, event.id, {
    status: "completed",
    expectedStatus: "in_progress",
    payload: {
      kind: "dispose_dry_run",
      title: "Dispose dry-run prepared",
      note: input.note,
      planId: plan.planId,
      action: plan.entry.action,
      count: 1,
      records: [input.recordId],
      approvalTarget: `approve artshelf dispose ledger ${input.ledgerPath} plan ${plan.planId}`
    }
  });
  return "completed";
}

function replyManagedLaneDryRun(home: string, session: UiSession, event: UiEvent): ManagedReviewOutcome {
  const lane = stringFrom(event.target.lane);
  const request = stringFrom(event.payload.request);
  if (!lane) {
    return replyFailure(home, session.id, event, "rejected", {
      reason: "Dry-run requests require either an exact record target or a dashboard lane.",
      next: "Refresh the dashboard/detail view and resubmit the exact dry-run request."
    });
  }
  if (lane === "purge-candidates" && request === "review_delete_forever") {
    return replyManagedPurgeReview(home, session, event);
  }
  if (lane === "registry-reconcile" && request === "check_source_problems") {
    return replyManagedSourceCheck(home, session, event);
  }
  if (lane === "resolve" && request === "check_missing_files") {
    return replyManagedMissingFilesCheck(home, session, event);
  }
  if (lane === "cleanup" && (request === null || request === "prepare_cleanup_plan")) {
    return replyManagedCleanupDryRun(home, session, event);
  }
  return replyFailure(home, session.id, event, "rejected", {
    reason: `Managed review does not know how to handle ${lane} dry-run request ${request ?? "(none)"}.`,
    next: "Refresh the dashboard and choose an available lane action."
  });
}

function replyManagedPurgeReview(home: string, session: UiSession, event: UiEvent): ManagedReviewOutcome {
  const dashboard = buildDashboard(managedDashboardOptions(session, event));
  const targets = purgeApprovalTargets(groupPurgeCandidates(dashboard.buckets.purgeCandidates));
  if (targets.length === 0) {
    return replyFailure(home, session.id, event, "stale", {
      reason: "There are no purge candidates left to review.",
      next: "Refresh the dashboard before requesting another delete review."
    });
  }
  const source = writeApprovalSnapshot(home, session.id, {
    actionType: PURGE_APPROVAL_ACTION,
    targets,
    selectedTargetIds: [],
    allowEmptySelection: true,
    reviewed: {}
  });
  replyToEvent(home, session.id, event.id, {
    status: "completed",
    expectedStatus: "in_progress",
    payload: {
      kind: "purge_review_prepared",
      title: "Purge review prepared",
      note: "Prepared an approval workbench for exact trash-purge targets; no deletion was executed.",
      bundleId: source.id,
      count: targets.length,
      actionType: PURGE_APPROVAL_ACTION,
      next: `Open artshelf ui bundle ${session.id} ${source.id}, choose exact targets, then submit the approval bundle.`
    }
  });
  return "completed";
}

function replyManagedSourceCheck(home: string, session: UiSession, event: UiEvent): ManagedReviewOutcome {
  const dashboard = buildDashboard(managedDashboardOptions(session, event));
  const invalidLedgers = dashboard.ledgers.filter((ledger) => !ledger.ok);
  const problems = dashboard.buckets.registryReconcile;
  replyToEvent(home, session.id, event.id, {
    status: "completed",
    expectedStatus: "in_progress",
    payload: {
      kind: "source_check",
      title: "Source check completed",
      note: "Checked registered sources and path-drift rows; no registry, ledger, file, trash, or plan was mutated.",
      count: invalidLedgers.length + problems.length,
      invalidLedgers: invalidLedgers.map((ledger) => ({ name: ledger.name, path: ledger.path, errors: ledger.errors })),
      problems: problems.map((row) => ({ source: row.source, category: row.category, target: row.recordId ?? row.ledgerPath, ledgerPath: row.ledgerPath })),
      next: problems.length + invalidLedgers.length === 0 ? "Refresh the dashboard; the source lane is clear." : "Review the listed source problems, then run the matching approval-gated reconcile or registry-prune dry-run."
    }
  });
  return "completed";
}

function replyManagedMissingFilesCheck(home: string, session: UiSession, event: UiEvent): ManagedReviewOutcome {
  const dashboard = buildDashboard(managedDashboardOptions(session, event));
  const rows = dashboard.buckets.resolve;
  replyToEvent(home, session.id, event.id, {
    status: "completed",
    expectedStatus: "in_progress",
    payload: {
      kind: "missing_file_check",
      title: "Missing-file check completed",
      note: "Checked missing-file rows; no ledger, file, trash, or plan was mutated.",
      count: rows.length,
      records: rows.map((row) => ({
        recordId: row.recordId,
        ledgerName: row.ledgerName,
        ledgerPath: row.ledgerPath,
        path: row.path,
        existence: row.existence,
        recommendation: row.recommendation
      })),
      next: rows.length === 0 ? "Refresh the dashboard; the missing-file lane is clear." : "Review the listed records, then approve exact resolve decisions or prepare reviewed dispose plans."
    }
  });
  return "completed";
}

function replyManagedCleanupDryRun(home: string, session: UiSession, event: UiEvent): ManagedReviewOutcome {
  const dashboard = buildDashboard(managedDashboardOptions(session, event));
  const reviewedRows = reviewedCleanupRowsFromEvent(event);
  if (reviewedRows.length === 0) {
    return replyFailure(home, session.id, event, "rejected", {
      reason: "Cleanup dry-run requests require reviewed cleanup row targets from the submitted dashboard snapshot.",
      next: "Refresh the dashboard and submit Prepare cleanup plan again."
    });
  }
  const scopedLedgers = new Set(dashboard.ledgers.filter((ledger) => ledger.ok).map((ledger) => ledger.path));
  const ledgersByPath = new Map<string, { name: string; path: string; recordIds: Set<string> }>();
  for (const row of reviewedRows) {
    if (!scopedLedgers.has(row.ledgerPath)) {
      return replyFailure(home, session.id, event, "rejected", {
        reason: `Reviewed cleanup row ${row.recordId} belongs to a ledger outside this review scope.`,
        next: "Refresh the dashboard and submit Prepare cleanup plan again."
      });
    }
    let ledger = ledgersByPath.get(row.ledgerPath);
    if (!ledger) {
      ledger = { name: row.ledgerName, path: row.ledgerPath, recordIds: new Set<string>() };
      ledgersByPath.set(row.ledgerPath, ledger);
    }
    ledger.recordIds.add(row.recordId);
  }
  const ledgers = [...ledgersByPath.values()];
  const plans = ledgers
    .map((ledger) => ({ ledger, plan: createCleanupPlan(ledger.path, { recordIds: [...ledger.recordIds] }) }))
    .filter((entry) => entry.plan.entries.length > 0);
  if (plans.length === 0) {
    return replyFailure(home, session.id, event, "stale", {
      reason: "There are no cleanup dry-run entries left to review.",
      next: "Refresh the dashboard before requesting another cleanup plan."
    });
  }
  replyToEvent(home, session.id, event.id, {
    status: "completed",
    expectedStatus: "in_progress",
    payload: {
      kind: "cleanup_dry_run",
      title: "Cleanup dry-run prepared",
      note: "Prepared reviewed cleanup plan artifacts through the existing dry-run path; no cleanup was executed.",
      count: plans.reduce((total, entry) => total + entry.plan.entries.length, 0),
      plans: plans.map((entry) => ({
        ledgerPath: entry.ledger.path,
        ledgerName: entry.ledger.name,
        planId: entry.plan.planId,
        count: entry.plan.entries.length,
        approvalTarget: `approve artshelf cleanup ledger ${entry.ledger.path} plan ${entry.plan.planId}`
      }))
    }
  });
  return "completed";
}

function reviewedCleanupRowsFromEvent(event: UiEvent): Array<Pick<DashboardArtifactRow, "recordId" | "ledgerPath" | "ledgerName">> {
  const rows = event.payload.reviewedRows;
  if (!Array.isArray(rows)) return [];
  const reviewed: Array<Pick<DashboardArtifactRow, "recordId" | "ledgerPath" | "ledgerName">> = [];
  const seen = new Set<string>();
  for (const entry of rows) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const recordId = stringFrom(record.recordId);
    const ledgerPath = stringFrom(record.ledgerPath);
    const ledgerName = stringFrom(record.ledgerName) ?? "ledger";
    if (!recordId || !ledgerPath) return [];
    const key = `${recordId}\0${ledgerPath}`;
    if (seen.has(key)) return [];
    seen.add(key);
    reviewed.push({ recordId, ledgerPath, ledgerName });
  }
  return reviewed;
}

function managedDashboardOptions(session: UiSession, event: UiEvent): BuildDashboardOptions {
  const options: BuildDashboardOptions = {};
  const registryPath = stringFrom(event.target.registryPath) ?? session.registryPath;
  const ledgerPath = stringFrom(event.target.ledgerPath) ?? session.ledgerPath;
  if (registryPath !== null) options.registryPath = registryPath;
  if (ledgerPath !== null) options.ledgerPath = ledgerPath;
  return options;
}

// Managed execution of one browser-approved bundle. executeApprovedBundle owns the claim and the
// per-target receipts reply; the returned aggregate maps onto the same reply status it wrote:
// executed -> completed, refused -> stale (re-review), anything partial -> failed (never silently
// presented as done). Failures before the core could reply are made visible here instead, without
// clobbering a state another attached agent already advanced.
function processManagedBundleEvent(home: string, session: UiSession, event: UiEvent): ManagedReviewOutcome {
  const bundleId = eventBundleId(event);
  if (!bundleId) {
    return replyManagedBundleFailure(home, session.id, event, "rejected", {
      reason: "Approval bundle event did not name an exact bundle id.",
      next: "Reopen the approval workbench and submit the exact reviewed bundle again."
    });
  }
  try {
    const snapshot = readApprovalSnapshot(home, session.id, bundleId);
    if (snapshot.actionType === PURGE_APPROVAL_ACTION) {
      try {
        replyToEvent(home, session.id, event.id, {
          status: "in_progress",
          expectedStatus: "pending",
          payload: {
            bundleId: snapshot.id,
            fingerprint: snapshot.fingerprint,
            reason: "Managed review does not auto-execute trash-purge bundles; permanent deletion is a separate one-way-door path.",
            next: "Delete permanently only by deliberately running `artshelf ui execute <session> <bundle>` or `artshelf trash purge` against the exact reviewed purge plan."
          }
        });
      } catch {
        return replyManagedBundleFailure(home, session.id, event, "failed", {
          reason: "Could not reserve the purge bundle for explicit execution.",
          next: "Refresh the approval workbench and resubmit if this deletion is still wanted.",
          bundleId
        });
      }
      return "completed";
    }
  } catch (error) {
    return replyManagedBundleFailure(home, session.id, event, "failed", {
      reason: `Could not load the approval bundle to check its action: ${errorMessage(error)}`,
      next: "Re-review and resubmit the exact bundle."
    });
  }
  try {
    const { execution } = executeApprovedBundle(home, session.id, bundleId);
    if (execution.status === "executed") return "completed";
    if (execution.status === "refused") return "stale";
    return "failed";
  } catch (error) {
    return replyManagedBundleFailure(home, session.id, event, "failed", {
      reason: errorMessage(error),
      next: "Check the attached agent output, then re-review and resubmit the bundle if it is still wanted."
    });
  }
}

function replyManagedBundleFailure(
  home: string,
  sessionId: string,
  event: UiEvent,
  status: Exclude<ManagedReviewOutcome, "completed" | "closed">,
  payload: Record<string, unknown>
): ManagedReviewOutcome {
  try {
    const current = readSessionEvents(home, sessionId).find((entry) => entry.id === event.id);
    if (current && (current.status === "pending" || current.status === "in_progress")) {
      replyToEvent(home, sessionId, event.id, { status, expectedStatus: current.status, payload });
    }
  } catch {
    // Another attached agent advanced it concurrently; avoid inventing another state.
  }
  return status;
}

function replyFailure(
  home: string,
  sessionId: string,
  event: UiEvent,
  status: Exclude<ManagedReviewOutcome, "completed" | "closed">,
  payload: Record<string, unknown>
): ManagedReviewOutcome {
  try {
    replyToEvent(home, sessionId, event.id, { status, expectedStatus: "in_progress", payload });
  } catch {
    // If a competing agent already advanced the event, avoid inventing another state.
  }
  return status;
}

function eventBundleId(event: UiEvent): string | null {
  return stringFrom(event.target.bundleId) ?? stringFrom(event.payload.bundleId);
}

function broadExecutionRequest(event: UiEvent): string | null {
  const raw = [event.payload.request, event.payload.action, event.payload.command, event.target.action]
    .map((value) => stringFrom(value))
    .filter((value): value is string => value !== null)
    .join(" ");
  if (!raw) return null;
  return /\b--all\b|\b--execute\b|\bexecute\b/i.test(raw) ? raw : null;
}

function stringFrom(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function printManagedStart(input: {
  json: boolean;
  home: string;
  session: UiSession;
  handle: UiServerHandle;
  accessUrl: string;
  pollIntervalMs: number;
}): void {
  if (input.json) {
    printCompactJson({
      ok: true,
      command: "ui-review-start",
      home: input.home,
      url: input.accessUrl,
      baseUrl: input.handle.url,
      host: input.handle.host,
      port: input.handle.port,
      session: publicSession(input.session),
      token: input.session.token,
      pollIntervalMs: input.pollIntervalMs
    });
    return;
  }
  process.stdout.write(`artshelf ui review: live review on ${input.accessUrl}\n`);
  process.stdout.write(`session: ${input.session.id}\n`);
  process.stdout.write("managed server and poller are attached; close the review from the browser to end.\n");
}

function printManagedEnd(input: {
  json: boolean;
  sessionId: string;
  reason: string;
  processed: ManagedReviewCounts;
  failure?: unknown;
}): void {
  const ok = input.failure == null;
  if (input.json) {
    const packet: Record<string, unknown> = { ok, command: "ui-review-end", sessionId: input.sessionId, reason: input.reason, processed: input.processed };
    if (!ok) packet.error = errorMessage(input.failure);
    printCompactJson(packet);
    return;
  }
  const stream = ok ? process.stdout : process.stderr;
  stream.write(`artshelf ui review: session ${input.sessionId} ended (${input.reason})\n`);
  stream.write(
    `processed: ${input.processed.completed} completed, ${input.processed.rejected} rejected, ${input.processed.stale} stale, ${input.processed.failed} failed, ${input.processed.cancelled} cancelled, ${input.processed.closed} closed\n`
  );
  if (!ok) stream.write(`error: ${errorMessage(input.failure)}\n`);
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port "${raw}"; expected an integer between 0 and 65535`);
  }
  return port;
}

function parsePollInterval(raw: string | undefined): number {
  if (raw === undefined) return 250;
  const interval = Number(raw);
  if (!Number.isInteger(interval) || interval < 10 || interval > 60_000) {
    throw new Error(`Invalid --poll-interval-ms "${raw}"; expected an integer between 10 and 60000`);
  }
  return interval;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signalProcess(): {
  once(event: "SIGINT" | "SIGTERM", listener: (signal: string) => void): void;
  removeListener(event: "SIGINT" | "SIGTERM", listener: (signal: string) => void): void;
} {
  return process as unknown as {
    once(event: "SIGINT" | "SIGTERM", listener: (signal: string) => void): void;
    removeListener(event: "SIGINT" | "SIGTERM", listener: (signal: string) => void): void;
  };
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
