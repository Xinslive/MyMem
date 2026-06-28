import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
  formatDashboardUnlockUrl,
  startMemoryDashboardServer,
} = await jiti("../src/dashboard-server.ts");

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options.method || "GET",
        headers: options.headers,
      },
      (res) => {
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
      },
    );
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

function requestRaw(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options.method || "GET",
        headers: options.headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
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
      summary: "The user likes clear dashboards.",
      content: "The user likes dashboard pages with clear visual summaries.",
      state: "confirmed",
      confidence: 0.91,
      access_count: 3,
      memory_layer: "durable",
      source: "manual",
      memory_kind: "memory",
      utility_score: 0.67,
      utility_success_count: 2,
      utility_failure_count: 1,
      utility_trial_count: 3,
    }),
  };
  const lowConfidenceEntry = {
    id: "dashboard_2",
    text: "A legacy fact stores a stale profile-like note.",
    category: "fact",
    scope: "global",
    importance: 0.42,
    timestamp: Date.now() - 1000,
    metadata: JSON.stringify({
      memory_category: "profile",
      summary: "Scene: stale profile note",
      content: "A legacy fact stores a stale profile-like note.",
      state: "confirmed",
      confidence: 0.21,
      bad_recall_count: 2,
      suppressed_until_turn: 4,
      memory_layer: "working",
      source: "auto",
    }),
  };
  const labelPrefixedEntry = {
    id: "dashboard_3",
    text: "Skill: 需要\n- OpenClaw web_search 需要 MiniMax Coding Plan key，不是普通 API key。\n- MiniMax Search API 需要 MINIMAX_CODE_PLAN_KEY。",
    category: "other",
    scope: "global",
    importance: 0.72,
    timestamp: Date.now() - 2000,
    metadata: JSON.stringify({
      memory_category: "patterns",
      summary: "Skill: 需要",
      content: "Skill: 需要\n- OpenClaw web_search 需要 MiniMax Coding Plan key，不是普通 API key。\n- MiniMax Search API 需要 MINIMAX_CODE_PLAN_KEY。",
      state: "confirmed",
      confidence: 0.7,
      access_count: 1,
      memory_layer: "working",
      source: "auto",
    }),
  };
  const entries = [entry, lowConfidenceEntry, labelPrefixedEntry];
  const listCalls = [];

  return {
    store: {
      hasFtsSupport: true,
      getFtsStatus: () => ({ available: true, lastError: null }),
      getIndexStatus: async () => ({
        totalRows: 3,
        totalIndices: 3,
        names: ["text_idx", "vector_idx"],
        available: { fts: true, vector: true, scalar: ["scope", "category"] },
        exhaustiveVectorSearch: false,
        missingRecommendedScalars: [],
        vectorIndexPending: false,
      }),
      stats: async () => ({
        totalCount: 3,
        scopeCounts: { global: 3 },
        categoryCounts: { preference: 1, fact: 1, other: 1 },
        memoryCategoryCounts: { preferences: 1, profile: 1, patterns: 1 },
        recentActivity: { last24h: 3, last7d: 3, last30d: 3 },
        tierDistribution: { durable: 1, working: 2 },
        healthSignals: { badRecall: 1, suppressed: 0, lowConfidence: 1 },
      }),
      list: async (_scopeFilter, category, limit = 20, offset = 0, filters = undefined) => {
        listCalls.push({ category, limit, offset, filters });
        const filtered = category ? entries.filter((item) => item.category === category) : entries;
        return filtered.slice(offset, offset + limit);
      },
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
    feedbackLoop: {
      getStatus: () => ({
        enabled: true,
        disposed: false,
        priorAdaptation: {
          enabled: true,
          observedAdmitted: 9,
          cycles: 10,
          lastAdaptedAt: Date.now(),
          lastAdaptiveTypePriors: { profile: 0.9 },
        },
        preventiveLessons: {
          enabled: true,
          bufferedEvidence: 1,
          learned: 2,
          updated: 3,
          promoted: 4,
          skipped: 5,
          failed: 0,
          scanCycles: 8,
          lastScanAt: Date.now(),
        },
        runtime: {
          hasWorkspaceDir: true,
          hasDbPath: true,
          hasAdmissionConfig: true,
        },
      }),
    },
    listCalls,
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
        hardMinScore: 0.7,
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
  const authToken = "test-dashboard-token-123";
  const context = createContext();
  const server = await startMemoryDashboardServer(context, {
    host: "127.0.0.1",
    port: 0,
    authToken,
  });
  const authHeaders = { "X-Dashboard-Token": authToken };

  try {
    const page = await requestText(server.url + "/");
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /MyMem 记忆管理台/);
    assert.equal(page.body.includes(authToken), false);
    assert.match(page.body, /召回实验台/);
    assert.match(page.body, /记忆瀑布流/);
    assert.match(page.body, /masonry-list/);
    assert.match(page.body, /data-action="delete"/);
    assert.match(page.body, /摘要/);
    assert.match(page.body, /正文/);
    assert.doesNotMatch(page.body, /L0 摘要/);
    assert.doesNotMatch(page.body, /L1 概览/);
    assert.doesNotMatch(page.body, /L2 原文\/叙事/);
    assert.doesNotMatch(page.body, /<div class="config-label">来源<\/div>/);
    assert.doesNotMatch(page.body, /function statusChip/);
    assert.doesNotMatch(page.body, /有效<\/span>/);
    assert.doesNotMatch(page.body, /已失效<\/span>/);
    assert.doesNotMatch(page.body, /<span>访问 /);
    assert.match(page.body, /function accessChip/);
    assert.match(page.body, /处理阶段/);
    assert.match(page.body, /命中结果/);
    assert.doesNotMatch(page.body, /反馈循环/);
    assert.doesNotMatch(page.body, /class="kpis"/);
    assert.match(page.body, /qualityFilter/);
    assert.doesNotMatch(page.body, /按范围/);
    assert.doesNotMatch(page.body, /最近记忆/);

    const memoriesPage = await requestText(server.url + "/memories");
    assert.equal(memoriesPage.statusCode, 200);
    assert.match(memoriesPage.body, /记忆瀑布流/);

    const unauthorized = await requestJson(server.url + "/api/summary");
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unauthorized.body.error, "unauthorized");

    const tokenLanding = await requestRaw(server.url + "/?token=" + encodeURIComponent(authToken));
    assert.equal(tokenLanding.statusCode, 302);
    assert.equal(tokenLanding.headers.location, "/");
    assert.equal(tokenLanding.body, "");
    const cookie = tokenLanding.headers["set-cookie"]?.[0];
    assert.match(cookie || "", /mymem_dashboard_token=/);
    assert.match(cookie || "", /HttpOnly/);
    assert.match(cookie || "", /SameSite=Strict/);

    const cookieSummary = await requestJson(server.url + "/api/summary", {
      headers: { cookie: cookie?.split(";")[0] || "" },
    });
    assert.equal(cookieSummary.statusCode, 200);
    assert.equal(cookieSummary.body.memory.totalCount, 3);

    const summary = await requestJson(server.url + "/api/summary", { headers: authHeaders });
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.body.memory.totalCount, 3);
    assert.equal(summary.body.retrieval.hasFtsSupport, true);
    assert.deepEqual(summary.body.scopes.available, ["global"]);
    assert.equal(summary.body.scopes.labels.global, "全局");
    assert.equal(summary.body.display.categoryCounts["用户偏好"], 1);
    assert.equal(summary.body.display.categoryCounts["用户画像"], 1);
    assert.equal(summary.body.display.recentActivity["1 天内"], 3);
    assert.equal(summary.body.display.recentActivity["1 月内"], 3);
    assert.equal(summary.body.display.recentActivity["全部"], 3);
    assert.equal(summary.body.display.tierDistribution["长期记忆"], 1);
    assert.equal(summary.body.feedbackLoop.preventiveLessons.updated, 3);
    assert.equal(summary.body.feedbackLoop.priorAdaptation.cycles, 10);

    const memories = await requestJson(server.url + "/api/memories?limit=1", { headers: authHeaders });
    assert.equal(memories.statusCode, 200);
    assert.equal(memories.body.memories[0].categoryLabel, "用户偏好");
    assert.equal(memories.body.memories[0].scopeLabel, "全局");
    assert.equal(memories.body.memories[0].preview, "The user likes clear dashboards.");
    assert.equal(memories.body.memories[0].details.summary, "The user likes clear dashboards.");
    assert.deepEqual(memories.body.memories[0].learning, {
      kind: "memory",
      utilityScore: 0.67,
      utilitySuccessCount: 2,
      utilityFailureCount: 1,
      utilityTrialCount: 3,
    });

    const profileMemories = await requestJson(server.url + "/api/memories?category=profile&limit=10", {
      headers: authHeaders,
    });
    assert.equal(profileMemories.statusCode, 200);
    assert.deepEqual(profileMemories.body.memories.map((memory) => memory.id), ["dashboard_2"]);
    assert.equal(profileMemories.body.memories[0].categoryLabel, "用户画像");
    assert.equal(profileMemories.body.memories[0].preview, "A legacy fact stores a stale profile-like note.");

    const patternMemories = await requestJson(server.url + "/api/memories?category=patterns&limit=10", {
      headers: authHeaders,
    });
    assert.equal(patternMemories.statusCode, 200);
    assert.equal(patternMemories.body.memories[0].preview, "OpenClaw web_search 需要 MiniMax Coding Plan key，不是普通 API key。");
    assert.doesNotMatch(patternMemories.body.memories[0].preview, /^Skill:/);

    const lowConfidenceMemories = await requestJson(
      server.url + "/api/memories?quality=low_confidence&limit=10",
      { headers: authHeaders },
    );
    assert.equal(lowConfidenceMemories.statusCode, 200);
    assert.equal(lowConfidenceMemories.body.filters.qualityLabel, "低置信");
    assert.deepEqual(lowConfidenceMemories.body.memories.map((memory) => memory.id), ["dashboard_2"]);
    assert.deepEqual(lowConfidenceMemories.body.memories[0].qualityFlags.sort(), ["bad_recall", "low_confidence"]);
    assert.deepEqual(context.listCalls.at(-1), {
      category: undefined,
      limit: 1000,
      offset: 0,
      filters: { quality: "low_confidence" },
    });

    const explain = await requestJson(server.url + "/api/explain?query=dashboard&limit=3", { headers: authHeaders });
    assert.equal(explain.statusCode, 200);
    assert.equal(explain.body.count, 1);
    assert.equal(explain.body.explanation.status, "matched");
    assert.equal(explain.body.results[0].id, "dashboard_1");
    assert.equal(explain.body.results[0].categoryLabel, "用户偏好");

    const deleted = await requestJson(server.url + "/api/memories/dashboard_1", {
      method: "DELETE",
      headers: authHeaders,
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.body.ok, true);
  } finally {
    await server.close();
  }
});

