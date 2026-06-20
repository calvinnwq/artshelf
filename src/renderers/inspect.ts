import type { InspectRecommendation, InspectReport } from "../inspect.js";
import { shellArg } from "../shared/shell-quote.js";
import type { Retention } from "../types.js";
import { attentionGlyph } from "./attention.js";

// Agent/compact surface for `artshelf get <id> --inspect --agent`. It wraps the
// deterministic InspectReport with read-only safety guarantees, the next-safe
// action, and a reproducer command so a portable agent skill can act without
// re-deriving anything. Read-only: nothing here ever mutates the ledger or files.
export type InspectAgentPacket = {
  schemaVersion: 1;
  command: "get";
  mode: "inspect";
  ledgerPath: string;
  inspect: InspectReport;
  safety: { readOnly: true; noFileMoves: true; noLedgerMutation: true };
  nextAction: string;
  verification: string;
};

// Buckets whose next-safe action is something other than "leave it alone" get the
// attention glyph so a scanned card reads as a decision, not just a status line.
const ATTENTION_RECOMMENDATIONS: ReadonlySet<InspectRecommendation> = new Set<InspectRecommendation>([
  "trash-safe",
  "resolve-only",
  "blocked"
]);

export function buildInspectAgentPacket(report: InspectReport, ledgerPath: string): InspectAgentPacket {
  return {
    schemaVersion: 1,
    command: "get",
    mode: "inspect",
    ledgerPath,
    inspect: report,
    safety: {
      readOnly: true,
      noFileMoves: true,
      noLedgerMutation: true
    },
    nextAction: report.nextAction,
    verification: `artshelf get ${shellArg(report.id)} --inspect --agent --ledger ${shellArg(ledgerPath)}`
  };
}

export function printInspect(report: InspectReport, ledgerPath: string): void {
  const glyph = attentionGlyph(ATTENTION_RECOMMENDATIONS.has(report.recommendation));
  const labels = report.labels.length > 0 ? report.labels.map(sanitizeHumanLine).join(", ") : "none";

  const lines: string[] = [];
  lines.push(`${glyph} ${sanitizeHumanLine(report.id)} [${sanitizeHumanLine(report.kind)}] — ${sanitizeHumanLine(report.recommendation)}`);
  lines.push(`path: ${sanitizeHumanLine(report.path)}`);
  // Trashed records point `path` at the now-empty original; existence and size
  // describe the trash target, so name it explicitly when the two differ.
  if (report.subjectPath !== report.path) lines.push(`trash target: ${sanitizeHumanLine(report.subjectPath)}`);
  lines.push(
    `status: ${sanitizeHumanLine(report.status)} · cleanup: ${sanitizeHumanLine(report.cleanup)} · owner: ${sanitizeHumanLine(report.owner)} · labels: ${labels}`
  );
  lines.push(
    `existence: ${sanitizeHumanLine(formatExistence(report))} · age: ${sanitizeHumanLine(report.age)} · retention: ${sanitizeHumanLine(formatRetention(report.retention))} · due: ${sanitizeHumanLine(report.dueState ?? "n/a")}`
  );
  lines.push(`reason: ${sanitizeHumanLine(report.reason)}`);
  lines.push(`next: ${sanitizeHumanLine(report.nextAction)}`);
  lines.push(`ledger: ${sanitizeHumanLine(ledgerPath)}`);

  process.stdout.write(`${lines.join("\n")}\n`);
}

function formatExistence(report: InspectReport): string {
  if (report.existence === "missing") return "missing";
  if (report.nodeKind === "file" || report.nodeKind === "directory") {
    const size = report.byteSize === null ? "size unavailable" : formatBytes(report.byteSize);
    if (report.nodeKind === "directory" && report.byteSizeTruncated) {
      return `present (directory, at least ${size}; scan capped)`;
    }
    return `present (${report.nodeKind}, ${size})`;
  }
  return "present (other)";
}

function formatRetention(retention: Retention): string {
  if (retention.mode === "ttl") return `ttl ${retention.ttl}`;
  if (retention.mode === "retain-until") return `retain-until ${retention.retainUntil}`;
  return "manual-review";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sanitizeHumanLine(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (char === "\\") {
      out += "\\\\";
    } else if (char === "\n") {
      out += "\\n";
    } else if (char === "\r") {
      out += "\\r";
    } else if (char === "\t") {
      out += "\\t";
    } else if (code < 32 || (code >= 0x7f && code <= 0x9f) || isUnicodeFormatControl(code)) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += char;
    }
  }
  return out;
}

function isUnicodeFormatControl(code: number): boolean {
  if (code === 0x00ad || code === 0x061c) return true;
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2060 && code <= 0x206f) return true;
  if (code >= 0xfe00 && code <= 0xfe0f) return true;
  return code >= 0xfff9 && code <= 0xfffb;
}
