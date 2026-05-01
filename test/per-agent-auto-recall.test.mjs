import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
const pluginModule = jiti("../index.ts");
const myMemPlugin = pluginModule.default || pluginModule;
const { parsePluginConfig } = jiti("../src/plugin-config-parser.ts");
const { registerAutoRecallHook } = jiti("../src/auto-recall-hook.ts");
const retrieverModuleForMock = jiti("../src/retriever.js");
const embedderModuleForMock = jiti("../src/embedder.js");
const origCreateRetriever = retrieverModuleForMock.createRetriever;
const origCreateEmbedder = embedderModuleForMock.createEmbedder;

async function runAutoRecallHook(hooks, event, ctx) {
  for (const { handler } of hooks) {
    const output = await handler(event, ctx);
    if (output === undefined || output?.prependContext?.includes("<relevant-memories>")) return output;
  }
  return undefined;
}


function createPluginApiHarness({ pluginConfig, resolveRoot, debugLogs = [], warnLogs = [] }) {
  const eventHandlers = new Map();

  const api = {
    pluginConfig,
    resolvePath(target) {
      if (typeof target !== "string") return target;
      if (path.isAbsolute(target)) return target;
      return path.join(resolveRoot, target);
    },
    logger: {
      info() {},
      warn(message) {
        warnLogs.push(String(message));
      },
      debug(message) {
        debugLogs.push(String(message));
      },
    },
    registerTool() {},
    registerCli() {},
    registerService() {},
    on(eventName, handler, meta) {
      const list = eventHandlers.get(eventName) || [];
      list.push({ handler, meta });
      eventHandlers.set(eventName, list);
    },
    registerHook(eventName, handler, opts) {
      const list = eventHandlers.get(eventName) || [];
      list.push({ handler, meta: opts });
      eventHandlers.set(eventName, list);
    },
  };

  return { api, eventHandlers };
}

function baseConfig() {
  return {
    embedding: {
      apiKey: "test-api-key",
      baseURL: "https://embedding.example/v1",
      model: "Embedding",
    },
  };
}

describe("autoRecallExcludeAgents", () => {
  it("defaults to undefined when not specified", () => {
    const parsed = parsePluginConfig(baseConfig());
    assert.equal(parsed.autoRecallExcludeAgents, undefined);
  });

  it("parses a valid array of agent IDs", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallExcludeAgents: ["saffron", "maple", "matcha"],
    });
    assert.deepEqual(parsed.autoRecallExcludeAgents, ["saffron", "maple", "matcha"]);
  });

  it("filters out non-string entries", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallExcludeAgents: ["saffron", null, 123, "maple", undefined, ""],
    });
    assert.deepEqual(parsed.autoRecallExcludeAgents, ["saffron", "maple"]);
  });

  it("filters out whitespace-only strings", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallExcludeAgents: ["saffron", "   ", "\t", "maple"],
    });
    assert.deepEqual(parsed.autoRecallExcludeAgents, ["saffron", "maple"]);
  });

  it("trims agent IDs during parsing", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallExcludeAgents: [" saffron ", "\tmaple\n"],
    });
    assert.deepEqual(parsed.autoRecallExcludeAgents, ["saffron", "maple"]);
  });

  it("trims agent IDs during parsing", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallIncludeAgents: [" saffron ", "\tmaple\n"],
    });
    assert.deepEqual(parsed.autoRecallIncludeAgents, ["saffron", "maple"]);
  });

  it("returns empty array for empty array input (not undefined)", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallExcludeAgents: [],
    });
    // Empty array stays as [] — falsy check via length is the right way to handle
    assert.ok(Array.isArray(parsed.autoRecallExcludeAgents));
    assert.equal(parsed.autoRecallExcludeAgents.length, 0);
  });

  it("handles single agent ID", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallExcludeAgents: ["cron-worker"],
    });
    assert.deepEqual(parsed.autoRecallExcludeAgents, ["cron-worker"]);
  });
});

