import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  TelemetryStore,
  normalizeTelemetryConfig,
} = jiti("../src/telemetry.ts");
const { runBenchmarkSummary } = jiti("../benchmark/run.ts");
const { runBenchmarkScenarios, compareBenchmarkBaseline } = jiti("../benchmark/run.ts");

function makeTrace(query, totalMs, finalCount, stages = []) {
  return {
    query,
    mode: "hybrid",
    startedAt: Date.now(),
    stages,
    finalCount,
    totalMs,
  };
}

describe("telemetry persistence", () => {
  it("persists retrieval and extraction summaries with max-record trimming", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mymem-telemetry-"));
    try {
      const store = new TelemetryStore(
        normalizeTelemetryConfig({ persist: true, maxRecords: 3, sampleRate: 1 }),
        dir,
      );

      await store.recordRetrieval(makeTrace("q1", 10, 1), "manual");
      await store.recordRetrieval(makeTrace("q2", 20, 0), "manual");
      await store.recordRetrieval(makeTrace("q3", 30, 2), "auto-recall");
      await store.recordRetrieval(makeTrace("q4", 40, 0), "auto-recall");

      await store.recordExtraction("session-1", "global", {
        created: 1,
        merged: 0,
        skipped: 0,
        telemetry: {
          totalMs: 25,
          candidateCount: 1,
          cappedCandidateCount: 1,
          processableCandidateCount: 1,
          duplicateSkipped: 0,
          batchDedupMs: 1,
          batchEmbedMs: 2,
          processMs: 3,
          flushMs: 4,
        },
      });
      await store.recordExtraction("session-2", "agent:main", {
        created: 0,
        merged: 1,
        skipped: 1,
        rejected: 1,
        telemetry: {
          totalMs: 45,
          candidateCount: 2,
          cappedCandidateCount: 2,
          processableCandidateCount: 2,
          duplicateSkipped: 0,
          batchDedupMs: 1,
          batchEmbedMs: 2,
          processMs: 3,
          flushMs: 4,
        },
      });

      const summary = await store.getPersistentSummary();
      assert.equal(summary.retrieval?.totalQueries, 3);
      assert.equal(summary.retrieval?.zeroResultQueries, 2);
      assert.equal(summary.extraction?.totalRuns, 2);
      assert.equal(summary.extraction?.totalCreated, 1);
      assert.equal(summary.extraction?.totalRejected, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("benchmark runner", () => {
  it("summarizes persisted telemetry files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mymem-benchmark-"));
    try {
      const store = new TelemetryStore(
        normalizeTelemetryConfig({ persist: true, maxRecords: 10, sampleRate: 1 }),
        dir,
      );
      await store.recordRetrieval(makeTrace("bench-1", 15, 1), "manual");
      await store.recordRetrieval(makeTrace("bench-2", 35, 0), "manual");
      await store.recordExtraction("bench-session", "global", {
        created: 2,
        merged: 1,
        skipped: 0,
        telemetry: {
          totalMs: 55,
          candidateCount: 3,
          cappedCandidateCount: 3,
          processableCandidateCount: 3,
          duplicateSkipped: 0,
          batchDedupMs: 2,
          batchEmbedMs: 2,
          processMs: 3,
          flushMs: 4,
        },
      });

      const summary = await runBenchmarkSummary({
        retrievalFile: store.filePaths.retrieval,
        extractionFile: store.filePaths.extraction,
      });

      assert.equal(summary.retrieval?.totalQueries, 2);
      assert.equal(summary.retrieval?.zeroResultQueries, 1);
      assert.equal(summary.extraction?.totalRuns, 1);
      assert.equal(summary.extraction?.totalCreated, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs deterministic benchmark scenarios without network providers", async () => {
    const summary = await runBenchmarkScenarios({
      scenario: "retrieval",
      rows: 12,
      iterations: 2,
    });

    assert.equal(summary.rows, 12);
    assert.equal(summary.iterations, 2);
    assert.equal(summary.retrieval?.hybrid.iterations, 2);
    assert.equal(typeof summary.retrieval?.hybrid.p95Ms, "number");
    assert.equal(typeof summary.retrieval?.autoRecall.zeroResultRate, "number");
  });

  it("reports benchmark p95 regressions against a baseline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mymem-benchmark-baseline-"));
    try {
      const baselinePath = join(dir, "baseline.json");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        baselinePath,
        JSON.stringify({
          rows: 1,
          iterations: 1,
          retrieval: {
            hybrid: {
              iterations: 1,
              avgMs: 10,
              p50Ms: 10,
              p95Ms: 10,
              minMs: 10,
              maxMs: 10,
            },
          },
        }),
      );

      const regressions = await compareBenchmarkBaseline(
        {
          rows: 1,
          iterations: 1,
          retrieval: {
            hybrid: {
              iterations: 1,
              avgMs: 30,
              p50Ms: 30,
              p95Ms: 30,
              minMs: 30,
              maxMs: 30,
            },
          },
        },
        baselinePath,
      );

      assert.equal(regressions.length, 1);
      assert.match(regressions[0], /retrieval\.hybrid\.p95Ms/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
