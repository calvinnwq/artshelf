import { existsSync } from "node:fs";
import { normalizeRegistryPath } from "../registry.js";
import { printCompactJson, printJson } from "../renderers/json.js";
import { buildReviewAgentPacketAll, buildReviewAgentPacketSingle, printReview, printReviewAll, reviewNextAction } from "../renderers/review.js";
import { boolFlag, stringFlag } from "../shared/flags.js";
import type { ParsedArgs } from "../shared/cli-types.js";
import { registeredLedgersOrThrow, reviewJsonResult, reviewLedger, summarizeReview } from "./shared.js";

export function handleReview(parsed: ParsedArgs, ledgerPath: string, json: boolean): number {
  const agent = boolFlag(parsed, "agent");
  if (boolFlag(parsed, "all")) {
    const registryPath = normalizeRegistryPath(stringFlag(parsed, "registry"));
    const results = registeredLedgersOrThrow(registryPath).map((ledger) => reviewLedger(ledger));
    const ok = results.every((entry) => entry.validate.ok);
    const summary = summarizeReview(results);
    if (agent) {
      printCompactJson(buildReviewAgentPacketAll(results, summary, { path: registryPath, exists: existsSync(registryPath) }));
      return ok ? 0 : 1;
    }
    const nextAction = reviewNextAction(summary, "all");
    if (json) {
      printJson({ ok, registryPath, summary, nextAction, ledgers: results.map(reviewJsonResult) });
      return ok ? 0 : 1;
    }
    printReviewAll(results, summary, nextAction, registryPath);
    return ok ? 0 : 1;
  }
  const result = reviewLedger({ name: "current", path: ledgerPath, scope: "other", createdAt: "", updatedAt: "" }, false);
  const summary = summarizeReview([result]);
  if (agent) {
    printCompactJson(buildReviewAgentPacketSingle(result, summary, ledgerPath));
    return result.validate.ok ? 0 : 1;
  }
  if (json) {
    printJson({ ok: result.validate.ok, ledger: reviewJsonResult(result) });
    return result.validate.ok ? 0 : 1;
  }
  printReview([result]);
  return result.validate.ok ? 0 : 1;
}