test("dashboard generated token is persisted privately and not printed", async () => {
  const dbPath = mkdtempSync(join(tmpdir(), "mymem-dashboard-token-"));
  const warnings = [];
  const originalWarn = console.warn;
  let server;

  try {
    console.warn = (...args) => {
      warnings.push(args.join(" "));
    };
    server = await startMemoryDashboardServer(
      { ...createContext(), dbPath },
      { host: "127.0.0.1", port: 0 },
    );

    const tokenFile = join(dbPath, ".dashboard-token");
    const token = readFileSync(tokenFile, "utf8");
    const warning = warnings.join("\n");

    assert.equal(token, server.authToken);
    assert.equal(server.authTokenFile, tokenFile);
    assert.ok(server.authToken.length >= 16);
    if (process.platform !== "win32") {
      assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    }
    assert.match(warning, /dashboard auth token written/);
    assert.ok(warning.includes(tokenFile));
    assert.ok(warning.includes(formatDashboardUnlockUrl(server.url, tokenFile)));
    assert.equal(warning.includes(server.authToken), false);
    assert.doesNotMatch(warning, new RegExp(`\\?token=${server.authToken}`));

    const page = await requestText(server.url + "/");
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /MyMem 记忆管理台/);
    assert.equal(page.body.includes(server.authToken), false);
  } finally {
    console.warn = originalWarn;
    await server?.close();
    rmSync(dbPath, { recursive: true, force: true });
  }
});