describe("autoRecallIncludeAgents", () => {
  it("defaults to undefined when not specified", () => {
    const parsed = parsePluginConfig(baseConfig());
    assert.equal(parsed.autoRecallIncludeAgents, undefined);
  });

  it("parses a valid array of agent IDs", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallIncludeAgents: ["saffron", "maple"],
    });
    assert.deepEqual(parsed.autoRecallIncludeAgents, ["saffron", "maple"]);
  });

  it("filters out non-string entries", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallIncludeAgents: ["saffron", null, 123, "maple"],
    });
    assert.deepEqual(parsed.autoRecallIncludeAgents, ["saffron", "maple"]);
  });

  it("filters out whitespace-only strings", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallIncludeAgents: ["saffron", "   ", "maple"],
    });
    assert.deepEqual(parsed.autoRecallIncludeAgents, ["saffron", "maple"]);
  });

  it("returns empty array for empty array input (not undefined)", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallIncludeAgents: [],
    });
    assert.ok(Array.isArray(parsed.autoRecallIncludeAgents));
    assert.equal(parsed.autoRecallIncludeAgents.length, 0);
  });

  it("handles single agent ID (whitelist mode)", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallIncludeAgents: ["sage"],
    });
    assert.deepEqual(parsed.autoRecallIncludeAgents, ["sage"]);
  });

  it("include takes precedence over exclude in parsing (both specified)", () => {
    // Note: logic precedence is handled at runtime in before_prompt_build,
    // not in the config parser. Parser accepts both.
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallIncludeAgents: ["saffron"],
      autoRecallExcludeAgents: ["maple"],
    });
    assert.deepEqual(parsed.autoRecallIncludeAgents, ["saffron"]);
    assert.deepEqual(parsed.autoRecallExcludeAgents, ["maple"]);
  });
});

describe("mixed-agent scenarios", () => {
  // Simulate the runtime logic for agent inclusion/exclusion
  const builtInExcludeAgents = ["cron"];

  function shouldInjectMemory({ agentId, autoRecallIncludeAgents, autoRecallExcludeAgents }) {
    if (agentId === undefined) return true; // no agent context, allow

    // autoRecallIncludeAgents takes precedence (whitelist mode)
    if (Array.isArray(autoRecallIncludeAgents) && autoRecallIncludeAgents.length > 0) {
      return autoRecallIncludeAgents.includes(agentId);
    }

    // Fall back to built-in + user exclude list (blacklist mode)
    const effectiveExcludeAgents = [
      ...builtInExcludeAgents,
      ...(Array.isArray(autoRecallExcludeAgents) ? autoRecallExcludeAgents : []),
    ];
    if (effectiveExcludeAgents.includes(agentId)) {
      return false;
    }

    return true; // not excluded, allow
  }

  it("whitelist mode: only included agents receive auto-recall", () => {
    const cfg = { autoRecallIncludeAgents: ["saffron", "maple"] };
    assert.equal(shouldInjectMemory({ agentId: "saffron", ...cfg }), true);
    assert.equal(shouldInjectMemory({ agentId: "maple", ...cfg }), true);
    assert.equal(shouldInjectMemory({ agentId: "matcha", ...cfg }), false);
    assert.equal(shouldInjectMemory({ agentId: "cron-worker", ...cfg }), false);
  });

  it("blacklist mode: all agents except excluded receive auto-recall", () => {
    const cfg = { autoRecallExcludeAgents: ["cron-worker", "matcha"] };
    assert.equal(shouldInjectMemory({ agentId: "saffron", ...cfg }), true);
    assert.equal(shouldInjectMemory({ agentId: "maple", ...cfg }), true);
    assert.equal(shouldInjectMemory({ agentId: "cron-worker", ...cfg }), false);
    assert.equal(shouldInjectMemory({ agentId: "matcha", ...cfg }), false);
  });

  it("whitelist takes precedence over blacklist when both set", () => {
    const cfg = { autoRecallIncludeAgents: ["saffron"], autoRecallExcludeAgents: ["saffron", "maple"] };
    // Include wins — saffron is in include list
    assert.equal(shouldInjectMemory({ agentId: "saffron", ...cfg }), true);
    // Exclude is ignored because include is set
    assert.equal(shouldInjectMemory({ agentId: "maple", ...cfg }), false);
  });

  it("no include/exclude: all agents receive auto-recall", () => {
    assert.equal(shouldInjectMemory({ agentId: "saffron" }), true);
    assert.equal(shouldInjectMemory({ agentId: "maple" }), true);
    assert.equal(shouldInjectMemory({ agentId: "matcha" }), true);
  });

  it("agentId='main': whitelist does not match unless main is included", () => {
    const cfg = { autoRecallIncludeAgents: ["saffron"] };
    assert.equal(shouldInjectMemory({ agentId: "main", ...cfg }), false);
  });

  it("empty include list treated as no include configured", () => {
    const cfg = { autoRecallIncludeAgents: [], autoRecallExcludeAgents: ["saffron"] };
    // Empty include array = not configured, fall through to exclude
    assert.equal(shouldInjectMemory({ agentId: "saffron", ...cfg }), false);
    assert.equal(shouldInjectMemory({ agentId: "maple", ...cfg }), true);
  });

  it("built-in blacklist: 'cron' agent is excluded by default", () => {
    // No include/exclude configured — cron should still be blocked
    assert.equal(shouldInjectMemory({ agentId: "cron" }), false);
    assert.equal(shouldInjectMemory({ agentId: "saffron" }), true);
  });

  it("built-in blacklist: 'cron' excluded even with user exclude list", () => {
    const cfg = { autoRecallExcludeAgents: ["matcha"] };
    assert.equal(shouldInjectMemory({ agentId: "cron", ...cfg }), false);
    assert.equal(shouldInjectMemory({ agentId: "matcha", ...cfg }), false);
    assert.equal(shouldInjectMemory({ agentId: "saffron", ...cfg }), true);
  });

  it("built-in blacklist: 'cron' can be overridden by whitelist", () => {
    // If whitelist explicitly includes 'cron', it should be allowed
    const cfg = { autoRecallIncludeAgents: ["cron", "saffron"] };
    assert.equal(shouldInjectMemory({ agentId: "cron", ...cfg }), true);
    assert.equal(shouldInjectMemory({ agentId: "saffron", ...cfg }), true);
    assert.equal(shouldInjectMemory({ agentId: "maple", ...cfg }), false);
  });
});


