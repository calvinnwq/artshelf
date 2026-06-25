import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ArtshelfEnv } from "./config/env.js";
import { withPathLock } from "./locks.js";
import { now, toIso } from "./time.js";
import type {
  UiApprovalSnapshot,
  UiApprovalTarget,
  UiEvent,
  UiEventStatus,
  UiEventType,
  UiReply,
  UiSession,
  UiSessionScope
} from "./types.js";

// Storage model for the Artshelf UI v1 review session (NGX-531, slice 1). This module is
// the durable handoff layer between the human decision surface (browser) and the agent
// that executes existing approval-gated CLI paths. It is the only authority on session
// metadata, the capability token, the append-only event log, and approval snapshots; it
// never executes a mutating workflow itself, preserving the v1 boundary that the browser
// records decisions and the agent executes.
//
// On-disk layout under the resolved UI home:
//
//   <ui-home>/sessions/<session-id>/session.json      session metadata + capability token
//   <ui-home>/sessions/<session-id>/events.jsonl       append-only events + agent replies
//   <ui-home>/sessions/<session-id>/bundles/<id>.json  immutable approval snapshots
//
// The UI home defaults to the user-level ~/.artshelf/ui tree so review works regardless of
// the current working directory; repo scope and an explicit ARTSHELF_UI_HOME override anchor
// it elsewhere (see resolveUiHome).

export type UiSessionOptions = {
  env?: ArtshelfEnv;
  cwd?: string;
};

export type ResolveUiHomeInput = UiSessionOptions & {
  scope?: UiSessionScope;
};

export type StartSessionInput = {
  home: string;
  scope: UiSessionScope;
  ledgerPath?: string | null;
};

export type AppendEventInput = {
  type: UiEventType;
  target?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  source?: "browser" | "agent";
  status?: UiEventStatus;
};

export type ReplyInput = {
  status: UiEventStatus;
  payload?: Record<string, unknown>;
};

export type ApprovalSnapshotInput = {
  actionType: string;
  targets: UiApprovalTarget[];
  reviewed?: Record<string, unknown>;
};

type StoredEvent = UiEvent & { kind: "event" };
type StoredReply = UiReply & { kind: "reply" };
type UiLogLine = StoredEvent | StoredReply;

// Runtime view of the UiEventStatus union for input validation at the command boundary. The
// Record forces this to stay exhaustive: adding a status to the type without listing it here
// (or vice versa) is a compile error, so the agent loop can never accept a status the storage
// layer does not understand.
const UI_EVENT_STATUS_SET: Record<UiEventStatus, true> = {
  pending: true,
  acknowledged: true,
  in_progress: true,
  completed: true,
  rejected: true,
  stale: true,
  failed: true,
  cancelled: true
};

export const UI_EVENT_STATUSES = Object.keys(UI_EVENT_STATUS_SET) as UiEventStatus[];

const UI_ID_PATTERNS: Record<"session" | "event" | "reply" | "bundle", RegExp> = {
  session: /^session_\d{8}_\d{6}_[0-9a-f]{8}$/,
  event: /^event_\d{8}_\d{6}_[0-9a-f]{8}$/,
  reply: /^reply_\d{8}_\d{6}_[0-9a-f]{8}$/,
  bundle: /^bundle_\d{8}_\d{6}_[0-9a-f]{8}$/
};
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

export function isUiEventStatus(value: string): value is UiEventStatus {
  return Object.prototype.hasOwnProperty.call(UI_EVENT_STATUS_SET, value);
}

// Resolve the UI home directory for a scope. An explicit ARTSHELF_UI_HOME/SHELF_UI_HOME
// override always wins (the primary test and ops hook); otherwise user scope lives under
// ~/.artshelf/ui and repo scope under the enclosing git root's .artshelf/ui (falling back
// to the working directory when there is no repo).
export function resolveUiHome(input: ResolveUiHomeInput = {}): string {
  const env = input.env ?? process.env;
  const override = env.ARTSHELF_UI_HOME ?? env.SHELF_UI_HOME;
  if (override) return resolve(override);

  const scope = input.scope ?? "user";
  if (scope === "repo") {
    const cwd = resolve(input.cwd ?? process.cwd());
    const root = findGitRoot(cwd) ?? cwd;
    return join(root, ".artshelf", "ui");
  }
  return join(homedir(), ".artshelf", "ui");
}