test("dashboard existing token file still prints unlock instructions without the token", async () => {
  const dbPath = mkdtempSync(join(tmpdir(), "mymem-dashboard-existing-token-"));
  const tokenFile = join(dbPath, ".dashboard-token");
  const existingToken = "existing-dashboard-token-value";
  writeFileSync(tokenFile, existingToken, { mode: 0o600 });
  const warnings = [];
  const originalWarn = console.warn;
  let server;

  try {
    console.warn = (...args) => {
      warnings.push(args.join(" "));
    };
    server = await startMemoryDashboardServer(
      { ...createContext(), dbPath },
      { host: "127.0.0.1", port: 0 },
    );

    const warning = warnings.join("\n");
    assert.equal(server.authToken, existingToken);
    assert.match(warning, /dashboard auth token loaded from/);
    assert.ok(warning.includes(tokenFile));
    assert.ok(warning.includes(formatDashboardUnlockUrl(server.url, tokenFile)));
    assert.equal(warning.includes(existingToken), false);
  } finally {
    console.warn = originalWarn;
    await server?.close();
    rmSync(dbPath, { recursive: true, force: true });
  }
});

test("dashboard unlock URL shell-quotes token file paths", () => {
  assert.equal(
    formatDashboardUnlockUrl("http://127.0.0.1:1314", "/tmp/mymem user's/.dashboard-token"),
    "http://127.0.0.1:1314/?token=$(cat '/tmp/mymem user'\\''s/.dashboard-token')",
  );
});
