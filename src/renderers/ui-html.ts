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
// styles and no scripts. The dashboard is display-only; detail pages carry no executable code or file
// contents and expose only token-bound triage-intent forms, never direct ledger/file/trash/plan
// mutation affordances. The loopback server (src/ui-server.ts) wires these to live state and sets the
// strict CSP (default-src 'none'; style-src 'unsafe-inline'; form-action 'self') the markup honors:
// no scripts, no external assets, no <img>, no web fonts. Interactivity (lane filters, collapsible
// stages, selection state) is therefore expressed entirely in CSS (:has(), <details>, :checked).

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
.wrap{ max-width:1080px; margin:0 auto; padding:0 24px 72px; }
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
.meta{ display:flex; flex-wrap:wrap; gap:6px 18px; font:12px/1.4 var(--mono); color:var(--ink-3); }
.meta b{ color:var(--ink-2); font-weight:600; }
.back{ display:inline-flex; align-items:center; gap:6px; font:600 12.5px/1 var(--sans); text-decoration:none; color:var(--ink-2); margin:0 0 16px; }
.back:hover{ color:var(--accent-ink); }
.guard{ display:inline-flex; align-items:flex-start; gap:9px; margin:18px 0 2px; padding:9px 13px; background:var(--surface); border:1px solid var(--line); border-radius:9px; font-size:12.5px; color:var(--ink-2); max-width:780px; }
.guard svg{ flex:none; margin-top:1px; color:var(--accent); }

