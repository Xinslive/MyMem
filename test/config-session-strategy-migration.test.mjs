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
    assert.equal(parsed.autoRecallMaxItems, 6);
    assert.equal(parsed.autoRecallDegradeAfterMs, 5000);
    assert.equal(parsed.captureAssistant, false);
    assert.deepEqual(parsed.captureAssistantAgents, ["main"]);
    assert.equal(parsed.captureMaxMessages, 10);
    assert.equal(parsed.retrieval?.rerank, "cross-encoder");
    assert.equal(parsed.extractMinMessages, 8);
    assert.equal(parsed.llm?.model, undefined);
    assert.equal(parsed.llm?.baseURL, undefined);
    assert.equal(parsed.llm?.timeoutMs, 90000);
    assert.equal(parsed.memoryReflection?.agentId, "main");
    assert.equal(parsed.memoryReflection?.timeoutMs, 90000);
    assert.equal(parsed.memoryReflection?.dbPath, undefined);
    assert.equal(parsed.memoryCompaction?.enabled, true);
    assert.equal(parsed.memoryCompaction?.mergeMode, "llm");
    assert.equal(parsed.memoryCompaction?.deleteSourceMemories, true);
    assert.equal(parsed.memoryCompaction?.dryRun, false);
    assert.equal(parsed.memoryCompaction?.maxLlmClustersPerRun, 10);
    assert.equal(parsed.lifecycleMaintenance?.enabled, true);
    assert.equal(parsed.memoryCompaction?.cooldownHours, 4);
    assert.equal(parsed.lifecycleMaintenance?.cooldownHours, 4);
    assert.equal(parsed.lifecycleMaintenance?.maxMemoriesToScan, 300);
    assert.equal(parsed.lifecycleMaintenance?.archiveThreshold, 0.15);
    assert.equal(parsed.lifecycleMaintenance?.dryRun, false);
    assert.equal(parsed.lifecycleMaintenance?.deleteMode, "archive");
    assert.deepEqual(parsed.lifecycleMaintenance?.hardDeleteReasons, ["duplicate_cluster_source", "noise", "superseded_fragment"]);
    assert.equal(parsed.preferenceDistiller?.enabled, true);
    assert.equal(parsed.preferenceDistiller?.cooldownHours, 4);
    assert.equal(parsed.preferenceDistiller?.maxSessions, 12);
    assert.equal(parsed.preferenceDistiller?.minEvidenceCount, 2);
    assert.equal(parsed.preferenceDistiller?.minStabilityScore, 0.6);
    assert.equal(parsed.preferenceDistiller?.maxRulesPerRun, 5);
    assert.equal(parsed.experienceCompiler?.enabled, true);
    assert.equal(parsed.experienceCompiler?.cooldownHours, 4);
    assert.equal(parsed.experienceCompiler?.maxStrategiesPerRun, 3);
    assert.equal(parsed.reasoningStrategyRecall?.enabled, true);
    assert.equal(parsed.reasoningStrategyRecall?.maxItems, 2);
    assert.equal(parsed.reasoningStrategyRecall?.maxChars, 600);
    assert.equal(parsed.reasoningStrategyRecall?.candidatePoolSize, 8);
    assert.equal(parsed.reasoningStrategyRecall?.minScore, 0.62);
    assert.equal(parsed.feedbackLoop?.preventiveLessons?.enabled, true);
    assert.equal(parsed.feedbackLoop?.preventiveLessons?.fromErrors, true);
    assert.equal(parsed.feedbackLoop?.preventiveLessons?.fromCorrections, true);
    assert.equal(parsed.feedbackLoop?.preventiveLessons?.minEvidenceToConfirm, 2);
    assert.equal(parsed.feedbackLoop?.preventiveLessons?.pendingConfidence, 0.45);
    assert.equal(parsed.feedbackLoop?.preventiveLessons?.confirmedConfidence, 0.72);
    assert.equal(parsed.sessionCompression?.enabled, true);
    assert.equal(parsed.sessionCompression?.minScoreToKeep, 0.3);
    assert.equal(parsed.extractionThrottle?.skipLowValue, true);
    assert.equal(parsed.extractionThrottle?.maxExtractionsPerHour, 0);
    assert.equal(parsed.hookEnhancements?.sessionPrimer?.enabled, true);
    assert.equal(parsed.hookEnhancements?.sessionPrimer?.preferDistilled, true);
    assert.equal(parsed.hookEnhancements?.selfCorrectionLoop?.enabled, true);
  });

  it("preserves explicit assistant capture settings", () => {
    const disabled = parsePluginConfig({
      ...baseConfig(),
      captureAssistant: false,
    });
    assert.deepEqual(disabled.captureAssistantAgents, []);

    const scoped = parsePluginConfig({
      ...baseConfig(),
      captureAssistantAgents: ["main", "life", "main", ""],
    });
    assert.deepEqual(scoped.captureAssistantAgents, ["main", "life"]);

    const global = parsePluginConfig({
      ...baseConfig(),
      captureAssistant: true,
    });
    assert.equal(global.captureAssistant, true);
    assert.deepEqual(global.captureAssistantAgents, ["main"]);
  });

  it("normalizes captureMaxMessages", () => {
    const configured = parsePluginConfig({
      ...baseConfig(),
      captureMaxMessages: 6,
    });
    assert.equal(configured.captureMaxMessages, 6);

    const tooLarge = parsePluginConfig({
      ...baseConfig(),
      captureMaxMessages: 999,
    });
    assert.equal(tooLarge.captureMaxMessages, 50);
  });

  it("allows disabling conservative auto-capture gates explicitly", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      sessionCompression: { enabled: false },
      extractionThrottle: { skipLowValue: false },
    });

    assert.equal(parsed.sessionCompression?.enabled, false);
    assert.equal(parsed.extractionThrottle?.skipLowValue, false);
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

  it("preserves Azure OpenAI embedding provider settings", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      embedding: {
        ...baseConfig().embedding,
        provider: "azure-openai",
        apiVersion: "2024-02-01",
      },
    });
    assert.equal(parsed.embedding.provider, "azure-openai");
    assert.equal(parsed.embedding.apiVersion, "2024-02-01");
  });

  it("applies tuning presets before explicit overrides", () => {
    const presetParsed = parsePluginConfig({
      ...baseConfig(),
      tuningPreset: "low-latency",
    });
    assert.equal(presetParsed.tuningPreset, "low-latency");
    assert.equal(presetParsed.autoRecallMaxItems, 4);
    assert.equal(presetParsed.extractMinMessages, 8);
    assert.equal(presetParsed.retrieval?.candidatePoolSize, 8);
    assert.equal(presetParsed.memoryCompaction?.mergeMode, "deterministic");

    const overridden = parsePluginConfig({
      ...baseConfig(),
      tuningPreset: "low-latency",
      autoRecallMaxItems: 9,
      retrieval: { candidatePoolSize: 15 },
    });
    assert.equal(overridden.autoRecallMaxItems, 9);
    assert.equal(overridden.retrieval?.candidatePoolSize, 15);
  });

  it("normalizes telemetry config with safe defaults", () => {
    const parsed = parsePluginConfig(baseConfig());
    assert.deepEqual(parsed.telemetry, {
      persist: true,
      dir: undefined,
      maxRecords: 1000,
      sampleRate: 1,
    });

    const custom = parsePluginConfig({
      ...baseConfig(),
      telemetry: {
        persist: true,
        dir: "./telemetry",
        maxRecords: 2500,
        sampleRate: 0.25,
      },
    });
    assert.equal(custom.telemetry?.persist, true);
    assert.equal(custom.telemetry?.dir, "./telemetry");
    assert.equal(custom.telemetry?.maxRecords, 2500);
    assert.equal(custom.telemetry?.sampleRate, 0.25);
  });
});
