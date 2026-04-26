import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { MemoryStore } = await jiti("../src/store.ts");
const { createRetriever, DEFAULT_RETRIEVAL_CONFIG } = await jiti("../src/retriever.ts");
const { SmartExtractor } = await jiti("../src/smart-extractor.ts");
const { RetrievalStatsCollector } = await jiti("../src/retrieval-stats.ts");

function makeDeterministicEmbedder() {
  const toVector = (text) => {
    const value = String(text || "").toLowerCase();
    return [
      value.includes("乌龙茶") || value.includes("oolong") ? 1 : 0,
      value.includes("typescript") ? 1 : 0,
      value.includes("咖啡") || value.includes("coffee") ? 1 : 0,
      Math.min(1, value.length / 1000),
    ];
  };

  return {
    async embed(text) {
      return toVector(text);
    },
    async embedQuery(text) {
      return toVector(text);
    },
    async embedPassage(text) {
      return toVector(text);
    },
    async embedBatch(texts) {
      return texts.map((text) => toVector(text));
    },
    async embedBatchPassage(texts) {
      return texts.map((text) => toVector(text));
    },
    async test() {
      return { success: true, dimensions: 4 };
    },
  };
}

function makeFixtureLlm() {
  return {
    async completeJson(_prompt, label) {
      if (label === "extract-candidates") {
        return {
          memories: [
            {
              category: "preferences",
              abstract: "用户偏好是热乌龙茶，不喜欢冰美式咖啡。",
              overview: "- 饮品偏好：热乌龙茶\n- 避免：冰美式咖啡",
              content: "用户明确说明：以后点饮品时，优先选择热乌龙茶，不要冰美式咖啡。",
            },
          ],
        };
      }
      if (label === "dedup-decision") {
        return { decision: "create", reason: "no existing memory" };
      }
      return null;
    },
    getLastError() {
      return null;
    },
  };
}

test("real closed loop stores extracted memory and recalls it later", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "memory-real-loop-"));

  try {
    const embedder = makeDeterministicEmbedder();
    const store = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: 4 });
    const retriever = createRetriever(store, embedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      mode: "vector",
      rerank: "none",
      minScore: 0,
      hardMinScore: 0,
      recencyWeight: 0,
      timeDecayHalfLifeDays: 0,
      filterNoise: false,
      candidatePoolSize: 10,
    });
    const statsCollector = new RetrievalStatsCollector();
    retriever.setStatsCollector(statsCollector);

    const extractor = new SmartExtractor(store, embedder, makeFixtureLlm(), {
      defaultScope: "agent:e2e",
      extractMinMessages: 1,
      log: () => {},
      debugLog: () => {},
    });

    const extractionStats = await extractor.extractAndPersist(
      "User: 以后帮我点饮品时，请记住我喜欢热乌龙茶，不要冰美式咖啡。\nAssistant: 记住了。",
      "session-real-loop",
      { scope: "agent:e2e", scopeFilter: ["agent:e2e"] },
    );

    assert.equal(extractionStats.created, 1);
    assert.equal(extractionStats.telemetry.candidateCount, 1);
    assert.equal(extractionStats.telemetry.processableCandidateCount, 1);
    assert.ok(extractionStats.telemetry.totalMs >= 0);

    const storedStats = await store.stats(["agent:e2e"]);
    assert.equal(storedStats.totalCount, 1);

    const recalled = await retriever.retrieve({
      query: "下次给我准备什么茶？",
      limit: 3,
      scopeFilter: ["agent:e2e"],
      source: "manual",
    });

    assert.equal(recalled.length, 1);
    assert.match(recalled[0].entry.text, /乌龙茶/);
    assert.equal(statsCollector.count, 1);
    assert.equal(statsCollector.getStats().totalQueries, 1);
    assert.equal(statsCollector.getStats().zeroResultQueries, 0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
