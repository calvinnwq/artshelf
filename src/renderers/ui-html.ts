import type { ArtifactAuditEvent, ArtifactDetail, ArtifactProvenanceView } from "../artifact-detail.js";
import { PURGE_APPROVAL_ACTION, groupPurgeCandidates } from "../dashboard.js";
import type {
  DashboardArtifactRow,
  DashboardBucketKey,
  DashboardLastAction,
  DashboardLedgerStatus,
  DashboardProblemRow,
  DashboardPurgeGroup,
  DashboardReceiptRow,
  DashboardSnapshot,
  DashboardTrashRow
} from "../dashboard.js";
import type {
  UiApprovalCandidate,
  UiApprovalGroup,
  UiApprovalTarget,
  UiApprovalWorkbenchView,
  UiEvent,
  UiReply,
  UiSessionHistoryEntry
} from "../types.js";

// Read-only HTML rendering for the Artshelf UI v1 browser surface (NGX-535 dashboard, NGX-536
// detail drawer, NGX-537 needs-context, NGX-539 approval workbench). These are pure functions: they
// take the existing read-only domain snapshots and return a self-contained HTML document with inline
// styles. Detail and bundle pages carry no executable code or file contents; the dashboard may carry
// a nonce-bound activity poller. Forms only post token-bound session events and never expose direct
// ledger/file/trash/plan mutation affordances. The loopback server (src/ui-server.ts) wires these to
// live state and sets the strict CSP the markup honors: no external assets, no <img>, no web fonts.
// Interactivity (collapsible stages, selection state) is expressed mostly in CSS (:has(),
// <details>, :checked); the dashboard script only refreshes token-scoped queue activity.

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

// A strict self-contained document shell. The viewport meta keeps the layout usable on narrow/mobile
// widths; the inline stylesheet avoids any external resource so the page renders fully offline and
// can run under a tight page-specific content policy.
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

