/**
 * Auto-recall abort regression test
 *
 * Verifies that when auto-recall times out, the AbortSignal propagates
 * through the retrieval -> embedding call chain and cancels in-flight
 * HTTP requests rather than letting them run to completion.
 *
 * The production code path is:
 *   index.ts: Promise.race([recallWork(abortController.signal), timeout])
 *     -> retrieveWithRetry({signal})
 *       -> retriever.retrieve({signal})
 *         -> embedder.embedQuery(query, signal)
 *
 * Run: node --test test/auto-recall-abort-regression.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

function buildResult(id, text = "test result") {
  return {
    entry: {
      id,
      text,
      vector: [0.1, 0.2, 0.3],
      category: "other",
      scope: "global",
      importance: 0.7,
      timestamp: 1700000000000,
      metadata: "{}",
    },
    score: 0.9,
  };
}

test("auto-recall aborts embedding when signal fires mid-retrieval", async () => {
  const { MemoryRetriever } = jiti("../src/retriever.ts");

  let embedQueryCallCount = 0;
  let sawAbortedSignal = false;

  const fakeEmbedder = {
    embedQuery: async (_text, signal) => {
      embedQueryCallCount++;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        if (signal) {
          if (signal.aborted) {
            clearTimeout(timer);
            sawAbortedSignal = true;
            reject(new Error("aborted before work started"));
            return;
          }
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            sawAbortedSignal = true;
            reject(new DOMException("Embedding aborted", "AbortError"));
          }, { once: true });
        }
      });
      return [0.1, 0.2, 0.3];
    },
    embedPassage: async () => [0.1, 0.2, 0.3],
    embed: async () => [0.1, 0.2, 0.3],
  };

  const fakeStore = {
    hasFtsSupport: true,
    async vectorSearch() { return []; },
    async bm25Search() { return []; },
    async hasId() { return false; },
  };

  const retriever = new MemoryRetriever(fakeStore, fakeEmbedder, { mode: "hybrid", rerank: "none" }, null);

  const controller = new AbortController();
  const TIMEOUT_MS = 500;

  const retrievalPromise = retriever.retrieve({
    query: "test abort signal propagation",
    limit: 5,
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(new Error("auto-recall timeout")), TIMEOUT_MS);

  const start = Date.now();
  let errorCaught;
  try {
    await retrievalPromise;
  } catch (e) {
    errorCaught = e;
  }
  const elapsed = Date.now() - start;

  assert.ok(embedQueryCallCount >= 1, "embedQuery should have been called at least once");
  assert.ok(sawAbortedSignal, "embedQuery should have observed the aborted signal");
  assert.ok(
    elapsed < 2_000,
    `Expected abort ~${TIMEOUT_MS}ms, got ${elapsed}ms — abort did NOT interrupt slow embedding`,
  );
  assert.ok(errorCaught !== undefined, "retrieve should have thrown on abort");
});

test("pre-aborted signal: Embedder.withTimeout rejects before embedSingle runs", async () => {
  const { Embedder } = jiti("../src/embedder.ts");

  let embedSingleCalled = false;
  // Patch embedSingle to spy on whether it gets called despite pre-aborted signal.
  // Embedder.withTimeout() checks signal.aborted and returns a rejected promise
  // BEFORE calling embedSingle, so this should remain false.
  const embedder = new Embedder({
    provider: "openai-compatible",
    apiKey: "test-key",
    model: "text-embedding-3-small",
  });
  const origEmbedSingle = embedder.embedSingle.bind(embedder);
  embedder.embedSingle = async (...args) => {
    embedSingleCalled = true;
    return origEmbedSingle(...args);
  };

  const controller = new AbortController();
  controller.abort(new Error("already timed out"));

  let errorCaught;
  try {
    await embedder.embedQuery("should not reach HTTP", controller.signal);
  } catch (e) {
    errorCaught = e;
  }

  assert.ok(!embedSingleCalled, "embedSingle should NOT be called for a pre-aborted signal — withTimeout should reject immediately");
  assert.ok(errorCaught !== undefined, "embedQuery should throw for pre-aborted signal");
});

test("auto-recall aborts while fusion validates BM25-only hits", async () => {
  const { MemoryRetriever } = jiti("../src/retriever.ts");

  let hasIdCallCount = 0;
  const fakeEmbedder = {
    embedQuery: async () => [0.1, 0.2, 0.3],
    embedPassage: async () => [0.1, 0.2, 0.3],
    embed: async () => [0.1, 0.2, 0.3],
  };

  const fakeStore = {
    hasFtsSupport: true,
    async vectorSearch() { return []; },
    async bm25Search() {
      return Array.from({ length: 20 }, (_, index) => buildResult(`bm25-only-${index}`));
    },
    async hasId() {
      hasIdCallCount++;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return true;
    },
  };

  const retriever = new MemoryRetriever(
    fakeStore,
    fakeEmbedder,
    {
      mode: "hybrid",
      rerank: "none",
      filterNoise: false,
      minScore: 0,
      hardMinScore: 0,
      candidatePoolSize: 20,
    },
    null,
  );

  const controller = new AbortController();
  const TIMEOUT_MS = 250;
  const retrievalPromise = retriever.retrieve({
    query: "test abort during fusion",
    limit: 10,
    source: "auto-recall",
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(new Error("auto-recall timeout")), TIMEOUT_MS);

  const start = Date.now();
  let errorCaught;
  try {
    await retrievalPromise;
  } catch (e) {
    errorCaught = e;
  }
  const elapsed = Date.now() - start;

  assert.equal(hasIdCallCount, 20, "BM25-only validation should start in parallel");
  assert.ok(errorCaught !== undefined, "retrieve should throw on abort during fusion");
  assert.ok(
    elapsed < 2_000,
    `Expected fusion abort ~${TIMEOUT_MS}ms, got ${elapsed}ms — slow hasId validation blocked abort`,
  );

  const diagnostics = retriever.getLastDiagnostics();
  assert.equal(diagnostics.currentStage, "hybrid.fuseResults");
  assert.equal(diagnostics.failureStage, "hybrid.fuseResults");
});
