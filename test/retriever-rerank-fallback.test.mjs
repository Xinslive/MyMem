/**
 * Retriever Rerank Fallback Test
 *
 * Tests that when the rerank API fails, the retriever gracefully falls back
 * to cosine similarity reranking.
 *
 * Run: node --test test/retriever-rerank-fallback.test.mjs
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createRetriever } = jiti("../src/retriever.ts");

function buildResult(id = "memory-1", text = "test result") {
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

function createRetrieverHarness(
  config = {},
  storeOverrides = {},
  embedderOverrides = {},
) {
  const retriever = createRetriever(
    {
      hasFtsSupport: true,
      async vectorSearch() {
        return [];
      },
      async bm25Search() {
        return [buildResult()];
      },
      async hasId() {
        return true;
      },
      async get() {
        return null;
      },
      async upsert() {
        return [];
      },
      async delete() {
        return;
      },
      ...storeOverrides,
    },
    {
      async embedQuery() {
        return [0.1, 0.2, 0.3];
      },
      ...embedderOverrides,
    },
    config,
  );

  return { retriever };
}

describe("Retriever Rerank Fallback", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses cosine fallback when rerank API returns non-OK status", async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        statusText: "Internal Server Error",
      });
    };

    const { retriever } = createRetrieverHarness({
      mode: "hybrid",
      rerank: "cross-encoder",
      rerankApiKey: "test-key",
      rerankModel: "jina-reranker-v3",
      rerankTimeoutMs: 100,
    });

    const results = await retriever.retrieve({
      query: "test query",
      limit: 5,
      source: "manual",
    });

    // Should return results despite rerank failure
    assert.ok(results.length > 0, "Should return results after rerank failure");

    // Cosine fallback should produce reranked scores
    assert.ok(
      results.every((r) => r.sources?.reranked?.score !== undefined),
      "Results should have cosine rerank scores",
    );
  });

  it("uses cosine fallback when rerank API returns invalid response", async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ invalid: "shape" }), { status: 200 });
    };

    const { retriever } = createRetrieverHarness({
      mode: "hybrid",
      rerank: "cross-encoder",
      rerankApiKey: "test-key",
      rerankModel: "jina-reranker-v3",
      rerankTimeoutMs: 100,
    });

    const results = await retriever.retrieve({
      query: "test query",
      limit: 5,
      source: "manual",
    });

    // Should return results with cosine fallback
    assert.ok(results.length > 0, "Should return results after invalid rerank response");
  });

  it("skips rerank when rerank is set to 'none'", async () => {
    const { retriever } = createRetrieverHarness({
      mode: "hybrid",
      rerank: "none",
    });

    const results = await retriever.retrieve({
      query: "test query",
      limit: 5,
      source: "manual",
    });

    assert.ok(results.length > 0, "Should return results");
    // Without rerank, there should be no reranked scores
    assert.ok(
      results.every((r) => r.sources?.reranked === undefined),
      "Results should not have reranked scores when rerank is disabled",
    );
  });

  it("skips rerank when no API key is configured", async () => {
    let fetchWasCalled = false;
    globalThis.fetch = async () => {
      fetchWasCalled = true;
      throw new Error("Should not be called");
    };

    const { retriever } = createRetrieverHarness({
      mode: "hybrid",
      rerank: "cross-encoder",
      rerankApiKey: undefined, // No API key
      rerankModel: "jina-reranker-v3",
    });

    const results = await retriever.retrieve({
      query: "test query",
      limit: 5,
      source: "manual",
    });

    assert.ok(results.length > 0, "Should return results");
    assert.ok(!fetchWasCalled, "Fetch should not be called when no API key");
  });

  it("aborts rerank when external signal is already aborted (falls back to cosine)", async () => {
    let fetchWasCalled = false;
    globalThis.fetch = async () => {
      fetchWasCalled = true;
      // Should not reach here due to pre-abort check in rerankResults
      throw new Error("Should not be called");
    };

    const { retriever } = createRetrieverHarness({
      mode: "hybrid",
      rerank: "cross-encoder",
      rerankApiKey: "test-key",
    });

    const controller = new AbortController();
    controller.abort(new Error("already timed out"));

    // When signal is pre-aborted, rerank should throw but be caught
    // and fallback to cosine - so overall retrieval should succeed
    const results = await retriever.retrieve({
      query: "test query",
      limit: 5,
      signal: controller.signal,
      source: "manual",
    });

    // Should still return results (cosine fallback)
    assert.ok(results.length > 0, "Should return results with cosine fallback");
    assert.ok(!fetchWasCalled, "Fetch should not be called for pre-aborted signal");
  });

  it("aborts rerank when external signal fires during rerank (falls back to cosine)", async () => {
    const originalWarn = console.warn;
    const originalDebug = console.debug;
    const warnings = [];
    const debugLogs = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    console.debug = (...args) => debugLogs.push(args.join(" "));
    try {
      globalThis.fetch = async (url, options) => {
        // Simulate slow response
        await new Promise((r) => setTimeout(r, 200));
        if (options?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return new Response(
          JSON.stringify({
            results: [{ index: 0, relevance_score: 0.9 }],
          }),
          { status: 200 },
        );
      };

      const { retriever } = createRetrieverHarness({
        mode: "hybrid",
        rerank: "cross-encoder",
        rerankApiKey: "test-key",
        rerankTimeoutMs: 1000,
      });

      const controller = new AbortController();
      const start = Date.now();

      // Abort after 100ms (during rerank)
      setTimeout(() => controller.abort(), 100);

      // Rerank abort should be caught and fallback to cosine
      const results = await retriever.retrieve({
        query: "test query",
        limit: 5,
        signal: controller.signal,
        source: "manual",
      });

      const elapsed = Date.now() - start;

      // Should return results (cosine fallback)
      assert.ok(results.length > 0, "Should return results with cosine fallback");
      // Should abort relatively quickly
      assert.ok(
        elapsed < 300,
        `Should abort quickly, got ${elapsed}ms`,
      );
      assert.equal(
        warnings.some((line) => line.includes("external signal aborted")),
        false,
        "external auto-recall aborts should not emit warning-level rerank logs",
      );
      assert.equal(
        debugLogs.some((line) => line.includes("external signal aborted")),
        false,
        "external auto-recall aborts should be silent because cosine fallback is expected",
      );
    } finally {
      console.warn = originalWarn;
      console.debug = originalDebug;
    }
  });

  it("returns results with cosine scores when rerank network error", async () => {
    globalThis.fetch = async () => {
      throw new Error("Network error: connection refused");
    };

    const { retriever } = createRetrieverHarness(
      {
        mode: "hybrid",
        rerank: "cross-encoder",
        rerankApiKey: "test-key",
        rerankModel: "jina-reranker-v3",
        rerankTimeoutMs: 100,
      },
      {
        async vectorSearch() {
          return [
            buildResult("v1", "result 1", [0.3, 0.4, 0.5]),
            buildResult("v2", "result 2", [0.1, 0.2, 0.3]),
          ];
        },
        async bm25Search() {
          return [];
        },
      },
    );

    const results = await retriever.retrieve({
      query: "test query",
      limit: 5,
      source: "manual",
    });

    // Should still return results with cosine fallback
    assert.ok(results.length > 0, "Should return results after network error");

    // Cosine scores should be computed
    assert.ok(
      results.every((r) => typeof r.sources?.reranked?.score === "number"),
      "Results should have cosine rerank scores",
    );
  });

  it("diagnostics reports rerank stage when it fails", async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: "Server error" }), {
        status: 500,
      });
    };

    const { retriever } = createRetrieverHarness({
      mode: "hybrid",
      rerank: "cross-encoder",
      rerankApiKey: "test-key",
      rerankModel: "jina-reranker-v3",
      rerankTimeoutMs: 100,
    });

    await retriever.retrieve({
      query: "test query",
      limit: 5,
      source: "manual",
    });

    const diagnostics = retriever.getLastDiagnostics();
    // Diagnostics should exist and have rerank input count
    assert.ok(diagnostics, "Should have diagnostics");
    assert.ok(
      diagnostics.stageCounts.rerankInput > 0,
      "Should have rerank input count",
    );
  });
});
