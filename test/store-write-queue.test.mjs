// test/store-write-queue.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { makeMemoryEntry, makeTempMemoryStore } from "./helpers/store-fixture.mjs";

function assertVectorClose(actual, expected) {
  assert.equal(actual?.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6, `vector[${i}] expected ${expected[i]}, got ${actual[i]}`);
  }
}

function makeStore() {
  return makeTempMemoryStore({ prefix: "mymem-write-queue-" });
}

const makeEntry = makeMemoryEntry;

describe("MemoryStore write queue", () => {
  it("serializes concurrent writes within the same store instance", async () => {
    const { store, dir } = makeStore();
    try {
      const results = await Promise.all([
        store.store(makeEntry(1)),
        store.store(makeEntry(2)),
        store.store(makeEntry(3)),
        store.store(makeEntry(4)),
      ]);

      assert.strictEqual(results.length, 4);

      const ids = new Set(results.map((r) => r.id));
      assert.strictEqual(ids.size, 4, "all writes should succeed with unique IDs");

      const all = await store.list(undefined, undefined, 20, 0);
      assert.strictEqual(all.length, 4, "all queued writes should persist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues processing queued writes after an earlier queued failure", async () => {
    const { store, dir } = makeStore();
    try {
      const created = await store.store(makeEntry(1));

      const failingWrite = store.update("00000000-0000-0000-0000-000000000000", { text: "should-fail" });
      const succeedingWrite = store.store(makeEntry(2));

      const failedResult = await failingWrite;
      assert.strictEqual(failedResult, null, "failed update should resolve to null");

      const created2 = await succeedingWrite;
      assert.ok(created2?.id, "later queued write should still succeed");

      const all = await store.list(undefined, undefined, 20, 0);
      assert.strictEqual(all.length, 2, "queue should continue processing after failure");

      const texts = new Set(all.map((x) => x.text));
      assert.deepStrictEqual(texts, new Set(["memory-1", "memory-2"]));
      assert.ok(created.id !== created2.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flushWrites waits for an in-flight serialized write", async () => {
    const { store, dir } = makeStore();
    try {
      let releaseWrite;
      let writeStarted;
      const writeStartedPromise = new Promise((resolve) => {
        writeStarted = resolve;
      });
      const writePromise = store.runSerializedUpdate(async () => {
        writeStarted();
        await new Promise((resolve) => {
          releaseWrite = resolve;
        });
      });

      await writeStartedPromise;
      let flushed = false;
      const flushPromise = store.flushWrites().then(() => {
        flushed = true;
      });
      await Promise.resolve();
      assert.equal(flushed, false, "flushWrites should wait for the active serialized write");

      releaseWrite();
      await writePromise;
      await flushPromise;
      assert.equal(flushed, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flushWrites waits for serialized writes queued while flushing", async () => {
    const { store, dir } = makeStore();
    try {
      let releaseFirst;
      let firstStarted;
      const firstStartedPromise = new Promise((resolve) => {
        firstStarted = resolve;
      });
      const firstPromise = store.runSerializedUpdate(async () => {
        firstStarted();
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      });

      await firstStartedPromise;
      let flushed = false;
      const flushPromise = store.flushWrites().then(() => {
        flushed = true;
      });
      await Promise.resolve();
      assert.equal(flushed, false, "flushWrites should wait for the first active write");

      let releaseSecond;
      let secondStarted;
      const secondStartedPromise = new Promise((resolve) => {
        secondStarted = resolve;
      });
      const secondPromise = store.runSerializedUpdate(async () => {
        secondStarted();
        await new Promise((resolve) => {
          releaseSecond = resolve;
        });
      });

      releaseFirst();
      await secondStartedPromise;
      await Promise.resolve();
      assert.equal(flushed, false, "flushWrites should also wait for writes appended while flushing");

      releaseSecond();
      await Promise.all([firstPromise, secondPromise, flushPromise]);
      assert.equal(flushed, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes mixed store/update/delete operations in one instance", async () => {
    const { store, dir } = makeStore();
    try {
      const a = await store.store(makeEntry(1));
      const b = await store.store(makeEntry(2));
      const c = await store.store(makeEntry(3));

      const [updatedA, deletedB, createdD] = await Promise.all([
        store.update(a.id, { text: "memory-1-updated", importance: 0.9 }),
        store.delete(b.id),
        store.store(makeEntry(4)),
      ]);

      assert.ok(updatedA, "update should succeed");
      assert.strictEqual(deletedB, true, "delete should succeed");
      assert.ok(createdD?.id, "new store should succeed");

      const all = await store.list(undefined, undefined, 20, 0);
      assert.strictEqual(all.length, 3, "final row count should be correct");

      const texts = new Set(all.map((x) => x.text));
      assert.deepStrictEqual(
        texts,
        new Set(["memory-1-updated", "memory-3", "memory-4"]),
      );

      const fetchedA = await store.getById(a.id);
      assert.ok(fetchedA);
      assert.strictEqual(fetchedA.text, "memory-1-updated");
      assert.strictEqual(fetchedA.importance, 0.9);

      const fetchedB = await store.getById(b.id);
      assert.strictEqual(fetchedB, null, "deleted entry should be gone");

      const fetchedC = await store.getById(c.id);
      assert.ok(fetchedC);
      assert.strictEqual(fetchedC.text, "memory-3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("batch metadata updates dedupe IDs and preserve latest patch", async () => {
    const { store, dir } = makeStore();
    try {
      const a = await store.store({ ...makeEntry(1), metadata: "{\"version\":1}" });
      const b = await store.store({ ...makeEntry(2), metadata: "{\"version\":1}" });
      let updateCalls = 0;
      let mergeInsertCalls = 0;
      const originalUpdate = store.table.update.bind(store.table);
      const originalMergeInsert = store.table.mergeInsert.bind(store.table);
      store.table.update = (...args) => {
        updateCalls++;
        return originalUpdate(...args);
      };
      store.table.mergeInsert = (...args) => {
        mergeInsertCalls++;
        return originalMergeInsert(...args);
      };

      const count = await store.updateBatchMetadata([
        { id: a.id, metadata: "{\"version\":2}" },
        { id: b.id, metadata: "{\"version\":3}" },
        { id: a.id, metadata: "{\"version\":4}" },
        { id: "missing", metadata: "{\"version\":999}" },
      ]);

      assert.equal(count, 2);
      assert.equal(updateCalls, 2);
      assert.equal(mergeInsertCalls, 0);
      const updatedA = await store.getById(a.id);
      const updatedB = await store.getById(b.id);
      assert.equal(updatedA?.text, "memory-1");
      assertVectorClose(updatedA?.vector, [0.1, 0.2, 0.3]);
      assert.equal(updatedA?.metadata, "{\"version\":4}");
      assert.equal(updatedB?.metadata, "{\"version\":3}");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("batch metadata patches dedupe IDs and skip scope-denied rows", async () => {
    const { store, dir } = makeStore();
    try {
      const a = await store.store({ ...makeEntry(1), scope: "global", metadata: "{\"state\":\"confirmed\"}" });
      const b = await store.store({ ...makeEntry(2), scope: "agent:other", metadata: "{\"state\":\"confirmed\"}" });
      let updateCalls = 0;
      let mergeInsertCalls = 0;
      const originalUpdate = store.table.update.bind(store.table);
      const originalMergeInsert = store.table.mergeInsert.bind(store.table);
      store.table.update = (...args) => {
        updateCalls++;
        return originalUpdate(...args);
      };
      store.table.mergeInsert = (...args) => {
        mergeInsertCalls++;
        return originalMergeInsert(...args);
      };

      const count = await store.patchMetadataBatch([
        { id: a.id, patch: { injected_count: 1 } },
        { id: a.id, patch: { last_accessed_at: 123 } },
        { id: b.id, patch: { injected_count: 99 } },
      ], ["global"]);

      assert.equal(count, 1);
      assert.equal(updateCalls, 1);
      assert.equal(mergeInsertCalls, 0);
      const updatedA = await store.getById(a.id);
      const updatedB = await store.getById(b.id);
      assert.equal(updatedA?.text, "memory-1");
      assertVectorClose(updatedA?.vector, [0.1, 0.2, 0.3]);
      assert.match(updatedA?.metadata || "", /"injected_count":1/);
      assert.match(updatedA?.metadata || "", /"last_accessed_at":123/);
      assert.doesNotMatch(updatedB?.metadata || "", /"injected_count":99/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
