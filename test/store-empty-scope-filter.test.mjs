import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { makeTempMemoryStore } from "./helpers/store-fixture.mjs";

function makeStore() {
  return makeTempMemoryStore({ prefix: "mymem-empty-scope-" });
}

describe("MemoryStore empty scopeFilter semantics", () => {
  it("treats [] as deny-all for scoped read APIs", async () => {
    const { store, dir } = makeStore();
    try {
      const entry = await store.store({
        text: "test memory",
        vector: [0.1, 0.2, 0.3],
        category: "cases",
        scope: "global",
        importance: 0.5,
        metadata: "{}",
      });

      assert.deepStrictEqual(await store.list([], undefined, 20, 0), []);
      assert.deepStrictEqual(await store.vectorSearch([0.1, 0.2, 0.3], 5, 0.0, []), []);
      assert.deepStrictEqual(await store.bm25Search("test", 5, []), []);
      assert.deepStrictEqual(await store.fetchForCompaction(Date.now() + 1_000, [], 20), []);
      assert.deepStrictEqual(await store.stats([]), {
        totalCount: 0,
        scopeCounts: {},
        categoryCounts: {},
        memoryCategoryCounts: {},
        recentActivity: { last24h: 0, last7d: 0, last30d: 0 },
        tierDistribution: {},
        healthSignals: { badRecall: 0, suppressed: 0, lowConfidence: 0 },
      });
      assert.strictEqual(await store.getById(entry.id, []), null);
      await assert.rejects(() => store.delete(entry.id, []), /outside accessible scopes/);
      await assert.rejects(() => store.update(entry.id, { text: "changed" }, []), /outside accessible scopes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
