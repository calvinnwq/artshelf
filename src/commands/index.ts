import { normalizeLedgerPath } from "../ledger.js";
import { boolFlag, stringFlag } from "../shared/flags.js";
import type { CommandRunResult, ParsedArgs } from "../shared/cli-types.js";
import { handleCleanup } from "./cleanup.js";
import { handleDispose } from "./dispose.js";
import { handleDoctor } from "./doctor.js";
import { handleDue } from "./due.js";
import { handleFind } from "./find.js";
import { handleGet } from "./get.js";
import { handleLedgers } from "./ledgers.js";
import { handleList } from "./list.js";
import { handlePut } from "./put.js";
import { handleReconcile } from "./reconcile.js";
import { handleResolve } from "./resolve.js";
import { handleReview } from "./review.js";
import { handleStatus } from "./status.js";
import { handleTrash } from "./trash.js";
import { handleUpdate, maybeNotifyAvailableUpdate } from "./update.js";
import { handleValidate } from "./validate.js";

export { maybeNotifyAvailableUpdate };

export async function runCommand(parsed: ParsedArgs): Promise<CommandRunResult> {
  let status = 0;
  let shouldCheckForUpdate = true;

  switch (parsed.command) {
    case "put":
      status = handlePut(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      break;
    case "ledgers":
      status = handleLedgers(parsed, boolFlag(parsed, "json"));
      break;
    case "list":
      status = handleList(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      break;
    case "find":
      status = handleFind(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      break;
    case "get":
      status = handleGet(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      break;
    case "due":
      status = handleDue(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      break;
    case "validate":
      status = handleValidate(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      break;
    case "cleanup":
      status = handleCleanup(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      break;
    case "dispose":
      status = handleDispose(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      break;
    case "reconcile":
      status = handleReconcile(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      break;
    case "trash":
      status = handleTrash(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      break;
    case "review":
      status = handleReview(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      break;
    case "doctor":
      status = handleDoctor(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      break;
    case "status":
      status = handleStatus(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      break;
    case "resolve":
      status = handleResolve(parsed, normalizeLedgerPath(stringFlag(parsed, "ledger")), boolFlag(parsed, "json"));
      break;
    case "update":
      shouldCheckForUpdate = false;
      status = await handleUpdate(parsed, boolFlag(parsed, "json"));
      break;
    default:
      throw new Error(`Unknown command: ${parsed.command}`);
  }

  return { status, shouldCheckForUpdate };
}
