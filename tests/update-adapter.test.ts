import assert from "node:assert/strict";
import { test } from "node:test";
import { createUpdateAdapter } from "../src/adapters/update.js";

test("update adapter uses injected cache, env, fetch, and clock boundaries", async () => {
  const writes: string[] = [];
  let fetches = 0;
  const adapter = createUpdateAdapter({
    currentVersion: "1.0.0",
    registryUrl: "https://registry.example/artshelf/latest",
    env: {
      ARTSHELF_UPDATE_CHECK_TTL_MS: "60000"
    },
    now: () => 2_000,
    cachePath: () => "/tmp/artshelf-update-cache.json",
    fileExists: () => false,
    readTextFile: () => {
      throw new Error("cache should be absent");
    },
    writeTextFile: (_path: string, contents: string) => {
      writes.push(contents);
    },
    ensureDirectory: () => undefined,
    fetchLatestVersion: async (registryUrl: string) => {
      assert.equal(registryUrl, "https://registry.example/artshelf/latest");
      fetches += 1;
      return "1.2.0";
    }
  });

  const info = await adapter.getUpdateInfo({ force: false });

  assert.deepEqual(info, { current: "1.0.0", latest: "1.2.0", updateAvailable: true });
  assert.equal(fetches, 1);
  assert.equal(JSON.parse(writes[0] ?? "{}").checkedAt, 2_000);
});

test("update adapter reuses fresh null cache entries without fetching", async () => {
  let fetches = 0;
  const adapter = createUpdateAdapter({
    currentVersion: "1.0.0",
    registryUrl: "https://registry.example/artshelf/latest",
    env: {
      ARTSHELF_NO_UPDATE_CHECK_TTL_MS: "60000"
    },
    now: () => 2_000,
    cachePath: () => "/tmp/artshelf-update-cache.json",
    fileExists: () => true,
    readTextFile: () => JSON.stringify({ latest: null, checkedAt: 1_500 }),
    writeTextFile: () => {
      throw new Error("fresh cache should not be rewritten");
    },
    ensureDirectory: () => undefined,
    fetchLatestVersion: async () => {
      fetches += 1;
      return "1.2.0";
    }
  });

  const info = await adapter.getUpdateInfo({ force: false });

  assert.equal(info, null);
  assert.equal(fetches, 0);
});
