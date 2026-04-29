import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

describe("MemoryStore flush-batch", () => {
  let dir;
  let MemoryStore;

  before(() => {
    MemoryStore = jiti("../src/store.ts").MemoryStore;
  });

  after(() => {
    try { rmSync(dir, { recursive: true }); } catch {}
  });

  it("flushBatch writes all buffered entries in a single lock", async () => {
    dir = mkdtempSync(join(tmpdir(), "flush-batch-"));
    const store = new MemoryStore({ dbPath: dir, vectorDim: 4 });

    store.startBatch();
    const e1 = await store.store({ text: "Alpha", vector: [0.1, 0.1, 0.1, 0.1], category: "fact", scope: "global", importance: 0.7, metadata: "{}" });
    const e2 = await store.store({ text: "Beta", vector: [0.2, 0.2, 0.2, 0.2], category: "fact", scope: "global", importance: 0.7, metadata: "{}" });
    const e3 = await store.store({ text: "Gamma", vector: [0.3, 0.3, 0.3, 0.3], category: "fact", scope: "global", importance: 0.7, metadata: "{}" });

    assert.ok(e1.id);
    assert.ok(e2.id);
    assert.ok(e3.id);

    const written = await store.flushBatch();
    assert.strictEqual(written.length, 3);
    assert.strictEqual(written[0].text, "Alpha");
    assert.strictEqual(written[1].text, "Beta");
    assert.strictEqual(written[2].text, "Gamma");

    const count = await store.count();
    assert.strictEqual(count, 3);
  });

  it("empty flushBatch returns [] without acquiring lock", async () => {
    const d = mkdtempSync(join(tmpdir(), "flush-empty-"));
    const store = new MemoryStore({ dbPath: d, vectorDim: 4 });

    store.startBatch();
    const result = await store.flushBatch();
    assert.strictEqual(result.length, 0);

    const count = await store.count();
    assert.strictEqual(count, 0);

    try { rmSync(d, { recursive: true }); } catch {}
  });

  it("store() without batch mode writes immediately", async () => {
    const d = mkdtempSync(join(tmpdir(), "flush-immediate-"));
    const store = new MemoryStore({ dbPath: d, vectorDim: 4 });

    await store.store({ text: "Direct", vector: [0.5, 0.5, 0.5, 0.5], category: "fact", scope: "global", importance: 0.7, metadata: "{}" });

    const count = await store.count();
    assert.strictEqual(count, 1);

    try { rmSync(d, { recursive: true }); } catch {}
  });

  it("batch mode is off after flushBatch", async () => {
    const d = mkdtempSync(join(tmpdir(), "flush-mode-off-"));
    const store = new MemoryStore({ dbPath: d, vectorDim: 4 });

    store.startBatch();
    await store.store({ text: "Batched", vector: [0.1, 0.1, 0.1, 0.1], category: "fact", scope: "global", importance: 0.7, metadata: "{}" });
    await store.flushBatch();

    await store.store({ text: "Immediate", vector: [0.2, 0.2, 0.2, 0.2], category: "fact", scope: "global", importance: 0.7, metadata: "{}" });

    const count = await store.count();
    assert.strictEqual(count, 2);

    try { rmSync(d, { recursive: true }); } catch {}
  });

  it("flushBatch preserves metadata and all fields", async () => {
    const d = mkdtempSync(join(tmpdir(), "flush-fields-"));
    const store = new MemoryStore({ dbPath: d, vectorDim: 4 });
    const meta = JSON.stringify({ l0_abstract: "test", memory_category: "fact" });

    store.startBatch();
    await store.store({ text: "Meta", vector: [0.1, 0.1, 0.1, 0.1], category: "fact", scope: "agent:bot", importance: 0.9, metadata: meta });
    const written = await store.flushBatch();

    assert.strictEqual(written[0].scope, "agent:bot");
    assert.strictEqual(written[0].importance, 0.9);
    assert.strictEqual(written[0].metadata, meta);

    const retrieved = await store.getById(written[0].id);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.text, "Meta");
    assert.strictEqual(retrieved.scope, "agent:bot");

    try { rmSync(d, { recursive: true }); } catch {}
  });

  it("multiple startBatch/flushBatch cycles work independently", async () => {
    const d = mkdtempSync(join(tmpdir(), "flush-cycles-"));
    const store = new MemoryStore({ dbPath: d, vectorDim: 4 });

    store.startBatch();
    await store.store({ text: "Cycle1-A", vector: [0.1, 0.1, 0.1, 0.1], category: "fact", scope: "global", importance: 0.7, metadata: "{}" });
    await store.store({ text: "Cycle1-B", vector: [0.2, 0.2, 0.2, 0.2], category: "fact", scope: "global", importance: 0.7, metadata: "{}" });
    const c1 = await store.flushBatch();
    assert.strictEqual(c1.length, 2);

    store.startBatch();
    await store.store({ text: "Cycle2-A", vector: [0.3, 0.3, 0.3, 0.3], category: "fact", scope: "global", importance: 0.7, metadata: "{}" });
    const c2 = await store.flushBatch();
    assert.strictEqual(c2.length, 1);

    const count = await store.count();
    assert.strictEqual(count, 3);

    try { rmSync(d, { recursive: true }); } catch {}
  });

  it("concurrent batch and non-batch writes interleave correctly", async () => {
    const d = mkdtempSync(join(tmpdir(), "flush-concurrent-"));
    const store = new MemoryStore({ dbPath: d, vectorDim: 4 });

    store.startBatch();
    const batched = store.store({ text: "Batched", vector: [0.1, 0.1, 0.1, 0.1], category: "fact", scope: "global", importance: 0.7, metadata: "{}" });
    const direct = store.store({ text: "Direct", vector: [0.2, 0.2, 0.2, 0.2], category: "fact", scope: "global", importance: 0.7, metadata: "{}" });

    const [bEntry, dEntry] = await Promise.all([batched, direct]);

    const written = await store.flushBatch();
    assert.strictEqual(written.length, 2);

    const count = await store.count();
    assert.strictEqual(count, 2);

    try { rmSync(d, { recursive: true }); } catch {}
  });
});
