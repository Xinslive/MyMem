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
          category: "cases",
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

  it("applies quality filters before list pagination", async () => {
    const { dir, store } = makeStore();
    try {
      const base = Date.now() - 10_000;
      const fixtures = [
        { text: "new high confidence", timestamp: base + 4_000, metadata: { confidence: 0.91, state: "confirmed" } },
        { text: "newest bad recall", timestamp: base + 3_000, metadata: { confidence: 0.8, state: "confirmed", bad_recall_count: 2 } },
        { text: "older low confidence", timestamp: base + 2_000, metadata: { confidence: 0.21, state: "confirmed" } },
        { text: "old archived", timestamp: base + 1_000, metadata: { confidence: 0.7, state: "archived" } },
        {
          text: "old suppressed",
          timestamp: base,
          metadata: {
            confidence: 0.7,
            state: "confirmed",
            suppressed_until_turn: 3,
            suppressed_session_key: "session-1",
            suppressed_until_at: Date.now() + 60_000,
          },
        },
      ];

      for (let i = 0; i < fixtures.length; i++) {
        await store.importEntry({
          id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          text: fixtures[i].text,
          vector: [1, 0, 0, 0],
          category: "cases",
          scope: "global",
          importance: 0.5,
          timestamp: fixtures[i].timestamp,
          metadata: JSON.stringify(fixtures[i].metadata),
        });
      }

      const lowConfidence = await store.list(["global"], undefined, 1, 0, { quality: "low_confidence" });
      assert.deepEqual(lowConfidence.map((entry) => entry.text), ["older low confidence"]);

      const badRecall = await store.list(["global"], undefined, 1, 0, { quality: "bad_recall" });
      assert.deepEqual(badRecall.map((entry) => entry.text), ["newest bad recall"]);

      const suppressed = await store.list(["global"], undefined, 1, 0, { quality: "suppressed" });
      assert.deepEqual(suppressed.map((entry) => entry.text), ["old suppressed"]);

      const inactive = await store.list(["global"], undefined, 1, 0, { quality: "inactive" });
      assert.deepEqual(inactive.map((entry) => entry.text), ["old archived"]);
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

  it("migrates legacy top-level categories and stats report six-category counts", async () => {
    const { dir, store } = makeStore();
    try {
      await store.importEntry({
        id: "20000000-0000-4000-8000-000000000001",
        text: "legacy preference row",
        vector: [1, 0, 0, 0],
        category: "preference",
        scope: "global",
        importance: 0.8,
        timestamp: Date.now(),
        metadata: "{}",
      });
      await store.importEntry({
        id: "20000000-0000-4000-8000-000000000002",
        text: "legacy fact row",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "agent:main",
        importance: 0.6,
        timestamp: Date.now(),
        metadata: "{}",
      });

      store.close();
      const reopened = new MemoryStore({ dbPath: dir, vectorDim: 4, logger: nullLogger });
      try {
        const all = await reopened.list(undefined, undefined, 10, 0);
        assert.deepEqual(
          new Set(all.map((entry) => entry.category)),
          new Set(["preferences", "cases"]),
        );

        const stats = await reopened.stats();
        assert.equal(stats.categoryCounts.preferences, 1);
        assert.equal(stats.categoryCounts.cases, 1);
        assert.equal(stats.categoryCounts.preference, undefined);
        assert.equal(stats.categoryCounts.fact, undefined);
        assert.equal(stats.memoryCategoryCounts.preferences, 1);
        assert.equal(stats.memoryCategoryCounts.cases, 1);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps stats bounded and avoids full-row scans", async () => {
    const { dir, store } = makeStore(nullLogger);
    try {
      store.table = {
        countRows: async (filter) => {
          if (!filter) return 1_000;
          if (filter.includes("timestamp")) return 7;
          if (filter.includes("category = 'cases'") || filter.includes("category = 'fact'")) return 1_000;
          if (filter.includes("scope = 'global'") || filter.includes("scope IS NULL")) return 1_000;
          if (filter.includes('"memory_layer"')) return 0;
          if (filter.includes("bad_recall_count")) return 0;
          if (filter.includes("suppressed_until")) return 0;
          if (filter.includes("confidence")) return 0;
          return 0;
        },
        query: () => {
          let limitValue = 0;
          return {
            select() {
              return this;
            },
            where() {
              return this;
            },
            limit(value) {
              limitValue = value;
              return this;
            },
            async toArray() {
              assert.equal(limitValue, 500, "stats scope sampling must stay bounded");
              return [{ scope: "global" }];
            },
          };
        },
      };

      const stats = await store.stats();
      assert.equal(stats.totalCount, 1_000);
      assert.equal(stats.scopeCounts.global, 1_000);
      assert.equal(stats.categoryCounts.cases, 1_000);
    } finally {
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
