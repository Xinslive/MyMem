/**
 * Regression test for CR-3 / P0-C (2026-07-21 review):
 * legacy NULL-scope rows must be visible ONLY when the requester's
 * scopeFilter includes "global". This pins the gate in
 * buildScopeWhereClause (store-sql-utils.ts) and the new helper
 * buildScopeEqualityWithLegacyFallback used by MemoryStore.countScopes.
 *
 * If anyone weakens the gate so NULL-scope rows surface for non-global
 * filters, this test must fail.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { makeTempMemoryStore } from "./helpers/store-fixture.mjs";

describe("legacy null scope isolation", () => {
  it("only treats null scope rows as global when global is explicitly accessible", async () => {
    const { store, dir } = makeTempMemoryStore({ prefix: "mymem-null-scope-" });
    try {
      await store.count();
      await store.table.add([{
        id: "00000000-0000-4000-8000-000000000101",
        text: "legacy null scope memory",
        vector: [0.1, 0.2, 0.3],
        category: "patterns",
        scope: null,
        importance: 0.7,
        timestamp: Date.now(),
        metadata: "{}",
      }]);

      // Without global in the filter: NULL-scope row must be invisible.
      assert.equal(
        await store.getById("00000000-0000-4000-8000-000000000101", ["agent:main"]),
        null,
      );
      assert.deepEqual(
        await store.list(["agent:main"], undefined, 20, 0),
        [],
      );
      assert.deepEqual(
        await store.vectorSearch([0.1, 0.2, 0.3], 5, 0, ["agent:main"]),
        [],
      );
      assert.deepEqual(
        await store.bm25Search("legacy null scope", 5, ["agent:main"]),
        [],
      );
      // stats() counts via countScopes — this is the path fixed by P0-C.
      assert.equal((await store.stats(["agent:main"])).totalCount, 0);

      // With global in the filter: NULL-scope row is normalized to global
      // and becomes visible across all read paths.
      const visible = await store.getById(
        "00000000-0000-4000-8000-000000000101",
        ["global"],
      );
      assert.equal(visible?.scope, "global");
      assert.equal((await store.list(["global"], undefined, 20, 0)).length, 1);
      assert.equal(
        (await store.vectorSearch([0.1, 0.2, 0.3], 5, 0, ["global"])).length,
        1,
      );
      assert.equal((await store.stats(["global"])).totalCount, 1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});