// One shared design system across all three surfaces, so the dashboard, detail drawer, and approval
// workbench read as one product. System fonts only (the CSP blocks web fonts): a characterful serif
// for display headings (Apple's New York via ui-serif, else Georgia), a humanist sans for prose, and
// monospace for machine-precise ids/paths/counts. Semantic colour is reserved for meaning - amber for
// attention, red for the one-way-door purge, green for done. Light by default, dark via the OS.
const STYLES = `
:root{
  color-scheme: light dark;
  --paper:#f5f2ec; --surface:#fffdf9; --surface-2:#f0ece3; --raise:#fffefb;
  --ink:#1b1d1a; --ink-2:#4c504a; --ink-3:#7c817a; --line:#e4ddd0; --line-2:#d3cabb;
  --accent:#0f6b62; --accent-ink:#0a4f48; --accent-soft:#dfeeeb;
  --attn:#985f05; --attn-soft:#fbefd6; --attn-line:#ecd6a4;
  --danger:#9d2a23; --danger-soft:#f7e1dc; --danger-line:#e6bbb2;
  --good:#2c6a44; --good-soft:#dfede3; --good-line:#bcd9c5;
  --slate:#5a6470; --slate-soft:#e9ecef;
  --shadow:0 1px 2px rgba(28,30,26,.05), 0 6px 20px -10px rgba(28,30,26,.18);
  --shadow-lift:0 2px 4px rgba(28,30,26,.06), 0 18px 40px -18px rgba(28,30,26,.30);
  --serif:ui-serif,"New York",Georgia,"Times New Roman",serif;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Monaco,"Cascadia Code",monospace;
}
@media (prefers-color-scheme: dark){
  :root{
    --paper:#131613; --surface:#1b1f1c; --surface-2:#222723; --raise:#202521;
    --ink:#e9ece8; --ink-2:#b2b8b1; --ink-3:#838a82; --line:#2a302b; --line-2:#3a423b;
    --accent:#54cabd; --accent-ink:#9fe5dc; --accent-soft:#17312e;
    --attn:#e0b25e; --attn-soft:#33270f; --attn-line:#4d3a16;
    --danger:#e98b80; --danger-soft:#3a1c18; --danger-line:#5a2a23;
    --good:#86c79b; --good-soft:#16291d; --good-line:#244c33;
    --slate:#9aa4af; --slate-soft:#242a2f;
    --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px -12px rgba(0,0,0,.6);
    --shadow-lift:0 2px 6px rgba(0,0,0,.5), 0 22px 48px -20px rgba(0,0,0,.7);
  }
}
*{ box-sizing:border-box; }
body{ margin:0; font:15px/1.55 var(--sans); color:var(--ink); background:var(--paper); -webkit-font-smoothing:antialiased; letter-spacing:.005em; }
a{ color:var(--accent-ink); text-underline-offset:2px; text-decoration-color:color-mix(in srgb,var(--accent) 35%, transparent); }
a:hover{ text-decoration-color:var(--accent); }
code{ font-family:var(--mono); font-size:.92em; }
.num{ font-variant-numeric:tabular-nums; }
.muted{ color:var(--ink-3); }
.wrap{ max-width:1040px; min-width:0; margin:0 auto; padding:0 24px 72px; }
.eyebrow{ font:600 11px/1 var(--mono); letter-spacing:.16em; text-transform:uppercase; color:var(--ink-3); margin:0 0 14px; display:flex; align-items:center; gap:8px; }
.eyebrow::after{ content:""; flex:1; height:1px; background:linear-gradient(90deg,var(--line),transparent); }
section.block{ margin-top:36px; }

/* ---- masthead ---- */
header.top{ padding:30px 24px 22px; border-bottom:1px solid var(--line); background:linear-gradient(180deg,var(--surface),var(--paper)); }
header.top .wrap{ padding-bottom:0; }
.brand{ font:600 11px/1 var(--mono); letter-spacing:.2em; text-transform:uppercase; color:var(--accent); display:flex; align-items:center; gap:9px; margin:0 0 12px; }
.brand .dot{ width:7px; height:7px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 4px var(--accent-soft); }
.brand.peril{ color:var(--danger); } .brand.peril .dot{ background:var(--danger); box-shadow:0 0 0 4px var(--danger-soft); }
header.top h1{ font:500 31px/1.06 var(--serif); letter-spacing:-.01em; margin:0 0 12px; }
.meta{ display:flex; flex-wrap:wrap; gap:6px 18px; font:12px/1.4 var(--mono); color:var(--ink-3); overflow-wrap:anywhere; }
.meta > *{ min-width:0; }
.meta b{ color:var(--ink-2); font-weight:600; }
.back{ display:inline-flex; align-items:center; gap:6px; font:600 12.5px/1 var(--sans); text-decoration:none; color:var(--ink-2); margin:0 0 16px; }
.back:hover{ color:var(--accent-ink); }
.guard{ display:inline-flex; align-items:flex-start; gap:9px; margin:18px 0 2px; padding:9px 13px; background:var(--surface); border:1px solid var(--line); border-radius:9px; font-size:12.5px; color:var(--ink-2); max-width:780px; overflow-wrap:anywhere; }
.guard svg{ flex:none; margin-top:1px; color:var(--accent); }

/* ---- required actions ---- */
.review-form{ margin:0; }
.review-shell{ min-height:100vh; display:grid; grid-template-columns:minmax(0,1fr) minmax(340px,400px); gap:0; align-items:stretch; }
.review-main{ min-width:0; }
.agent-rail{ min-width:0; min-height:100vh; background:var(--surface); border-left:1px solid var(--line); }
.agent-rail-inner{ position:sticky; top:0; height:100vh; display:flex; flex-direction:column; gap:12px; overflow:auto; padding:18px; }
.agent-rail .block{ margin-top:0; }
.agent-rail-title{ display:flex; align-items:center; justify-content:space-between; gap:10px; padding:0 2px; font:600 11px/1 var(--mono); letter-spacing:.14em; text-transform:uppercase; color:var(--ink-3); }
.agent-rail-title span:last-child{ letter-spacing:0; text-transform:none; font:12px/1.35 var(--sans); color:var(--ink-3); }
.agent-rail .required-submit{ position:sticky; top:0; z-index:4; background:var(--surface); }
.acts{ display:grid; grid-template-columns:1fr; gap:8px; }
.act{ position:relative; display:block; background:var(--surface); border:1px solid var(--line); border-radius:10px; box-shadow:var(--shadow); overflow:hidden; }
.act > summary{ list-style:none; cursor:pointer; display:grid; grid-template-columns:auto auto minmax(0,1fr) auto; gap:10px 13px; align-items:center; padding:10px 12px; }
.act > summary::-webkit-details-marker{ display:none; }
.act[open] > summary{ border-bottom:1px solid var(--line); }
.act .n{ font:500 25px/1 var(--serif); letter-spacing:-.02em; min-width:34px; text-align:right; }
.act-main{ min-width:0; }
.act .name{ font-weight:650; font-size:14px; margin:0 0 3px; }
.act .rec{ margin:0; font-size:12.5px; line-height:1.35; color:var(--ink-2); max-width:82ch; overflow-wrap:anywhere; }
.rec-label{ font:700 10px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--ink-3); margin-right:6px; }
.rec-action{ display:inline-flex; align-items:center; padding:2px 7px; border-radius:999px; background:var(--accent-soft); color:var(--accent-ink); border:1px solid color-mix(in srgb,var(--accent) 28%, transparent); font-weight:750; margin-right:5px; }
.act.danger .rec-action{ background:var(--danger-soft); color:var(--danger); border-color:var(--danger-line); }
.act.attn .rec-action{ background:var(--attn-soft); color:var(--attn); border-color:var(--attn-line); }
.toggle-copy{ display:inline-flex; align-items:center; justify-content:center; color:var(--ink-3); }
.toggle-copy .chev{ flex:none; transition:transform .18s ease; }
.act[open] .toggle-copy .chev{ transform:rotate(90deg); }
.act-actions{ display:flex; flex-wrap:wrap; justify-content:flex-end; justify-self:end; gap:7px; }
.act-body{ background:var(--surface); }
.act-body .lane-actions{ border-top:0; }
.approve-choice{ position:relative; display:inline-flex; align-items:center; justify-content:center; gap:7px; padding:8px 13px; border-radius:8px; font:650 13px/1 var(--sans); border:1px solid var(--accent); color:#fff; background:var(--accent); cursor:pointer; user-select:none; }
.approve-choice input{ position:absolute; inset:0; opacity:0; cursor:pointer; margin:0; }
.approve-choice .queued{ display:none; }
.approve-choice:has(input:checked){ background:var(--good-soft); color:var(--good); border-color:var(--good-line); }
.approve-choice:has(input:checked) .approve{ display:none; }
.approve-choice:has(input:checked) .queued{ display:inline; }
.approve-choice:has(input:focus-visible){ outline:2px solid var(--accent); outline-offset:2px; }
.approve-choice.submitted,.bulk-choice.submitted,.row-choice.submitted{ opacity:1!important; pointer-events:none; cursor:not-allowed; filter:none!important; }
.approve-choice.disabled,.bulk-choice.disabled{ opacity:.45; pointer-events:none; cursor:not-allowed; filter:saturate(.35); }
.act:has(.row-choice input:checked) > summary .approve-choice{ opacity:.45; pointer-events:none; cursor:not-allowed; filter:saturate(.35); }
.act:has(> summary .approve-choice input:checked) .row-actions .row-choice{ opacity:.45; pointer-events:none; cursor:not-allowed; filter:saturate(.35); }
.act:has(.bulk-choice input:checked) > summary .approve-choice{ opacity:.45; pointer-events:none; cursor:not-allowed; filter:saturate(.35); }
.act:has(> summary .approve-choice input:checked) .lane-actions .bulk-choice{ opacity:.45; pointer-events:none; cursor:not-allowed; filter:saturate(.35); }
.required-submit{ padding:12px 14px; display:grid; gap:10px; background:var(--surface); border:1px solid var(--line-2); border-radius:12px; box-shadow:var(--shadow); }
.required-submit .copy{ color:var(--ink-2); font-size:12.5px; }
.required-submit button{ width:100%; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:9px; padding:10px 14px; font:700 13px/1 var(--sans); cursor:pointer; }
.required-submit button[disabled]{ background:var(--surface-2); border-color:var(--line-2); color:var(--ink-3); cursor:not-allowed; }
.act .cta{ display:inline-flex; align-items:center; gap:6px; align-self:flex-start; padding:8px 13px; border-radius:8px; font:600 13px/1 var(--sans); text-decoration:none; border:1px solid transparent; color:#fff; cursor:pointer; }
.act .cta svg{ transition:transform .14s ease; } .act .cta:hover svg{ transform:translateX(3px); }
.act.danger .cta{ background:var(--danger); } .act.attn .cta{ background:var(--attn); } .act.go .cta{ background:var(--accent); }
.act.calm .cta{ background:var(--surface-2); color:var(--ink); border-color:var(--line-2); }
.act .cta.calm{ background:var(--surface-2); color:var(--ink); border-color:var(--line-2); }
.act .cta.keep{ background:var(--good-soft); color:var(--good); border-color:var(--good-line); }
.act .cta.trash{ background:var(--danger); color:#fff; border-color:var(--danger); }
@media (max-width:980px){ .review-shell{ min-height:0; grid-template-columns:1fr; } .agent-rail{ order:2; min-height:0; border-left:0; border-top:1px solid var(--line); } .agent-rail-inner{ position:static; height:auto; overflow:visible; } .agent-rail .required-submit{ position:static; } .session-activity{ flex:none; overflow:visible; } }
@media (max-width:720px){ .wrap{ padding:0 16px 56px; } .review-shell{ gap:0; } .act > summary{ grid-template-columns:auto auto minmax(0,1fr); } .act-actions{ grid-column:2 / -1; justify-self:start; justify-content:flex-start; } .act .n{ min-width:28px; } }
@media (prefers-color-scheme: dark){ .act.danger .cta,.act.attn .cta,.act.go .cta,.approve-choice,.required-submit button{ color:#0e120f; } }
.allclear{ display:flex; align-items:center; gap:12px; padding:18px 20px; background:var(--good-soft); border:1px solid var(--good-line); border-radius:13px; color:var(--good); font-weight:600; }

/* ---- status summary ---- */
.stats{ display:grid; grid-template-columns:repeat(auto-fit,minmax(165px,1fr)); gap:1px; background:var(--line); border:1px solid var(--line); border-radius:13px; overflow:hidden; box-shadow:var(--shadow); }
.stat{ background:var(--surface); padding:15px 16px; }
.stat .k{ font:600 11px/1.2 var(--mono); letter-spacing:.06em; text-transform:uppercase; color:var(--ink-3); display:flex; align-items:center; gap:7px; }
.stat .pip{ width:8px; height:8px; border-radius:50%; background:var(--slate); flex:none; }
.stat .v{ font:500 28px/1 var(--serif); margin-top:10px; letter-spacing:-.01em; }
.stat .sub{ font-size:11.5px; color:var(--ink-3); margin-top:5px; }
.stat.attn .pip{ background:var(--attn); } .stat.attn .v{ color:var(--attn); }
.stat.danger .pip{ background:var(--danger); } .stat.danger .v{ color:var(--danger); }
.stat.good .pip{ background:var(--good); } .stat.good .v{ color:var(--good); }

/* ---- sources / ledger health ---- */
.sources{ display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:10px; margin-top:12px; }
.sources-drawer summary{ cursor:pointer; color:var(--ink-2); font-weight:650; }
.sources-drawer[open] summary{ margin-bottom:12px; }
.ledger{ padding:11px 13px; background:var(--surface); border:1px solid var(--line); border-radius:10px; box-shadow:var(--shadow); }
.ledger.bad{ border-color:var(--danger-line); background:var(--danger-soft); }
.ledger .name{ font-weight:650; display:flex; align-items:center; gap:7px; }
.ledger .name .pip{ width:8px; height:8px; border-radius:50%; background:var(--good); flex:none; }
.ledger.bad .name .pip{ background:var(--danger); }
.ledger .path{ font:11.5px/1.4 var(--mono); color:var(--ink-3); word-break:break-all; margin-top:4px; }
.ledger .state{ font-size:12px; color:var(--ink-2); margin-top:5px; }
.ledger .err{ font-size:12.5px; color:var(--danger); margin-top:4px; }

/* ---- stages (collapsible compact tables) ---- */
.stage{ border:1px solid var(--line); border-radius:12px; background:var(--surface); margin:0 0 12px; box-shadow:var(--shadow); overflow:hidden; }
.stage > summary{ list-style:none; cursor:pointer; display:flex; align-items:center; gap:12px; padding:13px 16px; }
.stage > summary::-webkit-details-marker{ display:none; }
.stage .chev{ flex:none; color:var(--ink-3); transition:transform .18s ease; }
.stage[open] .chev{ transform:rotate(90deg); }
.stage .rail{ width:9px; height:9px; border-radius:50%; flex:none; background:var(--slate); }
.stage[data-rail="attn"] .rail{ background:var(--attn); }
.stage[data-rail="accent"] .rail{ background:var(--accent); }
.stage[data-rail="danger"] .rail{ background:var(--danger); }
.stage[data-rail="good"] .rail{ background:var(--good); }
.stage .title{ font:650 14.5px/1 var(--sans); }
.stage .count{ font:600 11px/1 var(--mono); color:var(--ink-3); padding:3px 8px; border:1px solid var(--line-2); border-radius:999px; }
.stage .hint{ flex:1; text-align:right; font-size:12px; color:var(--ink-3); }
.stage[data-rail="danger"] .hint{ color:var(--danger); }
.stage .body{ border-top:1px solid var(--line); }
.stagenote{ margin:0; padding:10px 16px; font-size:12.5px; display:flex; gap:8px; align-items:flex-start; background:var(--danger-soft); color:var(--danger); border-bottom:1px solid var(--danger-line); font-weight:600; }
.stagenote svg{ flex:none; margin-top:1px; }
.empty{ padding:18px 16px; color:var(--ink-3); font-style:italic; font-size:13px; }

.lane-actions{ padding:12px 16px; border-bottom:1px solid var(--line); background:var(--surface-2); }
.lane-actions .choice-row{ display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:0; }
.lane-actions .choice-row .lbl{ font:700 10px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--ink-3); margin-right:2px; }
.bulk-choice{ position:relative; display:inline-flex; align-items:center; gap:7px; padding:8px 12px; border:1px solid var(--line-2); border-radius:8px; background:var(--surface); color:var(--ink-2); cursor:pointer; font:650 12.5px/1 var(--sans); user-select:none; }
.bulk-choice input{ position:absolute; inset:0; opacity:0; cursor:pointer; margin:0; }
.bulk-choice:has(input:checked){ background:var(--accent); color:#fff; border-color:var(--accent); }
.bulk-choice.danger:has(input:checked){ background:var(--danger); border-color:var(--danger); }
.bulk-choice .queued{ display:none; }
.bulk-choice:has(input:checked) .choose{ display:none; }
.bulk-choice:has(input:checked) .queued{ display:inline; }
.choice-row:has(.bulk-choice input:checked) .bulk-choice:not(:has(input:checked)){ opacity:.45; pointer-events:none; cursor:not-allowed; filter:saturate(.35); }
.act-body:has(.row-choice input:checked) .lane-actions .bulk-choice{ opacity:.45; pointer-events:none; cursor:not-allowed; filter:saturate(.35); }
.act-body:has(.bulk-choice input:checked) .row-actions .row-choice{ opacity:.45; pointer-events:none; cursor:not-allowed; filter:saturate(.35); }
.bulk-choice:has(input:focus-visible){ outline:2px solid var(--accent); outline-offset:2px; }
@media (prefers-color-scheme: dark){ .bulk-choice:has(input:checked){ color:#0e120f; } }
.lane-copy{ color:var(--ink-3); font-size:12px; }
.review-form:has(input[name="approval:purge-candidates"][value="request:purge-candidates:review_delete_forever"]:checked) .approve-choice[data-approval-value="request:purge-candidates:review_delete_forever"],
.review-form:has(input[name="approval:needs-review"][value="decision:needs-review:trash"]:checked) .approve-choice[data-approval-value="decision:needs-review:trash"],
.review-form:has(input[name="approval:needs-context"][value="decision:needs-context:trash"]:checked) .approve-choice[data-approval-value="decision:needs-context:trash"],
.review-form:has(input[name="approval:cleanup"][value="decision:cleanup:trash"]:checked) .approve-choice[data-approval-value="decision:cleanup:trash"],
.review-form:has(input[name="approval:resolve"][value="decision:resolve:resolve"]:checked) .approve-choice[data-approval-value="decision:resolve:resolve"],
.review-form:has(input[name="approval:registry-reconcile"][value="request:registry-reconcile:check_source_problems"]:checked) .approve-choice[data-approval-value="request:registry-reconcile:check_source_problems"],
.review-form:has(input[name="approval:needs-review"][value="decision:needs-review:keep"]:checked) .bulk-choice[data-approval-value="decision:needs-review:keep"],
.review-form:has(input[name="approval:needs-review"][value="decision:needs-review:trash"]:checked) .bulk-choice[data-approval-value="decision:needs-review:trash"],
.review-form:has(input[name="approval:needs-context"][value="decision:needs-context:keep"]:checked) .bulk-choice[data-approval-value="decision:needs-context:keep"],
.review-form:has(input[name="approval:needs-context"][value="decision:needs-context:trash"]:checked) .bulk-choice[data-approval-value="decision:needs-context:trash"],
.review-form:has(input[name="approval:cleanup"][value="decision:cleanup:keep"]:checked) .bulk-choice[data-approval-value="decision:cleanup:keep"],
.review-form:has(input[name="approval:cleanup"][value="decision:cleanup:trash"]:checked) .bulk-choice[data-approval-value="decision:cleanup:trash"],
.review-form:has(input[name="approval:resolve"][value="decision:resolve:keep"]:checked) .bulk-choice[data-approval-value="decision:resolve:keep"],
.review-form:has(input[name="approval:resolve"][value="decision:resolve:resolve"]:checked) .bulk-choice[data-approval-value="decision:resolve:resolve"]{ background:var(--good-soft); color:var(--good); border-color:var(--good-line); }
.queued-list{ display:grid; gap:4px; margin:7px 0 0; padding:0; list-style:none; }
.queued-list li{ display:none; font:12px/1.35 var(--sans); color:var(--ink-2); }
.queued-empty{ display:block; font:12px/1.35 var(--sans); color:var(--ink-3); margin-top:5px; }
.review-form:has(input[name^="approval:"]:checked:not([value=""])) .queued-empty{ display:none; }
.review-form:has(input[name="approval:purge-candidates"][value="request:purge-candidates:review_delete_forever"]:checked) .queued-list li[data-approval-value="request:purge-candidates:review_delete_forever"],
.review-form:has(input[name="approval:needs-review"][value="decision:needs-review:keep"]:checked) .queued-list li[data-approval-value="decision:needs-review:keep"],
.review-form:has(input[name="approval:needs-review"][value="decision:needs-review:trash"]:checked) .queued-list li[data-approval-value="decision:needs-review:trash"],
.review-form:has(input[name="approval:needs-context"][value="decision:needs-context:keep"]:checked) .queued-list li[data-approval-value="decision:needs-context:keep"],
.review-form:has(input[name="approval:needs-context"][value="decision:needs-context:trash"]:checked) .queued-list li[data-approval-value="decision:needs-context:trash"],
.review-form:has(input[name="approval:cleanup"][value="decision:cleanup:keep"]:checked) .queued-list li[data-approval-value="decision:cleanup:keep"],
.review-form:has(input[name="approval:cleanup"][value="decision:cleanup:trash"]:checked) .queued-list li[data-approval-value="decision:cleanup:trash"],
.review-form:has(input[name="approval:resolve"][value="decision:resolve:keep"]:checked) .queued-list li[data-approval-value="decision:resolve:keep"],
.review-form:has(input[name="approval:resolve"][value="decision:resolve:resolve"]:checked) .queued-list li[data-approval-value="decision:resolve:resolve"],
.review-form:has(input[name="approval:registry-reconcile"][value="request:registry-reconcile:check_source_problems"]:checked) .queued-list li[data-approval-value="request:registry-reconcile:check_source_problems"]{ display:list-item; }
.rows{ display:grid; gap:0; }
.queue-row{ display:grid; grid-template-columns:minmax(0,1fr) minmax(150px,auto); gap:12px; padding:14px 16px; border-bottom:1px solid var(--line); background:var(--surface); }
.approval-row{ grid-template-columns:minmax(0,1fr) minmax(160px,240px); }
.queue-row:last-child{ border-bottom:0; }
.queue-row:hover{ background:var(--surface-2); }
.approval-target{ grid-column:1 / -1; margin-top:2px; padding-top:10px; border-top:1px solid var(--line); }
.approval-target summary{ cursor:pointer; font:700 10px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--ink-3); }
.approval-target code{ display:block; margin-top:7px; color:var(--ink-2); white-space:normal; overflow-wrap:anywhere; word-break:break-word; }
.row-head{ display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:4px; }
.id{ font:600 12.5px/1.3 var(--mono); white-space:nowrap; }
.id a{ text-decoration:none; } .id a:hover{ text-decoration:underline; }
.sub{ display:block; font:11.5px/1.4 var(--mono); color:var(--ink-3); white-space:normal; word-break:break-all; margin-top:3px; font-weight:400; text-transform:none; letter-spacing:0; }
.row-path{ font:11.5px/1.45 var(--mono); color:var(--ink-3); word-break:break-all; margin:0 0 6px; }
.row-summary{ color:var(--ink-2); font-size:13px; line-height:1.45; margin:0; max-width:76ch; }
.row-summary strong{ color:var(--ink); font-weight:650; }
.row-meta{ display:flex; flex-wrap:wrap; gap:6px 12px; margin-top:8px; font:11.5px/1.35 var(--mono); color:var(--ink-3); }
.reason{ color:var(--ink); }
.row-side{ display:flex; flex-direction:column; align-items:flex-end; gap:7px; text-align:right; }
.row-actions{ display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px; margin-top:2px; }
.row-choice{ position:relative; display:inline-flex; align-items:center; gap:6px; padding:6px 9px; border:1px solid var(--line-2); border-radius:8px; background:var(--surface); color:var(--ink-2); cursor:pointer; font:650 12px/1 var(--sans); user-select:none; }
.row-choice input{ position:absolute; inset:0; opacity:0; cursor:pointer; margin:0; }
.row-choice .queued{ display:none; }
.row-choice:has(input:checked){ background:var(--good-soft); color:var(--good); border-color:var(--good-line); }
.row-choice.danger:has(input:checked){ background:var(--danger-soft); color:var(--danger); border-color:var(--danger-line); }
.row-choice:has(input:checked) .choose{ display:none; }
.row-choice:has(input:checked) .queued{ display:inline; }
.row-actions:has(.row-choice input:checked) .row-choice:not(:has(input:checked)){ opacity:.45; pointer-events:none; cursor:not-allowed; filter:saturate(.35); }
.row-choice:has(input:focus-visible){ outline:2px solid var(--accent); outline-offset:2px; }
.src{ font:600 11.5px/1 var(--mono); color:var(--ink-2); white-space:nowrap; }
.age{ white-space:nowrap; color:var(--ink-2); font-variant-numeric:tabular-nums; }
.age .due{ display:block; font-size:11px; margin-top:2px; }
.due.over{ color:var(--danger); font-weight:600; } .due.soon{ color:var(--attn); font-weight:600; }
.badge{ display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border-radius:999px; font:600 11px/1.3 var(--sans); border:1px solid var(--line-2); background:var(--surface-2); color:var(--ink-2); white-space:nowrap; }
.badge.rec{ background:var(--accent-soft); border-color:transparent; color:var(--accent-ink); }
.badge.ctx{ background:var(--attn-soft); border-color:var(--attn-line); color:var(--attn); }
.badge.peril{ background:var(--danger-soft); border-color:var(--danger-line); color:var(--danger); }
.lastact{ display:block; font-size:11.5px; color:var(--ink-3); margin-top:5px; }
.legend{ margin-top:28px; padding-top:18px; border-top:1px solid var(--line); display:flex; flex-wrap:wrap; gap:16px; font-size:12px; color:var(--ink-3); }
.legend span{ display:inline-flex; align-items:center; gap:6px; }
.legend .pip{ width:8px; height:8px; border-radius:50%; }

/* ---- session activity ---- */
.session-activity{ background:var(--surface); border:1px solid var(--line); border-radius:14px; box-shadow:var(--shadow); padding:16px 18px; flex:1; min-height:0; overflow:auto; }
.session-head{ display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; justify-content:space-between; margin-bottom:10px; }
.session-head .title{ font:650 15px/1.2 var(--sans); }
.session-confirm{ margin:0; padding:10px 12px; border:1px solid var(--good-line); background:var(--good-soft); color:var(--good); border-radius:9px; font-weight:700; }
.activity-stats{ display:flex; flex-wrap:wrap; gap:8px; margin:0 0 10px; }
.activity-chip{ display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line-2); background:var(--surface-2); border-radius:999px; padding:5px 9px; font:650 12px/1.2 var(--sans); color:var(--ink-2); }
.activity-chip.warn{ color:var(--attn); border-color:var(--attn-line); background:var(--attn-soft); }
.activity-chip.good{ color:var(--good); border-color:var(--good-line); background:var(--good-soft); }
.activity-chip.bad{ color:var(--danger); border-color:var(--danger-line); background:var(--danger-soft); }
.safety-line{ margin:8px 0 0; font-weight:700; color:var(--accent-ink); font-size:13px; }
.activity-list{ display:grid; gap:8px; margin-top:12px; }
.activity-card{ border:1px solid var(--line); background:var(--raise); border-radius:10px; padding:11px 12px; }
.activity-card.good{ border-color:var(--good-line); background:var(--good-soft); }
.activity-card.warn{ border-color:var(--attn-line); background:var(--attn-soft); }
.activity-card.bad{ border-color:var(--danger-line); background:var(--danger-soft); }
.activity-card .topline{ display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:5px; }
.activity-card .name{ font-weight:700; }
.activity-card .detail{ margin:0; color:var(--ink-2); font-size:12.5px; }
.activity-card .mono{ font-family:var(--mono); font-size:12px; color:var(--ink-2); word-break:break-all; }
.activity-actions{ display:flex; flex-wrap:wrap; gap:6px; margin-top:9px; }
.unqueue-btn{ border:1px solid var(--attn-line); background:var(--surface); color:var(--attn); border-radius:8px; padding:6px 9px; font:700 12px/1 var(--sans); cursor:pointer; }
.unqueue-btn:hover{ border-color:var(--attn); background:var(--attn-soft); }
.reply-card{ margin-top:8px; padding:9px 10px; border:1px solid var(--good-line); background:var(--good-soft); border-radius:9px; }
.reply-card.final{ border-color:var(--accent); background:var(--accent-soft); }
.reply-card.bad{ border-color:var(--danger-line); background:var(--danger-soft); }
.reply-card .kind{ font:700 10px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--ink-3); margin-bottom:5px; }
.reply-card .headline{ font-weight:750; margin-bottom:5px; }
.reply-card dl{ display:grid; grid-template-columns:max-content minmax(0,1fr); gap:4px 10px; margin:6px 0 0; font-size:12.5px; }
.reply-card dt{ font:700 10px/1 var(--mono); letter-spacing:.06em; text-transform:uppercase; color:var(--ink-3); }
.reply-card dd{ margin:0; word-break:break-word; }
.receipt-list{ display:grid; gap:7px; margin-top:8px; }
.receipt-row{ border:1px solid var(--line-2); background:color-mix(in srgb,var(--raise) 72%, transparent); border-radius:8px; padding:8px 9px; }
.receipt-row.good{ border-color:var(--good-line); }
.receipt-row.warn{ border-color:var(--attn-line); }
.receipt-row.bad{ border-color:var(--danger-line); }
.receipt-topline{ display:flex; flex-wrap:wrap; gap:7px; align-items:center; margin-bottom:4px; }
.receipt-topline .name{ font-weight:700; min-width:0; overflow-wrap:anywhere; }

/* ---- detail drawer ---- */
.rec-head{ display:flex; flex-wrap:wrap; align-items:center; gap:10px 12px; }
.rec-head .brand{ margin:0; }
.rec-id{ font:600 25px/1 var(--mono); margin:0; letter-spacing:-.01em; }
.rec-reason{ font:400 18px/1.45 var(--serif); color:var(--ink); margin:14px 0 0; max-width:64ch; }
.detail{ display:grid; grid-template-columns:1fr; gap:18px; padding-top:28px; }
.cols{ display:grid; grid-template-columns:1.15fr .85fr; gap:18px; align-items:start; }
.panel{ background:var(--surface); border:1px solid var(--line); border-radius:14px; box-shadow:var(--shadow); padding:18px 20px; }
.facts{ display:grid; grid-template-columns:1fr 1fr; gap:0 26px; }
.facts .grp{ grid-column:1 / -1; font:600 10px/1 var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--accent); margin:16px 0 8px; padding-bottom:6px; border-bottom:1px solid var(--line); }
.facts .grp:first-of-type{ margin-top:0; }
.facts .f{ padding:7px 0; border-bottom:1px solid var(--line); }
.facts .f.wide{ grid-column:1 / -1; }
.facts dt{ font:600 10.5px/1 var(--mono); letter-spacing:.04em; text-transform:uppercase; color:var(--ink-3); margin-bottom:4px; }
.facts dd{ margin:0; font-size:13.5px; word-break:break-word; }
.facts dd.mono{ font-family:var(--mono); font-size:12.5px; color:var(--ink-2); }
.decide{ border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft), var(--shadow); position:sticky; top:18px; }
.decide .lead{ font-size:13px; color:var(--ink-2); margin:0 0 14px; }
.flabel{ font:600 10px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--ink-3); display:block; margin:0 0 7px; }
.decide textarea{ width:100%; font:14px/1.5 var(--sans); padding:10px 12px; border:1px solid var(--line-2); border-radius:9px; resize:vertical; background:var(--raise); color:inherit; min-height:60px; }
.decide textarea:focus{ outline:2px solid var(--accent); outline-offset:1px; border-color:var(--accent); }
.dbtns{ display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:12px 0 0; }
.btn{ font:650 13.5px/1 var(--sans); padding:11px 14px; border-radius:9px; border:1px solid transparent; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; gap:7px; }
.btn.keep{ background:var(--good-soft); color:var(--good); border-color:var(--good-line); }
.btn.trash{ background:var(--accent); color:#fff; }
.btn.resolve,.btn.defer{ background:var(--surface-2); color:var(--ink); border-color:var(--line-2); }
@media (prefers-color-scheme: dark){ .btn.trash{ color:#0e120f; } }
.secondary{ margin-top:14px; padding-top:14px; border-top:1px dashed var(--line-2); }
.secondary form{ display:inline; }
.btn.ghost{ background:transparent; border:1px solid var(--line-2); color:var(--ink-2); font-weight:600; padding:8px 12px; font-size:12.5px; margin:0 8px 8px 0; }
.btn.ghost:hover{ border-color:var(--accent); color:var(--accent-ink); }
.secondary .cmt{ margin-top:10px; }

/* timeline + audit */
.timeline{ list-style:none; margin:0; padding:0; position:relative; }
.timeline::before{ content:""; position:absolute; left:6px; top:6px; bottom:6px; width:2px; background:var(--line); }
.tl{ position:relative; padding:0 0 16px 26px; }
.tl:last-child{ padding-bottom:0; }
.tl::before{ content:""; position:absolute; left:0; top:4px; width:14px; height:14px; border-radius:50%; background:var(--surface); border:2px solid var(--accent); }
.tl.agent::before{ border-color:var(--good); }
.tl .head{ display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; }
.tl .who{ font-weight:650; font-size:13.5px; }
.tl .when{ font:11.5px/1 var(--mono); color:var(--ink-3); }
.tl .note{ margin:5px 0 0; font-size:13.5px; color:var(--ink-2); }
.tl .replies{ list-style:none; margin:8px 0 0; padding:0; }
.tl .replies li{ font-size:12.5px; color:var(--ink-2); padding:3px 0; }
.audit{ list-style:none; margin:0; padding:0; }
.audit li{ padding:9px 0; border-bottom:1px solid var(--line); font-size:13px; }
.audit li:last-child{ border-bottom:0; }
.audit .k{ font:600 11px/1 var(--mono); text-transform:uppercase; letter-spacing:.04em; color:var(--accent-ink); }

/* ---- approval workbench ---- */
.notebox{ display:flex; align-items:flex-start; gap:10px; padding:12px 15px; border-radius:11px; font-size:13px; margin:18px 0 0; }
.notebox svg{ flex:none; margin-top:1px; }
.notebox.guardn{ background:var(--surface); border:1px solid var(--line); color:var(--ink-2); }
.notebox.guardn svg{ color:var(--accent); }
.notebox.periln{ background:var(--danger-soft); border:1px solid var(--danger-line); color:var(--danger); font-weight:600; }
.approval-group{ margin-top:14px; }
.approval-group > h2{ display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; font:650 15px/1.2 var(--sans); margin:0 0 10px; }
.approval-group > h2 .muted{ font:12px/1 var(--mono); font-weight:400; }
.candidate{ background:var(--surface); border:1px solid var(--line); border-left:4px solid var(--line-2); border-radius:12px; padding:14px 16px; margin:0 0 10px; box-shadow:var(--shadow); transition:border-color .12s, background .12s; }
.candidate.selected{ border-left-color:var(--accent); }
.candidate.unselected{ opacity:.62; }
.candidate-head{ display:flex; flex-wrap:wrap; gap:10px; align-items:center; cursor:pointer; font-weight:650; }
.candidate-head input{ width:19px; height:19px; accent-color:var(--accent); flex:none; cursor:pointer; }
.candidate-label{ flex:1; min-width:0; }
.candidate .sel{ font:600 10px/1 var(--mono); letter-spacing:.06em; text-transform:uppercase; padding:3px 8px; border-radius:999px; background:var(--surface-2); color:var(--ink-3); border:1px solid var(--line-2); }
.candidate.selected .sel{ background:var(--accent-soft); color:var(--accent-ink); border-color:transparent; }
.candidate dl.fields{ display:flex; flex-wrap:wrap; gap:4px 22px; margin:9px 0 0; }
.candidate dl.fields div{ font-size:12.5px; }
.candidate dl.fields dt{ font:600 10px/1 var(--mono); letter-spacing:.04em; text-transform:uppercase; color:var(--ink-3); display:inline; }
.candidate dl.fields dd{ display:inline; margin:0 0 0 6px; font-family:var(--mono); font-size:12px; color:var(--ink-2); }
.approve-actions{ position:sticky; bottom:0; margin:14px -24px -72px; padding:14px 24px; background:var(--surface); border-top:1px solid var(--line-2); box-shadow:0 -8px 24px -16px rgba(0,0,0,.4); display:flex; flex-wrap:wrap; align-items:center; gap:14px; }
.approve-actions .tally{ font-size:13px; color:var(--ink-2); flex:1; }
.approve-actions button{ font:650 14px/1 var(--sans); padding:13px 20px; border-radius:10px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; display:inline-flex; align-items:center; gap:8px; }
.approve-actions button:hover{ filter:brightness(1.05); }
.approve-actions button[disabled]{ background:var(--surface-2); border-color:var(--line-2); color:var(--ink-3); cursor:not-allowed; filter:none; }
@media (prefers-color-scheme: dark){ .approve-actions button{ color:#0e120f; } .approve-actions button[disabled]{ color:var(--ink-3); } }
.approve-empty{ font-size:13px; color:var(--attn); font-weight:600; display:inline-flex; align-items:center; gap:8px; }

/* ---- error ---- */
.errwrap{ max-width:620px; margin:0 auto; padding:64px 24px; }
.errwrap h1{ font:500 26px/1.2 var(--serif); margin:0 0 12px; }

@media (max-width: 560px){
  header.top h1{ font-size:25px; }
  .wrap{ padding:0 16px 56px; }
  .cols{ grid-template-columns:1fr; }
  .facts{ grid-template-columns:1fr; }
  .decide{ position:static; }
  .stage .hint{ display:none; }
  .queue-row{ grid-template-columns:1fr; }
  .approval-row{ grid-template-columns:1fr; }
  .row-side{ align-items:flex-start; text-align:left; }
  .dbtns{ grid-template-columns:1fr; }
  .approve-actions{ margin-left:-16px; margin-right:-16px; padding-left:16px; padding-right:16px; }
}
`;