describe("real before_prompt_build hook", () => {
  it("skips auto-recall for built-in excluded agent 'cron'", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "per-agent-auto-recall-cron-"));
    const debugLogs = [];

    const retriever = {
      async retrieve() {
        throw new Error("retrieve should not run when built-in blacklist blocks agent");
      },
      getLastDiagnostics() {
        return null;
      },
    };

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      debugLogs,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key", baseURL: "https://embedding.example/v1", model: "Embedding" },
        sessionStrategy: "none",
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    try {
      registerAutoRecallHook({
        api: harness.api,
        config: parsePluginConfig(harness.api.pluginConfig),
        store: {},
        retriever,
        scopeManager: {
          getAccessibleScopes() { return ["global"]; },
          getDefaultScope() { return "global"; },
          isAccessible() { return true; },
          validateScope() { return true; },
          getAllScopes() { return ["global"]; },
          getScopeDefinition() { return undefined; },
        },
        turnCounter: new Map(),
        recallHistory: new Map(),
        lastRawUserMessage: new Map(),
      });
      const hooks = harness.eventHandlers.get("before_prompt_build") || [];
      assert.ok(hooks.length >= 1, "expected at least one before_prompt_build hook");

      const [{ handler: autoRecallHook }] = hooks;
      const output = await autoRecallHook(
        { prompt: "Check the scheduled task status.", sessionKey: "agent:cron:session:test-cron" },
        { sessionId: "test-cron", sessionKey: "agent:cron:session:test-cron" },
      );

      assert.equal(output, undefined);
      assert.ok(
        debugLogs.some((line) => line.includes("auto-recall skipped for excluded agent 'cron'")),
        "expected built-in blacklist skip debug log for 'cron'",
      );
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("skips auto-recall for fallback 'main' when whitelist excludes it", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "per-agent-auto-recall-"));
    const debugLogs = [];

    retrieverModuleForMock.createRetriever = function mockCreateRetriever() {
      return {
        async retrieve() {
          throw new Error("retrieve should not run when whitelist blocks agent");
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        setAccessTracker() {},
        setStatsCollector() {},
      };
    };

    embedderModuleForMock.createEmbedder = function mockCreateEmbedder() {
      return {
        async embedQuery() {
          return new Float32Array(384).fill(0);
        },
        async embedPassage() {
          return new Float32Array(384).fill(0);
        },
      };
    };

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      debugLogs,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key", baseURL: "https://embedding.example/v1", model: "Embedding" },
        sessionStrategy: "none",
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        autoRecallIncludeAgents: ["saffron"],
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    try {
      myMemPlugin.register(harness.api);
      const hooks = harness.eventHandlers.get("before_prompt_build") || [];
      assert.ok(hooks.length >= 1, "expected at least one before_prompt_build hook");

      const output = await runAutoRecallHook(hooks,
        { prompt: "Help me plan the API rollout with prior preferences.", sessionKey: "agent:main:session:test-main" },
        { sessionId: "test-main", sessionKey: "agent:main:session:test-main" },
      );

      assert.equal(output, undefined);
      assert.ok(
        debugLogs.some((line) => line.includes("auto-recall skipped for agent 'main' not in autoRecallIncludeAgents")),
        "expected whitelist skip debug log for fallback 'main'",
      );
    } finally {
      retrieverModuleForMock.createRetriever = origCreateRetriever;
      embedderModuleForMock.createEmbedder = origCreateEmbedder;
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("logs current retrieval stage diagnostics when auto-recall times out", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "auto-recall-timeout-diagnostics-"));
    const warnLogs = [];

    const retriever = {
      async retrieve(_params) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return [];
      },
      getLastDiagnostics() {
        return {
          mode: "hybrid",
          currentStage: "hybrid.rerank",
          currentStageStartedAt: Date.now() - 75,
          latencyMs: { embedQuery: 12, parallelSearch: 34 },
          vectorResultCount: 4,
          bm25ResultCount: 3,
          fusedResultCount: 5,
          finalResultCount: 0,
        };
      },
    };

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      warnLogs,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key", baseURL: "https://embedding.example/v1", model: "Embedding" },
        sessionStrategy: "none",
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        autoRecallTimeoutMs: 25,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    try {
      registerAutoRecallHook({
        api: harness.api,
        config: parsePluginConfig(harness.api.pluginConfig),
        store: {},
        retriever,
        scopeManager: {
          getAccessibleScopes() { return ["global"]; },
          getDefaultScope() { return "global"; },
          isAccessible() { return true; },
          validateScope() { return true; },
          getAllScopes() { return ["global"]; },
          getScopeDefinition() { return undefined; },
        },
        turnCounter: new Map(),
        recallHistory: new Map(),
        lastRawUserMessage: new Map(),
      });
      const hooks = harness.eventHandlers.get("before_prompt_build") || [];
      const [{ handler: autoRecallHook }] = hooks;
      const output = await autoRecallHook(
        { prompt: "Help me plan the API rollout with prior preferences.", sessionKey: "agent:main:session:test-timeout" },
        { sessionId: "test-timeout", sessionKey: "agent:main:session:test-timeout" },
      );

      assert.equal(output, undefined);
      const timeoutLog = warnLogs.find((line) => line.includes("auto-recall timed out after 25ms"));
      assert.ok(timeoutLog, "expected auto-recall timeout warning");
      assert.match(timeoutLog, /currentStage=hybrid\.rerank/);
      assert.match(timeoutLog, /currentStageElapsed=\d+ms/);
      assert.match(timeoutLog, /completedLatencies=embedQuery=12ms,parallelSearch=34ms/);
      assert.match(timeoutLog, /counts=vector=4,bm25=3,fused=5,final=0/);
    } finally {
      retrieverModuleForMock.createRetriever = origCreateRetriever;
      embedderModuleForMock.createEmbedder = origCreateEmbedder;
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("passes the auto-recall candidate pool cap to retrieval", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "auto-recall-candidate-pool-"));
    let retrieveParams;

    const retriever = {
      async retrieve(params) {
        retrieveParams = params;
        return [];
      },
      getLastDiagnostics() {
        return null;
      },
    };

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key", baseURL: "https://embedding.example/v1", model: "Embedding" },
        sessionStrategy: "none",
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        autoRecallMaxItems: 5,
        autoRecallCandidatePoolSize: 6,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    try {
      registerAutoRecallHook({
        api: harness.api,
        config: parsePluginConfig(harness.api.pluginConfig),
        store: {},
        retriever,
        scopeManager: {
          getAccessibleScopes() { return ["global"]; },
          getDefaultScope() { return "global"; },
          isAccessible() { return true; },
          validateScope() { return true; },
          getAllScopes() { return ["global"]; },
          getScopeDefinition() { return undefined; },
        },
        turnCounter: new Map(),
        recallHistory: new Map(),
        lastRawUserMessage: new Map(),
      });
      const hooks = harness.eventHandlers.get("before_prompt_build") || [];
      const [{ handler: autoRecallHook }] = hooks;
      await autoRecallHook(
        { prompt: "Help me plan the API rollout with prior preferences.", sessionKey: "agent:main:session:test-pool" },
        { sessionId: "test-pool", sessionKey: "agent:main:session:test-pool" },
      );

      assert.equal(retrieveParams.limit, 6);
      assert.equal(retrieveParams.candidatePoolSize, 6);
      assert.equal(retrieveParams.overFetchMultiplier, 4);
      assert.equal(retrieveParams.source, "auto-recall");
    } finally {
      retrieverModuleForMock.createRetriever = origCreateRetriever;
      embedderModuleForMock.createEmbedder = origCreateEmbedder;
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not retry normal empty auto-recall results", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "auto-recall-empty-no-retry-"));
    let retrieveCalls = 0;

    const retriever = {
      async retrieve() {
        retrieveCalls += 1;
        return [];
      },
      getLastDiagnostics() {
        return null;
      },
    };

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key", baseURL: "https://embedding.example/v1", model: "Embedding" },
        sessionStrategy: "none",
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    try {
      registerAutoRecallHook({
        api: harness.api,
        config: parsePluginConfig(harness.api.pluginConfig),
        store: {},
        retriever,
        scopeManager: {
          getAccessibleScopes() { return ["global"]; },
          getDefaultScope() { return "global"; },
          isAccessible() { return true; },
          validateScope() { return true; },
          getAllScopes() { return ["global"]; },
          getScopeDefinition() { return undefined; },
        },
        turnCounter: new Map(),
        recallHistory: new Map(),
        lastRawUserMessage: new Map(),
      });

      const hooks = harness.eventHandlers.get("before_prompt_build") || [];
      const [{ handler: autoRecallHook }] = hooks;
      await autoRecallHook(
        { prompt: "Help me plan the API rollout with prior preferences.", sessionKey: "agent:main:session:test-empty" },
        { sessionId: "test-empty", sessionKey: "agent:main:session:test-empty" },
      );

      assert.equal(retrieveCalls, 1);
    } finally {
      retrieverModuleForMock.createRetriever = origCreateRetriever;
      embedderModuleForMock.createEmbedder = origCreateEmbedder;
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("retries auto-recall once when retrieval throws", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "auto-recall-error-retry-"));
    let retrieveCalls = 0;

    const retriever = {
      async retrieve() {
        retrieveCalls += 1;
        if (retrieveCalls === 1) throw new Error("temporary retrieval failure");
        return [];
      },
      getLastDiagnostics() {
        return null;
      },
    };

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key", baseURL: "https://embedding.example/v1", model: "Embedding" },
        sessionStrategy: "none",
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    try {
      registerAutoRecallHook({
        api: harness.api,
        config: parsePluginConfig(harness.api.pluginConfig),
        store: {},
        retriever,
        scopeManager: {
          getAccessibleScopes() { return ["global"]; },
          getDefaultScope() { return "global"; },
          isAccessible() { return true; },
          validateScope() { return true; },
          getAllScopes() { return ["global"]; },
          getScopeDefinition() { return undefined; },
        },
        turnCounter: new Map(),
        recallHistory: new Map(),
        lastRawUserMessage: new Map(),
      });

      const hooks = harness.eventHandlers.get("before_prompt_build") || [];
      const [{ handler: autoRecallHook }] = hooks;
      await autoRecallHook(
        { prompt: "Help me plan the API rollout with prior preferences.", sessionKey: "agent:main:session:test-retry" },
        { sessionId: "test-retry", sessionKey: "agent:main:session:test-retry" },
      );

      assert.equal(retrieveCalls, 2);
    } finally {
      retrieverModuleForMock.createRetriever = origCreateRetriever;
      embedderModuleForMock.createEmbedder = origCreateEmbedder;
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("truncates long auto-recall queries while preserving latest context", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "auto-recall-smart-truncate-"));
    let retrieveParams;

    const retriever = {
      async retrieve(params) {
        retrieveParams = params;
        return [];
      },
      getLastDiagnostics() {
        return null;
      },
    };

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key", baseURL: "https://embedding.example/v1", model: "Embedding" },
        sessionStrategy: "none",
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        autoRecallMaxQueryLength: 120,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    try {
      registerAutoRecallHook({
        api: harness.api,
        config: parsePluginConfig(harness.api.pluginConfig),
        store: {},
        retriever,
        scopeManager: {
          getAccessibleScopes() { return ["global"]; },
          getDefaultScope() { return "global"; },
          isAccessible() { return true; },
          validateScope() { return true; },
          getAllScopes() { return ["global"]; },
          getScopeDefinition() { return undefined; },
        },
        turnCounter: new Map(),
        recallHistory: new Map(),
        lastRawUserMessage: new Map(),
      });
      const hooks = harness.eventHandlers.get("before_prompt_build") || [];
      const [{ handler: autoRecallHook }] = hooks;
      await autoRecallHook(
        {
          prompt: "BEGIN-" + "old context ".repeat(40) + "LATEST USER REQUEST: optimize deploy timeout",
          sessionKey: "agent:main:session:test-smart-truncate",
        },
        { sessionId: "test-smart-truncate", sessionKey: "agent:main:session:test-smart-truncate" },
      );

      assert.equal(retrieveParams.query.length, 120);
      assert.ok(retrieveParams.query.startsWith("BEGIN-"));
      assert.ok(retrieveParams.query.endsWith("LATEST USER REQUEST: optimize deploy timeout"));
      assert.match(retrieveParams.query, /keeping latest context/);
    } finally {
      retrieverModuleForMock.createRetriever = origCreateRetriever;
      embedderModuleForMock.createEmbedder = origCreateEmbedder;
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps redundancy history isolated by sessionKey when sessionId is missing", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "auto-recall-sessionkey-isolation-"));
    let retrieveCalls = 0;

    const memoryResult = {
      entry: {
        id: "shared-memory-1",
        text: "shared memory should be available in each session key",
        category: "fact",
        scope: "global",
        importance: 0.8,
        timestamp: Date.now(),
        metadata: JSON.stringify({
          l0_abstract: "shared memory should be available in each session key",
          memory_category: "cases",
          state: "confirmed",
          memory_layer: "working",
          source: "manual",
          injected_count: 0,
          bad_recall_count: 0,
          suppressed_until_turn: 0,
          access_count: 0,
        }),
      },
      score: 0.9,
    };

    const store = {
      patches: [],
      async patchMetadata(id, patch) {
        this.patches.push({ id, patch });
        return null;
      },
    };

    const retriever = {
      async retrieve() {
        retrieveCalls += 1;
        return [memoryResult];
      },
      getLastDiagnostics() {
        return null;
      },
    };

    const turnCounter = new Map();
    const recallHistory = new Map();
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key", baseURL: "https://embedding.example/v1", model: "Embedding" },
        sessionStrategy: "none",
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        autoRecallMinRepeated: 8,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    try {
      registerAutoRecallHook({
        api: harness.api,
        config: parsePluginConfig(harness.api.pluginConfig),
        store,
        retriever,
        scopeManager: {
          getAccessibleScopes() { return ["global"]; },
          getDefaultScope() { return "global"; },
          isAccessible() { return true; },
          validateScope() { return true; },
          getAllScopes() { return ["global"]; },
          getScopeDefinition() { return undefined; },
        },
        turnCounter,
        recallHistory,
        lastRawUserMessage: new Map(),
      });

      const hooks = harness.eventHandlers.get("before_prompt_build") || [];
      const [{ handler: autoRecallHook }] = hooks;

      const first = await autoRecallHook(
        { prompt: "Please recall the shared memory.", sessionKey: "agent:main:session:one" },
        { sessionKey: "agent:main:session:one", agentId: "main" },
      );
      const second = await autoRecallHook(
        { prompt: "Please recall the shared memory.", sessionKey: "agent:main:session:two" },
        { sessionKey: "agent:main:session:two", agentId: "main" },
      );

      assert.ok(first?.prependContext?.includes("shared memory should be available"));
      assert.ok(second?.prependContext?.includes("shared memory should be available"));
      assert.equal(retrieveCalls, 2);
      assert.equal(turnCounter.get("sessionKey:agent:main:session:one"), 1);
      assert.equal(turnCounter.get("sessionKey:agent:main:session:two"), 1);
      assert.ok(recallHistory.get("sessionKey:agent:main:session:one")?.has("shared-memory-1"));
      assert.ok(recallHistory.get("sessionKey:agent:main:session:two")?.has("shared-memory-1"));
    } finally {
      retrieverModuleForMock.createRetriever = origCreateRetriever;
      embedderModuleForMock.createEmbedder = origCreateEmbedder;
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
