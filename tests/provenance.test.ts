import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareRecord } from "../src/ledger.js";
import { computeProvenance } from "../src/provenance.js";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "artshelf-provenance-"));
}

test("repo-local artifact records repo root, relative path, basename, and file fingerprint", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  mkdirSync(join(repo, "build"), { recursive: true });
  const artifact = join(repo, "build", "out.txt");
  writeFileSync(artifact, "hello");

  const provenance = computeProvenance(artifact, { ledgerPath: ledger });

  assert.equal(provenance.root, "repo");
  assert.equal(provenance.rootPath, repo);
  assert.equal(provenance.relativePath, "build/out.txt");
  assert.equal(provenance.basename, "out.txt");
  assert.equal(provenance.pathKind, "file");
  assert.deepEqual(provenance.fingerprint, { byteSize: 5 });
});

test("ledger-local path records ledger root and a rename-stable relative path", () => {
  const repo = fixture();
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  mkdirSync(join(repo, ".artshelf", "trash", "plan_1"), { recursive: true });
  const target = join(repo, ".artshelf", "trash", "plan_1", "shf_x-out.txt");
  writeFileSync(target, "x");

  const provenance = computeProvenance(target, { ledgerPath: ledger });

  assert.equal(provenance.root, "ledger");
  assert.equal(provenance.rootPath, join(repo, ".artshelf"));
  assert.equal(provenance.relativePath, "trash/plan_1/shf_x-out.txt");
  assert.equal(provenance.basename, "shf_x-out.txt");
});

test("path outside repo and ledger roots is external with no reconstruct data", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const outside = fixture();
  const artifact = join(outside, "external.txt");
  writeFileSync(artifact, "data");

  const provenance = computeProvenance(artifact, { ledgerPath: ledger });

  assert.equal(provenance.root, "external");
  assert.equal(provenance.rootPath, null);
  assert.equal(provenance.relativePath, null);
  assert.equal(provenance.basename, "external.txt");
  assert.equal(provenance.pathKind, "file");
  assert.equal(provenance.fingerprint?.byteSize, 4);
});

test("directory artifacts record directory kind without a file fingerprint", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const dir = join(repo, "artifacts");
  mkdirSync(dir, { recursive: true });

  const provenance = computeProvenance(dir, { ledgerPath: ledger });

  assert.equal(provenance.pathKind, "directory");
  assert.equal(provenance.root, "repo");
  assert.equal(provenance.relativePath, "artifacts");
  assert.equal(provenance.fingerprint, undefined);
});

test("ledger-local relative paths are identical across .shelf and .artshelf roots", () => {
  const shelfRepo = fixture();
  const artshelfRepo = fixture();
  const shelfLedger = join(shelfRepo, ".shelf", "ledger.jsonl");
  const artshelfLedger = join(artshelfRepo, ".artshelf", "ledger.jsonl");
  mkdirSync(join(shelfRepo, ".shelf", "trash", "p"), { recursive: true });
  mkdirSync(join(artshelfRepo, ".artshelf", "trash", "p"), { recursive: true });
  const shelfTarget = join(shelfRepo, ".shelf", "trash", "p", "f.txt");
  const artshelfTarget = join(artshelfRepo, ".artshelf", "trash", "p", "f.txt");
  writeFileSync(shelfTarget, "f");
  writeFileSync(artshelfTarget, "f");

  const shelfProvenance = computeProvenance(shelfTarget, { ledgerPath: shelfLedger });
  const artshelfProvenance = computeProvenance(artshelfTarget, { ledgerPath: artshelfLedger });

  assert.equal(shelfProvenance.root, "ledger");
  assert.equal(artshelfProvenance.root, "ledger");
  assert.equal(shelfProvenance.relativePath, "trash/p/f.txt");
  assert.equal(artshelfProvenance.relativePath, "trash/p/f.txt");
});

test("missing paths are classified without throwing and carry no fingerprint", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const missing = join(repo, "gone.txt");

  const provenance = computeProvenance(missing, { ledgerPath: ledger });

  assert.equal(provenance.root, "repo");
  assert.equal(provenance.relativePath, "gone.txt");
  assert.equal(provenance.pathKind, "other");
  assert.equal(provenance.fingerprint, undefined);
});

test("prepareRecord stamps provenance derived from the ledger root onto new records", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const artifact = join(repo, "scratch.txt");
  writeFileSync(artifact, "hello");

  const record = prepareRecord({ path: artifact, reason: "scratch", ttl: "1d", labels: [] }, ledger);

  assert.equal(record.provenance?.root, "repo");
  assert.equal(record.provenance?.rootPath, repo);
  assert.equal(record.provenance?.relativePath, "scratch.txt");
  assert.equal(record.provenance?.basename, "scratch.txt");
  assert.equal(record.provenance?.pathKind, "file");
  assert.deepEqual(record.provenance?.fingerprint, { byteSize: 5 });
});