const REVIEW_SURFACE_NOTE =
  "Read-only review surface. Shows metadata only - never file contents - and mutates no ledger, file, trash, or plan. Open a record to queue a triage intent for the agent.";

const APPROVAL_SURFACE_NOTE =
  "Approving records a reviewed bundle for the agent to revalidate before execution - it is an approval record, not execution, and mutates no ledger, file, trash, or plan by itself. Deselect any row you are not approving.";

// One-way-door safety copy for the purge lane (NGX-541). Purge permanently deletes the trashed
// artifact with no recovery path, so the lane states the irreversibility up front, makes clear
// nothing is preselected, and that an exact, grouped approval is required before the agent purges.
const PURGE_LANE_NOTE =
  "Purge is a one-way door: it permanently deletes these trashed artifacts and there is no recovery path. Nothing here is selected by default - the agent purges only an exact, grouped selection you approve.";

// One-way-door safety copy for the approval flow (NGX-541). The contract requires the no-recovery
// warning in the lane AND the approval flow: the workbench is the last point before the human commits
// an irreversible selection, so a purge bundle restates the irreversibility right at the moment of
// approval. Only the one-way-door purge action carries this; reversible trash/dispose bundles do not.
const PURGE_APPROVAL_NOTE =
  "Purge is a one-way door: approving this bundle lets the agent permanently delete the exact targets you select below, with no recovery path. Approve only the targets you intend to destroy.";

// Inline SVG icons. The CSP forbids <img>/external assets, but inline SVG markup is not a fetched
// resource, so these render under default-src 'none'. Kept tiny and stroke-based to match the type.
const ICON = {
  shield: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 3v5c0 4.5-3 7.5-8 10-5-2.5-8-5.5-8-10V6z"/></svg>`,
  alert: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3l10 17H2z"/><path d="M12 10v4"/><circle cx="12" cy="17.5" r=".6" fill="currentColor"/></svg>`,
  arrow: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  chevron: `<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6"/></svg>`,
  back: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>`,
  trash: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>`,
  info: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16v.01"/></svg>`,
  check: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20 6L9 17l-5-5"/></svg>`
};

// Lane metadata: the hyphenated key doubles as the machine-precise label and the #lane-<key> anchor
// target the required-action CTAs jump to. The zone groups lanes for the scriptless filter; the rail
// is the lane's semantic colour. Order is the review -> quarantine -> problems -> done workflow flow.
type LaneMeta = { title: string; zone: string; rail: string; hint: string };
const LANES: Record<DashboardBucketKey, LaneMeta> = {
  "needs-review": { title: "Needs a decision", zone: "action", rail: "attn", hint: "waiting for your choice" },
  "needs-context": { title: "Needs details", zone: "action", rail: "attn", hint: "blocked until context is clearer" },
  cleanup: { title: "Ready to clean up", zone: "action", rail: "accent", hint: "prepare a plan first" },
  resolve: { title: "Missing files", zone: "action", rail: "accent", hint: "check before closing records" },
  trash: { title: "In trash", zone: "quarantine", rail: "slate", hint: "quarantined and still reversible" },
  "purge-candidates": { title: "Can delete forever", zone: "quarantine", rail: "danger", hint: "final review required" },
  "registry-reconcile": { title: "Source problems", zone: "problems", rail: "attn", hint: "source or path attention" },
  "recent-receipts": { title: "Recent receipts", zone: "done", rail: "good", hint: "verified - last 7 days" }
};

export type DashboardSessionActivityRender = {
  history?: UiSessionHistoryEntry[];
  submittedCount?: number | null;
  activityHref?: string;
  scriptNonce?: string;
  includeScript?: boolean;
  reviewablePreparedPlanEventIds?: Set<string>;
};

