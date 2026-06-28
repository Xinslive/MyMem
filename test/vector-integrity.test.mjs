/**
 * Vector Integrity Tests (audit #5 and #6)
 *
 * Covers:
 *  - assertValidVector: refuses empty / wrong-dim / non-finite vectors (audit #5)
 *  - readPersistedEmbeddingDimension: durable marker survives across opens (audit #6)
 *  - writePersistedEmbeddingDimension: refuses to clobber a disagreeing marker
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { assertValidVector } = jiti("../src/store-sql-utils.ts");

describe("assertValidVector (audit #5)", () => {
  it("accepts a vector of the expected dimension with finite values", () => {
    assertValidVector([0.1, 0.2, 0.3, 0.4], 4, "test");
  });

  it("refuses a zero-length vector (the audit #5 bug)", () => {
    assert.throws(
      () => assertValidVector([], 4, "store"),
      /zero-length vector/i,
      "an empty vector must be rejected at the write site so it cannot disappear from recall",
    );
  });

  it("refuses a vector with a different dimension than expected", () => {
    assert.throws(
      () => assertValidVector([0.1, 0.2, 0.3], 4, "store"),
      /dimension mismatch/i,
    );
  });

  it("refuses a non-array input (e.g. an Arrow Vector passed by mistake)", () => {
    assert.throws(
      () => assertValidVector(null, 4, "store"),
      /expected vector to be an array/i,
    );
    assert.throws(
      () => assertValidVector(undefined, 4, "store"),
      /expected vector to be an array/i,
    );
  });

  it("refuses a vector containing NaN or Infinity (failed embedder signal)", () => {
    assert.throws(
      () => assertValidVector([0.1, NaN, 0.3, 0.4], 4, "store"),
      /non-finite/i,
    );
    assert.throws(
      () => assertValidVector([0.1, Infinity, 0.3, 0.4], 4, "store"),
      /non-finite/i,
    );
  });

  it("includes the operation name in the error so log triage is easy", () => {
    assert.throws(
      () => assertValidVector([], 4, "custom-op-name"),
      /custom-op-name/,
    );
  });
});

describe("readPersistedEmbeddingDimension (audit #6)", () => {
  let dir;
  let MemoryStore;

  before(() => {
    MemoryStore = jiti("../src/store.ts").MemoryStore;
  });

  after(() => {
    try { rmSync(dir, { recursive: true }); } catch {}
  });

  it("returns null when no marker file exists (fresh install)", async () => {
    dir = mkdtempSync(join(tmpdir(), "embed-dim-fresh-"));
    const store = new MemoryStore({ dbPath: dir, vectorDim: 4 });
    const dim = await store.readPersistedEmbeddingDimension();
    assert.strictEqual(dim, null);
  });

  it("persists the dimension after a successful ensureInitialized", async () => {
    dir = mkdtempSync(join(tmpdir(), "embed-dim-write-"));
    const store = new MemoryStore({ dbPath: dir, vectorDim: 4 });
    // Trigger initialization by writing a row.
    await store.store({ text: "warmup", vector: [0.1, 0.1, 0.1, 0.1], category: "cases", scope: "global", importance: 0.5, metadata: "{}" });
    const dim = await store.readPersistedEmbeddingDimension();
    assert.strictEqual(dim, 4);
  });

  it("refuses bad vectors on update as well as create", async () => {
    const d = mkdtempSync(join(tmpdir(), "embed-update-guard-"));
    const store = new MemoryStore({ dbPath: d, vectorDim: 4 });
    const created = await store.store({ text: "warmup", vector: [0.1, 0.1, 0.1, 0.1], category: "cases", scope: "global", importance: 0.5, metadata: "{}" });

    await assert.rejects(
      () => store.update(created.id, { vector: [] }),
      /zero-length vector/i,
    );
    await assert.rejects(
      () => store.update(created.id, { vector: [0.1, 0.2, 0.3] }),
      /dimension mismatch/i,
    );
    await assert.rejects(
      () => store.update(created.id, { vector: [0.1, NaN, 0.3, 0.4] }),
      /non-finite/i,
    );

    try { rmSync(d, { recursive: true }); } catch {}
  });

  it("reads back the persisted dimension on a fresh store instance", async () => {
    const d = mkdtempSync(join(tmpdir(), "embed-dim-persist-"));
    const s1 = new MemoryStore({ dbPath: d, vectorDim: 8 });
    await s1.store({ text: "warmup", vector: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], category: "cases", scope: "global", importance: 0.5, metadata: "{}" });
    // New instance, same dbPath: should read 8 from disk.
    const s2 = new MemoryStore({ dbPath: d, vectorDim: 8 });
    const dim = await s2.readPersistedEmbeddingDimension();
    assert.strictEqual(dim, 8);
    try { rmSync(d, { recursive: true }); } catch {}
  });

  it("returns null when the marker file is corrupt", async () => {
    const d = mkdtempSync(join(tmpdir(), "embed-dim-corrupt-"));
    writeFileSync(
      join(d, ".mymem-embedding-dimension.json"),
      "{ this is not json",
      "utf8",
    );
    const s = new MemoryStore({ dbPath: d, vectorDim: 4 });
    const dim = await s.readPersistedEmbeddingDimension();
    assert.strictEqual(dim, null, "a corrupt marker should be treated as 'no marker'");
    try { rmSync(d, { recursive: true }); } catch {}
  });

  it("refuses to overwrite a disagreeing marker (audit #6 contract)", async () => {
    const d = mkdtempSync(join(tmpdir(), "embed-dim-guard-"));
    // Simulate a prior install at dimension 1024.
    writeFileSync(
      join(d, ".mymem-embedding-dimension.json"),
      JSON.stringify({ dimension: 1024, recordedAt: Date.now() }),
      "utf8",
    );
    // New instance claiming dimension 768 — write should be a no-op.
    const s = new MemoryStore({ dbPath: d, vectorDim: 768 });
    await s.store({ text: "x", vector: new Array(768).fill(0), category: "cases", scope: "global", importance: 0.5, metadata: "{}" });
    const file = join(d, ".mymem-embedding-dimension.json");
    assert.ok(existsSync(file));
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.strictEqual(parsed.dimension, 1024, "the disagreeing marker must not be silently overwritten");
    try { rmSync(d, { recursive: true }); } catch {}
  });
});
