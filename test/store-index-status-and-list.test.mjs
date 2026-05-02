import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { nullLogger } = jiti("../src/logger.ts");

function makeStore(logger = undefined) {
  const dir = mkdtempSync(join(tmpdir(), "mymem-store-index-"));
  return {
    dir,
    store: new MemoryStore({ dbPath: dir, vectorDim: 4, logger }),
  };
}

describe("MemoryStore index status and list pagination", () => {
  it("reports recommended scalar indexes and keeps list sorted newest-first", async () => {
    const { dir, store } = makeStore();
    try {
      const base = Date.now() - 10_000;
      for (let i = 0; i < 5; i++) {
        await store.importEntry({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          text: `memory-${i}`,
          vector: [1, 0, 0, 0],
          category: "fact",
          scope: i % 2 === 0 ? "global" : "agent:main",
          importance: 0.5,
          timestamp: base + i * 1000,
          metadata: "{}",
        });
      }

      const indexStatus = await store.getIndexStatus();
      assert.equal(indexStatus.available.fts, true);
      assert.ok(indexStatus.available.scalar.includes("id"));
      assert.ok(indexStatus.available.scalar.includes("timestamp"));
      assert.deepEqual(indexStatus.missingRecommendedScalars, []);

      const page = await store.list(undefined, undefined, 2, 1);
      assert.deepEqual(
        page.map((entry) => entry.text),
        ["memory-3", "memory-2"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records the FTS initialization error when index creation fails", async () => {
    const originalCreateFtsIndex = MemoryStore.prototype.createFtsIndex;
    MemoryStore.prototype.createFtsIndex = async function mockCreateFtsIndex() {
      throw new Error("simulated FTS failure");
    };

    const { dir, store } = makeStore(nullLogger);
    try {
      const indexStatus = await store.getIndexStatus();
      assert.equal(indexStatus.available.fts, false);

      const ftsStatus = store.getFtsStatus();
      assert.equal(ftsStatus.available, false);
      assert.match(ftsStatus.lastError || "", /simulated FTS failure/);
      assert.match(store.lastFtsError || "", /simulated FTS failure/);
    } finally {
      MemoryStore.prototype.createFtsIndex = originalCreateFtsIndex;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses an existing versioned FTS index without rebuilding", async () => {
    const { dir, store } = makeStore(nullLogger);
    let dropCount = 0;
    let createCount = 0;
    writeFileSync(join(dir, ".mymem-fts-index.version"), "ngram-v1\n");
    const table = {
      async listIndices() {
        return [{ name: "text_idx", indexType: "FTS", columns: ["text"] }];
      },
      async dropIndex() {
        dropCount++;
      },
      async createIndex() {
        createCount++;
      },
    };

    try {
      await store.createFtsIndex(table);
      assert.equal(dropCount, 0);
      assert.equal(createCount, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates an unversioned FTS index once and writes the version marker", async () => {
    const { dir, store } = makeStore(nullLogger);
    let dropCount = 0;
    let createCount = 0;
    const table = {
      async listIndices() {
        return [{ name: "text_idx", indexType: "FTS", columns: ["text"] }];
      },
      async dropIndex() {
        dropCount++;
      },
      async createIndex() {
        createCount++;
      },
    };

    try {
      await store.createFtsIndex(table);
      assert.equal(dropCount, 1);
      assert.equal(createCount, 1);
      assert.equal(readFileSync(join(dir, ".mymem-fts-index.version"), "utf8"), "ngram-v1\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