export function renderDashboardPage(snapshot: DashboardSnapshot, token?: string, activity: DashboardSessionActivityRender = {}): string {
  const counts = snapshot.counts;
  const ledgers = snapshot.ledgers;
  const okLedgers = ledgers.filter((ledger) => ledger.ok).length;
  const badLedgers = ledgers.length - okLedgers;
  const ledgerIndex = new Map(ledgers.map((ledger, i) => [ledger.path, i]));
  const history = activity.history ?? [];
  const rowActivity = recordActivityIndex(history);
  const preparedPlans = livePreparedPlanIndex(preparedPlanIndex(history, activity.reviewablePreparedPlanEventIds), snapshot);
  const visibleRows = visibleRequiredActionRows(snapshot, preparedPlans);
  const pendingActions = pendingActionIndex(history, visibleRows);

  const actionCount = visibleRows.needsReview.length + visibleRows.needsContext.length + visibleRows.cleanup.length + visibleRows.resolve.length + preparedPlans.size;
  const problemsCount = counts["registry-reconcile"] + badLedgers;
  const doneCount = counts["recent-receipts"];
  const queuedItems = queuedApprovalItems(snapshot, badLedgers, visibleRows, preparedPlans, pendingActions);
  const hasCancelableItems = hasCancelableQueuedItems(history);
  const submittedConfirmation = dashboardSubmittedConfirmation(activity.submittedCount ?? null);
  const activityOptions: { activityHref?: string; scriptNonce?: string; includeScript?: boolean } = {};
  if (activity.activityHref !== undefined) activityOptions.activityHref = activity.activityHref;
  if (activity.scriptNonce !== undefined) activityOptions.scriptNonce = activity.scriptNonce;
  if (activity.includeScript !== undefined) activityOptions.includeScript = activity.includeScript;
  const mainSurface = `${requiredActionsSection(snapshot, badLedgers, token, ledgerIndex, rowActivity, pendingActions, preparedPlans, visibleRows)}
${statusSummarySection({ actionCount, trash: counts.trash, purge: counts["purge-candidates"], problems: problemsCount, done: doneCount, ledgers: okLedgers, ledgerTotal: ledgers.length })}
${ledgerHealthSection(ledgers)}
${activitySection(snapshot, token, ledgerIndex)}`;
  const masthead = `<header class="top">
<div class="wrap">
<div class="brand"><span class="dot"></span>Artshelf &middot; Human Review</div>
<h1>Review dashboard</h1>
<div class="meta"><span><b>${ledgers.length}</b> ledger(s) &middot; <b>${okLedgers}</b> healthy</span><span>generated <b>${escapeHtml(snapshot.generatedAt)}</b></span><span>registry <b>${escapeHtml(snapshot.registryPath)}</b></span></div>
<div class="guard">${ICON.shield}<span>${escapeHtml(REVIEW_SURFACE_NOTE)}</span></div>
</div>
</header>`;
  const agentRail = `<aside class="agent-rail" aria-label="Agent loop">
<div class="agent-rail-inner"><div class="agent-rail-title"><span>Agent loop</span><span>poll, queue, reply</span></div>${token && queuedItems.length > 0 ? globalSubmitBar(queuedItems) : ""}${submittedConfirmation}${renderDashboardActivityFragment(history, activityOptions)}</div>
</aside>`;
  const dashboard = `<main class="review-main">${masthead}<div class="wrap">${mainSurface}</div></main>${agentRail}`;

  const reviewSurface = token && (queuedItems.length > 0 || hasCancelableItems)
    ? `<form class="review-form review-shell" method="post" action="/intents"><input type="hidden" name="type" value="required_actions_submitted"><input type="hidden" name="token" value="${escapeHtml(token)}">${dashboard}</form>`
    : `<div class="review-shell">${dashboard}</div>`;

  const body = reviewSurface;
  return page("Artshelf review dashboard", body);
}

function dashboardSubmittedConfirmation(submittedCount: number | null): string {
  return submittedCount && submittedCount > 0 ? `<p class="session-confirm">${submittedCount} decisions queued for agent</p>` : "";
}

// The top fold: priority-ordered cards for the lanes that need the human now. Cards stay intentionally
// terse: count, label, and action controls. Buttons only submit browser intents for the agent to poll;
// they never execute cleanup, resolve, purge, or registry changes from the browser. When nothing needs
// attention it is an explicit all-clear, never blank.
function requiredActionsSection(
  snapshot: DashboardSnapshot,
  badLedgers: number,
  token: string | undefined,
  ledgerIndex: Map<string, number>,
  rowActivity: Map<string, UiSessionHistoryEntry>,
  pendingActions: PendingActionIndex,
  preparedPlans: Map<string, PreparedPlanApproval>,
  visibleRows: RequiredActionRows
): string {
  const counts = snapshot.counts;
  const cards: string[] = [];
  if (preparedPlans.size > 0) {
    cards.push(preparedPlanApprovalCard([...preparedPlans.values()], ledgerIndex));
  }
  if (counts["purge-candidates"] > 0) {
    cards.push(
      actionCard(
        "danger",
        "purge-candidates",
        counts["purge-candidates"],
        "Can delete forever",
        "Prepare delete review",
        "before anything is purged.",
        token ? approvalChoice("request", "purge-candidates", "review_delete_forever", "Approve", isLaneRequestQueued(pendingActions, "purge-candidates", "review_delete_forever")) : "",
        purgeActionBody(snapshot.buckets.purgeCandidates, ledgerIndex)
      )
    );
  }
  if (visibleRows.needsReview.length > 0) {
    const trashState = laneDecisionChoiceState(pendingActions, "needs-review", visibleRows.needsReview, "trash");
    cards.push(
      actionCard(
        "attn",
        "needs-review",
        visibleRows.needsReview.length,
        "Needs a decision",
        "Move to trash",
        "unless a row looks worth keeping.",
        token ? approvalChoice("decision", "needs-review", "trash", "Approve", trashState.submitted, trashState.disabled) : "",
        artifactActionBody("needs-review", visibleRows.needsReview, token, ledgerIndex, rowActivity, pendingActions)
      )
    );
  }
  if (visibleRows.needsContext.length > 0) {
    const trashState = laneDecisionChoiceState(pendingActions, "needs-context", visibleRows.needsContext, "trash");
    cards.push(
      actionCard(
        "attn",
        "needs-context",
        visibleRows.needsContext.length,
        "Needs details",
        "Move to trash",
        "unless missing context changes the decision.",
        token ? approvalChoice("decision", "needs-context", "trash", "Approve", trashState.submitted, trashState.disabled) : "",
        artifactActionBody("needs-context", visibleRows.needsContext, token, ledgerIndex, rowActivity, pendingActions)
      )
    );
  }
  if (visibleRows.cleanup.length > 0) {
    const trashState = laneDecisionChoiceState(pendingActions, "cleanup", visibleRows.cleanup, "trash");
    cards.push(
      actionCard(
        "calm",
        "cleanup",
        visibleRows.cleanup.length,
        "Ready to clean up",
        "Move to trash",
        "because they are due and appear unused.",
        token ? approvalChoice("decision", "cleanup", "trash", "Approve", trashState.submitted, trashState.disabled) : "",
        artifactActionBody("cleanup", visibleRows.cleanup, token, ledgerIndex, rowActivity, pendingActions)
      )
    );
  }
  if (visibleRows.resolve.length > 0) {
    const resolveState = laneDecisionChoiceState(pendingActions, "resolve", visibleRows.resolve, "resolve");
    cards.push(
      actionCard(
        "calm",
        "resolve",
        visibleRows.resolve.length,
        "Missing files",
        "Resolve records",
        "because their files are already gone.",
        token ? approvalChoice("decision", "resolve", "resolve", "Approve", resolveState.submitted, resolveState.disabled) : "",
        artifactActionBody("resolve", visibleRows.resolve, token, ledgerIndex, rowActivity, pendingActions)
      )
    );
  }
  const problems = counts["registry-reconcile"] + badLedgers;
  if (problems > 0) {
    cards.push(
      actionCard(
        "attn",
        "registry-reconcile",
        problems,
        "Source problems",
        "Check sources",
        "before cleanup decisions.",
        token ? approvalChoice("request", "registry-reconcile", "check_source_problems", "Approve", isLaneRequestQueued(pendingActions, "registry-reconcile", "check_source_problems")) : "",
        problemActionBody(snapshot.buckets.registryReconcile, ledgerIndex)
      )
    );
  }

  const inner =
    cards.length === 0
      ? `<div class="allclear">${ICON.check}<span>You're all caught up - nothing needs review right now.</span></div>`
      : `<div class="acts">${cards.join("")}</div>`;
  return `<section class="block" id="required-actions">${reviewedLaneInputs(visibleRows)}<p class="eyebrow">Required actions &middot; in priority order</p>${inner}</section>`;
}

function actionCard(
  variant: string,
  key: DashboardBucketKey,
  count: number,
  name: string,
  recommendation: string,
  detail: string,
  control: string,
  body: string
): string {
  const lane = LANES[key];
  return `<details class="act ${variant}" id="lane-${key}" data-zone="${lane.zone}" data-rail="${lane.rail}">
<summary>
<span class="toggle-copy">${ICON.chevron}</span>
<div class="n num">${count}</div>
<div class="act-main"><p class="name">${escapeHtml(name)}</p>
<p class="rec"><span class="rec-label">Agent recommends</span> <span class="rec-action">${escapeHtml(recommendation)}</span> ${escapeHtml(detail)}</p></div>
${control || ""}
</summary>
<div class="act-body">${body}</div>
</details>`;
}

function approvalChoice(kind: "decision" | "request", lane: DashboardBucketKey, action: string, label: string, submitted = false, disabled = false): string {
  const value = `${kind}:${lane}:${action}`;
  const stateClass = submitted ? " submitted" : disabled ? " disabled" : "";
  const stateAttrs = submitted ? " checked disabled" : disabled ? " disabled" : "";
  return `<div class="act-actions"><label class="approve-choice${stateClass}" data-approval-value="${escapeHtml(value)}"><input type="checkbox" name="${escapeHtml(approvalFieldName(lane))}" value="${escapeHtml(value)}"${stateAttrs}><span class="approve">${escapeHtml(label)}</span><span class="queued">Queued</span></label></div>`;
}

type PreparedPlanApproval = {
  eventId: string;
  recordId: string;
  ledgerPath: string;
  ledgerName: string;
  lane: string;
  planId: string;
  action: string;
  actionLabel: string;
  approvalTarget: string;
  submitted: boolean;
};

function preparedPlanApprovalCard(plans: PreparedPlanApproval[], ledgerIndex: Map<string, number>): string {
  const rows = plans.map((plan) => preparedPlanRow(plan, ledgerIndex)).join("");
  const allSubmitted = plans.every((plan) => plan.submitted);
  return `<details class="act attn" id="lane-ready-approval" data-zone="action" data-rail="attn" open>
<summary>
<span class="toggle-copy">${ICON.chevron}</span>
<div class="n num">${plans.length}</div>
<div class="act-main"><p class="name">Ready for approval</p>
<p class="rec"><span class="rec-label">Agent prepared</span> <span class="rec-action">Approve execution</span> after reviewing the exact plan target.</p></div>
<div class="act-actions"><label class="approve-choice${allSubmitted ? " submitted" : ""}" data-approval-value="approve-plan:all"><input type="checkbox" name="approval:ready-approval" value="approve-plan:all"${allSubmitted ? " checked disabled" : ""}><span class="approve">Approve all</span><span class="queued">Queued</span></label></div>
</summary>
<div class="act-body"><div class="rows">${rows}</div></div>
</details>`;
}

function preparedPlanRow(plan: PreparedPlanApproval, ledgerIndex: Map<string, number>): string {
  const approvalValue = `approve-plan:${encodeURIComponent(plan.eventId)}`;
  const submitted = plan.submitted;
  return `<article class="queue-row r approval-row"${dataLedger(plan.ledgerPath, ledgerIndex)}>
<div>
<div class="row-head"><span class="id">${escapeHtml(plan.recordId)}</span><span class="badge ctx">Ready for approval</span></div>
<p class="row-summary"><strong>${escapeHtml(plan.actionLabel)}.</strong> Agent prepared a reviewed plan; approve only if this exact target is correct.</p>
<div class="row-meta"><span>lane ${escapeHtml(plan.lane)}</span><span>plan ${escapeHtml(plan.planId)}</span></div>
</div>
<div class="row-side">
<span class="src">${escapeHtml(plan.ledgerName)}</span>
<span class="badge">Plan prepared</span>
<label class="row-choice${submitted ? " submitted" : ""}" data-approval-value="${escapeHtml(approvalValue)}"><input type="checkbox" name="approval:ready-approval" value="${escapeHtml(approvalValue)}"${submitted ? " checked disabled" : ""}><span class="choose">Approve</span><span class="queued">Queued</span></label>
</div>
<details class="approval-target">
<summary>Approval target</summary>
<code>${escapeHtml(plan.approvalTarget)}</code>
</details>
</article>`;
}

type QueuedApprovalItem = { value: string; label: string; submittable: boolean };

type RequiredActionRows = {
  needsReview: DashboardArtifactRow[];
  needsContext: DashboardArtifactRow[];
  cleanup: DashboardArtifactRow[];
  resolve: DashboardArtifactRow[];
};

function queuedApprovalItems(
  snapshot: DashboardSnapshot,
  badLedgers: number,
  rows: RequiredActionRows,
  preparedPlans: Map<string, PreparedPlanApproval>,
  pendingActions: PendingActionIndex
): QueuedApprovalItem[] {
  const counts = snapshot.counts;
  const items: QueuedApprovalItem[] = [];
  if (preparedPlans.size > 0) {
    items.push({
      value: "approve-plan:all",
      label: `Approve all ${preparedPlans.size} prepared plan(s)`,
      submittable: [...preparedPlans.values()].some((plan) => !plan.submitted)
    });
  }
  for (const plan of preparedPlans.values()) {
    items.push({
      value: `approve-plan:${encodeURIComponent(plan.eventId)}`,
      label: `Approve ${plan.recordId} plan ${plan.planId}`,
      submittable: !plan.submitted
    });
  }
  if (counts["purge-candidates"] > 0) {
    items.push({
      value: "request:purge-candidates:review_delete_forever",
      label: `Prepare delete review for ${counts["purge-candidates"]} row(s)`,
      submittable: !isLaneRequestQueued(pendingActions, "purge-candidates", "review_delete_forever")
    });
  }
  addDecisionQueuedItems(items, "needs-review", rows.needsReview, "needs a decision", pendingActions);
  addRowDecisionQueuedItems(items, "needs-review", rows.needsReview, "needs a decision", pendingActions);
  addDecisionQueuedItems(items, "needs-context", rows.needsContext, "needs details", pendingActions);
  addRowDecisionQueuedItems(items, "needs-context", rows.needsContext, "needs details", pendingActions);
  addDecisionQueuedItems(items, "cleanup", rows.cleanup, "ready to clean up", pendingActions);
  addRowDecisionQueuedItems(items, "cleanup", rows.cleanup, "ready to clean up", pendingActions);
  if (rows.resolve.length > 0) {
    const submittable = areBulkChoicesSubmittable(pendingActions, "resolve", rows.resolve);
    items.push({ value: "decision:resolve:keep", label: `Keep ${rows.resolve.length} missing file row(s)`, submittable });
    items.push({ value: "decision:resolve:resolve", label: `Resolve ${rows.resolve.length} missing file row(s)`, submittable });
  }
  addResolveRowQueuedItems(items, rows.resolve, pendingActions);
  const problems = counts["registry-reconcile"] + badLedgers;
  if (problems > 0) {
    items.push({
      value: "request:registry-reconcile:check_source_problems",
      label: `Check ${problems} source problem(s)`,
      submittable: !isLaneRequestQueued(pendingActions, "registry-reconcile", "check_source_problems")
    });
  }
  return items;
}

