import type { ArtifactAuditEvent, ArtifactDetail, ArtifactProvenanceView } from "../artifact-detail.js";
import type {
  DashboardArtifactRow,
  DashboardBucketKey,
  DashboardLastAction,
  DashboardLedgerStatus,
  DashboardNeedsContext,
  DashboardProblemRow,
  DashboardReceiptRow,
  DashboardSnapshot,
  DashboardTrashRow
} from "../dashboard.js";

// Read-only HTML rendering for the Artshelf UI v1 browser surface (NGX-535 dashboard, NGX-536
// detail drawer, NGX-537 needs-context presentation). These are pure functions: they take the
// existing read-only domain snapshots and return a self-contained HTML document with inline styles
// and no scripts. The browser is a display surface only - the rendered pages carry no executable
// code, embed no file contents, and expose no mutation affordance, matching the v1 contract's
// non-negotiable boundaries. The loopback server (src/ui-server.ts) wires these to live state.

// Escape the five HTML metacharacters so record-supplied text (reasons, paths, ids) is always
// rendered as text, never markup. Every dynamic value in these pages routes through here.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// A strict, scriptless document shell. The viewport meta keeps the layout usable on narrow/mobile
// widths; the inline stylesheet avoids any external resource so the page renders fully offline and
// the read-only content policy can forbid everything but inline styles.
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

const STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #1c2024; background: #f4f5f7; }
a { color: #2b6cb0; }
header.top { padding: 16px 20px; background: #1c2733; color: #e8edf2; }
header.top h1 { margin: 0 0 4px; font-size: 18px; }
header.top .meta { font-size: 12px; opacity: .8; word-break: break-all; }
.banner { margin: 0; padding: 8px 20px; background: #fef3c7; color: #5b4708; font-size: 13px; border-bottom: 1px solid #f0d98a; }
main { padding: 16px 20px 48px; max-width: 1100px; margin: 0 auto; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 20px; padding: 0; list-style: none; }
.chip { display: flex; flex-direction: column; min-width: 116px; padding: 10px 12px; background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; }
.chip-k { font-size: 11px; letter-spacing: .02em; color: #6b7480; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.chip-v { font-size: 22px; font-weight: 600; }
section { margin: 0 0 24px; }
section > h2 { font-size: 15px; margin: 0 0 8px; padding-bottom: 4px; border-bottom: 2px solid #dfe3e8; }
.empty { margin: 0; color: #6b7480; font-style: italic; font-size: 13px; }
.row { background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; padding: 12px 14px; margin: 0 0 10px; }
.row h4 { margin: 0 0 6px; font-size: 14px; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.row h4 a { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.status { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #6b7480; }
.reason { margin: 0 0 8px; }
.muted { color: #6b7480; }
.badge { margin: 0 0 8px; padding: 6px 10px; background: #fdecea; color: #7a271a; border: 1px solid #f5c2bc; border-radius: 6px; font-size: 13px; }
dl.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px 16px; margin: 0; }
dl.fields > div { display: flex; flex-direction: column; }
dl.fields dt { font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: #6b7480; }
dl.fields dd { margin: 0; word-break: break-word; }
.ledgers { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px; }
.ledger { padding: 10px 12px; background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; }
.ledger.bad { border-color: #f5c2bc; background: #fdecea; }
.ledger .name { font-weight: 600; }
.ledger .path { font-size: 12px; color: #6b7480; word-break: break-all; }
.ledger .err { font-size: 13px; color: #7a271a; margin: 4px 0 0; }
.audit { list-style: none; margin: 0; padding: 0; }
.audit li { padding: 6px 0; border-bottom: 1px solid #eceef1; }
.audit li:last-child { border-bottom: 0; }
.intents .intent { background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; padding: 12px 14px; margin: 0 0 10px; display: flex; flex-direction: column; gap: 8px; }
.intents label { font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: #6b7480; }
.intents textarea { width: 100%; font: inherit; padding: 8px; border: 1px solid #cfd4da; border-radius: 6px; resize: vertical; background: #fff; color: inherit; }
.intents .intent-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.intents button { font: inherit; padding: 8px 14px; border: 1px solid #2b6cb0; background: #2b6cb0; color: #fff; border-radius: 6px; cursor: pointer; align-self: flex-start; }
.intents button:hover { background: #245a96; }
.back { display: inline-block; margin: 16px 20px 0; }
@media (max-width: 560px) { dl.fields { grid-template-columns: 1fr; } main { padding: 12px 14px 40px; } .intents button { align-self: stretch; } }
`;

const READ_ONLY_NOTE = "Read-only review surface - no file contents, no mutations, no browser-direct actions.";

// Contract bucket order for the count summary. The literal hyphenated keys double as the
// machine-precise lane labels in the first viewport.
const LANE_ORDER: DashboardBucketKey[] = [
  "needs-review",
  "needs-context",
  "cleanup",
  "resolve",
  "trash",
  "purge-candidates",
  "registry-reconcile",
  "recent-receipts"
];

export function renderDashboardPage(snapshot: DashboardSnapshot, token?: string): string {
  const okLedgers = snapshot.ledgers.filter((ledger) => ledger.ok).length;
  const chips = LANE_ORDER.map(
    (key) => `<li class="chip"><span class="chip-k">${key}</span><span class="chip-v">${snapshot.counts[key]}</span></li>`
  ).join("");

  const body = `<header class="top">
<h1>Artshelf review dashboard</h1>
<div class="meta">${snapshot.ledgers.length} ledger(s), ${okLedgers} healthy &middot; generated ${escapeHtml(snapshot.generatedAt)} &middot; registry ${escapeHtml(snapshot.registryPath)}</div>
</header>
<p class="banner">${READ_ONLY_NOTE}</p>
<main>
<ul class="chips">${chips}</ul>
${ledgerHealthSection(snapshot.ledgers)}
${artifactLane("needs-review", "Needs review", snapshot.buckets.needsReview, token)}
${artifactLane("needs-context", "Needs context", snapshot.buckets.needsContext, token)}
${artifactLane("cleanup", "Cleanup candidates", snapshot.buckets.cleanup, token)}
${artifactLane("resolve", "Resolve candidates", snapshot.buckets.resolve, token)}
${trashLane("trash", "Trash", snapshot.buckets.trash)}
${trashLane("purge-candidates", "Purge candidates", snapshot.buckets.purgeCandidates)}
${problemLane("registry-reconcile", "Registry / reconcile problems", snapshot.buckets.registryReconcile)}
${receiptLane("recent-receipts", "Recent receipts", snapshot.buckets.recentReceipts)}
</main>`;
  return page("Artshelf review dashboard", body);
}

function ledgerHealthSection(ledgers: DashboardLedgerStatus[]): string {
  if (ledgers.length === 0) {
    return `<section id="lane-ledgers"><h2>Ledger health</h2><p class="empty">No ledgers are registered.</p></section>`;
  }
  const cards = ledgers
    .map((ledger) => {
      const cls = ledger.ok ? "ledger" : "ledger bad";
      const state = ledger.ok ? `healthy &middot; ${ledger.records} record(s)` : "unavailable";
      const errs = ledger.ok ? "" : `<p class="err">${escapeHtml(ledger.errors[0] ?? "unavailable")}</p>`;
      return `<div class="${cls}"><div class="name">${escapeHtml(ledger.name)}</div><div class="path">${escapeHtml(ledger.path)}</div><div class="muted">${state}</div>${errs}</div>`;
    })
    .join("");
  return `<section id="lane-ledgers"><h2>Ledger health</h2><div class="ledgers">${cards}</div></section>`;
}

function laneSection(key: string, title: string, count: number, inner: string): string {
  const heading = `<h2 id="lane-${key}">${escapeHtml(title)} <span class="muted">(${key}: ${count})</span></h2>`;
  const content = count === 0 ? `<p class="empty">Nothing in this lane.</p>` : inner;
  return `<section>${heading}${content}</section>`;
}

function artifactLane(key: string, title: string, rows: DashboardArtifactRow[], token?: string): string {
  const inner = rows.map((row) => artifactCard(row, token)).join("");
  return laneSection(key, title, rows.length, inner);
}

function artifactCard(row: DashboardArtifactRow, token?: string): string {
  const href = detailHref(row.recordId, row.ledgerPath, token);
  const reason = row.reason.trim() ? escapeHtml(row.reason) : `<span class="muted">(no reason recorded)</span>`;
  const due = row.dueState ? ` &middot; ${escapeHtml(row.dueState)}` : "";
  const retention = row.retainUntil
    ? `${escapeHtml(row.retention.mode)} until ${escapeHtml(row.retainUntil)}`
    : escapeHtml(row.retention.mode);
  return `<article class="row">
<h4><a href="${href}">${escapeHtml(row.recordId)}</a> <span class="status">${escapeHtml(row.status)}</span></h4>
<p class="reason">${reason}</p>
${needsContextBadge(row.needsContext)}
<dl class="fields">
<div><dt>source</dt><dd>${escapeHtml(row.ledgerName)}</dd></div>
<div><dt>record path</dt><dd>${escapeHtml(row.path)}</dd></div>
<div><dt>age / due</dt><dd>${escapeHtml(row.age)}${due}</dd></div>
<div><dt>retention</dt><dd>${retention}</dd></div>
<div><dt>cleanup</dt><dd>${escapeHtml(row.cleanup)}</dd></div>
<div><dt>existence</dt><dd>${escapeHtml(row.existence)}</dd></div>
<div><dt>recommendation</dt><dd>${escapeHtml(row.recommendation)}</dd></div>
${lastActionField(row.lastAction)}
</dl>
</article>`;
}

function needsContextBadge(needsContext: DashboardNeedsContext | null): string {
  return needsContext ? `<p class="badge">Needs context: ${escapeHtml(needsContext.label)}</p>` : "";
}

function lastActionField(lastAction: DashboardLastAction | null): string {
  if (!lastAction) return "";
  const receipt = lastAction.receiptPath ? `; receipt ${lastAction.receiptPath}` : "";
  return `<div><dt>last action</dt><dd>${escapeHtml(lastAction.kind)} at ${escapeHtml(lastAction.at)}${escapeHtml(receipt)}</dd></div>`;
}

function trashLane(key: string, title: string, rows: DashboardTrashRow[]): string {
  const inner = rows
    .map(
      (row) => `<article class="row">
<h4>${escapeHtml(row.recordId)} <span class="status">${escapeHtml(row.ledgerName)}</span></h4>
<dl class="fields">
<div><dt>target</dt><dd>${escapeHtml(row.targetPath)}</dd></div>
<div><dt>cleaned</dt><dd>${escapeHtml(row.cleanedAt)} (${escapeHtml(row.age)})</dd></div>
<div><dt>plan</dt><dd>${escapeHtml(row.cleanupPlanId)}</dd></div>
<div><dt>receipt</dt><dd>${escapeHtml(row.receiptPath)}</dd></div>
</dl>
</article>`
    )
    .join("");
  return laneSection(key, title, rows.length, inner);
}

function problemLane(key: string, title: string, rows: DashboardProblemRow[]): string {
  const inner = rows
    .map((row) => {
      const remap =
        row.currentPath && row.proposedPath
          ? `<div><dt>remap</dt><dd>${escapeHtml(row.currentPath)} &rarr; ${escapeHtml(row.proposedPath)}</dd></div>`
          : "";
      const target = row.recordId ? escapeHtml(row.recordId) : escapeHtml(row.ledgerName ?? row.ledgerPath ?? "registry");
      return `<article class="row">
<h4>${target} <span class="status">${escapeHtml(row.source)}: ${escapeHtml(row.category)}</span></h4>
<p class="reason">${escapeHtml(row.detail)}</p>
<dl class="fields">
<div><dt>ledger</dt><dd>${escapeHtml(row.ledgerName ?? row.ledgerPath ?? "-")}</dd></div>
${remap}
</dl>
</article>`;
    })
    .join("");
  return laneSection(key, title, rows.length, inner);
}

function receiptLane(key: string, title: string, rows: DashboardReceiptRow[]): string {
  const inner = rows
    .map(
      (row) => `<article class="row">
<h4>${escapeHtml(row.recordId)} <span class="status">${escapeHtml(row.receiptKind)}</span></h4>
<p class="reason">${escapeHtml(row.reason)}</p>
<dl class="fields">
<div><dt>source</dt><dd>${escapeHtml(row.ledgerName)}</dd></div>
<div><dt>age</dt><dd>${escapeHtml(row.age)}</dd></div>
</dl>
</article>`
    )
    .join("");
  return laneSection(key, title, rows.length, inner);
}

export function renderDetailPage(detail: ArtifactDetail, token?: string): string {
  const inspect = detail.inspect;
  const reason = inspect.reason.trim() ? escapeHtml(inspect.reason) : `<span class="muted">(no reason recorded)</span>`;
  const source = detail.ledgerName ? `${escapeHtml(detail.ledgerName)} (${escapeHtml(detail.ledgerPath)})` : escapeHtml(detail.ledgerPath);
  const retention = inspect.retainUntil
    ? `${escapeHtml(inspect.retention.mode)} until ${escapeHtml(inspect.retainUntil)}`
    : escapeHtml(inspect.retention.mode);

  const body = `<a class="back" href="${dashboardHref(token)}">&larr; dashboard</a>
<main>
<header>
<h1><span class="muted">${escapeHtml(detail.recordId)}</span> <span class="status">${escapeHtml(inspect.status)}</span></h1>
</header>
<p class="reason">${reason}</p>
${needsContextBadge(detail.needsContext)}
<dl class="fields">
<div><dt>source</dt><dd>${source}</dd></div>
<div><dt>record path</dt><dd>${escapeHtml(inspect.path)}</dd></div>
<div><dt>subject path</dt><dd>${escapeHtml(inspect.subjectPath)}</dd></div>
<div><dt>created / age</dt><dd>${escapeHtml(detail.createdAt)} (${escapeHtml(inspect.age)})</dd></div>
<div><dt>review due reason</dt><dd>${detail.dueReason ? escapeHtml(detail.dueReason) : `<span class="muted">not due</span>`}</dd></div>
<div><dt>retention</dt><dd>${retention}</dd></div>
<div><dt>cleanup policy</dt><dd>${escapeHtml(inspect.cleanup)}</dd></div>
<div><dt>existence</dt><dd>${existenceLabel(inspect.existence, inspect.nodeKind, inspect.byteSize)}</dd></div>
<div><dt>recommendation</dt><dd>${escapeHtml(inspect.recommendation)}</dd></div>
<div><dt>next action</dt><dd>${escapeHtml(inspect.nextAction)}</dd></div>
<div><dt>provenance</dt><dd>${provenanceLabel(detail.provenance)}</dd></div>
</dl>
${token ? intentForms(detail.recordId, detail.ledgerPath, token) : ""}
<section>
<h2>Audit trail</h2>
<ul class="audit">${detail.audit.map(auditItem).join("")}</ul>
</section>
${lastActionSection(detail.lastAction)}
</main>`;
  return page(`Artshelf detail ${detail.recordId}`, body);
}

function existenceLabel(existence: string, nodeKind: string | null, byteSize: number | null): string {
  if (existence !== "present") return escapeHtml(existence);
  const facts = [nodeKind, byteSize === null ? null : `${byteSize} B`].filter((fact): fact is string => fact !== null);
  return facts.length > 0 ? `present (${escapeHtml(facts.join(", "))})` : "present";
}

function provenanceLabel(view: ArtifactProvenanceView): string {
  if (!view.present || !view.provenance) return `<span class="muted">none recorded</span>`;
  const provenance = view.provenance;
  const place = provenance.relativePath ? `${provenance.root}:${provenance.relativePath}` : provenance.root;
  return provenance.fingerprint ? `${escapeHtml(place)} (fingerprinted)` : escapeHtml(place);
}

function auditItem(event: ArtifactAuditEvent): string {
  const parts = [`<strong>${escapeHtml(event.kind)}</strong> ${escapeHtml(event.at)}`];
  if (event.reason) parts.push(escapeHtml(event.reason));
  if (event.detail) parts.push(escapeHtml(event.detail));
  if (event.receiptPath) parts.push(`receipt ${escapeHtml(event.receiptPath)}`);
  return `<li>${parts.join(" &middot; ")}</li>`;
}

function lastActionSection(lastAction: DashboardLastAction | null): string {
  if (!lastAction) return "";
  const receipt = lastAction.receiptPath ? ` &middot; receipt ${escapeHtml(lastAction.receiptPath)}` : "";
  return `<section><h2>Last action</h2><p>${escapeHtml(lastAction.kind)} at ${escapeHtml(lastAction.at)}${receipt}</p></section>`;
}

// NGX-538 human triage intent affordances on the detail drawer. Each intent is a scriptless HTML form
// posting back to the server's /intents endpoint under the page's capability token. The browser only
// records the intent for the agent's poll queue - it executes nothing and mutates no ledger, file,
// trash, or plan. Every form carries the exact record + ledger target as hidden fields so each queued
// event names an unambiguous target. The four decision buttons share one form; the clicked button's
// value is the keep/trash/resolve/defer decision. Rendered only when a capability token is present, so
// a tokenless render stays read-only.
function intentForms(recordId: string, ledgerPath: string, token: string): string {
  const targetFields =
    `<input type="hidden" name="recordId" value="${escapeHtml(recordId)}">` +
    `<input type="hidden" name="ledgerPath" value="${escapeHtml(ledgerPath)}">` +
    `<input type="hidden" name="token" value="${escapeHtml(token)}">`;
  return `<section class="intents">
<h2>Record a triage intent</h2>
<p class="muted">Intents are queued for the agent to act on. The browser records the decision; it executes nothing and changes no ledger, file, or trash.</p>
<form method="post" action="/intents" class="intent">
<input type="hidden" name="type" value="inspect_requested">${targetFields}
<button type="submit">Request inspect card</button>
</form>
<form method="post" action="/intents" class="intent">
<input type="hidden" name="type" value="dry_run_requested">${targetFields}
<button type="submit">Request dry-run plan</button>
</form>
<form method="post" action="/intents" class="intent">
<input type="hidden" name="type" value="decision_submitted">${targetFields}
<label for="decision-reason">Decision reason (optional)</label>
<textarea id="decision-reason" name="reason" rows="2" placeholder="why keep, trash, resolve, or defer this record"></textarea>
<div class="intent-actions">
<button type="submit" name="decision" value="keep">Keep</button>
<button type="submit" name="decision" value="trash">Trash candidate</button>
<button type="submit" name="decision" value="resolve">Resolve candidate</button>
<button type="submit" name="decision" value="defer">Defer / snooze</button>
</div>
</form>
<form method="post" action="/intents" class="intent">
<input type="hidden" name="type" value="comment_added">${targetFields}
<label for="comment-text">Comment</label>
<textarea id="comment-text" name="text" rows="2" required placeholder="note for the agent and the audit trail"></textarea>
<button type="submit">Add comment</button>
</form>
</section>`;
}

export function renderErrorPage(options: { status: number; title: string; message: string }): string {
  const body = `<main>
<header><h1>${options.status} &middot; ${escapeHtml(options.title)}</h1></header>
<p class="reason">${escapeHtml(options.message)}</p>
<p><a href="/">&larr; back to the dashboard</a></p>
</main>`;
  return page(`Artshelf ${options.status}`, body);
}

function detailHref(recordId: string, ledgerPath: string, token?: string): string {
  const params = [`ledger=${encodeURIComponent(ledgerPath)}`];
  if (token) params.push(`token=${encodeURIComponent(token)}`);
  return `/detail/${encodeURIComponent(recordId)}?${params.join("&")}`;
}

function dashboardHref(token?: string): string {
  return token ? `/?token=${encodeURIComponent(token)}` : "/";
}
