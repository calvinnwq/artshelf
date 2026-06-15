import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendPreparedRecord, prepareRecord, readLedger, validateLedger } from "../src/ledger.js";
import { computeProvenance, validateProvenance } from "../src/provenance.js";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "artshelf-provenance-"));
}

// A minimally valid legacy ledger row (no provenance field) for validation fixtures.
function legacyRecord(path: string): Record<string, unknown> {
  return {
    id: "shf_legacy_1",
    path,
    kind: "scratch",
    reason: "fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    retention: { mode: "manual-review" },
    cleanup: "review",
    owner: "manual",
    labels: [],
    status: "active"
  };
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

test("validateProvenance accepts well-formed repo and external provenance", () => {
  assert.deepEqual(
    validateProvenance({ root: "repo", rootPath: "/r", relativePath: "a/b.txt", basename: "b.txt", pathKind: "file" }),
    []
  );
  assert.deepEqual(
    validateProvenance({ root: "ledger", rootPath: "/r/.artshelf", relativePath: "trash/p/f", basename: "f", pathKind: "file", fingerprint: { byteSize: 0 } }),
    []
  );
  assert.deepEqual(
    validateProvenance({ root: "external", rootPath: null, relativePath: null, basename: "b.txt", pathKind: "file" }),
    []
  );
});

test("validateProvenance rejects a non-object provenance value", () => {
  assert.ok(validateProvenance("nope").length > 0);
  assert.ok(validateProvenance(null).length > 0);
});

test("validateProvenance rejects an unknown root kind", () => {
  const problems = validateProvenance({ root: "bogus", rootPath: null, relativePath: null, basename: "b", pathKind: "file" });
  assert.ok(problems.some((p) => p.includes("root")));
});

test("validateProvenance rejects an invalid pathKind", () => {
  const problems = validateProvenance({ root: "repo", rootPath: "/r", relativePath: "b", basename: "b", pathKind: "weird" });
  assert.ok(problems.some((p) => p.includes("pathKind")));
});

test("validateProvenance rejects a missing basename", () => {
  const problems = validateProvenance({ root: "repo", rootPath: "/r", relativePath: "b", pathKind: "file" });
  assert.ok(problems.some((p) => p.includes("basename")));
});

test("validateProvenance rejects reconstructable roots missing rootPath or relativePath", () => {
  assert.ok(
    validateProvenance({ root: "repo", rootPath: "/r", relativePath: null, basename: "b", pathKind: "file" }).length > 0
  );
  assert.ok(
    validateProvenance({ root: "ledger", rootPath: null, relativePath: "b", basename: "b", pathKind: "file" }).length > 0
  );
});

test("validateProvenance rejects external provenance that still carries reconstruct data", () => {
  assert.ok(
    validateProvenance({ root: "external", rootPath: "/r", relativePath: null, basename: "b", pathKind: "file" }).length > 0
  );
});

test("validateProvenance rejects a fingerprint with a non-numeric byteSize", () => {
  const problems = validateProvenance({ root: "repo", rootPath: "/r", relativePath: "b", basename: "b", pathKind: "file", fingerprint: { byteSize: "big" } });
  assert.ok(problems.some((p) => p.includes("fingerprint")));
});

test("validateLedger accepts a legacy record that has no provenance field", () => {
  const repo = fixture();
  const artifact = join(repo, "a.txt");
  writeFileSync(artifact, "a");
  const ledger = join(repo, "ledger.jsonl");
  writeFileSync(ledger, `${JSON.stringify(legacyRecord(artifact))}\n`);

  const result = validateLedger(ledger);

  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.ok(!result.errors.some((e) => e.includes("provenance")));
});

test("validateLedger flags a record whose provenance is structurally malformed", () => {
  const repo = fixture();
  const artifact = join(repo, "a.txt");
  writeFileSync(artifact, "a");
  const ledger = join(repo, "ledger.jsonl");
  const record = {
    ...legacyRecord(artifact),
    provenance: { root: "bogus", rootPath: null, relativePath: null, basename: "a.txt", pathKind: "file" }
  };
  writeFileSync(ledger, `${JSON.stringify(record)}\n`);

  const result = validateLedger(ledger);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("provenance")));
});

test("provenance round-trips through ledger append and read unchanged", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(repo, ".artshelf", "ledger.jsonl");
  const artifact = join(repo, "out.bin");
  writeFileSync(artifact, "abcd");

  const record = prepareRecord({ path: artifact, reason: "scratch", ttl: "1d", labels: [] }, ledger);
  appendPreparedRecord(ledger, record);
  const [reread] = readLedger(ledger);

  assert.deepEqual(reread?.provenance, record.provenance);
  assert.equal(reread?.provenance?.root, "repo");
  assert.equal(reread?.provenance?.relativePath, "out.bin");
  assert.deepEqual(reread?.provenance?.fingerprint, { byteSize: 4 });
});