function addDecisionQueuedItems(
  items: QueuedApprovalItem[],
  lane: "needs-review" | "needs-context" | "cleanup",
  rows: DashboardArtifactRow[],
  label: string,
  pendingActions: PendingActionIndex
): void {
  if (rows.length === 0) return;
  const submittable = areBulkChoicesSubmittable(pendingActions, lane, rows);
  items.push({ value: `decision:${lane}:keep`, label: `Keep ${rows.length} ${label} row(s)`, submittable });
  items.push({ value: `decision:${lane}:trash`, label: `Trash ${rows.length} ${label} row(s)`, submittable });
}

function addRowDecisionQueuedItems(
  items: QueuedApprovalItem[],
  lane: "needs-review" | "needs-context" | "cleanup",
  rows: DashboardArtifactRow[],
  label: string,
  pendingActions: PendingActionIndex
): void {
  for (const row of rows) {
    const submittable = queuedRowDecision(pendingActions, lane, row) === null;
    items.push({ value: rowDecisionValue(lane, row, "keep"), label: `Keep ${row.recordId} (${label})`, submittable });
    items.push({ value: rowDecisionValue(lane, row, "trash"), label: `Trash ${row.recordId} (${label})`, submittable });
  }
}

function addResolveRowQueuedItems(items: QueuedApprovalItem[], rows: DashboardArtifactRow[], pendingActions: PendingActionIndex): void {
  for (const row of rows) {
    const submittable = queuedRowDecision(pendingActions, "resolve", row) === null;
    items.push({ value: rowDecisionValue("resolve", row, "keep"), label: `Keep ${row.recordId} (missing file)`, submittable });
    items.push({ value: rowDecisionValue("resolve", row, "resolve"), label: `Resolve ${row.recordId} (missing file)`, submittable });
  }
}

function globalSubmitBar(items: QueuedApprovalItem[]): string {
  const list = items
    .map((item) => `<li data-approval-value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</li>`)
    .join("");
  const style = queuedApprovalVisibilityStyles(items);
  const disabled = items.some((item) => item.submittable) ? "" : " disabled";
  return `${style}<div class="required-submit"><div><span class="copy">Queued for agent</span><span class="queued-empty">Nothing selected yet.</span><ul class="queued-list">${list}</ul></div><button type="submit"${disabled}>Submit selected to agent</button></div>`;
}

