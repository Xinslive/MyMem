import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { startMemoryDashboardServer } = await jiti("../src/dashboard-server.ts");

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method || "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(body),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function requestText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          body,
        });
      });
    }).on("error", reject);
  });
}

function createContext() {
  const entry = {
    id: "dashboard_1",
    text: "The user likes dashboard pages with clear visual summaries.",
    category: "preference",
    scope: "global",
    importance: 0.88,
    timestamp: Date.now(),
    metadata: JSON.stringify({
      memory_category: "preferences",
      l0_abstract: "The user likes clear dashboards.",
      l1_overview: "- clear dashboard preference",
      l2_content: "The user likes dashboard pages with clear visual summaries.",
      state: "confirmed",
      confidence: 0.91,
      access_count: 3,
      memory_layer: "durable",
      source: "manual",
    }),
  };

  return {
    store: {
      hasFtsSupport: true,
      getFtsStatus: () => ({ available: true, lastError: null }),
      getIndexStatus: async () => ({
        totalRows: 1,
        totalIndices: 3,
        names: ["text_idx", "vector_idx"],
        available: { fts: true, vector: true, scalar: ["scope", "category"] },
        exhaustiveVectorSearch: false,
        missingRecommendedScalars: [],
        vectorIndexPending: false,
      }),
      stats: async () => ({
        totalCount: 1,
        scopeCounts: { global: 1 },
        categoryCounts: { preference: 1 },
        memoryCategoryCounts: { preferences: 1 },
        recentActivity: { last24h: 1, last7d: 1, last30d: 1 },
        tierDistribution: { durable: 1 },
        healthSignals: { badRecall: 0, suppressed: 0, lowConfidence: 0 },
      }),
      list: async () => [entry],
      delete: async (id) => id === entry.id,
    },
    scopeManager: {
      getStats: () => ({
        totalScopes: 1,
        agentsWithCustomAccess: 0,
        scopesByType: { global: 1 },
      }),
      getAllScopes: () => ["global"],
      getAccessibleScopes: () => ["global"],
    },
    retriever: {
      getConfig: () => ({
        mode: "hybrid",
        vectorWeight: 0.7,
        bm25Weight: 0.3,
        queryExpansion: true,
        minScore: 0.5,
        rerank: "cross-encoder",
        candidatePoolSize: 12,
        recencyHalfLifeDays: 14,
        recencyWeight: 0.15,
        filterNoise: true,
        hardMinScore: 0.55,
        timeDecayHalfLifeDays: 60,
        tagPrefixes: ["proj", "env"],
      }),
      getLastDiagnostics: () => null,
      retrieveWithTrace: async (params) => ({
        results: [
          {
            entry,
            score: 0.93,
            confidence: 0.9,
            sources: { bm25: { score: 0.93, rank: 1 } },
          },
        ],
        trace: {
          query: params.query,
          mode: "hybrid",
          startedAt: Date.now(),
          stages: [
            {
              name: "parallel_search",
              inputCount: 0,
              outputCount: 1,
              droppedIds: [],
              scoreRange: [0.93, 0.93],
              durationMs: 2,
            },
            {
              name: "hard_cutoff",
              inputCount: 1,
              outputCount: 1,
              droppedIds: [],
              scoreRange: [0.93, 0.93],
              durationMs: 1,
            },
          ],
          finalCount: 1,
          totalMs: 3,
        },
      }),
    },
  };
}

test("dashboard server serves page and read-only APIs", async () => {
  const server = await startMemoryDashboardServer(createContext(), {
    host: "127.0.0.1",
    port: 0,
  });

  try {
    const page = await requestText(server.url + "/");
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /MyMem 记忆管理台/);
    assert.match(page.body, /召回诊断/);
    assert.match(page.body, /记忆瀑布流/);
    assert.match(page.body, /masonry-list/);
    assert.match(page.body, /data-action="delete"/);
    assert.match(page.body, /L0 摘要/);
    assert.doesNotMatch(page.body, /按范围/);
    assert.doesNotMatch(page.body, /最近记忆/);

    const memoriesPage = await requestText(server.url + "/memories");
    assert.equal(memoriesPage.statusCode, 200);
    assert.match(memoriesPage.body, /记忆瀑布流/);

    const summary = await requestJson(server.url + "/api/summary");
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.body.memory.totalCount, 1);
    assert.equal(summary.body.retrieval.hasFtsSupport, true);
    assert.deepEqual(summary.body.scopes.available, ["global"]);
    assert.equal(summary.body.scopes.labels.global, "全局");
    assert.equal(summary.body.display.categoryCounts["用户偏好"], 1);
    assert.equal(summary.body.display.categoryCounts["用户画像"], 0);
    assert.equal(summary.body.display.recentActivity["1 天内"], 1);
    assert.equal(summary.body.display.recentActivity["1 月内"], 1);
    assert.equal(summary.body.display.recentActivity["全部"], 1);
    assert.equal(summary.body.display.tierDistribution["长期记忆"], 1);

    const memories = await requestJson(server.url + "/api/memories?limit=1");
    assert.equal(memories.statusCode, 200);
    assert.equal(memories.body.memories[0].categoryLabel, "用户偏好");
    assert.equal(memories.body.memories[0].scopeLabel, "全局");
    assert.equal(memories.body.memories[0].details.l0, "The user likes clear dashboards.");

    const explain = await requestJson(server.url + "/api/explain?query=dashboard&limit=3");
    assert.equal(explain.statusCode, 200);
    assert.equal(explain.body.count, 1);
    assert.equal(explain.body.explanation.status, "matched");
    assert.equal(explain.body.results[0].id, "dashboard_1");
    assert.equal(explain.body.results[0].categoryLabel, "用户偏好");

    const deleted = await requestJson(server.url + "/api/memories/dashboard_1", { method: "DELETE" });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.body.ok, true);
  } finally {
    await server.close();
  }
});
