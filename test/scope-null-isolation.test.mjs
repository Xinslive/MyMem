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
        category: "fact",
        scope: null,
        importance: 0.7,
        timestamp: Date.now(),
        metadata: "{}",
      }]);

      assert.equal(await store.getById("00000000-0000-4000-8000-000000000101", ["agent:main"]), null);
      assert.deepEqual(await store.list(["agent:main"], undefined, 20, 0), []);
      assert.deepEqual(await store.vectorSearch([0.1, 0.2, 0.3], 5, 0, ["agent:main"]), []);
      assert.deepEqual(await store.bm25Search("legacy null scope", 5, ["agent:main"]), []);
      assert.equal((await store.stats(["agent:main"])).totalCount, 0);

      const visible = await store.getById("00000000-0000-4000-8000-000000000101", ["global"]);
      assert.equal(visible?.scope, "global");
      assert.equal((await store.list(["global"], undefined, 20, 0)).length, 1);
      assert.equal((await store.vectorSearch([0.1, 0.2, 0.3], 5, 0, ["global"])).length, 1);
      assert.equal((await store.stats(["global"])).totalCount, 1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