// Start a new session or resume the existing active one for this scope + ledger target.
// Multi-ledger review is the default (ledgerPath null); passing an explicit ledger narrows
// both resume matching and the recorded scope. Scan-and-create runs under a directory lock
// so concurrent agents cannot create duplicate sessions for the same target.
export function startOrResumeSession(input: StartSessionInput): UiSession {
  const home = input.home;
  const ledgerPath = input.ledgerPath ? resolve(input.ledgerPath) : null;
  const lockPath = join(sessionsDir(home), "create");
  return withUiStorageLock(home, lockPath, () => {
    const existing = listSessions(home)
      .filter((session) => session.status === "active" && session.scope === input.scope && session.ledgerPath === ledgerPath)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (existing) return existing;

    const createdAt = toIso(now());
    const session: UiSession = {
      version: 1,
      id: makeId("session"),
      scope: input.scope,
      status: "active",
      createdAt,
      updatedAt: createdAt,
      endedAt: null,
      ledgerPath,
      token: randomBytes(24).toString("hex")
    };
    writeSession(home, session);
    return session;
  });
}

export function listSessions(home: string): UiSession[] {
  const root = sessionsDir(home);
  if (!existsSync(root)) return [];
  const sessions: UiSession[] = [];
  for (const id of readdirSync(root)) {
    if (!isUiId("session", id)) continue;
    if (!existsSync(sessionFile(home, id))) continue;
    sessions.push(readSession(home, id));
  }
  return sessions;
}

