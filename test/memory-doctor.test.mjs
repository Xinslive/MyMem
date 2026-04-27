import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { registerMemoryDoctorTool } = await jiti("../src/memory-doctor-tool.ts");

function createApi() {
  const tools = new Map();
  return {
    tools,
    registerTool(factory, options) {
      tools.set(options.name, factory({ agentId: "main" }));
    },
  };
}

function createContext(overrides = {}) {
  return {
    agentId: "main",
    scopeManager: {
      getStats: () => ({ totalScopes: 2 }),
      getAccessibleScopes: () => ["global", "agent:main"],
      isAccessible: () => true,
    },
    store: {
      hasFtsSupport: true,
      count: async () => 3,
      getIndexStatus: async () => ({
        totalRows: 3,
        totalIndices: 5,
        names: ["text_idx", "id_idx", "timestamp_idx", "scope_idx", "vector_idx"],
        available: {
          fts: true,
          vector: true,
          scalar: ["category", "id", "scope", "timestamp"],
        },
        exhaustiveVectorSearch: false,
        missingRecommendedScalars: [],
        vectorIndexPending: false,
      }),
      stats: async () => ({
        totalCount: 2,
        scopeCounts: { global: 1, "agent:main": 1 },
        categoryCounts: { preference: 1, fact: 1 },
      }),
    },
    retriever: {
      getConfig: () => ({
        mode: "hybrid",
        rerank: "none",
        candidatePoolSize: 20,
        minScore: 0.1,
        hardMinScore: 0,
      }),
      test: async () => ({ success: true, mode: "hybrid", hasFtsSupport: true }),
      getStatsCollector: () => ({
        count: 1,
        getStats: () => ({
          totalQueries: 1,
          zeroResultQueries: 0,
          avgLatencyMs: 12,
          p95LatencyMs: 12,
          avgResultCount: 2,
          rerankUsed: 0,
          noiseFiltered: 0,
          queriesBySource: { manual: 1 },
          topDropStages: [],
        }),
      }),
    },
    embedder: {
      test: async () => ({ success: true, dimensions: 1024 }),
    },
    telemetry: null,
    ...overrides,
  };
}

test("memory_doctor reports ok diagnostics without embedding probe", async () => {
  const api = createApi();
  registerMemoryDoctorTool(api, createContext());

  const tool = api.tools.get("memory_doctor");
  assert.ok(tool);

  const result = await tool.execute("call-1", {}, undefined, undefined, { agentId: "main" });
  assert.equal(result.details.status, "warn");
  assert.match(result.content[0].text, /Memory Doctor: WARN/);
  assert.match(result.content[0].text, /embedding_probe: skipped/);
  assert.equal(result.details.checks.some((check) => check.name === "storage" && check.status === "ok"), true);
  assert.equal(result.details.checks.some((check) => check.name === "indices"), true);
});

test("memory_doctor can call embedding probe", async () => {
  const api = createApi();
  registerMemoryDoctorTool(api, createContext());

  const tool = api.tools.get("memory_doctor");
  const result = await tool.execute("call-1", { testEmbedding: true }, undefined, undefined, { agentId: "main" });

  assert.equal(result.details.status, "ok");
  assert.match(result.content[0].text, /embedding provider returned 1024 dimensions/);
});

test("memory_doctor reports failing retrieval probe", async () => {
  const api = createApi();
  registerMemoryDoctorTool(api, createContext({
    retriever: {
      getConfig: () => ({ mode: "vector", rerank: "none", minScore: 0.1, hardMinScore: 0 }),
      test: async () => ({ success: false, mode: "vector", hasFtsSupport: true, error: "boom" }),
    },
  }));

  const tool = api.tools.get("memory_doctor");
  const result = await tool.execute("call-1", {}, undefined, undefined, { agentId: "main" });

  assert.equal(result.details.status, "fail");
  assert.match(result.content[0].text, /retrieval_probe: boom/);
});

test("memory_doctor reports retrieval telemetry and suggestions", async () => {
  const api = createApi();
  registerMemoryDoctorTool(api, createContext({
    store: {
      hasFtsSupport: false,
      count: async () => 3,
      stats: async () => ({
        totalCount: 2,
        scopeCounts: { global: 2 },
        categoryCounts: { preference: 2 },
      }),
    },
    retriever: {
      getConfig: () => ({
        mode: "hybrid",
        rerank: "none",
        candidatePoolSize: 20,
        minScore: 0.5,
        hardMinScore: 0.4,
      }),
      test: async () => ({ success: true, mode: "vector", hasFtsSupport: false }),
      getStatsCollector: () => ({
        count: 4,
        getStats: () => ({
          totalQueries: 4,
          zeroResultQueries: 3,
          avgLatencyMs: 25,
          p95LatencyMs: 40,
          avgResultCount: 0.5,
          rerankUsed: 0,
          noiseFiltered: 1,
          queriesBySource: { manual: 2, "auto-recall": 2 },
          topDropStages: [{ name: "hard_min_score", totalDropped: 3 }],
        }),
      }),
    },
  }));

  const tool = api.tools.get("memory_doctor");
  const result = await tool.execute("call-1", {}, undefined, undefined, { agentId: "main" });

  assert.equal(result.details.status, "warn");
  assert.match(result.content[0].text, /retrieval_quality: queries=4, zero=3/);
  assert.match(result.content[0].text, /Suggestions:/);
  assert.ok(result.details.suggestions.some((s) => s.includes("zero-result queries")));
});

test("memory_doctor reports persisted telemetry when enabled", async () => {
  const api = createApi();
  registerMemoryDoctorTool(api, createContext({
    telemetry: {
      enabled: true,
      dir: "/tmp/mymem-telemetry",
      filePaths: {
        retrieval: "/tmp/mymem-telemetry/retrieval.jsonl",
        extraction: "/tmp/mymem-telemetry/extraction.jsonl",
      },
      getPersistentSummary: async () => ({
        retrieval: {
          totalQueries: 10,
          zeroResultQueries: 2,
          avgLatencyMs: 18,
          p95LatencyMs: 30,
        },
        extraction: {
          totalRuns: 3,
          avgLatencyMs: 45,
          p95LatencyMs: 60,
          totalCreated: 4,
          totalMerged: 1,
          totalSkipped: 2,
          totalRejected: 0,
        },
      }),
    },
  }));

  const tool = api.tools.get("memory_doctor");
  const result = await tool.execute("call-1", {}, undefined, undefined, { agentId: "main" });

  assert.equal(result.details.checks.some((check) => check.name === "telemetry_persistence" && check.status === "ok"), true);
  assert.match(result.content[0].text, /telemetry_persistence: enabled at \/tmp\/mymem-telemetry/);
});
