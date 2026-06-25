import { uiLinkBaseUrl } from "../config/env.js";
import { printCompactJson } from "../renderers/json.js";
import {
  endSession,
  isUiEventStatus,
  pollPendingEvents,
  readSession,
  replyToEvent,
  resolveUiHome,
  startOrResumeSession,
  UI_EVENT_STATUSES
} from "../session.js";
import type { ParsedArgs } from "../shared/cli-types.js";
import { requiredStringFlag, stringFlag } from "../shared/flags.js";
import { UI_HELP } from "../shared/help-text.js";
import type { UiEvent, UiSession, UiSessionScope } from "../types.js";

// AXI-style command surface for the Artshelf UI v1 review session (NGX-532). This is the agent's
// side of the v1 boundary: `ui` starts or resumes a durable review session, and the poll/reply/end
// loop lets the agent drain browser-recorded decisions and write back receipts. The browser records
// decisions through the durable session layer; this command never executes a mutating workflow and
// exposes no browser-direct mutation path. Output defaults to a human summary; `--json` emits a
// compact single-line packet optimized for agent consumption.
export function handleUi(parsed: ParsedArgs, json: boolean): number {
  const sub = parsed.positionals[0];
  if (sub === "help") {
    process.stdout.write(UI_HELP);
    return 0;
  }
  if (sub === "poll") return handleUiPoll(parsed, json);
  if (sub === "reply") return handleUiReply(parsed, json);
  if (sub === "end") return handleUiEnd(parsed, json);
  if (sub === undefined) return handleUiStart(parsed, json);
  throw new Error(`Unknown ui subcommand: ${sub} (expected poll, reply, or end)`);
}

// `artshelf ui [--scope user|repo] [--ledger <path>] [--json]` - start or resume the session for
// this scope/ledger target. Defaults to user-level, multi-ledger review so it works regardless of
// the current working directory.
function handleUiStart(parsed: ParsedArgs, json: boolean): number {
  const scope = resolveScope(stringFlag(parsed, "scope"));
  const ledgerPath = stringFlag(parsed, "ledger") ?? null;
  const home = resolveUiHome({ scope, cwd: process.cwd() });
  const session = startOrResumeSession({ home, scope, ledgerPath });
  const link = buildLink(session);
  const pollHint = `artshelf ui poll ${session.id} --json`;

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
  if (!isUiEventStatus(status)) {
    throw new Error(`Invalid --status "${status}"; expected one of: ${UI_EVENT_STATUSES.join(", ")}`);
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
  if (!id) throw new Error("Missing session id; usage: artshelf ui <poll|reply|end> <session-id>");
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
