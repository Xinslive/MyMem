import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { TraceCollector } = jiti("../src/retrieval-trace.ts");
const { RetrievalStatsCollector } = jiti("../src/retrieval-stats.ts");
const { buildDropSummary } = jiti("../src/retriever-utils.ts");

// ============================================================================
// TraceCollector tests
// ============================================================================

describe("TraceCollector", () => {
  it("tracks a single stage with drops", () => {
    const tc = new TraceCollector();
    tc.startStage("vector_search", ["a", "b", "c"]);
    tc.endStage(["a", "c"], [0.9, 0.7]);

    const trace = tc.finalize("test query", "hybrid");
    assert.equal(trace.stages.length, 1);
    assert.equal(trace.stages[0].name, "vector_search");
    assert.equal(trace.stages[0].inputCount, 3);
    assert.equal(trace.stages[0].outputCount, 2);
    assert.deepEqual(trace.stages[0].droppedIds, ["b"]);
    assert.deepEqual(trace.stages[0].scoreRange, [0.7, 0.9]);
    assert.ok(trace.stages[0].durationMs >= 0);
  });

  it("tracks multiple stages in sequence", () => {
    const tc = new TraceCollector();

    tc.startStage("vector_search", ["a", "b", "c", "d"]);
    tc.endStage(["a", "b", "c", "d"], [0.9, 0.8, 0.7, 0.5]);

    tc.startStage("min_score_filter", ["a", "b", "c", "d"]);
    tc.endStage(["a", "b", "c"], [0.9, 0.8, 0.7]);

    tc.startStage("noise_filter", ["a", "b", "c"]);
    tc.endStage(["a", "b"], [0.9, 0.8]);

    const trace = tc.finalize("test query", "hybrid");
    assert.equal(trace.stages.length, 3);
    assert.equal(trace.query, "test query");
    assert.equal(trace.mode, "hybrid");
    assert.equal(trace.finalCount, 2);
    assert.ok(trace.totalMs >= 0);
  });

  it("handles null scores (no score range)", () => {
    const tc = new TraceCollector();
    tc.startStage("rrf_fusion", ["a", "b"]);
    tc.endStage(["a", "b"]);

    const trace = tc.finalize("q", "vector");
    assert.equal(trace.stages[0].scoreRange, null);
  });

  it("handles zero entries", () => {
    const tc = new TraceCollector();
    tc.startStage("vector_search", []);
    tc.endStage([]);

    const trace = tc.finalize("q", "vector");
    assert.equal(trace.stages[0].inputCount, 0);
    assert.equal(trace.stages[0].outputCount, 0);
    assert.deepEqual(trace.stages[0].droppedIds, []);
    assert.equal(trace.finalCount, 0);
  });

  it("auto-closes unclosed stage on finalize", () => {
    const tc = new TraceCollector();
    tc.startStage("vector_search", ["a", "b"]);
    // Not calling endStage explicitly

    const trace = tc.finalize("q", "hybrid");
    assert.equal(trace.stages.length, 1);
    // Auto-closed with all input IDs surviving
    assert.equal(trace.stages[0].outputCount, 2);
  });

  it("auto-closes previous stage when starting new one", () => {
    const tc = new TraceCollector();
    tc.startStage("vector_search", ["a", "b"]);
    // Start a new stage without ending the previous one
    tc.startStage("rerank", ["a"]);
    tc.endStage(["a"], [0.95]);

    const trace = tc.finalize("q", "hybrid");
    assert.equal(trace.stages.length, 2);
    assert.equal(trace.stages[0].name, "vector_search");
    assert.equal(trace.stages[1].name, "rerank");
  });

  it("endStage is a no-op without a pending stage", () => {
    const tc = new TraceCollector();
    // Should not throw
    tc.endStage(["a"]);
    const trace = tc.finalize("q", "vector");
    assert.equal(trace.stages.length, 0);
  });

  it("computes correct drop IDs across stages", () => {
    const tc = new TraceCollector();

    tc.startStage("rerank", ["x", "y", "z"]);
    tc.endStage(["x", "z"], [0.95, 0.60]);

    const stage = tc.stages[0];
    assert.deepEqual(stage.droppedIds, ["y"]);
    assert.equal(stage.inputCount, 3);
    assert.equal(stage.outputCount, 2);
  });

  it("summarize produces human-readable output", () => {
    const tc = new TraceCollector();
    tc.startStage("vector_search", ["a", "b", "c"]);
    tc.endStage(["a", "b"], [0.9, 0.7]);
    tc.startStage("noise_filter", ["a", "b"]);
    tc.endStage(["a"], [0.9]);

    const summary = tc.summarize();
    assert.ok(summary.includes("vector_search"));
    assert.ok(summary.includes("noise_filter"));
    assert.ok(summary.includes("3"));
    assert.ok(summary.includes("2"));
  });

  it("summarize truncates long drop lists", () => {
    const tc = new TraceCollector();
    const ids = Array.from({ length: 10 }, (_, i) => `id-${i}`);
    tc.startStage("filter", ids);
    tc.endStage(["id-0"], [0.9]);

    const summary = tc.summarize();
    assert.ok(summary.includes("+"));
    assert.ok(summary.includes("more"));
  });
});

