#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const APPROVAL_ACTIONS = new Set(["cleanup", "trash-purge", "resolve-missing"]);
const NON_APPROVAL_ACTIONS = new Set(["inspect", "fix-registry", "keep-or-snooze", "change-retention"]);
const APPROVAL_TARGET_PATTERNS = {
  cleanup: /^approve artshelf cleanup ledger .+ plan .+$/,
  "trash-purge": /^approve artshelf trash purge ledger .+ plan .+$/,
  "resolve-missing": /^approve artshelf resolve missing ledger .+ ids .+$/
};

function readInput() {
  const path = process.argv[2];
  if (path && path !== "-") {
    return readFileSync(path, "utf8");
  }
  return readFileSync(0, "utf8");
}

function lineForEmpty(value) {
  return value.length === 0 ? "<none>" : null;
}

function formatApprovalDecision(decision, index) {
  const lines = [
    `${index + 1}. ${decision.label}`,
    `   Why: ${decision.reason}`,
    `   Action: ${decision.nextStep}`,
    `   ${decision.approvalTarget}`
  ];
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

function requireArray(report, path) {
  const value = path.reduce((current, key) => current?.[key], report);
  if (!Array.isArray(value)) {
    throw new Error(`missing array ${path.join(".")}`);
  }
  return value;
}

function requireString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing string ${path}`);
  }
  return value;
}

function requireActionType(value, allowed, path) {
  const actionType = requireString(value, path);
  if (!allowed.has(actionType)) {
    throw new Error(`unsupported actionType ${path}`);
  }
  return actionType;
}

function validateDecision(decision, path, allowedActions) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new Error(`missing object ${path}`);
  }
  requireString(decision.label, `${path}.label`);
  requireActionType(decision.actionType, allowedActions, `${path}.actionType`);
  requireString(decision.reason, `${path}.reason`);
  requireString(decision.nextStep, `${path}.nextStep`);
  return decision;
}

function validateApprovalDecision(decision, index) {
  const path = `decisionGroups.readyForApproval.${index}`;
  validateDecision(decision, path, APPROVAL_ACTIONS);
  const approvalTarget = requireString(decision.approvalTarget, `${path}.approvalTarget`);
  if (!APPROVAL_TARGET_PATTERNS[decision.actionType].test(approvalTarget)) {
    throw new Error(`invalid approvalTarget ${path}.approvalTarget`);
  }
  return decision;
}

function validateNonApprovalDecision(group, decision, index) {
  return validateDecision(decision, `decisionGroups.${group}.${index}`, NON_APPROVAL_ACTIONS);
}

export function renderReviewReport(report) {
  if (report?.schemaVersion !== 1) {
    throw new Error("unsupported ArtshelfReviewReport schemaVersion");
  }

  const scope = report.scope ?? {};
  const summary = report.decisionSummary ?? {};
  const ready = requireArray(report, ["decisionGroups", "readyForApproval"]).map(validateApprovalDecision);
  const needsReview = requireArray(report, ["decisionGroups", "needsReviewFirst"])
    .map((decision, index) => validateNonApprovalDecision("needsReviewFirst", decision, index));
  const blocked = requireArray(report, ["decisionGroups", "blocked"])
    .map((decision, index) => validateNonApprovalDecision("blocked", decision, index));

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = JSON.parse(readInput());
    process.stdout.write(`${renderReviewReport(report)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
