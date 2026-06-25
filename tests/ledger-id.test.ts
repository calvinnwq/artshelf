import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendPreparedRecord, prepareRecord, readLedger } from "../src/ledger.js";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "artshelf-ledger-id-test-"));
}

test("appendPreparedRecord assigns a fresh id when a prepared id collides", () => {
  const root = fixture();
  const ledger = join(root, ".artshelf", "ledger.jsonl");
  const firstArtifact = join(root, "first.txt");
  const secondArtifact = join(root, "second.txt");
  writeFileSync(firstArtifact, "first");
  writeFileSync(secondArtifact, "second");

  const first = prepareRecord({ path: firstArtifact, reason: "first", ttl: "1d", labels: [] }, ledger);
  appendPreparedRecord(ledger, first);

  const second = {
    ...prepareRecord({ path: secondArtifact, reason: "second", ttl: "1d", labels: [] }, ledger),
    id: first.id
  };
  appendPreparedRecord(ledger, second);

  const records = readLedger(ledger);
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map((record) => record.id)).size, 2);
  assert.notEqual(records.find((record) => record.path === secondArtifact)?.id, first.id);
});
