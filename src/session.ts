import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ArtshelfEnv } from "./config/env.js";
import { withPathLock } from "./locks.js";
import { now, toIso } from "./time.js";
import type {
  UiApprovalLiveFacts,
  UiApprovalRevalidation,
  UiApprovalSnapshot,
  UiApprovalTarget,
  UiDecisionIntent,
  UiEvent,
  UiReplyStatus,
  UiEventStatus,
  UiEventType,
  UiReply,
  UiSession,
  UiSessionHistoryEntry,
  UiSessionScope
} from "./types.js";

// Storage model for the Artshelf UI v1 review session (NGX-531, slice 1). This module is
// the durable handoff layer between the human decision surface (browser) and the agent
// that executes existing approval-gated CLI paths. It is the only authority on session
// metadata, the capability token, the append-only event log, and approval snapshots; it
// never executes a mutating workflow itself, preserving the v1 boundary that the browser
// records exact-target triage intents and the agent executes.
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
  status?: UiEventStatus;
};

export type ReplyInput = {
  status: UiReplyStatus;
  payload?: Record<string, unknown>;
};

export type ApprovalSnapshotInput = {
  actionType: string;
  // Full reviewed candidate pool (selected + unselected rows shown in the workbench).
  targets: UiApprovalTarget[];
  // Deliberate human selection: a non-empty, duplicate-free subset of `targets` ids.
  selectedTargetIds: string[];
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

const UI_EVENT_TYPE_SET: Record<UiEventType, true> = {
  inspect_requested: true,
  comment_added: true,
  decision_submitted: true,
  dry_run_requested: true,
  approval_bundle_submitted: true,
  session_done: true,
  question_answered: true,
  filter_saved: true,
  session_note_added: true
};

// Exhaustive runtime view of the UiDecisionIntent union, mirroring UI_EVENT_TYPE_SET so a new
// triage intent cannot be added to the type without the storage layer learning to validate it.
const UI_DECISION_INTENT_SET: Record<UiDecisionIntent, true> = {
  keep: true,
  trash: true,
  resolve: true,
  defer: true
};

export const UI_EVENT_STATUSES = Object.keys(UI_EVENT_STATUS_SET) as UiEventStatus[];
export const UI_REPLY_STATUSES = UI_EVENT_STATUSES.filter((entry) => entry !== "pending") as UiReplyStatus[];
export const UI_DECISION_INTENTS = Object.keys(UI_DECISION_INTENT_SET) as UiDecisionIntent[];

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

export function isUiEventType(value: unknown): value is UiEventType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(UI_EVENT_TYPE_SET, value);
}

export function isUiReplyStatus(value: string): value is UiReplyStatus {
  return isUiEventStatus(value) && value !== "pending";
}

