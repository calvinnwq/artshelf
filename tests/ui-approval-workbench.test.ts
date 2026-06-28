import assert from "node:assert/strict";
import { test } from "node:test";
import { renderApprovalWorkbenchPage } from "../src/renderers/ui-html.js";
import type { UiApprovalTarget, UiApprovalWorkbenchView } from "../src/types.js";

const TOKEN = "tok_abc";

function target(overrides: Partial<UiApprovalTarget> & { targetId: string }): UiApprovalTarget {
  return {
    ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl",
    registryPath: null,
    recordPath: "/tmp/a",
    planId: "plan_a",
    actionType: "dispose",
    label: "trash scratch a",
    ...overrides
  };
}

// A two-ledger workbench with a partial selection: two of three reviewed candidates selected.
function workbench(): UiApprovalWorkbenchView {
  return {
    sessionId: "session_x",
    bundleId: "bundle_20260625_120000_abcdef01",
    actionType: "dispose",
    groups: [
      {
        ledgerName: "alpha",
        ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl",
        candidates: [
          { target: target({ targetId: "shf_a", label: "trash scratch a", recordPath: "/tmp/a" }), selected: true },
          { target: target({ targetId: "shf_b", label: "keep notes b", recordPath: "/tmp/b" }), selected: false }
        ]
      },
      {
        ledgerName: "beta",
        ledgerPath: "/ledgers/b/.artshelf/ledger.jsonl",
        candidates: [
          {
            target: target({
              targetId: "shf_c",
              label: "resolve c",
              ledgerPath: "/ledgers/b/.artshelf/ledger.jsonl",
              recordPath: "/tmp/c"
            }),
            selected: true
          }
        ]
      }
    ],
    selectedCount: 2,
    totalCount: 3
  };
}

function checkboxes(html: string): string[] {
  return html.match(/<input type="checkbox" name="targetId"[^>]*>/g) ?? [];
}

test("renderApprovalWorkbenchPage is a full scriptless HTML document summarizing the selection", () => {
  const html = renderApprovalWorkbenchPage(workbench(), TOKEN);

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<title>[^<]*approval/i);
  assert.ok(!html.includes("<script"), "the workbench page must carry no script");
  assert.match(html, /2 of 3 selected/, "the header summarizes the deliberate selection");
  assert.match(html, /dispose/, "the bundle action being approved is shown");
});

test("renderApprovalWorkbenchPage groups candidates by ledger and shows each row's label and exact target", () => {
  const html = renderApprovalWorkbenchPage(workbench(), TOKEN);

  assert.match(html, /alpha/, "first ledger group is shown");
  assert.match(html, /beta/, "second ledger group is shown");
  assert.match(html, /trash scratch a/);
  assert.match(html, /keep notes b/);
  assert.match(html, /resolve c/);
  assert.match(html, /\/tmp\/a/, "an exact record subject is shown");
  assert.match(html, /\/ledgers\/b\/\.artshelf\/ledger\.jsonl/, "the exact owning ledger is shown");
});

test("renderApprovalWorkbenchPage clearly distinguishes selected vs unselected rows", () => {
  const html = renderApprovalWorkbenchPage(workbench(), TOKEN);

  assert.match(html, /candidate selected/, "selected rows carry a distinct class");
  assert.match(html, /candidate unselected/, "unselected rows carry a distinct class");
  assert.match(html, /Not selected/, "an unselected row reads as not selected");

  const boxes = checkboxes(html);
  assert.equal(boxes.length, 3, "every candidate has a selection checkbox");
  assert.equal(boxes.filter((box) => box.includes("checked")).length, 2, "exactly the selected rows are checked");
  assert.ok(boxes.some((box) => box.includes('value="shf_a"') && box.includes("checked")));
  assert.ok(boxes.some((box) => box.includes('value="shf_b"') && !box.includes("checked")));
});

test("renderApprovalWorkbenchPage offers a deliberate approval submit and never a vague approve-all", () => {
  const html = renderApprovalWorkbenchPage(workbench(), TOKEN);

  assert.match(html, /<form[^>]*method="post"[^>]*action="\/approve"/, "the approval form posts to /approve");
  assert.match(html, /name="token" value="tok_abc"/, "the capability token is carried on the form");
  assert.match(html, /name="sourceBundleId" value="bundle_20260625_120000_abcdef01"/, "approval posts the source immutable bundle id");
  assert.doesNotMatch(html, /name="target"/, "approval never posts hidden target JSON");
  assert.match(html, /Approve 2 selected/, "the submit names the exact count being approved");
  assert.ok(!/approve all/i.test(html), "the workbench must not offer approve-all");
  assert.ok(!/select all/i.test(html), "the workbench must not offer select-all");
});

test("renderApprovalWorkbenchPage blocks approval when nothing is selected", () => {
  const view: UiApprovalWorkbenchView = {
    sessionId: "session_x",
    bundleId: "bundle_20260625_120000_abcdef01",
    actionType: "dispose",
    groups: [
      {
        ledgerName: "alpha",
        ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl",
        candidates: [{ target: target({ targetId: "shf_a" }), selected: false }]
      }
    ],
    selectedCount: 0,
    totalCount: 1
  };

  const html = renderApprovalWorkbenchPage(view, TOKEN);

  assert.match(html, /select at least one/i, "an empty selection shows an invalid-selection notice");
  assert.match(html, /<button[^>]*disabled/i, "the approve submit is disabled with an empty selection");
});

test("renderApprovalWorkbenchPage renders an explicit empty state with no form when there are no candidates", () => {
  const html = renderApprovalWorkbenchPage(
    {
      sessionId: "session_x",
      bundleId: "bundle_20260625_120000_abcdef01",
      actionType: "dispose",
      groups: [],
      selectedCount: 0,
      totalCount: 0
    },
    TOKEN
  );

  assert.match(html, /no reviewed candidates/i, "the empty pool is an explicit state, not a blank panel");
  assert.ok(!html.includes("<form"), "there is no approval form when there is nothing to approve");
});

test("renderApprovalWorkbenchPage without a token is read-only with no form or selection inputs", () => {
  const html = renderApprovalWorkbenchPage(workbench());

  assert.ok(!html.includes("<form"), "a tokenless render carries no approval form");
  assert.ok(!html.includes('type="checkbox"'), "a tokenless render carries no selection inputs");
  assert.match(html, /candidate selected/, "it still distinguishes selected rows");
  assert.match(html, /candidate unselected/, "it still distinguishes unselected rows");
});

test("renderApprovalWorkbenchPage escapes candidate-supplied label and path text", () => {
  const view: UiApprovalWorkbenchView = {
    sessionId: "session_x",
    bundleId: "bundle_20260625_120000_abcdef01",
    actionType: "dispose",
    groups: [
      {
        ledgerName: "alpha",
        ledgerPath: "/ledgers/a/.artshelf/ledger.jsonl",
        candidates: [
          {
            target: target({ targetId: "shf_a", label: "<script>alert(1)</script>", recordPath: '/tmp/"evil"' }),
            selected: true
          }
        ]
      }
    ],
    selectedCount: 1,
    totalCount: 1
  };

  const html = renderApprovalWorkbenchPage(view, TOKEN);

  assert.ok(!html.includes("<script>alert(1)</script>"), "record-supplied markup must not render as markup");
  assert.match(html, /&lt;script&gt;/, "angle brackets are escaped");
  assert.match(html, /&quot;evil&quot;/, "quotes in a path are escaped");
});