function queuedApprovalVisibilityStyles(items: QueuedApprovalItem[]): string {
  const rules = items
    .map((item) => {
      const value = escapeCssString(item.value);
      return `.review-form:has(input[name^="approval:"][value="${value}"]:checked) .queued-list li[data-approval-value="${value}"]{display:list-item;}`;
    })
    .join("");
  return rules ? `<style>${rules}</style>` : "";
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function approvalFieldName(lane: DashboardBucketKey): string {
  return `approval:${lane}`;
}

function reviewedLaneInputs(rows: RequiredActionRows): string {
  return [
    reviewedArtifactLaneInputs("needs-review", rows.needsReview),
    reviewedArtifactLaneInputs("needs-context", rows.needsContext),
    reviewedArtifactLaneInputs("cleanup", rows.cleanup),
    reviewedArtifactLaneInputs("resolve", rows.resolve)
  ].join("");
}

function reviewedArtifactLaneInputs(
  lane: "needs-review" | "needs-context" | "cleanup" | "resolve",
  rows: DashboardArtifactRow[]
): string {
  return rows
    .map(
      (row) =>
        `<input type="hidden" name="${escapeHtml(reviewedLaneFieldName(lane))}" value="${escapeHtml(reviewedLaneRowValue(row))}">`
    )
    .join("");
}

function reviewedLaneFieldName(lane: "needs-review" | "needs-context" | "cleanup" | "resolve"): string {
  return `reviewed:${lane}`;
}

function reviewedLaneRowValue(row: DashboardArtifactRow): string {
  return `${encodeURIComponent(row.recordId)}:${encodeURIComponent(row.ledgerPath ?? "")}`;
}

function statusSummarySection(s: {
  actionCount: number;
  trash: number;
  purge: number;
  problems: number;
  done: number;
  ledgers: number;
  ledgerTotal: number;
}): string {
  const stat = (cls: string, k: string, v: number, sub: string) =>
    `<div class="stat ${cls}"><div class="k"><span class="pip"></span>${k}</div><div class="v num">${v}</div><div class="sub">${sub}</div></div>`;
  return `<section class="block">
<p class="eyebrow">Status at a glance</p>
<div class="stats">
${stat("attn", "Action needed", s.actionCount, "review &middot; context &middot; cleanup &middot; resolve")}
${stat("", "In trash", s.trash, "quarantined, reversible")}
${stat("danger", "Purge &middot; one-way", s.purge, "awaiting exact approval")}
${stat("attn", "Problems", s.problems, s.problems === 0 ? "all sources healthy" : "needs attention")}
${stat("good", "Done &middot; recent", s.done, "verified receipts")}
</div>
</section>`;
}

function ledgerHealthSection(ledgers: DashboardLedgerStatus[]): string {
  if (ledgers.length === 0) {
    return `<section class="block"><p class="eyebrow">Sources</p><p class="empty">No ledgers are registered.</p></section>`;
  }
  const cards = ledgers
    .map((ledger) => {
      const cls = ledger.ok ? "ledger" : "ledger bad";
      const state = ledger.ok ? `healthy &middot; ${ledger.records} record(s)` : "unavailable";
      const err = ledger.ok ? "" : `<div class="err">${escapeHtml(ledger.errors[0] ?? "unavailable")}</div>`;
      return `<div class="${cls}"><div class="name"><span class="pip"></span>${escapeHtml(ledger.name)}</div><div class="path">${escapeHtml(ledger.path)}</div><div class="state">${state}</div>${err}</div>`;
    })
    .join("");
  return `<section class="block"><details class="sources-drawer"><summary>Sources &middot; ${ledgers.length} ledger(s) &middot; ${ledgers.filter((ledger) => ledger.ok).length} healthy</summary><div class="sources">${cards}</div></details></section>`;
}

export function renderDashboardActivityFragment(
  history: UiSessionHistoryEntry[],
  options: { activityHref?: string; scriptNonce?: string; includeScript?: boolean } = {}
): string {
  const queued = history.filter((entry) => isQueuedForAgentStatus(entry.event.status));
  const handled = history.filter((entry) => entry.event.status === "completed" || entry.event.status === "cancelled");
  const problem = history.filter((entry) => ["stale", "rejected", "failed"].includes(entry.event.status));
  const executionRan = history.some((entry) => entry.replies.some((reply) => isExecutionReply(reply)));
  const activityRows = [
    ...activityGroupCards(queued, "Queued", "warn"),
    ...activityGroupCards(handled, "Handled by agent", "good"),
    ...activityGroupCards(problem, "Needs re-review", "bad")
  ];
  const activityBody = activityRows.length > 0 ? `<div class="activity-list">${activityRows.join("")}</div>` : `<p class="empty">No queued work yet.</p>`;
  const activityHref = options.activityHref ? ` data-activity-href="${escapeHtml(options.activityHref)}"` : "";
  const script = options.activityHref && options.includeScript !== false ? activityPollScript(options.scriptNonce) : "";
  const safety = executionRan ? "Execution receipt received. Browser did not execute files." : "No execution ran.";
  return `<section class="block session-activity" id="session-activity"${activityHref}>
<div class="session-head"><span class="title">Queue activity</span><span class="muted">live status</span></div>
<div class="activity-stats">
<span class="activity-chip warn">Queued: <span class="num">${queued.length}</span></span>
<span class="activity-chip good">Handled: <span class="num">${handled.length}</span></span>
<span class="activity-chip${problem.length > 0 ? " bad" : ""}">Needs review: <span class="num">${problem.length}</span></span>
</div>
<p class="safety-line">${escapeHtml(safety)}</p>
${activityBody}
</section>${script}`;
}

function activityPollScript(nonce?: string): string {
  const nonceAttribute = nonce ? ` nonce="${escapeHtml(nonce)}"` : "";
  return `<script${nonceAttribute}>(function(){function activityHref(){var current=document.getElementById("session-activity");return current&&current.dataset?current.dataset.activityHref:"";}function hasQueuedSelections(){var form=document.querySelector(".review-form");return !!(form&&form.querySelector('input[name^="approval:"]:checked:not(:disabled)'));}async function refreshReviewShell(){var current=document.querySelector(".review-shell");if(!current||hasQueuedSelections())return;try{var response=await fetch(window.location.pathname+window.location.search,{cache:"no-store",credentials:"omit"});if(!response.ok)return;var html=await response.text();var doc=new DOMParser().parseFromString(html,"text/html");var next=doc.querySelector(".review-shell");if(next)current.replaceWith(next);}catch(_error){}}async function refresh(){var href=activityHref();var current=document.getElementById("session-activity");if(!href||!current)return;try{var response=await fetch(href,{cache:"no-store",credentials:"omit"});if(!response.ok)return;var next=await response.text();var changed=current.outerHTML!==next;current.outerHTML=next;if(changed)await refreshReviewShell();}catch(_error){}}setInterval(refresh,2500);refresh();})();</script>`;
}

function activityGroupCards(entries: UiSessionHistoryEntry[], badge: string, tone: "good" | "warn" | "bad"): string[] {
  const groups = new Map<string, { label: string; entries: UiSessionHistoryEntry[] }>();
  for (const entry of entries) {
    const label = activityGroupLabel(entry.event);
    const existing = groups.get(label) ?? { label, entries: [] };
    existing.entries.push(entry);
    groups.set(label, existing);
  }
  return [...groups.values()].map((group) => {
    const targets = group.entries.map((entry) => eventTargetLabel(entry.event)).filter((value) => value.length > 0).join(", ");
    const actions = tone === "warn" ? unqueueButtons(group.entries) : "";
    return `<article class="activity-card ${tone}"><div class="topline"><span class="badge">${escapeHtml(badge)}</span><span class="badge">${escapeHtml(compactStatusLabel(group.entries))}</span><span class="name">${group.entries.length} ${group.entries.length === 1 ? "item" : "items"}: ${escapeHtml(group.label)}</span></div>${targets ? `<p class="detail">${escapeHtml(targets)}</p>` : ""}${actions}</article>`;
  });
}

function unqueueButtons(entries: UiSessionHistoryEntry[]): string {
  const queued = entries.filter((entry) => entry.event.source === "browser" && entry.event.status === "pending");
  if (queued.length === 0) return "";
  if (queued.length === 1) {
    const entry = queued[0]!;
    const label = eventTargetLabel(entry.event);
    const title = label ? ` title="Unqueue ${escapeHtml(label)}"` : "";
    return `<div class="activity-actions"><button class="unqueue-btn" type="submit" name="cancelEventId" value="${escapeHtml(entry.event.id)}"${title}>Unqueue</button></div>`;
  }
  const ids = queued.map((entry) => entry.event.id).join(",");
  return `<div class="activity-actions"><button class="unqueue-btn" type="submit" name="cancelEventIds" value="${escapeHtml(ids)}">Unqueue all ${queued.length}</button></div>`;
}

function compactStatusLabel(entries: UiSessionHistoryEntry[]): string {
  const statuses = [...new Set(entries.map((entry) => entry.event.status))];
  return statuses.length === 1 ? statuses[0] ?? "unknown" : statuses.join(" / ");
}

function replyCard(reply: UiReply): string {
  const title = replyTitle(reply);
  const planId = stringPayload(reply.payload, "planId");
  const approvalTarget = stringPayload(reply.payload, "approvalTarget") ?? stringPayload(reply.payload, "approvalPhrase");
  const count = numberPayload(reply.payload, "count");
  const records = stringArrayPayload(reply.payload, "records");
  const execution = isExecutionReply(reply);
  const executionStatus = stringPayload(reply.payload, "executionStatus");
  const executionCounts = executionCountsPayload(reply.payload);
  const executionReceipts = executionReceiptsPayload(reply.payload);
  const bad = ["stale", "rejected", "failed"].includes(reply.status);
  const dryRun = !execution && (planId !== null || /dry-run/i.test(title));
  const kind = execution ? "Final execution receipt" : dryRun ? "Dry-run reply" : "Agent reply";
  const fields = [
    planId ? `<dt>plan</dt><dd class="mono">${escapeHtml(planId)}</dd>` : "",
    executionStatus ? `<dt>status</dt><dd>${escapeHtml(executionStatus)}</dd>` : "",
    executionCounts ? `<dt>counts</dt><dd class="mono">${executionCounts.map(([key, value]) => `${escapeHtml(key)} ${value}`).join(" &middot; ")}</dd>` : "",
    count !== null ? `<dt>count</dt><dd>${count}</dd>` : "",
    records.length > 0 ? `<dt>records</dt><dd class="mono">${escapeHtml(records.join(", "))}</dd>` : "",
    approvalTarget ? `<dt>approval</dt><dd class="mono">${escapeHtml(approvalTarget)}</dd>` : ""
  ].join("");
  const continuity = dryRun ? `<p class="detail">completed dry-run &middot; awaiting approval &middot; No execution ran</p>` : "";
  const note = replyNote(reply.payload);
  return `<div class="reply-card${execution ? " final" : ""}${bad ? " bad" : ""}">
<div class="kind">${kind}</div>
<div class="headline">${escapeHtml(title)}</div>
${continuity}
${note ? `<p class="detail">${escapeHtml(note)}</p>` : ""}
${fields ? `<dl>${fields}</dl>` : ""}
${executionReceipts.length > 0 ? executionReceiptRows(executionReceipts) : ""}
</div>`;
}

function replyTitle(reply: UiReply): string {
  const title = stringPayload(reply.payload, "title");
  if (title) return title;
  const kind = stringPayload(reply.payload, "kind");
  if (kind === "dispose_dry_run") return "Dispose dry-run prepared";
  if (kind === "purge_dry_run") return "Purge dry-run prepared";
  if (kind === "reconcile_dry_run") return "Reconcile dry-run prepared";
  if (isExecutionReply(reply)) return "Execution receipt";
  return `Agent ${reply.status}`;
}

function isExecutionReply(reply: UiReply): boolean {
  return typeof reply.payload.executionStatus === "string" || Array.isArray(reply.payload.receipts);
}

const EXECUTION_OUTCOMES = ["executed", "skipped_stale", "failed", "needs_manual_review"];

type ExecutionReceiptPayload = {
  targetId: string;
  label: string;
  actionType: string;
  ledgerPath: string;
  outcome: string;
  detail: string;
  evidence: Record<string, unknown> | null;
};

function executionCountsPayload(payload: Record<string, unknown>): Array<[string, number]> | null {
  const counts = payload.counts;
  if (!isRecord(counts)) return null;
  const entries = EXECUTION_OUTCOMES.flatMap((key): Array<[string, number]> => {
    const value = counts[key];
    return typeof value === "number" && Number.isFinite(value) ? [[key, value]] : [];
  });
  return entries.length > 0 ? entries : null;
}

function executionReceiptsPayload(payload: Record<string, unknown>): ExecutionReceiptPayload[] {
  const receipts = payload.receipts;
  if (!Array.isArray(receipts)) return [];
  return receipts.flatMap((receipt): ExecutionReceiptPayload[] => {
    if (!isRecord(receipt)) return [];
    const targetId = stringRecordValue(receipt, "targetId");
    const outcome = stringRecordValue(receipt, "outcome");
    if (!targetId || !outcome) return [];
    return [
      {
        targetId,
        outcome,
        label: stringRecordValue(receipt, "label") ?? targetId,
        actionType: stringRecordValue(receipt, "actionType") ?? "",
        ledgerPath: stringRecordValue(receipt, "ledgerPath") ?? "",
        detail: stringRecordValue(receipt, "detail") ?? "",
        evidence: isRecord(receipt.evidence) ? receipt.evidence : null
      }
    ];
  });
}

function executionReceiptRows(receipts: ExecutionReceiptPayload[]): string {
  const rows = receipts.map((receipt) => {
    const fields = [
      `<dt>target</dt><dd class="mono">${escapeHtml(receipt.targetId)}</dd>`,
      receipt.actionType ? `<dt>action</dt><dd>${escapeHtml(receipt.actionType)}</dd>` : "",
      receipt.ledgerPath ? `<dt>ledger</dt><dd class="mono">${escapeHtml(receipt.ledgerPath)}</dd>` : "",
      receipt.evidence ? `<dt>evidence</dt><dd class="mono">${escapeHtml(JSON.stringify(receipt.evidence))}</dd>` : ""
    ].join("");
    return `<article class="receipt-row ${receiptOutcomeClass(receipt.outcome)}">
<div class="receipt-topline"><span class="badge">${escapeHtml(receipt.outcome)}</span><span class="name">${escapeHtml(receipt.label)}</span></div>
${receipt.detail ? `<p class="detail">${escapeHtml(receipt.detail)}</p>` : ""}
<dl>${fields}</dl>
</article>`;
  });
  return `<div class="receipt-list">${rows.join("")}</div>`;
}

function receiptOutcomeClass(outcome: string): string {
  if (outcome === "executed") return "good";
  if (outcome === "skipped_stale" || outcome === "needs_manual_review") return "warn";
  if (outcome === "failed") return "bad";
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecordValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringPayload(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberPayload(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArrayPayload(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function activityGroupLabel(event: UiEvent): string {
  const lane = typeof event.payload.lane === "string" ? event.payload.lane : typeof event.target.lane === "string" ? event.target.lane : "record";
  if (event.type === "decision_submitted") {
    const decision = typeof event.payload.decision === "string" ? event.payload.decision : "decision";
    return `${lane} / ${decision}`;
  }
  if (event.type === "dry_run_requested") {
    const request = typeof event.payload.request === "string" ? event.payload.request : "dry-run";
    return `${lane} / ${request}`;
  }
  return event.type;
}

function eventTargetLabel(event: UiEvent): string {
  const recordId = typeof event.target.recordId === "string" ? event.target.recordId : "";
  const ledgerName = typeof event.target.ledgerName === "string" ? event.target.ledgerName : "";
  const lane = typeof event.target.lane === "string" ? event.target.lane : "";
  return [recordId, ledgerName, lane].filter((value) => value.length > 0).join(" / ");
}

function recordActivityIndex(history: UiSessionHistoryEntry[]): Map<string, UiSessionHistoryEntry> {
  const index = new Map<string, UiSessionHistoryEntry>();
  for (const entry of history) {
    const recordId = typeof entry.event.target.recordId === "string" ? entry.event.target.recordId : "";
    const ledgerPath = typeof entry.event.target.ledgerPath === "string" ? entry.event.target.ledgerPath : "";
    if (recordId && ledgerPath) index.set(recordActivityKey(recordId, ledgerPath), entry);
  }
  return index;
}

function preparedPlanIndex(history: UiSessionHistoryEntry[], reviewableEventIds?: Set<string>): Map<string, PreparedPlanApproval> {
  const index = new Map<string, PreparedPlanApproval>();
  const submittedPlanEvents = submittedPreparedPlanEventIds(history);
  for (const entry of history) {
    if (entry.event.status !== "completed" || entry.event.type !== "decision_submitted") continue;
    if (reviewableEventIds !== undefined && !reviewableEventIds.has(entry.event.id)) continue;
    const recordId = typeof entry.event.target.recordId === "string" ? entry.event.target.recordId : "";
    const ledgerPath = typeof entry.event.target.ledgerPath === "string" ? entry.event.target.ledgerPath : "";
    if (!recordId || !ledgerPath) continue;
    const reply = [...entry.replies].reverse().find((candidate) => stringPayload(candidate.payload, "planId") !== null);
    if (!reply) continue;
    const planId = stringPayload(reply.payload, "planId");
    if (!planId) continue;
    const action = stringPayload(reply.payload, "action") ?? decisionActionLabel(typeof entry.event.payload.decision === "string" ? entry.event.payload.decision : "");
    const approvalTarget = stringPayload(reply.payload, "approvalTarget") ?? stringPayload(reply.payload, "approvalPhrase") ?? "";
    index.set(recordActivityKey(recordId, ledgerPath), {
      eventId: entry.event.id,
      recordId,
      ledgerPath,
      ledgerName: typeof entry.event.target.ledgerName === "string" ? entry.event.target.ledgerName : "ledger",
      lane: typeof entry.event.payload.lane === "string" ? entry.event.payload.lane : "record",
      planId,
      action,
      actionLabel: planActionLabel(action),
      approvalTarget: approvalTarget || `approve plan ${planId}`,
      submitted: submittedPlanEvents.has(entry.event.id)
    });
  }
  return index;
}

function submittedPreparedPlanEventIds(history: UiSessionHistoryEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of history) {
    if (entry.event.type !== "approval_bundle_submitted") continue;
    if (!isQueuedForAgentStatus(entry.event.status)) continue;
    const preparedEventId = typeof entry.event.payload.preparedEventId === "string" ? entry.event.payload.preparedEventId : "";
    if (preparedEventId) ids.add(preparedEventId);
  }
  return ids;
}

function hasCancelableQueuedItems(history: UiSessionHistoryEntry[]): boolean {
  return history.some((entry) => entry.event.source === "browser" && entry.event.status === "pending");
}

function visibleRequiredActionRows(snapshot: DashboardSnapshot, preparedPlans: Map<string, PreparedPlanApproval>): RequiredActionRows {
  return {
    needsReview: filterPreparedRows(snapshot.buckets.needsReview, preparedPlans),
    needsContext: filterPreparedRows(snapshot.buckets.needsContext, preparedPlans),
    cleanup: filterPreparedRows(snapshot.buckets.cleanup, preparedPlans),
    resolve: filterPreparedRows(snapshot.buckets.resolve, preparedPlans)
  };
}

function filterPreparedRows(rows: DashboardArtifactRow[], preparedPlans: Map<string, PreparedPlanApproval>): DashboardArtifactRow[] {
  return rows.filter((row) => !preparedPlans.has(recordActivityKey(row.recordId, row.ledgerPath ?? "")));
}

function livePreparedPlanIndex(preparedPlans: Map<string, PreparedPlanApproval>, snapshot: DashboardSnapshot): Map<string, PreparedPlanApproval> {
  const liveActionKeys = new Set<string>();
  for (const row of [...snapshot.buckets.needsReview, ...snapshot.buckets.needsContext, ...snapshot.buckets.cleanup, ...snapshot.buckets.resolve]) {
    liveActionKeys.add(recordActivityKey(row.recordId, row.ledgerPath ?? ""));
  }
  return new Map([...preparedPlans].filter(([key]) => liveActionKeys.has(key)));
}

function decisionActionLabel(decision: string): string {
  if (decision === "trash") return "trash-resolve";
  if (decision === "resolve") return "resolve-only";
  return decision;
}

function planActionLabel(action: string): string {
  if (action === "trash-resolve") return "Trash and resolve";
  if (action === "resolve-only") return "Resolve only";
  if (action === "keep") return "Keep";
  if (action === "snooze") return "Snooze";
  return action || "Prepared action";
}

type PendingActionIndex = {
  laneRequests: Set<string>;
  rowDecisions: Map<string, string>;
};

function pendingActionIndex(history: UiSessionHistoryEntry[], rows?: RequiredActionRows): PendingActionIndex {
  const index: PendingActionIndex = { laneRequests: new Set(), rowDecisions: new Map() };
  const rowLanes = rows ? rowLaneIndex(rows) : new Map<string, Array<"needs-review" | "needs-context" | "cleanup" | "resolve">>();
  for (const entry of history) {
    if (!isQueuedForAgentStatus(entry.event.status)) continue;
    if (entry.event.type === "dry_run_requested") {
      const lane = typeof entry.event.target.lane === "string" ? entry.event.target.lane : typeof entry.event.payload.lane === "string" ? entry.event.payload.lane : "";
      const request = typeof entry.event.payload.request === "string" ? entry.event.payload.request : "";
      if (lane && request) index.laneRequests.add(laneActionKey(lane, request));
      continue;
    }
    if (entry.event.type !== "decision_submitted") continue;
    const lane = typeof entry.event.payload.lane === "string" ? entry.event.payload.lane : "";
    const decision = typeof entry.event.payload.decision === "string" ? entry.event.payload.decision : "";
    const recordId = typeof entry.event.target.recordId === "string" ? entry.event.target.recordId : "";
    const ledgerPath = typeof entry.event.target.ledgerPath === "string" ? entry.event.target.ledgerPath : "";
    if (!decision || !recordId || !ledgerPath) continue;
    if (isBulkDecisionLane(lane)) {
      index.rowDecisions.set(rowDecisionActionKey(lane, recordId, ledgerPath), decision);
      continue;
    }
    for (const currentLane of rowLanes.get(recordActivityKey(recordId, ledgerPath)) ?? []) {
      index.rowDecisions.set(rowDecisionActionKey(currentLane, recordId, ledgerPath), decision);
    }
  }
  return index;
}

function rowLaneIndex(rows: RequiredActionRows): Map<string, Array<"needs-review" | "needs-context" | "cleanup" | "resolve">> {
  const index = new Map<string, Array<"needs-review" | "needs-context" | "cleanup" | "resolve">>();
  for (const [lane, laneRows] of [
    ["needs-review", rows.needsReview],
    ["needs-context", rows.needsContext],
    ["cleanup", rows.cleanup],
    ["resolve", rows.resolve]
  ] as const) {
    for (const row of laneRows) {
      const key = recordActivityKey(row.recordId, row.ledgerPath ?? "");
      const lanes = index.get(key);
      if (lanes) lanes.push(lane);
      else index.set(key, [lane]);
    }
  }
  return index;
}

function isQueuedForAgentStatus(status: UiEvent["status"]): boolean {
  return status === "pending" || status === "acknowledged" || status === "in_progress";
}

function isLaneRequestQueued(index: PendingActionIndex, lane: DashboardBucketKey, request: string): boolean {
  return index.laneRequests.has(laneActionKey(lane, request));
}

function queuedRowDecision(index: PendingActionIndex, lane: "needs-review" | "needs-context" | "cleanup" | "resolve", row: DashboardArtifactRow): string | null {
  return index.rowDecisions.get(rowDecisionActionKey(lane, row.recordId, row.ledgerPath ?? "")) ?? null;
}

function areRowsQueuedForDecision(
  index: PendingActionIndex,
  lane: "needs-review" | "needs-context" | "cleanup" | "resolve",
  rows: DashboardArtifactRow[],
  decision: string
): boolean {
  return rows.length > 0 && rows.every((row) => queuedRowDecision(index, lane, row) === decision);
}

function laneActionKey(lane: string, action: string): string {
  return `${lane}\0${action}`;
}

function rowDecisionActionKey(lane: string, recordId: string, ledgerPath: string): string {
  return `${lane}\0${recordId}\0${ledgerPath}`;
}

function isBulkDecisionLane(value: unknown): value is "needs-review" | "needs-context" | "cleanup" | "resolve" {
  return value === "needs-review" || value === "needs-context" || value === "cleanup" || value === "resolve";
}

function recordActivityKey(recordId: string, ledgerPath: string): string {
  return `${recordId}\0${ledgerPath}`;
}

function rowActivityBadge(entry: UiSessionHistoryEntry | undefined): string {
  if (!entry) return "";
  if (entry.event.status === "pending" || entry.event.status === "acknowledged" || entry.event.status === "in_progress") {
    return `<span class="badge ctx">Sent to agent</span>`;
  }
  if (entry.event.status === "completed") return `<span class="badge rec">Agent replied</span>`;
  if (entry.event.status === "stale" || entry.event.status === "rejected" || entry.event.status === "failed") {
    return `<span class="badge peril">Needs re-review</span>`;
  }
  return "";
}

function activitySection(snapshot: DashboardSnapshot, token: string | undefined, ledgerIndex: Map<string, number>): string {
  const stages = [
    readonlyStage("trash", snapshot.buckets.trash.length, trashActivityBody(snapshot.buckets.trash, ledgerIndex)),
    readonlyStage("recent-receipts", snapshot.buckets.recentReceipts.length, receiptActivityBody(snapshot.buckets.recentReceipts, token, ledgerIndex))
  ].filter((stage) => stage.length > 0);
  return stages.length === 0
    ? ""
    : `<section class="block"><p class="eyebrow">Recent activity</p>${stages.join("")}</section>`;
}

function readonlyStage(key: DashboardBucketKey, count: number, body: string): string {
  if (count === 0) return "";
  const lane = LANES[key];
  return `<details class="stage" id="lane-${key}" data-zone="${lane.zone}" data-rail="${lane.rail}">
<summary>${ICON.chevron}<span class="rail"></span><span class="title">${escapeHtml(lane.title)}</span><span class="count num">${count}</span><span class="hint">${escapeHtml(lane.hint)}</span></summary>
<div class="body">${body}</div>
</details>`;
}

function dataLedger(ledgerPath: string | null, ledgerIndex: Map<string, number>): string {
  const idx = ledgerPath === null ? undefined : ledgerIndex.get(ledgerPath);
  return idx === undefined ? "" : ` data-ledger="led-${idx}"`;
}

function artifactActionBody(
  key: "needs-review" | "needs-context" | "cleanup" | "resolve",
  rows: DashboardArtifactRow[],
  token: string | undefined,
  ledgerIndex: Map<string, number>,
  rowActivity: Map<string, UiSessionHistoryEntry>,
  pendingActions: PendingActionIndex
): string {
  return rows.length === 0
    ? ""
    : `${bulkDecisionControls(key, rows, token, pendingActions)}
<div class="rows">${rows
      .map((row) => artifactRow(key, row, token, ledgerIndex, rowActivity, pendingActions))
      .join("")}</div>`;
}

function artifactRow(
  lane: "needs-review" | "needs-context" | "cleanup" | "resolve",
  row: DashboardArtifactRow,
  token: string | undefined,
  ledgerIndex: Map<string, number>,
  rowActivity: Map<string, UiSessionHistoryEntry>,
  pendingActions: PendingActionIndex
): string {
  const href = detailHref(row.recordId, row.ledgerPath, token);
  const reason = row.reason.trim() ? escapeHtml(row.reason) : `<span class="muted">(no reason recorded)</span>`;
  const due = row.dueState ? dueLabel(row.dueState) : "";
  const disposition = row.needsContext
    ? `<span class="badge ctx">${escapeHtml(row.needsContext.label)}</span>`
    : `<span class="badge rec">${escapeHtml(row.recommendation)}</span>`;
  const queued = rowActivityBadge(rowActivity.get(recordActivityKey(row.recordId, row.ledgerPath ?? "")));
  const last = lastActionLine(row.lastAction);
  return `<article class="queue-row r"${dataLedger(row.ledgerPath, ledgerIndex)}>
<div>
<div class="row-head"><span class="id"><a href="${href}">${escapeHtml(row.recordId)}</a></span>${disposition}${queued}</div>
<p class="row-path">${escapeHtml(row.path)}</p>
<p class="row-summary"><strong>Reason:</strong> ${reason}${last}</p>
<div class="row-meta"><span>${escapeHtml(row.kind)}</span><span>${escapeHtml(row.status)}</span><span>cleanup ${escapeHtml(row.cleanup)}</span></div>
</div>
<div class="row-side">
<span class="src">${escapeHtml(row.ledgerName)}</span>
<span class="age">${escapeHtml(row.age)}${due}</span>
<a class="badge" href="${href}">Details</a>
${rowDecisionControls(lane, row, token, pendingActions)}
</div>
</article>`;
}

function rowDecisionControls(
  lane: "needs-review" | "needs-context" | "cleanup" | "resolve",
  row: DashboardArtifactRow,
  token: string | undefined,
  pendingActions: PendingActionIndex
): string {
  if (!token) return "";
  const queuedDecision = queuedRowDecision(pendingActions, lane, row);
  const choices =
    lane === "resolve"
      ? [
        rowDecisionChoice(lane, row, "keep", "Keep", false, queuedDecision),
        rowDecisionChoice(lane, row, "resolve", "Resolve", false, queuedDecision)
      ]
      : [
        rowDecisionChoice(lane, row, "keep", "Keep", false, queuedDecision),
        rowDecisionChoice(lane, row, "trash", "Trash", true, queuedDecision)
      ];
  return `<div class="row-actions">${choices.join("")}</div>`;
}

function rowDecisionChoice(
  lane: "needs-review" | "needs-context" | "cleanup" | "resolve",
  row: DashboardArtifactRow,
  decision: "keep" | "trash" | "resolve",
  label: string,
  danger = false,
  queuedDecision: string | null = null
): string {
  const value = rowDecisionValue(lane, row, decision);
  const name = rowDecisionFieldName(lane, row);
  const submitted = queuedDecision === decision;
  const disabled = queuedDecision !== null;
  return `<label class="row-choice${danger ? " danger" : ""}${submitted ? " submitted" : ""}" data-approval-value="${escapeHtml(value)}"><input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${submitted ? " checked" : ""}${disabled ? " disabled" : ""}><span class="choose">${escapeHtml(label)}</span><span class="queued">Queued</span></label>`;
}

function rowDecisionValue(lane: "needs-review" | "needs-context" | "cleanup" | "resolve", row: DashboardArtifactRow, decision: "keep" | "trash" | "resolve"): string {
  return `row-decision:${lane}:${decision}:${encodeURIComponent(row.recordId)}:${encodeURIComponent(row.ledgerPath ?? "")}`;
}

function rowDecisionFieldName(lane: "needs-review" | "needs-context" | "cleanup" | "resolve", row: DashboardArtifactRow): string {
  return `approval:${lane}:row:${encodeURIComponent(row.recordId)}:${encodeURIComponent(row.ledgerPath ?? "")}`;
}

function bulkDecisionControls(
  key: "needs-review" | "needs-context" | "cleanup" | "resolve",
  rows: DashboardArtifactRow[],
  token: string | undefined,
  pendingActions: PendingActionIndex
): string {
  if (!token) return "";
  const lane = LANES[key];
  const submittedDecision = queuedBulkDecision(pendingActions, key, rows);
  const choices =
    key === "resolve"
      ? [
        bulkDecisionChoice(key, "keep", "Keep all", false, submittedDecision, isLaneDecisionBlocked(pendingActions, key, rows, "keep")),
        bulkDecisionChoice(key, "resolve", "Resolve all", false, submittedDecision, isLaneDecisionBlocked(pendingActions, key, rows, "resolve"))
      ]
      : [
        bulkDecisionChoice(key, "keep", "Keep all", false, submittedDecision, isLaneDecisionBlocked(pendingActions, key, rows, "keep")),
        bulkDecisionChoice(key, "trash", "Trash all", true, submittedDecision, isLaneDecisionBlocked(pendingActions, key, rows, "trash"))
      ];
  return `<div class="lane-actions">
<div class="choice-row"><span class="lbl">Queue</span>
${choices.join("\n")}
<span class="lane-copy">${rows.length} ${escapeHtml(lane.title.toLowerCase())} row(s)</span>
</div>
</div>
`;
}

function queuedBulkDecision(
  pendingActions: PendingActionIndex,
  lane: "needs-review" | "needs-context" | "cleanup" | "resolve",
  rows: DashboardArtifactRow[]
): string | null {
  const decisions = lane === "resolve" ? ["keep", "resolve"] : ["keep", "trash"];
  for (const decision of decisions) {
    if (areRowsQueuedForDecision(pendingActions, lane, rows, decision)) return decision;
  }
  return null;
}

function areBulkChoicesSubmittable(
  pendingActions: PendingActionIndex,
  lane: "needs-review" | "needs-context" | "cleanup" | "resolve",
  rows: DashboardArtifactRow[]
): boolean {
  return rows.length > 0 && rows.every((row) => queuedRowDecision(pendingActions, lane, row) === null);
}

function hasQueuedRowDecision(
  index: PendingActionIndex,
  lane: "needs-review" | "needs-context" | "cleanup" | "resolve",
  rows: DashboardArtifactRow[]
): boolean {
  return rows.some((row) => queuedRowDecision(index, lane, row) !== null);
}

function isLaneDecisionBlocked(
  index: PendingActionIndex,
  lane: "needs-review" | "needs-context" | "cleanup" | "resolve",
  rows: DashboardArtifactRow[],
  decision: string
): boolean {
  return hasQueuedRowDecision(index, lane, rows) && !areRowsQueuedForDecision(index, lane, rows, decision);
}

function laneDecisionChoiceState(
  index: PendingActionIndex,
  lane: "needs-review" | "needs-context" | "cleanup" | "resolve",
  rows: DashboardArtifactRow[],
  decision: string
): { submitted: boolean; disabled: boolean } {
  const submitted = areRowsQueuedForDecision(index, lane, rows, decision);
  return { submitted, disabled: !submitted && hasQueuedRowDecision(index, lane, rows) };
}

function bulkDecisionChoice(lane: DashboardBucketKey, decision: string, label: string, danger = false, submittedDecision: string | null = null, blocked = false): string {
  const value = `decision:${lane}:${decision}`;
  const submitted = submittedDecision === decision;
  const disabled = submittedDecision !== null || blocked;
  const stateClass = submitted ? " submitted" : blocked ? " disabled" : "";
  return `<label class="bulk-choice${danger ? " danger" : ""}${stateClass}" data-approval-value="${escapeHtml(value)}"><input type="checkbox" name="${escapeHtml(approvalFieldName(lane))}" value="${escapeHtml(value)}"${submitted ? " checked" : ""}${disabled ? " disabled" : ""}><span class="choose">${escapeHtml(label)}</span><span class="queued">Queued</span></label>`;
}

function dueLabel(dueState: string): string {
  const lower = dueState.toLowerCase();
  const cls = /overdue|ago/.test(lower) ? "due over" : /today|soon|due/.test(lower) ? "due soon" : "due";
  return `<span class="${cls}">${escapeHtml(dueState)}</span>`;
}

// The contract's "last action and receipt when available" row metadata, kept in the exact
// "<kind> at <at>; receipt <path>" shape the agent and audit consumers expect.
function lastActionLine(lastAction: DashboardLastAction | null): string {
  if (!lastAction) return "";
  const receipt = lastAction.receiptPath ? `; receipt ${lastAction.receiptPath}` : "";
  return `<span class="lastact">last action: ${escapeHtml(lastAction.kind)} at ${escapeHtml(lastAction.at)}${escapeHtml(receipt)}</span>`;
}

// The purge-candidate lane: grouped by source/ledger with a per-group total and the exact target rows,
// fronted by the one-way-door warning. It exposes no checkbox or execution control - selecting an exact
// subset and approving it happens in the dedicated approval flow, never directly from this lane.
function purgeActionBody(rows: DashboardTrashRow[], ledgerIndex: Map<string, number>): string {
  const groups = groupPurgeCandidates(rows)
    .map((group) => purgeGroup(group, ledgerIndex))
    .join("");
  const danger = `<p class="stagenote">${ICON.alert}${escapeHtml(PURGE_LANE_NOTE)}</p>`;
  return rows.length === 0 ? "" : `${danger}${groups}`;
}

function purgeGroup(group: DashboardPurgeGroup, ledgerIndex: Map<string, number>): string {
  const rows = group.candidates
    .map(
      (row) =>
        `<article class="queue-row r"${dataLedger(row.ledgerPath, ledgerIndex)}>
<div>
<div class="row-head"><span class="id">${escapeHtml(row.recordId)}</span><span class="badge peril">delete review</span></div>
<p class="row-path">${escapeHtml(row.targetPath)}</p>
<p class="row-summary">Trashed item old enough for final delete review; permanent deletion still needs exact approval.</p>
<div class="row-meta"><span>age ${escapeHtml(row.age)}</span><span>plan ${escapeHtml(row.cleanupPlanId)}</span></div>
</div>
<div class="row-side"><span class="src">${escapeHtml(row.ledgerName)}</span><span class="age">${escapeHtml(row.age)}</span><span class="id">${escapeHtml(row.cleanupPlanId)}</span></div>
</article>`
    )
    .join("");
  return `<section class="approval-group"><h2>${escapeHtml(group.ledgerName)} <span class="muted">${escapeHtml(group.ledgerPath)} &middot; ${group.total} candidate(s)</span></h2><div class="rows">${rows}</div></section>`;
}

function problemActionBody(rows: DashboardProblemRow[], ledgerIndex: Map<string, number>): string {
  return rows.length === 0
    ? ""
    : `<div class="rows">${rows
      .map((row) => problemRow(row, ledgerIndex))
      .join("")}</div>`;
}

function problemRow(row: DashboardProblemRow, ledgerIndex: Map<string, number>): string {
  const target = row.recordId ? escapeHtml(row.recordId) : escapeHtml(row.ledgerName ?? row.ledgerPath ?? "registry");
  const remap =
    row.currentPath && row.proposedPath
      ? `<span class="sub">${escapeHtml(row.currentPath)} &rarr; ${escapeHtml(row.proposedPath)}</span>`
      : "";
  return `<article class="queue-row r"${dataLedger(row.ledgerPath, ledgerIndex)}>
<div>
<div class="row-head"><span class="id">${target}</span><span class="badge peril">${escapeHtml(row.source)}: ${escapeHtml(row.category)}</span></div>
<p class="row-summary">${escapeHtml(row.detail)}${remap}</p>
<div class="row-meta"><span>${escapeHtml(row.source)}</span><span>${escapeHtml(row.category)}</span></div>
</div>
<div class="row-side"><span class="src">${escapeHtml(row.ledgerName ?? row.ledgerPath ?? "-")}</span></div>
</article>`;
}

function trashActivityBody(rows: DashboardTrashRow[], ledgerIndex: Map<string, number>): string {
  return `<div class="rows">${rows.map((row) => trashActivityRow(row, ledgerIndex)).join("")}</div>`;
}

function trashActivityRow(row: DashboardTrashRow, ledgerIndex: Map<string, number>): string {
  return `<article class="queue-row r"${dataLedger(row.ledgerPath, ledgerIndex)}>
<div>
<div class="row-head"><span class="id">${escapeHtml(row.recordId)}</span><span class="badge">quarantined</span></div>
<p class="row-path">${escapeHtml(row.targetPath)}</p>
<p class="row-summary">Moved to trash by cleanup plan <span class="id">${escapeHtml(row.cleanupPlanId)}</span>; receipt ${escapeHtml(row.receiptPath)}.</p>
<div class="row-meta"><span>cleaned ${escapeHtml(row.cleanedAt)}</span><span>age ${escapeHtml(row.age)}</span></div>
</div>
<div class="row-side"><span class="src">${escapeHtml(row.ledgerName)}</span><span class="age">${escapeHtml(row.age)}</span><span class="id">${escapeHtml(row.cleanupPlanId)}</span></div>
</article>`;
}

function receiptActivityBody(rows: DashboardReceiptRow[], token: string | undefined, ledgerIndex: Map<string, number>): string {
  return `<div class="rows">${rows.map((row) => receiptActivityRow(row, token, ledgerIndex)).join("")}</div>`;
}

function receiptActivityRow(row: DashboardReceiptRow, token: string | undefined, ledgerIndex: Map<string, number>): string {
  const href = detailHref(row.recordId, row.ledgerPath, token);
  const reason = row.reason.trim() ? escapeHtml(row.reason) : `<span class="muted">(no reason recorded)</span>`;
  return `<article class="queue-row r"${dataLedger(row.ledgerPath, ledgerIndex)}>
<div>
<div class="row-head"><span class="id"><a href="${href}">${escapeHtml(row.recordId)}</a></span><span class="badge rec">${escapeHtml(row.receiptKind)}</span></div>
<p class="row-path">${escapeHtml(row.path)}</p>
<p class="row-summary"><strong>Reason:</strong> ${reason}</p>
<div class="row-meta"><span>created ${escapeHtml(row.createdAt)}</span><span>age ${escapeHtml(row.age)}</span></div>
</div>
<div class="row-side"><span class="src">${escapeHtml(row.ledgerName)}</span><span class="age">${escapeHtml(row.age)}</span><a class="badge" href="${href}">Details</a></div>
</article>`;
}

export function renderDetailPage(detail: ArtifactDetail, token?: string, history: UiSessionHistoryEntry[] = []): string {
  const inspect = detail.inspect;
  const reason = inspect.reason.trim() ? escapeHtml(inspect.reason) : `<span class="muted">(no reason recorded)</span>`;
  const source = detail.ledgerName ? `${escapeHtml(detail.ledgerName)} (${escapeHtml(detail.ledgerPath)})` : escapeHtml(detail.ledgerPath);
  const retention = inspect.retainUntil
    ? `${escapeHtml(inspect.retention.mode)} until ${escapeHtml(inspect.retainUntil)}`
    : escapeHtml(inspect.retention.mode);
  const recommendationBadge = detail.needsContext
    ? `<span class="badge ctx">${escapeHtml(detail.needsContext.label)}</span>`
    : `<span class="badge rec">recommendation &middot; ${escapeHtml(inspect.recommendation)}</span>`;

  const facts = `<dl class="facts">
<div class="grp">Identity</div>
<div class="f"><dt>source</dt><dd>${source}</dd></div>
<div class="f"><dt>created / age</dt><dd>${escapeHtml(detail.createdAt)} (${escapeHtml(inspect.age)})</dd></div>
<div class="f wide"><dt>record path</dt><dd class="mono">${escapeHtml(inspect.path)}</dd></div>
<div class="f wide"><dt>subject path</dt><dd class="mono">${escapeHtml(inspect.subjectPath)}</dd></div>
<div class="grp">Lifecycle</div>
<div class="f"><dt>retention</dt><dd>${retention}</dd></div>
<div class="f"><dt>cleanup policy</dt><dd>${escapeHtml(inspect.cleanup)}</dd></div>
<div class="f wide"><dt>review due reason</dt><dd>${detail.dueReason ? escapeHtml(detail.dueReason) : `<span class="muted">not due</span>`}</dd></div>
<div class="grp">State</div>
<div class="f"><dt>existence</dt><dd>${existenceLabel(inspect.existence, inspect.nodeKind, inspect.byteSize)}</dd></div>
<div class="f"><dt>recommendation</dt><dd>${escapeHtml(inspect.recommendation)}</dd></div>
${lastActionFact(detail.lastAction)}
<div class="f wide"><dt>next safe action</dt><dd>${escapeHtml(inspect.nextAction)}</dd></div>
<div class="grp">Provenance</div>
<div class="f wide"><dt>origin</dt><dd class="mono">${provenanceLabel(detail.provenance)}</dd></div>
</dl>`;

  const body = `<header class="top">
<div class="wrap">
<a class="back" href="${dashboardHref(token)}">${ICON.back}Review dashboard</a>
<div class="rec-head"><span class="brand"><span class="dot"></span>Record</span><h1 class="rec-id">${escapeHtml(detail.recordId)}</h1><span class="badge">${escapeHtml(inspect.status)}</span>${recommendationBadge}</div>
<p class="rec-reason">${reason}</p>
</div>
</header>
<div class="wrap detail">
<div class="cols">
<section class="panel"><p class="eyebrow">Record facts</p>${facts}</section>
${token ? decisionPanel(detail.recordId, detail.ledgerPath, token) : ""}
</div>
${sessionHistorySection(history)}
<section class="panel"><p class="eyebrow">Audit trail</p><ul class="audit">${detail.audit.map(auditItem).join("")}</ul></section>
</div>`;
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

function lastActionFact(lastAction: DashboardLastAction | null): string {
  if (!lastAction) return "";
  const receipt = lastAction.receiptPath ? `; receipt ${lastAction.receiptPath}` : "";
  const reason = lastAction.reason ? `; ${lastAction.reason}` : "";
  return `<div class="f wide"><dt>last action</dt><dd>${escapeHtml(lastAction.kind)} at ${escapeHtml(lastAction.at)}${escapeHtml(receipt)}${escapeHtml(reason)}</dd></div>`;
}

function auditItem(event: ArtifactAuditEvent): string {
  const parts = [`<span class="k">${escapeHtml(event.kind)}</span> ${escapeHtml(event.at)}`];
  if (event.reason) parts.push(escapeHtml(event.reason));
  if (event.detail) parts.push(escapeHtml(event.detail));
  if (event.receiptPath) parts.push(`receipt ${escapeHtml(event.receiptPath)}`);
  return `<li>${parts.join(" &middot; ")}</li>`;
}

// NGX-538 human triage intent affordances on the detail drawer, restyled as one "Your decision" panel.
// Each intent is a scriptless HTML form posting back to the server's /intents endpoint under the page's
// capability token. The browser only records the intent for the agent's poll queue - it executes
// nothing and mutates no ledger, file, trash, or plan. Every form carries the exact record + ledger
// target as hidden fields. The four keep/trash/resolve/defer decisions share one form; the clicked
// button's value is the decision. Rendered only when a capability token is present.
function decisionPanel(recordId: string, ledgerPath: string, token: string): string {
  const targetFields =
    `<input type="hidden" name="recordId" value="${escapeHtml(recordId)}">` +
    `<input type="hidden" name="ledgerPath" value="${escapeHtml(ledgerPath)}">` +
    `<input type="hidden" name="token" value="${escapeHtml(token)}">`;
  return `<section class="panel decide">
<p class="eyebrow">Your decision</p>
<p class="lead">Records a triage intent for the agent to act on. The browser changes <b>no</b> ledger, file, trash, or plan - the agent executes only after you approve a bundle.</p>
<form method="post" action="/intents">
<input type="hidden" name="type" value="decision_submitted">${targetFields}
<label class="flabel" for="decision-reason">Decision reason (optional)</label>
<textarea id="decision-reason" name="reason" rows="2" placeholder="why keep, trash, resolve, or defer this record"></textarea>
<div class="dbtns">
<button class="btn keep" type="submit" name="decision" value="keep">Keep</button>
<button class="btn trash" type="submit" name="decision" value="trash">Trash candidate</button>
<button class="btn resolve" type="submit" name="decision" value="resolve">Resolve candidate</button>
<button class="btn defer" type="submit" name="decision" value="defer">Defer / snooze</button>
</div>
</form>
<div class="secondary">
<form method="post" action="/intents"><input type="hidden" name="type" value="inspect_requested">${targetFields}<button class="btn ghost" type="submit">Request inspect card</button></form>
<form method="post" action="/intents"><input type="hidden" name="type" value="dry_run_requested">${targetFields}<button class="btn ghost" type="submit">Request dry-run plan</button></form>
<form method="post" action="/intents" class="cmt"><input type="hidden" name="type" value="comment_added">${targetFields}<label class="flabel" for="comment-text">Comment</label><textarea id="comment-text" name="text" rows="2" required placeholder="note for the agent and the audit trail"></textarea><button class="btn ghost" type="submit">Add comment</button></form>
</div>
</section>`;
}

// NGX-538 session activity history on the detail drawer. The browser is the human half of the agent
// poll/reply loop, so the drawer surfaces this record's queued triage intents together with the
// agent's replies (acknowledged/completed/rejected/...): the visible-in-history acceptance criterion.
function sessionHistorySection(entries: UiSessionHistoryEntry[]): string {
  if (entries.length === 0) {
    return `<section class="panel"><p class="eyebrow">Session activity</p><p class="empty">No triage intents recorded for this record yet.</p></section>`;
  }
  const items = entries.map(historyItem).join("");
  return `<section class="panel"><p class="eyebrow">Session activity</p><ul class="timeline">${items}</ul></section>`;
}

function historyItem(entry: UiSessionHistoryEntry): string {
  const { event, replies } = entry;
  const note = intentNote(event);
  const noteHtml = note ? `<p class="note">${escapeHtml(note)}</p>` : "";
  const repliesHtml = replies.length > 0 ? `<ul class="replies">${replies.map(replyItem).join("")}</ul>` : "";
  const agent = replies.length > 0 ? " agent" : "";
  return `<li class="tl${agent}">
<div class="head"><span class="who">${escapeHtml(intentLabel(event))}</span> <span class="badge">${escapeHtml(event.status)}</span> <span class="when">${escapeHtml(event.createdAt)}</span></div>
${noteHtml}${repliesHtml}</li>`;
}

// Humanize a triage intent for the history line. decision_submitted carries the keep/trash/resolve/
// defer choice in its payload, so it reads as "Decision: <choice>"; the rest map to a plain label.
function intentLabel(event: UiEvent): string {
  switch (event.type) {
    case "inspect_requested":
      return "Inspect requested";
    case "dry_run_requested":
      return "Dry-run requested";
    case "comment_added":
      return "Comment";
    case "decision_submitted": {
      const decision = typeof event.payload.decision === "string" ? event.payload.decision : "";
      return decision ? `Decision: ${decision}` : "Decision";
    }
    default:
      return event.type;
  }
}

// The human's own note for an intent: a comment's text or a decision's optional reason. Other intent
// types carry no free-text body of their own.
function intentNote(event: UiEvent): string | null {
  if (event.type === "comment_added" && typeof event.payload.text === "string") return event.payload.text;
  if (event.type === "decision_submitted" && typeof event.payload.reason === "string") return event.payload.reason;
  return null;
}

function replyItem(reply: UiReply): string {
  const note = replyNote(reply.payload);
  const detail = note ? ` &middot; ${escapeHtml(note)}` : "";
  return `<li><span class="badge">agent ${escapeHtml(reply.status)}</span> <span class="when">${escapeHtml(reply.createdAt)}</span>${detail}${replyCard(reply)}</li>`;
}

// Surface the agent's free-text reply note from the first recognized payload field. Replies carry a
// result/receipt/validation-failure/question/note; showing the first present one keeps the human in
// the loop without coupling the browser to the agent's full reply schema.
function replyNote(payload: Record<string, unknown>): string | null {
  for (const key of ["note", "receipt", "result", "reason", "message"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

// NGX-539 browser approval workbench (AC4). A pure, scriptless render of the grouped reviewed
// candidate rows: it shows the exact action being approved, clearly distinguishes selected from
// unselected rows, and (only when a capability token is present) exposes per-row checkboxes plus a
// single deliberate "Approve N selected" submit posting to /approve. There is no approve-all or
// select-all affordance, and an empty selection disables the submit - approval is always a deliberate
// act over an explicit subset. Like the other surfaces it embeds no file contents and mutates nothing.
export function renderApprovalWorkbenchPage(view: UiApprovalWorkbenchView, token?: string): string {
  const summary = `${view.selectedCount} of ${view.totalCount} selected &middot; action ${escapeHtml(view.actionType)}`;
  const peril = view.actionType === PURGE_APPROVAL_ACTION;
  const body = `<header class="top">
<div class="wrap">
<a class="back" href="${dashboardHref(token)}">${ICON.back}Review dashboard</a>
<div class="brand${peril ? " peril" : ""}"><span class="dot"></span>Approval workbench${peril ? " &middot; one-way door" : ""}</div>
<h1>Artshelf approval workbench</h1>
<div class="meta">${summary}</div>
<div class="guard">${ICON.shield}<span>${escapeHtml(APPROVAL_SURFACE_NOTE)}</span></div>
</div>
</header>
<div class="wrap">
${approvalWorkbenchWarning(view)}${approvalWorkbenchMain(view, token)}
</div>`;
  return page("Artshelf approval workbench", body);
}

// NGX-541: a one-way-door purge bundle restates the no-recovery warning in the approval flow itself,
// so the irreversibility copy is present in the lane AND at the moment of approval. Keyed off the exact
// purge action so reversible (trash/dispose) bundles carry no such banner.
function approvalWorkbenchWarning(view: UiApprovalWorkbenchView): string {
  if (view.actionType !== PURGE_APPROVAL_ACTION) return "";
  return `<p class="notebox periln">${ICON.alert}<span>${escapeHtml(PURGE_APPROVAL_NOTE)}</span></p>\n`;
}

function approvalWorkbenchMain(view: UiApprovalWorkbenchView, token?: string): string {
  if (view.totalCount === 0) {
    return `<p class="empty">No reviewed candidates to approve.</p>`;
  }
  const withSelection = token !== undefined;
  const groups = view.groups.map((group) => approvalGroupSection(group, withSelection)).join("");
  if (!withSelection) return groups;
  return `<form class="approve" method="post" action="/approve">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<input type="hidden" name="sourceBundleId" value="${escapeHtml(view.bundleId)}">
${groups}
${approvalSubmit(view)}
</form>`;
}

function approvalGroupSection(group: UiApprovalGroup, withSelection: boolean): string {
  const rows = group.candidates.map((candidate) => approvalCandidateRow(candidate, withSelection)).join("");
  return `<section class="approval-group">
<h2>${escapeHtml(group.ledgerName)} <span class="muted">${escapeHtml(group.ledgerPath)}</span></h2>
${rows}
</section>`;
}

// One grouped candidate row. The article class and the state badge both carry the selected/unselected
// distinction so it survives with or without checkboxes; the checkbox (token render only) names the
// exact targetId, pre-checked to mirror the server-decided selection. Every dynamic value is escaped.
function approvalCandidateRow(candidate: UiApprovalCandidate, withSelection: boolean): string {
  const { target, selected } = candidate;
  const cls = selected ? "candidate selected" : "candidate unselected";
  const stateBadge = `<span class="sel">${selected ? "Selected" : "Not selected"}</span>`;
  const checkbox = withSelection
    ? `<input type="checkbox" name="targetId" value="${escapeHtml(target.targetId)}"${selected ? " checked" : ""}>`
    : "";
  return `<article class="${cls}">
<label class="candidate-head">${checkbox}<span class="candidate-label">${escapeHtml(target.label)}</span> ${stateBadge}</label>
<dl class="fields">
<div><dt>action</dt><dd>${escapeHtml(target.actionType)}</dd></div>
<div><dt>subject</dt><dd>${escapeHtml(approvalSubject(target))}</dd></div>
<div><dt>ledger</dt><dd>${escapeHtml(target.ledgerPath)}</dd></div>
</dl>
</article>`;
}

// The deliberate-approval submit, pinned to the foot of the form. An empty selection is an invalid
// state: the submit is disabled and a notice explains approval must name an explicit subset, so it can
// never collapse into an approve-all.
function approvalSubmit(view: UiApprovalWorkbenchView): string {
  if (view.selectedCount === 0) {
    return `<div class="approve-actions">
<span class="approve-empty">${ICON.info}Select at least one target to approve. Approval is a deliberate act over an explicit subset, never an approve-all.</span>
<button type="submit" disabled>Approve 0 selected targets</button>
</div>`;
  }
  const noun = view.selectedCount === 1 ? "target" : "targets";
  const peril = view.actionType === PURGE_APPROVAL_ACTION;
  const tally = peril
    ? `Permanently deleting <b>${view.selectedCount}</b> of ${view.totalCount} reviewed targets. This cannot be undone.`
    : `Approving <b>${view.selectedCount}</b> of ${view.totalCount} reviewed targets for the agent to revalidate.`;
  return `<div class="approve-actions">
<span class="tally">${tally}</span>
<button type="submit">${ICON.trash}Approve ${view.selectedCount} selected ${noun}</button>
</div>`;
}

// The exact subject of an approval target, typed so the reviewer sees what concretely will be acted
// on. A selected target always names one of these (enforced at the storage seam); the fallback only
// guards a malformed unselected candidate row.
function approvalSubject(target: UiApprovalTarget): string {
  if (target.recordPath) return `record ${target.recordPath}`;
  if (target.planId) return `plan ${target.planId}`;
  if (target.registryPath) return `registry ${target.registryPath}`;
  return "(no exact subject)";
}

export function renderErrorPage(options: { status: number; title: string; message: string }): string {
  const body = `<div class="errwrap">
<div class="brand"><span class="dot"></span>Artshelf</div>
<h1>${options.status} &middot; ${escapeHtml(options.title)}</h1>
<p class="reason">${escapeHtml(options.message)}</p>
<p><a href="/">&larr; back to the dashboard</a></p>
</div>`;
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
