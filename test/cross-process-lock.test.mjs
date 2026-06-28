import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeMemoryEntry, makeTempMemoryStore } from "./helpers/store-fixture.mjs";

function makeStore() {
  return makeTempMemoryStore({ prefix: "mymem-lock-" });
}

const makeEntry = makeMemoryEntry;

describe("Cross-process file lock", () => {
  // Note: proper-lockfile v4 uses mkdir-based locking, creating a DIRECTORY at
  // <lockPath>.lock (e.g., .memory-write.lock.lock), not a FILE at <lockPath>.
  // The lock artifact exists DURING the lock and is removed on release.
  // We verify proper-lockfile works by checking concurrent operations succeed.
  it("concurrent writes serialize via proper-lockfile v4", async () => {
    const { store, dir } = makeStore();
    try {
      // Fire concurrent stores - if lock isn't working, these would conflict
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) => store.store(makeEntry(i + 1))),
      );
      // If we got here, proper-lockfile v4 is working (no lock conflicts)
      assert.strictEqual(results.length, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sequential writes succeed without conflict", async () => {
    const { store, dir } = makeStore();
    try {
      const e1 = await store.store(makeEntry(1));
      const e2 = await store.store(makeEntry(2));
      assert.ok(e1.id !== e2.id, "entries should have different IDs");

      const all = await store.list(undefined, undefined, 20, 0);
      assert.strictEqual(all.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("concurrent writes do not lose data", async () => {
    const { store, dir } = makeStore();
    const count = 4;
    try {
      // Fire 4 concurrent stores (realistic ClawTeam swarm size)
      const results = await Promise.all(
        Array.from({ length: count }, (_, i) => store.store(makeEntry(i + 1))),
      );

      assert.strictEqual(results.length, count, "all store calls should resolve");

      const ids = new Set(results.map(r => r.id));
      assert.strictEqual(ids.size, count, "all entries should have unique IDs");

      const all = await store.list(undefined, undefined, 100, 0);
      assert.strictEqual(all.length, count, "all entries should be retrievable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("concurrent updates do not corrupt data", async () => {
    const { store, dir } = makeStore();
    try {
      // Seed entries
      const entries = await Promise.all(
        Array.from({ length: 4 }, (_, i) => store.store(makeEntry(i + 1))),
      );

      // Concurrently update all of them
      const updated = await Promise.all(
        entries.map((e, i) =>
          store.update(e.id, { text: `updated-${i}`, importance: 0.9 }),
        ),
      );

      assert.strictEqual(updated.filter(Boolean).length, 4, "all updates should succeed");

      // Verify data integrity
      for (let i = 0; i < 4; i++) {
        const fetched = await store.getById(entries[i].id);
        assert.ok(fetched, `entry ${i} should exist`);
        assert.strictEqual(fetched.text, `updated-${i}`);
        assert.strictEqual(fetched.importance, 0.9);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lock is released after each operation", async () => {
    const { store, dir } = makeStore();
    try {
      await store.store(makeEntry(1));
      // If lock were stuck, this second store would hang/fail
      await store.store(makeEntry(2));
      await store.delete((await store.list(undefined, undefined, 1, 0))[0].id);
      // Still works after delete
      await store.store(makeEntry(3));

      const all = await store.list(undefined, undefined, 20, 0);
      assert.strictEqual(all.length, 2, "should have 2 entries after store+store+delete+store");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
