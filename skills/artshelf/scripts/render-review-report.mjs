#!/usr/bin/env node

import { readFileSync } from "node:fs";

function readInput() {
  const path = process.argv[2];
  if (path && path !== "-") {
    return readFileSync(path, "utf8");
  }
  return readFileSync(0, "utf8");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function lineForEmpty(value) {
  return value.length === 0 ? "<none>" : null;
}

function formatApprovalDecision(decision, index) {
  const lines = [
    `${index + 1}. ${decision.label}`,
    `   Why: ${decision.reason}`,
    `   Action: ${decision.nextStep}`
  ];
  if (decision.approvalTarget) {
    lines.push(`   ${decision.approvalTarget}`);
  }
  return lines.join("\n");
}

function formatNonApprovalDecision(decision, index) {
  return [
    `${index + 1}. ${decision.label}`,
    `   Why: ${decision.reason}`,
    `   Suggested next step: ${decision.nextStep}`
  ].join("\n");
}

function formatGroup(title, decisions, formatter) {
  const empty = lineForEmpty(decisions);
  return [
    title,
    empty ?? decisions.map((decision, index) => formatter(decision, index)).join("\n\n")
  ].join("\n");
}

function requireBoolean(report, path) {
  const value = path.reduce((current, key) => current?.[key], report);
  if (typeof value !== "boolean") {
    throw new Error(`missing boolean ${path.join(".")}`);
  }
  return value;
}

export function renderReviewReport(report) {
  if (report?.schemaVersion !== 1) {
    throw new Error("unsupported ArtshelfReviewReport schemaVersion");
  }

  const scope = report.scope ?? {};
  const summary = report.decisionSummary ?? {};
  const groups = report.decisionGroups ?? {};
  const ready = asArray(groups.readyForApproval);
  const needsReview = asArray(groups.needsReviewFirst);
  const blocked = asArray(groups.blocked);

  const dryRunOnly = requireBoolean(report, ["safety", "dryRunOnly"]);
  const noExecuteRan = requireBoolean(report, ["safety", "noExecuteRan"]);
  const noResolveRan = requireBoolean(report, ["safety", "noResolveRan"]);
  const noDeleteRan = requireBoolean(report, ["safety", "noDeleteRan"]);
  const safetyLine = dryRunOnly && noExecuteRan && noResolveRan && noDeleteRan
    ? "Dry-run only. No execute, resolve, or delete ran."
    : "Attention: safety flags show a mutation may have run.";

  return [
    "Artshelf daily review",
    `Status: ${scope.health ?? "attention"}; registry ${scope.registryHealth ?? "attention"}`,
    "",
    `Ready for approval: ${summary.readyForApproval ?? ready.length}`,
    `Needs review first: ${summary.needsReviewFirst ?? needsReview.length}`,
    `Blocked: ${summary.blocked ?? blocked.length}`,
    "",
    "Recommended action",
    report.recommendation,
    "",
    formatGroup("Ready for approval", ready, formatApprovalDecision),
    "",
    formatGroup("Needs review first", needsReview, formatNonApprovalDecision),
    "",
    formatGroup("Blocked", blocked, formatNonApprovalDecision),
    "",
    "Safety",
    safetyLine
  ].join("\n");
}

try {
  const report = JSON.parse(readInput());
  process.stdout.write(`${renderReviewReport(report)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
