import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { registerMemoryExplainTool } = await jiti("../src/tools-management.ts");

function createApi() {
  const tools = new Map();
  return {
    tools,
    registerTool(factory, options) {
      tools.set(options.name, factory({ agentId: "main" }));
    },
  };
}

function makeTrace(finalCount, stages) {
  return {
    query: "test query",
    mode: "hybrid",
    startedAt: Date.now(),
    stages,
    finalCount,
    totalMs: 8,
  };
}

function createContext(overrides = {}) {
  const entry = {
    id: "memory_1",
    text: "The user prefers concise answers.",
    category: "preference",
    scope: "global",
    importance: 0.9,
    timestamp: Date.now(),
    metadata: JSON.stringify({
      l0_abstract: "The user prefers concise answers.",
      memory_category: "preferences",
      state: "confirmed",
      memory_layer: "durable",
    }),
  };
  return {
    agentId: "main",
    scopeManager: {
      getAccessibleScopes: () => ["global", "agent:main"],
      isAccessible: (scope) => scope === "global" || scope === "agent:main",
    },
    store: {
      hasFtsSupport: true,
    },
    retriever: {
      getConfig: () => ({
        mode: "hybrid",
        rerank: "none",
        minScore: 0.1,
        hardMinScore: 0.2,
      }),
      getLastDiagnostics: () => null,
      retrieveWithTrace: async () => ({
        results: [
          {
            entry,
            score: 0.91,
            confidence: 0.88,
            sources: { vector: { score: 0.91, rank: 1 } },
          },
        ],
        trace: makeTrace(1, [
          {
            name: "parallel_search",
            inputCount: 0,
            outputCount: 1,
            droppedIds: [],
            scoreRange: [0.91, 0.91],
            durationMs: 2,
          },
          {
            name: "hard_cutoff",
            inputCount: 1,
            outputCount: 1,
            droppedIds: [],
            scoreRange: [0.91, 0.91],
            durationMs: 1,
          },
        ]),
      }),
    },
    embedder: {},
    ...overrides,
  };
}

test("mymem_explain reports matched retrieval with trace details", async () => {
  const api = createApi();
  registerMemoryExplainTool(api, createContext());

  const tool = api.tools.get("mymem_explain");
  const result = await tool.execute("call-1", { query: "concise answers" }, undefined, undefined, { agentId: "main" });

  assert.equal(result.details.count, 1);
  assert.equal(result.details.explanation.status, "matched");
  assert.match(result.content[0].text, /Memory Explain:/);
  assert.match(result.content[0].text, /Matched 1 memory result/);
  assert.match(result.content[0].text, /parallel vector\/BM25 search/);
});

test("mymem_explain explains hardMinScore zero-result drops", async () => {
  const api = createApi();
  registerMemoryExplainTool(api, createContext({
    retriever: {
      getConfig: () => ({
        mode: "hybrid",
        rerank: "none",
        minScore: 0.1,
        hardMinScore: 0.9,
      }),
      getLastDiagnostics: () => null,
      retrieveWithTrace: async () => ({
        results: [],
        trace: makeTrace(0, [
          {
            name: "parallel_search",
            inputCount: 0,
            outputCount: 2,
            droppedIds: [],
            scoreRange: [0.4, 0.6],
            durationMs: 2,
          },
          {
            name: "hard_cutoff",
            inputCount: 2,
            outputCount: 0,
            droppedIds: ["memory_1", "memory_2"],
            scoreRange: null,
            durationMs: 1,
          },
        ]),
      }),
    },
  }));

  const tool = api.tools.get("mymem_explain");
  const result = await tool.execute("call-1", { query: "strict threshold" }, undefined, undefined, { agentId: "main" });

  assert.equal(result.details.count, 0);
  assert.equal(result.details.explanation.status, "empty");
  assert.match(result.content[0].text, /hardMinScore filter/);
  assert.ok(result.details.explanation.suggestions.some((item) => item.includes("hardMinScore")));
});

test("mymem_explain rejects inaccessible scope", async () => {
  const api = createApi();
  registerMemoryExplainTool(api, createContext());

  const tool = api.tools.get("mymem_explain");
  const result = await tool.execute("call-1", { query: "secret", scope: "agent:other" }, undefined, undefined, { agentId: "main" });

  assert.equal(result.details.error, "scope_access_denied");
  assert.match(result.content[0].text, /Access denied/);
});