export function readSession(home: string, sessionId: string): UiSession {
  const path = sessionFile(home, sessionId);
  if (!existsSync(path)) throw new Error(`Artshelf UI session not found: ${sessionId}`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<UiSession>;
  if (parsed.version !== 1 || parsed.id !== sessionId || !parsed.scope || !parsed.status || !parsed.token) {
    throw new Error(`Invalid Artshelf UI session: ${path}`);
  }
  return {
    version: 1,
    id: parsed.id,
    scope: parsed.scope,
    status: parsed.status,
    createdAt: parsed.createdAt ?? "",
    updatedAt: parsed.updatedAt ?? "",
    endedAt: parsed.endedAt ?? null,
    ledgerPath: parsed.ledgerPath ?? null,
    token: parsed.token
  };
}

// End a session: revoke the browser write capability and record a session_done event in the
// durable log for audit. Idempotent - ending an already-ended session is a no-op read.
export function endSession(home: string, sessionId: string): UiSession {
  const path = sessionFile(home, sessionId);
  return withUiStorageLock(home, path, () => {
    const session = readSession(home, sessionId);
    if (session.status === "ended") return session;

    const endedAt = toIso(now());
    appendLogLine(home, sessionId, {
      kind: "event",
      ...buildEvent(sessionId, { type: "session_done", source: "agent", status: "completed" }, endedAt)
    });
    const ended: UiSession = { ...session, status: "ended", endedAt, updatedAt: endedAt };
    writeSession(home, ended);
    return ended;
  });
}

// Capability check for browser event writes. The token authorizes writes only while the
// session is active, so ending a session revokes it regardless of the token presented. This
// is same-machine capability protection, not full account authentication.
export function validateBrowserToken(session: UiSession, token: string): boolean {
  if (session.status !== "active") return false;
  if (!token) return false;
  return constantTimeEqual(token, session.token);
}

// Append an event to the durable log. Browser writes are refused once the session has ended;
// agent-sourced bookkeeping is always allowed. Defaults: source browser, status pending.
export function appendEvent(home: string, sessionId: string, input: AppendEventInput): UiEvent {
  const path = sessionFile(home, sessionId);
  return withUiStorageLock(home, path, () => {
    const session = readSession(home, sessionId);
    const source = input.source ?? "browser";
    if (source === "browser" && session.status !== "active") {
      throw new Error(`Artshelf UI session ${sessionId} has ended; browser writes are closed`);
    }
    const createdAt = toIso(now());
    const event = buildEvent(sessionId, input, createdAt);
    appendLogLine(home, sessionId, { kind: "event", ...event });
    writeSession(home, { ...session, updatedAt: createdAt });
    return event;
  });
}

// Read every event with replies folded into the current status, in creation order. The log
// stays append-only on disk; this is the read-side projection used by poll and history.
export function readSessionEvents(home: string, sessionId: string): UiEvent[] {
  const events = new Map<string, UiEvent>();
  const order: string[] = [];
  for (const line of readLog(home, sessionId)) {
    if (line.kind === "event") {
      const { kind: _kind, ...event } = line;
      events.set(event.id, event);
      order.push(event.id);
    } else {
      const event = events.get(line.eventId);
      if (event) {
        event.status = line.status;
        event.updatedAt = line.createdAt;
      }
    }
  }
  return order.map((id) => events.get(id)!);
}

// Compact actionable queue for agent consumption: events still awaiting an agent reply.
export function pollPendingEvents(home: string, sessionId: string): UiEvent[] {
  readSession(home, sessionId);
  return readSessionEvents(home, sessionId).filter((event) => event.status === "pending");
}

// Append an agent reply that advances exactly one event's status and carries the agent's
// result/receipt/validation-failure/question/note in payload.
export function replyToEvent(
  home: string,
  sessionId: string,
  eventId: string,
  input: ReplyInput
): { event: UiEvent; reply: UiReply } {
  readSession(home, sessionId);
  const target = readSessionEvents(home, sessionId).find((event) => event.id === eventId);
  if (!target) throw new Error(`Artshelf UI event not found: ${eventId}`);

  const createdAt = toIso(now());
  const reply: UiReply = {
    id: makeId("reply"),
    sessionId,
    eventId,
    status: input.status,
    createdAt,
    payload: input.payload ?? {}
  };
  appendLogLine(home, sessionId, { kind: "reply", ...reply });
  touchSession(home, sessionId, createdAt);
  const event = readSessionEvents(home, sessionId).find((entry) => entry.id === eventId)!;
  return { event, reply };
}

export function readReplies(home: string, sessionId: string): UiReply[] {
  return readLog(home, sessionId)
    .filter((line): line is StoredReply => line.kind === "reply")
    .map(({ kind: _kind, ...reply }) => reply);
}

// Persist an immutable, fingerprinted approval snapshot for the session. Slice 1 only
// defines the storage and fingerprint; the review/execute flow lands in later slices.
export function writeApprovalSnapshot(home: string, sessionId: string, input: ApprovalSnapshotInput): UiApprovalSnapshot {
  const session = readSession(home, sessionId);
  const reviewed = input.reviewed ?? {};
  const snapshot: UiApprovalSnapshot = {
    id: makeId("bundle"),
    sessionId: session.id,
    createdAt: toIso(now()),
    actionType: input.actionType,
    targets: input.targets,
    reviewed,
    fingerprint: approvalSnapshotFingerprint(input.targets, reviewed)
  };
  const path = bundleFile(home, sessionId, snapshot.id);
  withUiStorageLock(home, path, () => {
    ensureOwnerOnlyDirectoryTree(home, dirname(path));
    atomicWriteFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  });
  return snapshot;
}

export function readApprovalSnapshot(home: string, sessionId: string, bundleId: string): UiApprovalSnapshot {
  const path = bundleFile(home, sessionId, bundleId);
  if (!existsSync(path)) throw new Error(`Artshelf UI approval snapshot not found: ${bundleId}`);
  return JSON.parse(readFileSync(path, "utf8")) as UiApprovalSnapshot;
}

// Deterministic digest over the selected targets and reviewed facts. Targets are sorted by
// their canonical form so selection order never changes the fingerprint, while any change to
// a target or a reviewed fact does - the property a later agent relies on to detect drift and
// refuse a stale or tampered bundle before executing any exact target.
export function approvalSnapshotFingerprint(targets: UiApprovalTarget[], reviewed: Record<string, unknown>): string {
  const sortedTargets = [...targets]
    .map((target) => canonicalJson(target))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const canonical = `[${sortedTargets.join(",")}]|${canonicalJson(reviewed)}`;
  return createHash("sha256").update(canonical).digest("hex");
}

function buildEvent(sessionId: string, input: AppendEventInput, createdAt: string): UiEvent {
  return {
    id: makeId("event"),
    sessionId,
    type: input.type,
    status: input.status ?? "pending",
    source: input.source ?? "browser",
    createdAt,
    updatedAt: createdAt,
    target: input.target ?? {},
    payload: input.payload ?? {}
  };
}

function touchSession(home: string, sessionId: string, when: string): void {
  const path = sessionFile(home, sessionId);
  withUiStorageLock(home, path, () => {
    const session = readSession(home, sessionId);
    writeSession(home, { ...session, updatedAt: when });
  });
}

function writeSession(home: string, session: UiSession): void {
  const path = sessionFile(home, session.id);
  ensureOwnerOnlyDirectoryTree(home, dirname(path));
  atomicWriteFileSync(path, `${JSON.stringify(session, null, 2)}\n`);
}

function appendLogLine(home: string, sessionId: string, line: UiLogLine): void {
  const path = eventsFile(home, sessionId);
  withUiStorageLock(home, path, () => {
    ensureOwnerOnlyDirectoryTree(home, dirname(path));
    const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
    const separator = previous && !previous.endsWith("\n") ? "\n" : "";
    atomicWriteFileSync(path, `${previous}${separator}${JSON.stringify(line)}\n`);
  });
}

function withUiStorageLock<T>(home: string, targetPath: string, fn: () => T): T {
  ensureOwnerOnlyDirectoryTree(home, dirname(targetPath));
  return withPathLock(targetPath, fn);
}

function ensureOwnerOnlyDirectoryTree(home: string, targetPath: string): void {
  const root = resolve(home);
  const target = resolve(targetPath);
  mkdirSync(target, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
  const directories: string[] = [];
  let current = target;
  while (true) {
    directories.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const directory of directories.reverse()) {
    chmodSync(directory, OWNER_ONLY_DIRECTORY_MODE);
  }
}

function readLog(home: string, sessionId: string): UiLogLine[] {
  const path = eventsFile(home, sessionId);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8").trim();
  if (!content) return [];
  return content.split(/\n+/).map((raw, index) => {
    try {
      return JSON.parse(raw) as UiLogLine;
    } catch (error) {
      throw new Error(`Invalid Artshelf UI event log at line ${index + 1}: ${(error as Error).message}`);
    }
  });
}

function sessionsDir(home: string): string {
  return join(resolve(home), "sessions");
}

function sessionDir(home: string, sessionId: string): string {
  return join(sessionsDir(home), assertUiId("session", sessionId));
}

function sessionFile(home: string, sessionId: string): string {
  return join(sessionDir(home, sessionId), "session.json");
}

function eventsFile(home: string, sessionId: string): string {
  return join(sessionDir(home, sessionId), "events.jsonl");
}

function bundleFile(home: string, sessionId: string, bundleId: string): string {
  return join(sessionDir(home, sessionId), "bundles", `${assertUiId("bundle", bundleId)}.json`);
}

function isUiId(prefix: "session" | "event" | "reply" | "bundle", value: string): boolean {
  return UI_ID_PATTERNS[prefix].test(value);
}

function assertUiId(prefix: "session" | "event" | "reply" | "bundle", value: string): string {
  if (!isUiId(prefix, value)) {
    throw new Error(`Invalid Artshelf UI ${prefix} id: ${value}`);
  }
  return value;
}

// Deterministic JSON with object keys sorted recursively, so the approval fingerprint does
// not depend on property insertion order.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

// Length-stable comparison via fixed-width SHA-256 digests, avoiding a trivial timing oracle
// on the capability token. Collision resistance makes equal digests imply equal tokens.
function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest("hex");
  const right = createHash("sha256").update(b).digest("hex");
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function atomicWriteFileSync(targetPath: string, content: string): void {
  const tmpPath = `${targetPath}.${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpPath, content, { mode: OWNER_ONLY_FILE_MODE });
  chmodSync(tmpPath, OWNER_ONLY_FILE_MODE);
  renameSync(tmpPath, targetPath);
  chmodSync(targetPath, OWNER_ONLY_FILE_MODE);
}

function makeId(prefix: "session" | "event" | "reply" | "bundle"): string {
  const stamp = toIso(now()).replace(/[-:]/g, "").replace("T", "_").replace("Z", "");
  return `${prefix}_${stamp}_${randomBytes(4).toString("hex")}`;
}

function findGitRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