// ============================================================================
// Zero-overhead test
// ============================================================================

describe("TraceCollector zero-overhead", () => {
  it("optional chaining on undefined trace does not throw", () => {
    const trace = undefined;
    // This pattern is used throughout retriever.ts
    trace?.startStage("test", ["a"]);
    trace?.endStage(["a"]);
    // Should complete without error
    assert.ok(true);
  });
});

// ============================================================================
// Diagnostics summary tests
// ============================================================================

describe("retrieval diagnostics drop summary", () => {
  function diagnosticsWithCounts(stageCounts) {
    return {
      mode: "hybrid",
      originalQuery: "test",
      bm25Query: "test",
      queryExpanded: false,
      limit: 5,
      vectorResultCount: 5,
      bm25ResultCount: 5,
      fusedResultCount: 10,
      finalResultCount: stageCounts.afterHardMinScore ?? 1,
      stageCounts: {
        afterMinScore: 10,
        afterCandidateCap: 10,
        afterSoftMinScore: 10,
        rerankInput: 10,
        afterRerank: 10,
        afterRecency: 10,
        afterImportance: 10,
        afterLengthNorm: 10,
        afterTimeDecay: 10,
        afterLearningPolicy: 10,
        afterHardMinScore: 10,
        afterNoiseFilter: 10,
        afterDiversity: 10,
        ...stageCounts,
      },
      dropSummary: [],
    };
  }

  it("reports hard cutoff drops after rerank, using the current stage score", () => {
    const drops = buildDropSummary(diagnosticsWithCounts({
      afterSoftMinScore: 1,
      rerankInput: 1,
      afterRerank: 1,
      afterHardMinScore: 0,
    }));

    const hardDrop = drops.find((drop) => drop.stage === "hardMinScore");
    assert.deepEqual(hardDrop, {
      stage: "hardMinScore",
      before: 1,
      after: 0,
      dropped: 1,
    });
  });

  it("orders equal drops by the real post-processing pipeline", () => {
    const drops = buildDropSummary(diagnosticsWithCounts({
      afterMinScore: 9,
      afterRecency: 8,
      afterImportance: 7,
      afterLengthNorm: 6,
      afterNoiseFilter: 5,
      afterTimeDecay: 4,
      afterLearningPolicy: 3,
      afterDiversity: 2,
      afterCandidateCap: 1,
      afterSoftMinScore: 0,
      afterRerank: 0,
      afterHardMinScore: 0,
    }));

    assert.deepEqual(
      drops.map((drop) => drop.stage),
      [
        "minScore",
        "recencyBoost",
        "importanceWeight",
        "lengthNorm",
        "noiseFilter",
        "timeDecay",
        "learningPolicy",
        "diversity",
        "candidateCap",
        "softMinScore",
      ],
    );
  });
});

