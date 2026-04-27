import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "mymem-store-index-"));
  return {
    dir,
    store: new MemoryStore({ dbPath: dir, vectorDim: 4 }),
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
});
