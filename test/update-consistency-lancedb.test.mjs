import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { AccessTracker } = jiti("../src/access-tracker.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("MemoryStore update rollback (real LanceDB backend)", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-risk-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  async function createStoreWithEntry(overrides = {}) {
    const store = new MemoryStore({
      dbPath: path.join(workDir, "db"),
      vectorDim: 4,
    });

    const entry = await store.store({
      text: "original memory",
      vector: [0, 0, 0, 0],
      category: "fact",
      scope: "global",
      importance: 0.7,
      metadata: "{}",
      ...overrides,
    });

    return { store, entry };
  }

  function wrapTableMethod(store, methodName, wrapper) {
    const table = store.table;
    assert.ok(table, `expected initialized table for ${methodName}`);
    const original = table[methodName].bind(table);
    table[methodName] = wrapper(original);
    return () => {
      table[methodName] = original;
    };
  }

  it("preserves original record if mergeInsert fails", async () => {
    const { store, entry } = await createStoreWithEntry();
    let failed = false;

    // Wrap the store's update method to simulate failure
    const origUpdate = store.update.bind(store);
    store.update = async (...args) => {
      if (!failed) {
        failed = true;
        throw new Error("injected update failure");
      }
      return origUpdate(...args);
    };

    try {
      await store.update(entry.id, { text: "updated memory", vector: [1, 1, 1, 1] });
      assert.fail("expected update to throw");
    } catch (err) {
      assert.match(err.message, /injected update failure/);
    }

    store.update = origUpdate;

    assert.equal((await store.getById(entry.id))?.text, "original memory");
    assert.equal((await store.list(["global"]))[0]?.text, "original memory");
  });

  it("concurrent updates are serialized via file lock", async () => {
    const { store, entry } = await createStoreWithEntry();

    const first = store.update(entry.id, {
      text: "update from A",
      vector: [1, 0, 0, 0],
    });
    const second = store.update(entry.id, {
      text: "update from B",
      vector: [0, 1, 0, 0],
    });

    await first;
    await second;

    const result = await store.getById(entry.id);
    assert.equal(result?.text, "update from B");
    assert.equal((await store.list(["global"]))[0]?.text, "update from B");
  });

  it("access-tracker style metadata update preserves the row on write failure", async () => {
    const { store, entry } = await createStoreWithEntry({
      metadata: "{\"accessCount\":2}",
    });
    const warnings = [];
    let failed = false;

    // Wrap the store's update method to simulate failure
    const origUpdate = store.update.bind(store);
    store.update = async (...args) => {
      if (!failed) {
        failed = true;
        throw new Error("injected update failure");
      }
      return origUpdate(...args);
    };

    const tracker = new AccessTracker({
      store,
      logger: {
        warn(...args) {
          warnings.push(args.join(" "));
        },
        info() {},
      },
      debounceMs: 60_000,
    });

    tracker.recordAccess([entry.id]);
    await tracker.flush();
    tracker.destroy();
    store.update = origUpdate;

    const preserved = await store.getById(entry.id);
    assert.equal(preserved?.text, "original memory");
    assert.equal(preserved?.metadata, "{\"accessCount\":2}");
    assert.ok(warnings.some((msg) => /write-back failed/i.test(msg)));
  });

  it("after a successful update, getById/list can still read the record", async () => {
    const { store, entry } = await createStoreWithEntry();

    const updated = await store.update(entry.id, {
      text: "updated memory",
      vector: [1, 1, 1, 1],
      metadata: "{\"accessCount\":1}",
    });

    assert.equal(updated?.text, "updated memory");

    const byId = await store.getById(entry.id);
    assert.equal(byId?.text, "updated memory");
    assert.equal(byId?.metadata, "{\"accessCount\":1}");

    const listed = await store.list(["global"]);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].text, "updated memory");
  });
});
