import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});
const { parsePluginConfig } = jiti("../src/plugin-config-parser.ts");

function baseConfig() {
  return {
    embedding: {
      apiKey: "test-api-key",
      baseURL: "https://embedding.example/v1",
      model: "Embedding",
    },
  };
}

describe("sessionStrategy legacy compatibility mapping", () => {
  it("maps legacy sessionMemory.enabled=true to systemSessionMemory", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      sessionMemory: { enabled: true },
    });
    assert.equal(parsed.sessionStrategy, "systemSessionMemory");
  });

  it("preserves explicit legacy sessionMemory.enabled=false as none", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      sessionMemory: { enabled: false },
    });
    assert.equal(parsed.sessionStrategy, "none");
  });

  it("prefers explicit sessionStrategy over legacy sessionMemory.enabled", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      sessionStrategy: "memoryReflection",
      sessionMemory: { enabled: false },
    });
    assert.equal(parsed.sessionStrategy, "memoryReflection");
  });

  it("defaults to memoryReflection when neither session field is set", () => {
    const parsed = parsePluginConfig(baseConfig());
    assert.equal(parsed.sessionStrategy, "memoryReflection");
  });

  it("uses opinionated defaults after provider endpoints and models are configured", () => {
    const parsed = parsePluginConfig(baseConfig());

    assert.equal(parsed.embedding.model, "Embedding");
    assert.equal(parsed.embedding.baseURL, "https://embedding.example/v1");
    assert.equal(parsed.embedding.dimensions, 2048);
    assert.equal(parsed.embedding.chunking, true);
    assert.equal(parsed.autoRecall, true);
    assert.equal(parsed.autoRecallMinLength, 6);
    assert.equal(parsed.autoRecallMaxItems, 5);
    assert.equal(parsed.extractMinMessages, 2);
    assert.equal(parsed.llm?.model, undefined);
    assert.equal(parsed.llm?.baseURL, undefined);
    assert.equal(parsed.llm?.timeoutMs, 90000);
    assert.equal(parsed.memoryReflection?.agentId, "main");
    assert.equal(parsed.memoryReflection?.timeoutMs, 90000);
    assert.equal(parsed.memoryCompaction?.enabled, true);
    assert.equal(parsed.memoryCompaction?.mergeMode, "llm");
    assert.equal(parsed.memoryCompaction?.deleteSourceMemories, true);
    assert.equal(parsed.memoryCompaction?.dryRun, false);
    assert.equal(parsed.memoryCompaction?.maxLlmClustersPerRun, 10);
    assert.equal(parsed.lifecycleMaintenance?.enabled, true);
    assert.equal(parsed.lifecycleMaintenance?.cooldownHours, 6);
    assert.equal(parsed.lifecycleMaintenance?.maxMemoriesToScan, 300);
    assert.equal(parsed.lifecycleMaintenance?.archiveThreshold, 0.15);
    assert.equal(parsed.lifecycleMaintenance?.dryRun, false);
    assert.equal(parsed.lifecycleMaintenance?.deleteMode, "archive");
    assert.deepEqual(parsed.lifecycleMaintenance?.hardDeleteReasons, ["duplicate_cluster_source", "noise", "superseded_fragment"]);
    assert.equal(parsed.preferenceDistiller?.enabled, true);
    assert.equal(parsed.preferenceDistiller?.maxSessions, 12);
    assert.equal(parsed.preferenceDistiller?.minEvidenceCount, 2);
    assert.equal(parsed.preferenceDistiller?.minStabilityScore, 0.6);
    assert.equal(parsed.preferenceDistiller?.maxRulesPerRun, 5);
    assert.equal(parsed.experienceCompiler?.enabled, true);
    assert.equal(parsed.experienceCompiler?.maxStrategiesPerRun, 3);
    assert.equal(parsed.hookEnhancements?.sessionPrimer?.enabled, true);
    assert.equal(parsed.hookEnhancements?.sessionPrimer?.preferDistilled, true);
    assert.equal(parsed.hookEnhancements?.selfCorrectionLoop?.enabled, true);
  });

  it("requires embedding baseURL and model", () => {
    assert.throws(
      () => parsePluginConfig({ embedding: { apiKey: "test-api-key", model: "Embedding" } }),
      /embedding\.baseURL is required/,
    );
    assert.throws(
      () => parsePluginConfig({ embedding: { apiKey: "test-api-key", baseURL: "https://embedding.example/v1" } }),
      /embedding\.model is required/,
    );
  });

  it("requires llm endpoint and model when llm apiKey is configured", () => {
    assert.throws(
      () => parsePluginConfig({ ...baseConfig(), llm: { apiKey: "llm-key", model: "MiniMax" } }),
      /llm\.baseURL is required/,
    );
    assert.throws(
      () => parsePluginConfig({ ...baseConfig(), llm: { apiKey: "llm-key", baseURL: "https://llm.example/v1" } }),
      /llm\.model is required/,
    );
  });

  it("requires rerank endpoint and model when rerank apiKey is configured", () => {
    assert.throws(
      () => parsePluginConfig({ ...baseConfig(), retrieval: { rerankApiKey: "rerank-key", rerankModel: "Rerank" } }),
      /retrieval\.rerankEndpoint is required/,
    );
    assert.throws(
      () => parsePluginConfig({ ...baseConfig(), retrieval: { rerankApiKey: "rerank-key", rerankEndpoint: "https://rerank.example/v1/rerank" } }),
      /retrieval\.rerankModel is required/,
    );
  });

  it("allows disabling lifecycle maintenance explicitly", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      lifecycleMaintenance: { enabled: false },
    });
    assert.equal(parsed.lifecycleMaintenance?.enabled, false);
  });

  it("allows disabling memory compaction explicitly", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      memoryCompaction: { enabled: false },
    });
    assert.equal(parsed.memoryCompaction?.enabled, false);
  });

  it("preserves embedding.chunking when explicitly configured", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      embedding: {
        ...baseConfig().embedding,
        chunking: false,
      },
    });
    assert.equal(parsed.embedding.chunking, false);
  });
});
