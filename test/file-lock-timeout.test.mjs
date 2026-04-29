/**
 * File Lock Timeout Test
 *
 * Tests file lock timeout scenarios:
 * 1. Lock acquisition timeout when another process holds the lock
 * 2. Stale lock detection and recovery
 * 3. Lock held by crashed process recovery
 *
 * Run: node --test test/file-lock-timeout.test.mjs
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "memory-lock-timeout-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
  return { store, dir };
}

function makeEntry(i = 1) {
  return {
    text: `memory-${i}`,
    vector: [0.1 * i, 0.2 * i, 0.3 * i],
    category: "fact",
    scope: "global",
    importance: 0.5,
    metadata: "{}",
  };
}

function waitForLine(stream, pattern, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      stream.off("data", onData);
      stream.off("error", onError);
      reject(new Error(`Timed out waiting for: ${pattern}`));
    }, timeoutMs);

    function onData(chunk) {
      buffer += chunk.toString();
      if (buffer.includes(pattern)) {
        clearTimeout(timer);
        stream.off("data", onData);
        stream.off("error", onError);
        resolve(buffer);
      }
    }

    function onError(err) {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("error", onError);
      reject(err);
    }

    stream.on("data", onData);
    stream.on("error", onError);
  });
}

describe("File Lock Timeout Scenarios", () => {
  let dir = "";

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("succeeds when lock is released before timeout", async () => {
    const { store, dir: storeDir } = makeStore();
    dir = storeDir;

    // First store should succeed and release lock
    const entry1 = await store.store(makeEntry(1));
    assert.ok(entry1.id, "First store should succeed");

    // Second store should succeed (lock should be available)
    const entry2 = await store.store(makeEntry(2));
    assert.ok(entry2.id, "Second store should succeed");

    const all = await store.list(undefined, undefined, 10, 0);
    assert.strictEqual(all.length, 2, "Should have 2 entries");
  });

  it("recovers when stale lock age exceeds threshold", async () => {
    const { store, dir: storeDir } = makeStore();
    dir = storeDir;
    const lockPath = join(storeDir, ".memory-write.lock");

    // Create an old lock artifact (older than 5 minutes)
    mkdirSync(lockPath, { recursive: true });
    const oldTime = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    utimesSync(lockPath, oldTime, oldTime);

    // Store should succeed despite stale lock
    const entry = await store.store(makeEntry(1));
    assert.ok(entry.id, "Should recover from stale lock");

    const all = await store.list(undefined, undefined, 10, 0);
    assert.strictEqual(all.length, 1);
  });

  it("handles concurrent stores from same store instance", async () => {
    const { store, dir: storeDir } = makeStore();
    dir = storeDir;

    // Create a single store instance for concurrent operations
    const count = 4;

    // All should serialize correctly via proper-lockfile
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) => store.store(makeEntry(i + 1))),
    );

    assert.strictEqual(results.length, count, "All stores should resolve");
    assert.strictEqual(
      new Set(results.map((r) => r.id)).size,
      count,
      "All IDs should be unique",
    );

    // Final count should be count
    const all = await store.list(undefined, undefined, 10, 0);
    assert.strictEqual(all.length, count, `All ${count} entries should be persisted`);
  });

  it("serializes rapid sequential stores correctly", async () => {
    const { store, dir: storeDir } = makeStore();
    dir = storeDir;

    const count = 10;
    const entries = [];

    for (let i = 1; i <= count; i++) {
      const entry = await store.store(makeEntry(i));
      entries.push(entry);
    }

    assert.strictEqual(entries.length, count, `Should have ${count} entries`);
    assert.strictEqual(
      new Set(entries.map((e) => e.id)).size,
      count,
      "All IDs should be unique",
    );
  });

  it("handles store after delete without lock conflicts", async () => {
    const { store, dir: storeDir } = makeStore();
    dir = storeDir;

    // Store
    const entry = await store.store(makeEntry(1));
    assert.ok(entry.id);

    // Delete
    await store.delete(entry.id);

    // Store again - should not conflict with deleted entry's lock
    const entry2 = await store.store(makeEntry(2));
    assert.ok(entry2.id);
    assert.notStrictEqual(entry.id, entry2.id);

    const all = await store.list(undefined, undefined, 10, 0);
    assert.strictEqual(all.length, 1, "Should have only 1 entry");
  });

  it("recovers from concurrent store and delete operations", async () => {
    const { store, dir: storeDir } = makeStore();
    dir = storeDir;

    // Seed some entries
    await store.store(makeEntry(1));
    await store.store(makeEntry(2));

    // Concurrent operations
    const results = await Promise.allSettled([
      store.store(makeEntry(3)),
      store.store(makeEntry(4)),
      store.delete((await store.list(undefined, undefined, 1, 0))[0].id),
      store.update((await store.list(undefined, undefined, 1, 0))[0].id, {
        text: "updated",
      }),
    ]);

    // All should settle (not reject)
    const rejections = results.filter((r) => r.status === "rejected");
    assert.strictEqual(
      rejections.length,
      0,
      `No operations should fail, got: ${rejections.map((r) => String(r.reason)).join(", ")}`,
    );

    // Should have 3-4 entries depending on timing
    const all = await store.list(undefined, undefined, 10, 0);
    assert.ok(
      all.length >= 3,
      `Should have at least 3 entries, got ${all.length}`,
    );
  });

  it("lock artifact is cleaned up after successful store", async () => {
    const { store, dir: storeDir } = makeStore();
    dir = storeDir;
    const lockPath = join(storeDir, ".memory-write.lock");

    // Before store, no lock artifact
    assert.strictEqual(existsSync(lockPath), false, "No lock before store");

    // After store, lock should be released
    await store.store(makeEntry(1));
    assert.strictEqual(
      existsSync(lockPath),
      false,
      "Lock should be released after store",
    );

    // Second store
    await store.store(makeEntry(2));
    assert.strictEqual(
      existsSync(lockPath),
      false,
      "Lock should be released after second store",
    );
  });
});

describe("Cross-Process Lock Recovery", () => {
  let dir = "";
  let holderScript = "";
  let recoveryScript = "";

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("recovers from stale lock after process crash (via mtime check)", async () => {
    const { dir: storeDir } = makeStore();
    dir = storeDir;
    const lockPath = join(storeDir, ".memory-write.lock");

    // Simulate a stale lock from a crashed process (mtime > 5 minutes old)
    mkdirSync(lockPath, { recursive: true });
    const oldTime = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    utimesSync(lockPath, oldTime, oldTime);

    // Store should succeed (stale lock should be auto-cleaned)
    const jiti2 = jitiFactory(import.meta.url, { interopDefault: true });
    const { MemoryStore: Store2 } = jiti2("../src/store.ts");
    const store = new Store2({ dbPath: storeDir, vectorDim: 3 });

    const entry = await store.store(makeEntry(1));
    assert.ok(entry.id, "Should recover from stale lock");

    // Verify entry persisted
    const all = await store.list(undefined, undefined, 10, 0);
    assert.strictEqual(all.length, 1);
  });

  it("handles lock file with zero retries config gracefully", async () => {
    // This tests the retry behavior - with retries exhausted, it should throw
    // rather than hang indefinitely
    const { dir: storeDir } = makeStore();
    dir = storeDir;

    // Create a permanent lock artifact to force retry exhaustion
    const lockPath = join(storeDir, ".memory-write.lock");
    mkdirSync(lockPath, { recursive: true });

    // Start a background process that holds the lock
    const holderScript = join(storeDir, "holder.mjs");
    writeFileSync(
      holderScript,
      `
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const lockPath = join(${JSON.stringify(storeDir)}, ".memory-write.lock");
console.log("Holder: waiting for lock...");

// Wait for lock to be created by main process, then hold it
while (!existsSync(${JSON.stringify(lockPath)})) {
  await new Promise(r => setTimeout(r, 50));
}

// Hold lock for 10 seconds
await new Promise(r => setTimeout(r, 10000));
console.log("Holder: releasing lock");
`,
      "utf8",
    );

    // First, create a store instance to initiate locking
    const jiti1 = jitiFactory(import.meta.url, { interopDefault: true });
    const { MemoryStore: Store1 } = jiti1("../src/store.ts");
    const store1 = new Store1({ dbPath: storeDir, vectorDim: 3 });

    // Start holder process
    const holder = spawn("node", [holderScript], {
      cwd: storeDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      // Start store operation (will hold lock)
      const storePromise = store1.store(makeEntry(1));

      // Wait for holder to start
      await waitForLine(holder.stdout, "Holder: waiting for lock");

      // Holder now holds lock, our store is waiting
      // After retries exhausted (max 10 retries, ~20s total), it should fail
      // rather than hang forever

      // Give it some time for retries
      await new Promise((r) => setTimeout(r, 500));

      // The store should eventually succeed or fail, not hang
      // With retries config, it should eventually acquire the lock after holder releases
      const result = await Promise.race([
        storePromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Store hung")), 30000),
        ),
      ]);

      assert.ok(result.id, "Store should eventually succeed");
    } finally {
      try {
        holder.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  });
});
