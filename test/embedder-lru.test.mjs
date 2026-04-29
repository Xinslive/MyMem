import assert from "node:assert/strict";
import { test } from "node:test";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { Embedder } = jiti("../src/embedder.ts");

test("EmbeddingCache moves an existing key to most-recent position when re-set", () => {
  const embedder = new Embedder({
    provider: "openai-compatible",
    apiKey: "test-key",
    model: "text-embedding-3-small",
  });
  const cache = embedder._cache;
  cache.maxSize = 2;

  cache.set("key1", undefined, [1, 0, 0]);
  cache.set("key2", undefined, [0, 1, 0]);
  cache.set("key1", undefined, [1, 1, 0]);
  cache.set("key3", undefined, [0, 0, 1]);

  assert.deepEqual(cache.get("key1", undefined), [1, 1, 0]);
  assert.equal(cache.get("key2", undefined), undefined);
  assert.deepEqual(cache.get("key3", undefined), [0, 0, 1]);
});

test("concurrent identical query embeddings share one provider request", async () => {
  const embedder = new Embedder({
    provider: "openai-compatible",
    apiKey: "test-key",
    model: "text-embedding-3-small",
  });

  let calls = 0;
  embedder.clients = [{
    embeddings: {
      async create() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { data: [{ embedding: new Array(1536).fill(0.1) }] };
      },
    },
  }];

  const [first, second] = await Promise.all([
    embedder.embedQuery("same query"),
    embedder.embedQuery("same query"),
  ]);

  assert.equal(calls, 1);
  assert.equal(first.length, 1536);
  assert.deepEqual(second, first);

  await embedder.embedQuery("same query");
  assert.equal(calls, 1, "completed result should be served from cache");
});

test("different query embedding tasks do not share inflight work", async () => {
  const embedder = new Embedder({
    provider: "openai-compatible",
    apiKey: "test-key",
    model: "jina-embeddings-v5-text-small",
    taskQuery: "retrieval.query",
    taskPassage: "retrieval.passage",
  });

  const tasks = [];
  embedder.clients = [{
    embeddings: {
      async create(payload) {
        tasks.push(payload.task);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { data: [{ embedding: new Array(1024).fill(0.2) }] };
      },
    },
  }];

  await Promise.all([
    embedder.embedQuery("same text"),
    embedder.embedPassage("same text"),
  ]);

  assert.equal(tasks.length, 2);
  assert.deepEqual(new Set(tasks), new Set(["retrieval.query", "retrieval.passage"]));
});

test("embedding provider requests are capped at 10 globally across embedder instances", async () => {
  const first = new Embedder({
    provider: "openai-compatible",
    apiKey: "test-key-1",
    model: "text-embedding-3-small",
  });
  const second = new Embedder({
    provider: "openai-compatible",
    apiKey: "test-key-2",
    model: "text-embedding-3-small",
  });

  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const create = async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return { data: [{ embedding: new Array(1536).fill(0.3) }] };
  };

  first.clients = [{ embeddings: { create } }];
  second.clients = [{ embeddings: { create } }];

  const results = await Promise.all([
    ...Array.from({ length: 8 }, (_, idx) => first.embedQuery(`first-${idx}`)),
    ...Array.from({ length: 8 }, (_, idx) => second.embedQuery(`second-${idx}`)),
  ]);

  assert.equal(calls, 16);
  assert.equal(results.length, 16);
  assert.equal(maxActive, 10);
});
