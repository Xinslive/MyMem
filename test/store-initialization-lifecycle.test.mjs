import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { nullLogger } = jiti("../src/logger.ts");

function makeEntry(id, text = "lifecycle memory") {
  return {
    id,
    text,
    vector: [1, 0, 0],
    category: "cases",
    scope: "global",
    importance: 0.5,
    timestamp: Date.now(),
    metadata: "{}",
  };
}

describe("MemoryStore initialization lifecycle", () => {
  it("closes LanceDB handles and can reinitialize after close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mymem-store-close-"));
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3, logger: nullLogger });

    try {
      await store.importEntry(makeEntry("00000000-0000-4000-8000-000000000001"));

      const table = store.table;
      const db = store.db;
      assert.equal(table?.isOpen(), true);
      assert.equal(db?.isOpen(), true);

      store.close();

      assert.equal(table.isOpen(), false);
      assert.equal(db.isOpen(), false);
      assert.equal(store.table, null);
      assert.equal(store.db, null);
      assert.equal(store.initPromise, null);

      const entries = await store.list();
      assert.deepEqual(entries.map((entry) => entry.text), ["lifecycle memory"]);
      assert.equal(store.table?.isOpen(), true);
      assert.equal(store.db?.isOpen(), true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not recreate an existing table that cannot be opened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mymem-store-corrupt-"));
    mkdirSync(join(dir, "memories.lance"));
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3, logger: nullLogger });

    try {
      await assert.rejects(
        () => store.list(),
        /Failed to open existing LanceDB table "memories"/,
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects reflection top-level writes unless explicitly configured as a reflection store", async () => {
    const mainDir = mkdtempSync(join(tmpdir(), "mymem-store-main-category-"));
    const reflectionDir = mkdtempSync(join(tmpdir(), "mymem-store-reflection-category-"));
    const mainStore = new MemoryStore({ dbPath: mainDir, vectorDim: 3, logger: nullLogger });
    const reflectionStore = new MemoryStore({
      dbPath: reflectionDir,
      vectorDim: 3,
      logger: nullLogger,
      allowReflectionCategory: true,
    });

    try {
      await assert.rejects(
        () => mainStore.store({
          text: "reflection should stay out of main memory",
          vector: [1, 0, 0],
          category: "reflection",
          scope: "global",
          importance: 0.5,
          metadata: "{}",
        }),
        /dedicated reflection store/,
      );

      const entry = await reflectionStore.store({
        text: "reflection belongs in the reflection store",
        vector: [1, 0, 0],
        category: "reflection",
        scope: "global",
        importance: 0.5,
        metadata: "{}",
      });

      assert.equal(entry.category, "reflection");
      assert.deepEqual(
        (await reflectionStore.list(["global"], "reflection", 10, 0)).map((row) => row.id),
        [entry.id],
      );
    } finally {
      mainStore.close();
      reflectionStore.close();
      rmSync(mainDir, { recursive: true, force: true });
      rmSync(reflectionDir, { recursive: true, force: true });
    }
  });

  it("rejects legacy and unknown categories on new main-store writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mymem-store-category-boundary-"));
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3, logger: nullLogger });

    try {
      for (const category of ["preference", "fact", "decision", "entity", "other", "unknown"]) {
        await assert.rejects(
          () => store.store({
            text: `legacy category ${category}`,
            vector: [1, 0, 0],
            category,
            scope: "global",
            importance: 0.5,
            metadata: "{}",
          }),
          /cannot write category/,
        );
      }

      const entry = await store.store({
        text: "new category writes still work",
        vector: [1, 0, 0],
        category: "cases",
        scope: "global",
        importance: 0.5,
        metadata: "{}",
      });
      assert.equal(entry.category, "cases");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