/* ---- required actions ---- */
.acts{ display:grid; grid-template-columns:repeat(auto-fit,minmax(232px,1fr)); gap:14px; }
.act{ position:relative; display:flex; flex-direction:column; padding:16px 16px 14px; background:var(--surface); border:1px solid var(--line); border-radius:13px; box-shadow:var(--shadow); overflow:hidden; transition:transform .14s ease, box-shadow .14s ease; }
.act:hover{ transform:translateY(-2px); box-shadow:var(--shadow-lift); }
.act::before{ content:""; position:absolute; inset:0 auto 0 0; width:4px; background:var(--slate); }
.act.danger::before{ background:var(--danger); } .act.attn::before{ background:var(--attn); } .act.go::before{ background:var(--accent); }
.act .tag{ display:inline-flex; align-items:center; gap:6px; font:600 10px/1.3 var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); }
.act.danger .tag{ color:var(--danger); } .act.attn .tag{ color:var(--attn); }
.act .n{ font:500 38px/1 var(--serif); margin:10px 0 2px; letter-spacing:-.02em; }
.act .name{ font-weight:650; font-size:15px; margin:0; }
.act .desc{ font-size:12.5px; color:var(--ink-2); margin:6px 0 14px; line-height:1.45; flex:1; }
.act .cta{ display:inline-flex; align-items:center; gap:6px; align-self:flex-start; padding:8px 13px; border-radius:8px; font:600 13px/1 var(--sans); text-decoration:none; border:1px solid transparent; color:#fff; }
.act .cta svg{ transition:transform .14s ease; } .act .cta:hover svg{ transform:translateX(3px); }
.act.danger .cta{ background:var(--danger); } .act.attn .cta{ background:var(--attn); } .act.go .cta{ background:var(--accent); }
.act.calm .cta{ background:var(--surface-2); color:var(--ink); border-color:var(--line-2); }
@media (prefers-color-scheme: dark){ .act.danger .cta,.act.attn .cta,.act.go .cta{ color:#0e120f; } }
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
.ledger{ padding:11px 13px; background:var(--surface); border:1px solid var(--line); border-radius:10px; box-shadow:var(--shadow); }
.ledger.bad{ border-color:var(--danger-line); background:var(--danger-soft); }
.ledger .name{ font-weight:650; display:flex; align-items:center; gap:7px; }
.ledger .name .pip{ width:8px; height:8px; border-radius:50%; background:var(--good); flex:none; }
.ledger.bad .name .pip{ background:var(--danger); }
.ledger .path{ font:11.5px/1.4 var(--mono); color:var(--ink-3); word-break:break-all; margin-top:4px; }
.ledger .state{ font-size:12px; color:var(--ink-2); margin-top:5px; }
.ledger .err{ font-size:12.5px; color:var(--danger); margin-top:4px; }

/* ---- filters ---- */
.filters{ display:flex; flex-wrap:wrap; gap:18px; margin:6px 0 18px; padding:13px 15px; background:var(--surface); border:1px solid var(--line); border-radius:12px; box-shadow:var(--shadow); }
.fgroup{ display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.fgroup .lbl{ font:600 10px/1 var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); margin-right:2px; }
.chip{ position:relative; display:inline-flex; align-items:center; gap:7px; padding:6px 12px; border-radius:999px; border:1px solid var(--line-2); background:var(--surface); color:var(--ink-2); font:600 12.5px/1 var(--sans); cursor:pointer; transition:background .12s,color .12s,border-color .12s; user-select:none; }
.chip input{ position:absolute; inset:0; opacity:0; cursor:pointer; margin:0; }
.chip .c{ font:600 11px/1 var(--mono); color:var(--ink-3); }
.chip:hover{ border-color:var(--accent); }
.chip:has(input:checked){ background:var(--accent); border-color:var(--accent); color:#fff; }
.chip:has(input:checked) .c{ color:rgba(255,255,255,.8); }
.chip:has(input:focus-visible){ outline:2px solid var(--accent); outline-offset:2px; }
@media (prefers-color-scheme: dark){ .chip:has(input:checked){ color:#0e120f; } .chip:has(input:checked) .c{ color:rgba(14,18,15,.7); } }

/* ---- scriptless zone filter: a checked zone radio hides every off-zone stage via :has() ---- */
.queue:has(#flt-zone-action:checked) details.stage:not([data-zone="action"]){ display:none; }
.queue:has(#flt-zone-quarantine:checked) details.stage:not([data-zone="quarantine"]){ display:none; }
.queue:has(#flt-zone-problems:checked) details.stage:not([data-zone="problems"]){ display:none; }
.queue:has(#flt-zone-done:checked) details.stage:not([data-zone="done"]){ display:none; }

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

table.tbl{ width:100%; border-collapse:collapse; font-size:13px; }
.tbl th{ text-align:left; font:600 10px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--ink-3); padding:9px 14px; border-bottom:1px solid var(--line); white-space:nowrap; }
.tbl td{ padding:11px 14px; border-bottom:1px solid var(--line); vertical-align:top; }
.tbl tr.r:last-child td{ border-bottom:0; }
.tbl tr.r:hover{ background:var(--surface-2); }
.id{ font:600 12.5px/1.3 var(--mono); white-space:nowrap; }
.id a{ text-decoration:none; } .id a:hover{ text-decoration:underline; }
.sub{ display:block; font:11.5px/1.4 var(--mono); color:var(--ink-3); white-space:normal; word-break:break-all; margin-top:3px; font-weight:400; text-transform:none; letter-spacing:0; }
.reason{ color:var(--ink); max-width:44ch; }
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
  "needs-review": { title: "Needs review", zone: "action", rail: "attn", hint: "artifacts awaiting your judgment" },
  "needs-context": { title: "Needs context", zone: "action", rail: "attn", hint: "blocked - can't be reviewed yet" },
  cleanup: { title: "Cleanup candidates", zone: "action", rail: "accent", hint: "dry-run, then approve" },
  resolve: { title: "Resolve candidates", zone: "action", rail: "accent", hint: "close out the row" },
  trash: { title: "Trash", zone: "quarantine", rail: "slate", hint: "quarantined - still reversible" },
  "purge-candidates": { title: "Purge candidates", zone: "quarantine", rail: "danger", hint: "one-way door" },
  "registry-reconcile": { title: "Registry / reconcile problems", zone: "problems", rail: "attn", hint: "infrastructure attention" },
  "recent-receipts": { title: "Recent receipts", zone: "done", rail: "good", hint: "verified - last 7 days" }
};

export function renderDashboardPage(snapshot: DashboardSnapshot, token?: string): string {
  const counts = snapshot.counts;
  const ledgers = snapshot.ledgers;
  const okLedgers = ledgers.filter((ledger) => ledger.ok).length;
  const badLedgers = ledgers.length - okLedgers;
  const ledgerIndex = new Map(ledgers.map((ledger, i) => [ledger.path, i]));

  const actionCount = counts["needs-review"] + counts["needs-context"] + counts.cleanup + counts.resolve;
  const quarantineCount = counts.trash + counts["purge-candidates"];
  const problemsCount = counts["registry-reconcile"] + badLedgers;
  const doneCount = counts["recent-receipts"];
  const totalCount =
    actionCount + counts.trash + counts["purge-candidates"] + counts["registry-reconcile"] + doneCount;

  const body = `<header class="top">
<div class="wrap">
<div class="brand"><span class="dot"></span>Artshelf &middot; Human Review</div>
<h1>Review dashboard</h1>
<div class="meta"><span><b>${ledgers.length}</b> ledger(s) &middot; <b>${okLedgers}</b> healthy</span><span>generated <b>${escapeHtml(snapshot.generatedAt)}</b></span><span>registry <b>${escapeHtml(snapshot.registryPath)}</b></span></div>
<div class="guard">${ICON.shield}<span>${escapeHtml(REVIEW_SURFACE_NOTE)}</span></div>
</div>
</header>
<div class="wrap">
${requiredActionsSection(snapshot, badLedgers)}
${statusSummarySection({ actionCount, trash: counts.trash, purge: counts["purge-candidates"], problems: problemsCount, done: doneCount, ledgers: okLedgers, ledgerTotal: ledgers.length })}
${ledgerHealthSection(ledgers)}
<section class="block">
<p class="eyebrow">Review queue &middot; across the workflow cycle</p>
<div class="queue">
${filterBar({ totalCount, actionCount, quarantineCount, problemsCount, doneCount }, ledgers)}
${ledgerFilterStyle(ledgers)}
${artifactStage("needs-review", snapshot.buckets.needsReview, token, ledgerIndex, true)}
${artifactStage("needs-context", snapshot.buckets.needsContext, token, ledgerIndex, true)}
${artifactStage("cleanup", snapshot.buckets.cleanup, token, ledgerIndex, false)}
${artifactStage("resolve", snapshot.buckets.resolve, token, ledgerIndex, false)}
${trashStage("trash", snapshot.buckets.trash, ledgerIndex, false)}
${purgeStage(snapshot.buckets.purgeCandidates, ledgerIndex)}
${problemStage(snapshot.buckets.registryReconcile, ledgerIndex)}
${receiptStage(snapshot.buckets.recentReceipts, ledgerIndex)}
</div>
${legend()}
</section>
</div>`;
  return page("Artshelf review dashboard", body);
}

// The top fold: priority-ordered cards for the lanes that need the human now, each with a count and a
// CTA jumping to its lane. Purge leads (one-way door), then judgment-blocking lanes, then ready work,
// then infrastructure problems. When nothing needs attention it is an explicit all-clear, never blank.
function requiredActionsSection(snapshot: DashboardSnapshot, badLedgers: number): string {
  const counts = snapshot.counts;
  const cards: string[] = [];
  if (counts["purge-candidates"] > 0) {
    cards.push(
      actionCard(
        "danger",
        `${ICON.alert}One-way door`,
        counts["purge-candidates"],
        "Purge candidates",
        "Permanent deletion, <b>no recovery</b>. Nothing is preselected - the agent purges only an exact, grouped selection you approve.",
        "lane-purge-candidates",
        "Review purge"
      )
    );
  }
  if (counts["needs-review"] > 0) {
    cards.push(
      actionCard("attn", "Awaiting judgment", counts["needs-review"], "Needs review", "Artifacts due for a keep / trash / resolve decision.", "lane-needs-review", "Start review")
    );
  }
  if (counts["needs-context"] > 0) {
    cards.push(
      actionCard("attn", "Blocked", counts["needs-context"], "Needs context", "Reason or provenance is missing or vague - provide context before these can be reviewed.", "lane-needs-context", "Provide context")
    );
  }
  const ready = counts.cleanup + counts.resolve;
  if (ready > 0) {
    cards.push(
      actionCard("calm", "Ready when you are", ready, "Cleanup &amp; resolve", "Candidates the agent can act on once you approve a dry-run plan.", "lane-cleanup", "Review candidates")
    );
  }
  const problems = counts["registry-reconcile"] + badLedgers;
  if (problems > 0) {
    cards.push(
      actionCard("attn", "Infrastructure", problems, "Registry problems", "A registered ledger is unavailable or a tracked subject drifted.", "lane-registry-reconcile", "Inspect problems")
    );
  }

  const inner =
    cards.length === 0
      ? `<div class="allclear">${ICON.check}<span>You're all caught up - nothing needs review right now.</span></div>`
      : `<div class="acts">${cards.join("")}</div>`;
  return `<section class="block"><p class="eyebrow">Required actions &middot; in priority order</p>${inner}</section>`;
}

function actionCard(variant: string, tag: string, count: number, name: string, desc: string, anchor: string, cta: string): string {
  return `<article class="act ${variant}">
<span class="tag">${tag}</span>
<div class="n num">${count}</div>
<p class="name">${name}</p>
<p class="desc">${desc}</p>
<a class="cta" href="#${anchor}">${cta} ${ICON.arrow}</a>
</article>`;
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
  return `<section class="block"><p class="eyebrow">Sources &middot; ledger health</p><div class="sources">${cards}</div></section>`;
}

function filterBar(
  c: { totalCount: number; actionCount: number; quarantineCount: number; problemsCount: number; doneCount: number },
  ledgers: DashboardLedgerStatus[]
): string {
  const zoneChip = (id: string, label: string, count: number, checked = false) =>
    `<label class="chip"><input type="radio" name="flt-zone" id="${id}"${checked ? " checked" : ""}>${label} <span class="c num">${count}</span></label>`;
  const zone = `<div class="fgroup"><span class="lbl">Show</span>
${zoneChip("flt-zone-all", "All", c.totalCount, true)}
${zoneChip("flt-zone-action", "Action needed", c.actionCount)}
${zoneChip("flt-zone-quarantine", "Quarantine", c.quarantineCount)}
${zoneChip("flt-zone-problems", "Problems", c.problemsCount)}
${zoneChip("flt-zone-done", "Done", c.doneCount)}</div>`;

  // The source filter only earns its space with more than one ledger.
  let source = "";
  if (ledgers.length > 1) {
    const chips = ledgers
      .map(
        (ledger, i) =>
          `<label class="chip"><input type="radio" name="flt-led" id="flt-led-${i}">${escapeHtml(ledger.name)}</label>`
      )
      .join("\n");
    source = `<div class="fgroup"><span class="lbl">Source</span>
<label class="chip"><input type="radio" name="flt-led" id="flt-led-all" checked>All ledgers</label>
${chips}</div>`;
  }
  return `<form class="filters" aria-label="Filter the review queue">${zone}${source}</form>`;
}

// Per-ledger filter rules are generated here (not in the static stylesheet) because the ledger set is
// dynamic. Emitted as an inline <style> element, which the CSP's style-src 'unsafe-inline' permits.
// Rows carry a stable led-<index> token (never the raw name) so no record text reaches a selector.
// Each rule hides non-matching rows and then collapses any stage left with no matching row.
function ledgerFilterStyle(ledgers: DashboardLedgerStatus[]): string {
  if (ledgers.length <= 1) return "";
  const rules = ledgers
    .map(
      (_ledger, i) =>
        `.queue:has(#flt-led-${i}:checked) tr.r:not([data-ledger="led-${i}"]){display:none}\n` +
        `.queue:has(#flt-led-${i}:checked) details.stage:not(:has(tr.r[data-ledger="led-${i}"])){display:none}`
    )
    .join("\n");
  return `<style>${rules}</style>`;
}

function dataLedger(ledgerPath: string | null, ledgerIndex: Map<string, number>): string {
  const idx = ledgerPath === null ? undefined : ledgerIndex.get(ledgerPath);
  return idx === undefined ? "" : ` data-ledger="led-${idx}"`;
}

// A collapsible stage: the <details id="lane-<key>"> wrapper carries the lane anchor, zone (filter
// grouping), and rail colour. Even an empty lane renders its shell so every lane key/id is present.
function stageShell(key: DashboardBucketKey, count: number, inner: string, open: boolean, danger = ""): string {
  const lane = LANES[key];
  const body = count === 0 ? `<p class="empty">Nothing in this lane.</p>` : inner;
  return `<details class="stage" id="lane-${key}" data-zone="${lane.zone}" data-rail="${lane.rail}"${open ? " open" : ""}>
<summary>${ICON.chevron}<span class="rail"></span><span class="title">${escapeHtml(lane.title)}</span><span class="count num">${count}</span><span class="hint">${escapeHtml(lane.hint)}</span></summary>
<div class="body">${danger}${body}</div>
</details>`;
}

function artifactStage(
  key: DashboardBucketKey,
  rows: DashboardArtifactRow[],
  token: string | undefined,
  ledgerIndex: Map<string, number>,
  open: boolean
): string {
  const inner =
    rows.length === 0
      ? ""
      : `<table class="tbl"><thead><tr><th>Record</th><th>Reason</th><th>Source</th><th>Age / due</th><th>Disposition</th></tr></thead><tbody>${rows
          .map((row) => artifactRow(row, token, ledgerIndex))
          .join("")}</tbody></table>`;
  return stageShell(key, rows.length, inner, open);
}

function artifactRow(row: DashboardArtifactRow, token: string | undefined, ledgerIndex: Map<string, number>): string {
  const href = detailHref(row.recordId, row.ledgerPath, token);
  const reason = row.reason.trim() ? escapeHtml(row.reason) : `<span class="muted">(no reason recorded)</span>`;
  const due = row.dueState ? dueLabel(row.dueState) : "";
  const disposition = row.needsContext
    ? `<span class="badge ctx">${escapeHtml(row.needsContext.label)}</span>`
    : `<span class="badge rec">${escapeHtml(row.recommendation)}</span>`;
  const last = lastActionLine(row.lastAction);
  return `<tr class="r"${dataLedger(row.ledgerPath, ledgerIndex)}>
<td class="id"><a href="${href}">${escapeHtml(row.recordId)}</a><span class="sub">${escapeHtml(row.path)}</span></td>
<td class="reason">${reason}${last}</td>
<td class="src">${escapeHtml(row.ledgerName)}</td>
<td class="age">${escapeHtml(row.age)}${due}</td>
<td>${disposition}</td>
</tr>`;
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

function trashStage(
  key: DashboardBucketKey,
  rows: DashboardTrashRow[],
  ledgerIndex: Map<string, number>,
  open: boolean
): string {
  const inner =
    rows.length === 0
      ? ""
      : `<table class="tbl"><thead><tr><th>Record</th><th>Target</th><th>Source</th><th>Cleaned</th><th>Plan</th></tr></thead><tbody>${rows
          .map((row) => trashRow(row, ledgerIndex))
          .join("")}</tbody></table>`;
  return stageShell(key, rows.length, inner, open);
}

function trashRow(row: DashboardTrashRow, ledgerIndex: Map<string, number>): string {
  return `<tr class="r"${dataLedger(row.ledgerPath, ledgerIndex)}>
<td class="id">${escapeHtml(row.recordId)}</td>
<td class="reason"><span class="sub" style="margin-top:0">${escapeHtml(row.targetPath)}</span></td>
<td class="src">${escapeHtml(row.ledgerName)}</td>
<td class="age">${escapeHtml(row.cleanedAt)}<span class="due">${escapeHtml(row.age)}</span></td>
<td class="id">${escapeHtml(row.cleanupPlanId)}</td>
</tr>`;
}

// The purge-candidate lane: grouped by source/ledger with a per-group total and the exact target rows,
// fronted by the one-way-door warning. It exposes no checkbox or execution control - selecting an exact
// subset and approving it happens in the dedicated approval flow, never directly from this lane.
function purgeStage(rows: DashboardTrashRow[], ledgerIndex: Map<string, number>): string {
  const groups = groupPurgeCandidates(rows)
    .map((group) => purgeGroup(group, ledgerIndex))
    .join("");
  const danger = `<p class="stagenote">${ICON.alert}${escapeHtml(PURGE_LANE_NOTE)}</p>`;
  return stageShell("purge-candidates", rows.length, groups, true, rows.length === 0 ? "" : danger);
}

function purgeGroup(group: DashboardPurgeGroup, ledgerIndex: Map<string, number>): string {
  const rows = group.candidates
    .map(
      (row) =>
        `<tr class="r"${dataLedger(row.ledgerPath, ledgerIndex)}><td class="id">${escapeHtml(row.recordId)}</td><td class="reason"><span class="sub" style="margin-top:0">${escapeHtml(row.targetPath)}</span></td><td class="src">${escapeHtml(row.ledgerName)}</td><td class="age">${escapeHtml(row.age)}</td><td class="id">${escapeHtml(row.cleanupPlanId)}</td></tr>`
    )
    .join("");
  return `<table class="tbl"><thead><tr><th>${escapeHtml(group.ledgerName)} <span class="muted">${escapeHtml(group.ledgerPath)}</span></th><th></th><th></th><th></th><th>${group.total} candidate(s)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function problemStage(rows: DashboardProblemRow[], ledgerIndex: Map<string, number>): string {
  const inner =
    rows.length === 0
      ? ""
      : `<table class="tbl"><thead><tr><th>Target</th><th>Detail</th><th>Source</th><th>Kind</th></tr></thead><tbody>${rows
          .map((row) => problemRow(row, ledgerIndex))
          .join("")}</tbody></table>`;
  return stageShell("registry-reconcile", rows.length, inner, false);
}

function problemRow(row: DashboardProblemRow, ledgerIndex: Map<string, number>): string {
  const target = row.recordId ? escapeHtml(row.recordId) : escapeHtml(row.ledgerName ?? row.ledgerPath ?? "registry");
  const remap =
    row.currentPath && row.proposedPath
      ? `<span class="sub">${escapeHtml(row.currentPath)} &rarr; ${escapeHtml(row.proposedPath)}</span>`
      : "";
  return `<tr class="r"${dataLedger(row.ledgerPath, ledgerIndex)}>
<td class="id">${target}</td>
<td class="reason">${escapeHtml(row.detail)}${remap}</td>
<td class="src">${escapeHtml(row.ledgerName ?? row.ledgerPath ?? "-")}</td>
<td><span class="badge peril">${escapeHtml(row.source)}: ${escapeHtml(row.category)}</span></td>
</tr>`;
}

function receiptStage(rows: DashboardReceiptRow[], ledgerIndex: Map<string, number>): string {
  const inner =
    rows.length === 0
      ? ""
      : `<table class="tbl"><thead><tr><th>Record</th><th>What happened</th><th>Source</th><th>Action</th><th>Age</th></tr></thead><tbody>${rows
          .map(
            (row) =>
              `<tr class="r"${dataLedger(row.ledgerPath, ledgerIndex)}><td class="id">${escapeHtml(row.recordId)}</td><td class="reason">${escapeHtml(row.reason)}</td><td class="src">${escapeHtml(row.ledgerName)}</td><td><span class="badge">${escapeHtml(row.receiptKind)}</span></td><td class="age">${escapeHtml(row.age)}</td></tr>`
          )
          .join("")}</tbody></table>`;
  return stageShell("recent-receipts", rows.length, inner, false);
}

function legend(): string {
  const pip = (color: string, label: string) => `<span><span class="pip" style="background:${color}"></span>${label}</span>`;
  return `<div class="legend">${pip("var(--attn)", "Action needed")}${pip("var(--accent)", "Ready to act")}${pip("var(--slate)", "Quarantine")}${pip("var(--danger)", "One-way door")}${pip("var(--good)", "Done")}</div>`;
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
  return `<li><span class="badge">agent ${escapeHtml(reply.status)}</span> <span class="when">${escapeHtml(reply.createdAt)}</span>${detail}</li>`;
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