export function isUiDecisionIntent(value: unknown): value is UiDecisionIntent {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(UI_DECISION_INTENT_SET, value);
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
      ...buildEvent(sessionId, { type: "session_done", status: "completed" }, "agent", endedAt)
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

// Append a browser event to the durable log. Browser writes are refused once the session has
// ended and always enter the agent poll queue as pending.
export function appendEvent(home: string, sessionId: string, input: AppendEventInput): UiEvent {
  const path = sessionFile(home, sessionId);
  return withUiStorageLock(home, path, () => {
    const session = readSession(home, sessionId);
    if (session.status !== "active") {
      throw new Error(`Artshelf UI session ${sessionId} has ended; browser writes are closed`);
    }
    const createdAt = toIso(now());
    const event = buildEvent(sessionId, input, "browser", createdAt);
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

// Read the full session history: every event paired, in creation order, with the agent replies
// appended against it. Like readSessionEvents this folds each reply's status/updatedAt onto the
// event, but it additionally keeps every reply (with its own payload) so the browser session
// history can show the agent's note, receipt, or rejection reason - the visible-in-history half of
// the NGX-538 decision-intent contract. The on-disk log stays append-only; this is a read-side view.
export function readSessionHistory(home: string, sessionId: string): UiSessionHistoryEntry[] {
  const entries = new Map<string, UiSessionHistoryEntry>();
  const order: string[] = [];
  for (const line of readLog(home, sessionId)) {
    if (line.kind === "event") {
      const { kind: _kind, ...event } = line;
      entries.set(event.id, { event, replies: [] });
      order.push(event.id);
    } else {
      const entry = entries.get(line.eventId);
      if (entry) {
        const { kind: _kind, ...reply } = line;
        entry.event.status = reply.status;
        entry.event.updatedAt = reply.createdAt;
        entry.replies.push(reply);
      }
    }
  }
  return order.map((id) => entries.get(id)!);
}

// Compact actionable queue for agent consumption: events still awaiting an agent reply.
export function pollPendingEvents(home: string, sessionId: string): UiEvent[] {
  const path = sessionFile(home, sessionId);
  return withUiStorageLock(home, path, () => {
    const session = readSession(home, sessionId);
    if (session.status === "ended") return [];
    return readSessionEvents(home, sessionId).filter((event) => event.status === "pending");
  });
}

// Append an agent reply that advances exactly one event's status and carries the agent's
// result/receipt/validation-failure/question/note in payload.
export function replyToEvent(
  home: string,
  sessionId: string,
  eventId: string,
  input: ReplyInput
): { event: UiEvent; reply: UiReply } {
  if (!isUiReplyStatus(input.status)) {
    throw new Error(`Invalid Artshelf UI reply status "${input.status}"; expected one of: ${UI_REPLY_STATUSES.join(", ")}`);
  }
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

// Persist an immutable, fingerprinted approval snapshot for the session (NGX-539). The
// reviewed candidate pool and the deliberate selection are both validated and persisted, and
// the fingerprint is taken over the *selected* targets + reviewed facts so the bundle identity
// reflects exactly what the human approved. Approval is an approval record, never an execution:
// this only writes the snapshot.
export function writeApprovalSnapshot(home: string, sessionId: string, input: ApprovalSnapshotInput): UiApprovalSnapshot {
  const session = readSession(home, sessionId);
  validateApprovalSnapshotInput(input);
  const reviewed = input.reviewed ?? {};
  const selectedTargets = resolveSelectedTargets(input.targets, input.selectedTargetIds);
  const snapshot: UiApprovalSnapshot = {
    id: makeId("bundle"),
    sessionId: session.id,
    createdAt: toIso(now()),
    actionType: input.actionType,
    targets: input.targets,
    selectedTargetIds: input.selectedTargetIds,
    reviewed,
    fingerprint: approvalSnapshotFingerprint(selectedTargets, reviewed)
  };
  const path = bundleFile(home, sessionId, snapshot.id);
  withUiStorageLock(home, path, () => {
    ensureOwnerOnlyDirectoryTree(home, dirname(path));
    atomicWriteFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  });
  return snapshot;
}

// Resolve a bundle's deliberate selection back to its exact target rows, in selection order.
// Used both at write time (to fingerprint the selected subset) and by readers/agents that need
// the approved per-target context without re-implementing the pool lookup.
export function selectedApprovalTargets(snapshot: UiApprovalSnapshot): UiApprovalTarget[] {
  return resolveSelectedTargets(snapshot.targets, snapshot.selectedTargetIds);
}

function resolveSelectedTargets(targets: UiApprovalTarget[], selectedTargetIds: string[]): UiApprovalTarget[] {
  const byId = new Map(targets.map((target) => [target.targetId, target]));
  return selectedTargetIds
    .map((id) => byId.get(id))
    .filter((target): target is UiApprovalTarget => target !== undefined);
}

// Enforce the NGX-539 approval boundary at the storage seam: a bundle must carry a non-empty
// reviewed candidate pool of well-formed exact targets, and the selection must be a deliberate,
// duplicate-free, non-empty subset of that pool whose every member names an exact subject. This
// is where "no vague approve-all" and "exact target context for every selected item" become
// impossible to express, before the snapshot is ever fingerprinted or persisted.
function validateApprovalSnapshotInput(input: ApprovalSnapshotInput): void {
  if (!isNonEmptyString(input.actionType)) {
    throw new Error("Invalid Artshelf UI approval bundle actionType; expected a non-empty string");
  }
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new Error("Invalid Artshelf UI approval bundle; expected at least one reviewed target in the candidate pool");
  }

  const poolIds = new Set<string>();
  for (const target of input.targets) {
    validateApprovalTarget(target);
    if (poolIds.has(target.targetId)) {
      throw new Error(`Duplicate Artshelf UI approval target id in the candidate pool: ${target.targetId}`);
    }
    poolIds.add(target.targetId);
  }

  if (!Array.isArray(input.selectedTargetIds) || input.selectedTargetIds.length === 0) {
    throw new Error(
      "Invalid Artshelf UI approval selection; approval requires at least one deliberately selected target (no vague approve-all)"
    );
  }
  const selectedIds = new Set<string>();
  for (const id of input.selectedTargetIds) {
    if (selectedIds.has(id)) {
      throw new Error(`Duplicate Artshelf UI approval selection id: ${id}`);
    }
    selectedIds.add(id);
    if (!poolIds.has(id)) {
      throw new Error(`Artshelf UI approval selection id not in the reviewed candidate pool: ${id}`);
    }
  }

  // Every *selected* row must name an exact subject; an unselected candidate is only context.
  for (const target of input.targets) {
    if (selectedIds.has(target.targetId)) {
      requireExactTargetSubject(target);
    }
  }
}

// Structural well-formedness of one candidate row, independent of whether it is selected: the
// identity, owning ledger, action, and human label must all be present, and the optional subject
// pointers must be either a non-empty string or explicit null (never blank).
function validateApprovalTarget(target: UiApprovalTarget): void {
  if (!isPlainRecord(target)) {
    throw new Error("Invalid Artshelf UI approval target; expected a JSON object");
  }
  for (const field of ["targetId", "ledgerPath", "actionType", "label"] as const) {
    if (!isNonEmptyString(target[field])) {
      throw new Error(`Invalid Artshelf UI approval target.${field}; expected a non-empty string`);
    }
  }
  for (const field of ["registryPath", "recordPath", "planId"] as const) {
    const value = target[field];
    if (value !== null && !isNonEmptyString(value)) {
      throw new Error(`Invalid Artshelf UI approval target.${field}; expected a non-empty string or null`);
    }
  }
}

// A selected target must point at an exact subject - a record, a reviewed plan, or a registry
// entry - so cross-ledger approval stays a bundle of exact per-target actions and can never
// collapse into "approve everything on ledger X".
function requireExactTargetSubject(target: UiApprovalTarget): void {
  const hasSubject =
    isNonEmptyString(target.recordPath) || isNonEmptyString(target.planId) || isNonEmptyString(target.registryPath);
  if (!hasSubject) {
    throw new Error(
      `Invalid Artshelf UI approval target ${target.targetId}; a selected target must name an exact subject ` +
        "(recordPath, planId, or registryPath) - no vague global approval"
    );
  }
}

export function readApprovalSnapshot(home: string, sessionId: string, bundleId: string): UiApprovalSnapshot {
  const path = bundleFile(home, sessionId, bundleId);
  if (!existsSync(path)) throw new Error(`Artshelf UI approval snapshot not found: ${bundleId}`);
  return JSON.parse(readFileSync(path, "utf8")) as UiApprovalSnapshot;
}

// List every persisted approval bundle for a session (NGX-539): a read-only audit/discovery
// surface for the agent. It resolves each immutable snapshot from `<ui-home>/sessions/<id>/bundles/`,
// skipping any file whose name is not a well-formed bundle id, and returns them sorted by creation
// time (then id) so the listing is stable across calls. Returns an empty list when the session has
// approved nothing yet - the bundles directory need not exist.
export function listApprovalSnapshots(home: string, sessionId: string): UiApprovalSnapshot[] {
  const dir = join(sessionDir(home, sessionId), "bundles");
  if (!existsSync(dir)) return [];
  const snapshots: UiApprovalSnapshot[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const bundleId = entry.slice(0, -".json".length);
    if (!isUiId("bundle", bundleId)) continue;
    snapshots.push(readApprovalSnapshot(home, sessionId, bundleId));
  }
  return snapshots.sort((left, right) => compareBundleOrder(left, right));
}

// Deterministic listing order: oldest approval first (by createdAt), breaking same-second ties by
// bundle id so two bundles minted in the same second still sort stably.
function compareBundleOrder(left: UiApprovalSnapshot, right: UiApprovalSnapshot): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
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

// Revalidate an approved bundle against the live facts an agent re-read from current
// ledger/registry/record/plan state (NGX-539). The reviewed snapshot is immutable, so this never
// mutates it - it only reports whether the live world still matches what the human approved. A
// bundle is "fresh" (safe for the agent to execute) only when every *selected* target is still
// present and unchanged and no reviewed fact drifted; any divergence is "stale", and the granular
// fields tell the agent (and, later, the workbench) exactly what changed so the human can
// re-review. Drift in an unselected candidate row is ignored: only the approved subset gates
// execution.
export function revalidateApprovalSnapshot(
  snapshot: UiApprovalSnapshot,
  live: UiApprovalLiveFacts
): UiApprovalRevalidation {
  const selected = selectedApprovalTargets(snapshot);
  const liveById = new Map((live.targets ?? []).map((target) => [target.targetId, target]));
  const missingTargetIds: string[] = [];
  const changedTargetIds: string[] = [];
  const liveSelected: UiApprovalTarget[] = [];
  for (const target of selected) {
    const liveTarget = liveById.get(target.targetId);
    if (liveTarget === undefined) {
      missingTargetIds.push(target.targetId);
      continue;
    }
    liveSelected.push(liveTarget);
    if (canonicalJson(liveTarget) !== canonicalJson(target)) {
      changedTargetIds.push(target.targetId);
    }
  }

  const liveReviewed = live.reviewed ?? {};
  const reviewedKeysDrifted = driftedReviewedKeys(snapshot.reviewed, liveReviewed);
  const drifted = missingTargetIds.length > 0 || changedTargetIds.length > 0 || reviewedKeysDrifted.length > 0;
  return {
    status: drifted ? "stale" : "fresh",
    expectedFingerprint: snapshot.fingerprint,
    liveFingerprint: approvalSnapshotFingerprint(liveSelected, liveReviewed),
    missingTargetIds,
    changedTargetIds,
    reviewedKeysDrifted
  };
}

// Reviewed facts whose live value diverges from what was captured at approval time - a changed
// value, a key that disappeared from live state, or a new key live state now reports. Compared by
// canonical form so property insertion order never registers as drift, and returned sorted so the
// verdict is stable for logging and assertions.
function driftedReviewedKeys(reviewed: Record<string, unknown>, live: Record<string, unknown>): string[] {
  const keys = new Set<string>([...Object.keys(reviewed ?? {}), ...Object.keys(live ?? {})]);
  const drifted: string[] = [];
  for (const key of keys) {
    if (canonicalJson((reviewed ?? {})[key]) !== canonicalJson((live ?? {})[key])) {
      drifted.push(key);
    }
  }
  return drifted.sort();
}

function buildEvent(sessionId: string, input: AppendEventInput, source: UiEvent["source"], createdAt: string): UiEvent {
  const normalized = validateEventInput(input);
  return {
    id: makeId("event"),
    sessionId,
    type: normalized.type,
    status: source === "browser" ? "pending" : normalized.status ?? "pending",
    source,
    createdAt,
    updatedAt: createdAt,
    target: normalized.target,
    payload: normalized.payload
  };
}

function validateEventInput(input: AppendEventInput): Required<AppendEventInput> {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid Artshelf UI event input; expected an object");
  }
  if (!isUiEventType(input.type)) {
    throw new Error(`Invalid Artshelf UI event type "${String(input.type)}"`);
  }
  if (input.status !== undefined && !isUiEventStatus(input.status)) {
    throw new Error(`Invalid Artshelf UI event status "${String(input.status)}"`);
  }
  const target = normalizeEventRecord("target", input.target);
  const payload = normalizeEventRecord("payload", input.payload);
  UI_EVENT_VALIDATORS[input.type]?.(target, payload);
  return {
    type: input.type,
    status: input.status ?? "pending",
    target,
    payload
  };
}

// Per-intent payload/target validators run before the event reaches the durable log, enforcing the
// NGX-538 rule that every triage intent names the exact record + ledger it concerns and carries a
// well-formed body - no vague global action events. The record-scoped intents (inspect/comment/
// decision/dry-run request) are tightened here; session-level types
// (session_done/session_note_added/etc.) keep the base validation. Event types without an entry
// accept any plain-object target/payload.
const UI_EVENT_VALIDATORS: Partial<
  Record<UiEventType, (target: Record<string, unknown>, payload: Record<string, unknown>) => void>
> = {
  inspect_requested: validateInspectRequest,
  comment_added: validateCommentIntent,
  decision_submitted: validateDecisionIntent,
  dry_run_requested: validateDryRunRequest
};

// An inspect intent asks the agent to surface the inspect card for one exact record; it carries no
// body of its own, only the record + ledger it concerns, so a vague "inspect everything" request
// cannot enter the log.
function validateInspectRequest(target: Record<string, unknown>): void {
  requireRecordTarget(target);
}

// A dry-run request asks the agent to prepare the appropriate reviewed plan for one exact record; it
// carries no executable authority, but still must name the record + ledger so it cannot become a
// vague global planning event.
function validateDryRunRequest(target: Record<string, unknown>): void {
  requireRecordTarget(target);
}

// A comment intent annotates one exact record and must carry the human's note: the record + ledger it
// concerns plus a non-empty text body, so a blank or record-less comment never enters the audit trail.
// A session-wide note is a separate (future) session_note_added event, not a target-less comment.
function validateCommentIntent(target: Record<string, unknown>, payload: Record<string, unknown>): void {
  requireRecordTarget(target);
  if (!isNonEmptyString(payload.text)) {
    throw new Error("Invalid Artshelf UI comment text; expected a non-empty string");
  }
}

// A keep/trash/resolve/defer triage intent must name the exact record + ledger it concerns and
// carry a recognized decision; the optional reason, when present, must be a non-empty string so a
// blank-but-present reason cannot slip into the audit trail.
function validateDecisionIntent(target: Record<string, unknown>, payload: Record<string, unknown>): void {
  requireRecordTarget(target);
  if (!isUiDecisionIntent(payload.decision)) {
    throw new Error(
      `Invalid Artshelf UI decision intent "${String(payload.decision)}"; expected one of: ${UI_DECISION_INTENTS.join(", ")}`
    );
  }
  if (payload.reason !== undefined && !isNonEmptyString(payload.reason)) {
    throw new Error("Invalid Artshelf UI decision reason; expected a non-empty string when provided");
  }
}

// Exact-target guard shared by record-scoped intents: the record id and its owning ledger path
// must both be present so a multi-ledger agent can act on an unambiguous target.
function requireRecordTarget(target: Record<string, unknown>): void {
  requireNonEmptyTargetField(target, "recordId");
  requireNonEmptyTargetField(target, "ledgerPath");
}

function requireNonEmptyTargetField(target: Record<string, unknown>, field: string): void {
  if (!isNonEmptyString(target[field])) {
    throw new Error(`Invalid Artshelf UI event target.${field}; expected a non-empty string`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeEventRecord(name: "target" | "payload", value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) {
    throw new Error(`Invalid Artshelf UI event ${name}; expected a JSON object`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  const root = sessionsDir(home);
  const target = resolve(targetPath);
  mkdirSync(target, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
  const directories: string[] = [];
  let current = target;
  while (true) {
    if (current === root || current.startsWith(`${root}/`)) directories.push(current);
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