// ============================================================================
// RetrievalStatsCollector tests
// ============================================================================

describe("RetrievalStatsCollector", () => {
  it("returns empty stats when no queries recorded", () => {
    const collector = new RetrievalStatsCollector();
    const stats = collector.getStats();
    assert.equal(stats.totalQueries, 0);
    assert.equal(stats.zeroResultQueries, 0);
    assert.equal(stats.avgLatencyMs, 0);
  });

  it("records and aggregates query traces", () => {
    const collector = new RetrievalStatsCollector();

    collector.recordQuery(
      {
        query: "test 1",
        mode: "hybrid",
        startedAt: Date.now() - 100,
        stages: [
          {
            name: "vector_search",
            inputCount: 10,
            outputCount: 8,
            droppedIds: ["a", "b"],
            scoreRange: [0.5, 0.9],
            durationMs: 50,
          },
          {
            name: "noise_filter",
            inputCount: 8,
            outputCount: 6,
            droppedIds: ["c", "d"],
            scoreRange: [0.5, 0.9],
            durationMs: 5,
          },
        ],
        finalCount: 6,
        totalMs: 100,
      },
      "manual",
    );

    collector.recordQuery(
      {
        query: "test 2",
        mode: "hybrid",
        startedAt: Date.now() - 200,
        stages: [
          {
            name: "vector_search",
            inputCount: 5,
            outputCount: 5,
            droppedIds: [],
            scoreRange: [0.6, 0.95],
            durationMs: 30,
          },
          {
            name: "rerank",
            inputCount: 5,
            outputCount: 5,
            droppedIds: [],
            scoreRange: [0.6, 0.95],
            durationMs: 20,
          },
        ],
        finalCount: 0,
        totalMs: 200,
      },
      "auto-recall",
    );

    const stats = collector.getStats();
    assert.equal(stats.totalQueries, 2);
    assert.equal(stats.zeroResultQueries, 1);
    assert.equal(stats.avgLatencyMs, 150);
    assert.equal(stats.rerankUsed, 1);
    assert.equal(stats.noiseFiltered, 1);
    assert.deepEqual(stats.queriesBySource, {
      manual: 1,
      "auto-recall": 1,
    });
    assert.ok(stats.topDropStages.length > 0);
    const vectorDrop = stats.topDropStages.find(
      (s) => s.name === "vector_search",
    );
    assert.equal(vectorDrop?.totalDropped, 2);
  });

  it("computes p95 latency correctly", () => {
    const collector = new RetrievalStatsCollector();

    for (let i = 1; i <= 20; i++) {
      collector.recordQuery(
        {
          query: `q${i}`,
          mode: "vector",
          startedAt: Date.now(),
          stages: [],
          finalCount: 1,
          totalMs: i * 10,
        },
        "manual",
      );
    }

    const stats = collector.getStats();
    // p95 of [10,20,...,200] is at index ceil(20*0.95)-1 = 18 -> 190
    assert.equal(stats.p95LatencyMs, 190);
  });

  it("reset clears all data", () => {
    const collector = new RetrievalStatsCollector();
    collector.recordQuery(
      {
        query: "q",
        mode: "vector",
        startedAt: Date.now(),
        stages: [],
        finalCount: 1,
        totalMs: 50,
      },
      "manual",
    );
    assert.equal(collector.count, 1);

    collector.reset();
    assert.equal(collector.count, 0);
    assert.equal(collector.getStats().totalQueries, 0);
  });

  it("evicts oldest records when over capacity", () => {
    const collector = new RetrievalStatsCollector(3);

    for (let i = 0; i < 5; i++) {
      collector.recordQuery(
        {
          query: `q${i}`,
          mode: "vector",
          startedAt: Date.now(),
          stages: [],
          finalCount: 1,
          totalMs: 10,
        },
        "manual",
      );
    }

    assert.equal(collector.count, 3);
    assert.equal(collector.getStats().totalQueries, 3);
  });
});
