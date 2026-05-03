import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const plugin = jiti("../index.ts");
const { __resetSingletonForTesting__ } = plugin;

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
);
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function schemaAt(pathExpression) {
  const parts = pathExpression.split(".");
  let current = manifest.configSchema;
  for (const part of parts) {
    current = current?.properties?.[part];
  }
  assert.ok(current, `configSchema should declare ${pathExpression}`);
  return current;
}

function assertSchemaDefault(pathExpression, expected) {
  assert.deepEqual(
    schemaAt(pathExpression).default,
    expected,
    `${pathExpression} schema default should match runtime default`,
  );
}

function assertSchemaEnumIncludes(pathExpression, expected) {
  assert.ok(
    schemaAt(pathExpression).enum.includes(expected),
    `${pathExpression} schema enum should include ${expected}`,
  );
}

function assertAnyOfTypes(pathExpression, expectedTypes) {
  const schema = schemaAt(pathExpression);
  const branches = schema.anyOf || schema.oneOf || [];
  const actual = branches.map((item) => item.type).sort();
  assert.deepEqual(actual, [...expectedTypes].sort(), `${pathExpression} should allow ${expectedTypes.join(" or ")}`);
}

function createMockApi(pluginConfig, options = {}) {
  return {
    pluginConfig,
    hooks: {},
    toolFactories: {},
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    resolvePath(value) {
      return value;
    },
    registerTool(toolOrFactory, meta) {
      this.toolFactories[meta.name] =
        typeof toolOrFactory === "function" ? toolOrFactory : () => toolOrFactory;
    },
    registerCli() {},
    registerService(service) {
      options.services?.push(service);
    },
    on(name, handler) {
      this.hooks[name] = handler;
    },
    registerHook(name, handler) {
      this.hooks[name] = handler;
    },
  };
}

for (const key of [
  "tuningPreset",
  "telemetry",
  "smartExtraction",
  "captureMaxMessages",
  "extractMinMessages",
  "extractMaxChars",
  "llm",
  "autoRecallMaxItems",
  "autoRecallMaxChars",
  "autoRecallPerItemMaxChars",
]) {
  schemaAt(key);
}

for (const pathExpression of ["llm.auth", "llm.oauthPath", "llm.oauthProvider"]) {
  schemaAt(pathExpression);
}

assertSchemaDefault("autoRecallMinRepeated", 8);
assertSchemaDefault("extractMinMessages", 8);
assertSchemaDefault("sessionStrategy", "memoryReflection");
assertSchemaDefault("autoRecall", true);
assertSchemaDefault("autoRecallMinLength", 6);
assertSchemaDefault("autoRecallMaxItems", 6);
assertSchemaDefault("autoRecallMaxChars", 800);
assertSchemaDefault("autoRecallPerItemMaxChars", 200);
assertSchemaDefault("autoRecallCandidatePoolSize", 12);
assertSchemaDefault("autoRecallTimeoutMs", 20000);
assertSchemaDefault("autoRecallMaxQueryLength", 2000);
assertSchemaDefault("maxRecallPerTurn", 10);
assertSchemaDefault("recallMode", "full");
assertSchemaDefault("reasoningStrategyRecall.enabled", true);
assertSchemaDefault("reasoningStrategyRecall.maxItems", 2);
assertSchemaDefault("reasoningStrategyRecall.maxChars", 600);
assertSchemaDefault("reasoningStrategyRecall.candidatePoolSize", 8);
assertSchemaDefault("reasoningStrategyRecall.minScore", 0.62);
assertSchemaDefault("memoryReflection.agentId", "main");
schemaAt("memoryReflection.dbPath");
assertSchemaDefault("feedbackLoop.preventiveLessons.enabled", true);
assertSchemaDefault("feedbackLoop.preventiveLessons.fromErrors", true);
assertSchemaDefault("feedbackLoop.preventiveLessons.fromCorrections", true);
assertSchemaDefault("feedbackLoop.preventiveLessons.minEvidenceToConfirm", 2);
assertSchemaDefault("feedbackLoop.preventiveLessons.pendingConfidence", 0.45);
assertSchemaDefault("feedbackLoop.preventiveLessons.confirmedConfidence", 0.72);
assertSchemaDefault("feedbackLoop.preventiveLessons.maxLearnPerScan", 3);
assertSchemaDefault("autoCapture", true);
assertSchemaDefault("captureAssistantAgents", ["main"]);
assertSchemaDefault("captureMaxMessages", 10);
assertSchemaDefault("sessionCompression.enabled", true);
assertSchemaDefault("extractionThrottle.skipLowValue", true);
assertSchemaDefault("embedding.chunking", true);
assert.equal(schemaAt("embedding.omitDimensions").type, "boolean", "embedding.omitDimensions should be declared in the plugin schema");
assertSchemaDefault("sessionMemory.enabled", false);
assertSchemaDefault("telemetry.persist", true);
assertSchemaDefault("telemetry.maxRecords", 1000);
assertSchemaDefault("telemetry.sampleRate", 1);
assertSchemaEnumIncludes("retrieval.rerankProvider", "tei");
assertSchemaEnumIncludes("admissionControl.preset", "conservative");
assertSchemaEnumIncludes("admissionControl.preset", "high-recall");
assertSchemaDefault("retrieval.rerank", "cross-encoder");
assertSchemaDefault("retrieval.hardMinScore", 0.55);
assertSchemaDefault("retrieval.candidatePoolSize", 12);
assertSchemaDefault("retrieval.tagPrefixes", ["proj", "env", "team", "scope"]);
assertAnyOfTypes("hookEnhancements.sessionPrimer", ["boolean", "object"]);
assertAnyOfTypes("hookEnhancements.selfCorrectionLoop", ["boolean", "object"]);

assert.equal(
  manifest.version,
  pkg.version,
  "openclaw.plugin.json version should stay aligned with package.json",
);
assert.equal(
  pkg.dependencies["apache-arrow"],
  "18.1.0",
  "package.json should declare apache-arrow directly so OpenClaw plugin installs do not miss the LanceDB runtime dependency",
);
assert.ok(
  Array.isArray(pkg.files),
  "package.json should use a files whitelist to keep local runtime data out of published packages",
);
for (const expectedPackagePath of [
  "index.ts",
  "cli.ts",
  "src",
  "lesson",
  "scripts",
  "openclaw.plugin.json",
]) {
  assert.ok(
    pkg.files.includes(expectedPackagePath),
    `package.json files whitelist should include ${expectedPackagePath}`,
  );
}
for (const forbiddenPackagePath of [".claude", ".claude/", "~", "~/", "~/.claude-mem", "test"]) {
  assert.ok(
    !pkg.files.includes(forbiddenPackagePath),
    `package.json files whitelist should not include ${forbiddenPackagePath}`,
  );
}

const workDir = mkdtempSync(path.join(tmpdir(), "memory-plugin-regression-"));
const services = [];
const embeddingRequests = [];

try {
  const api = createMockApi(
    {
      dbPath: path.join(workDir, "db"),
      autoRecall: false,
      embedding: {
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "text-embedding-3-small",
        baseURL: "http://127.0.0.1:9/v1",
        dimensions: 1536,
      },
    },
    { services },
  );
  plugin.register(api);
  assert.equal(services.length, 1, "plugin should register its background service");
  assert.equal(typeof api.hooks.agent_end, "function", "autoCapture should remain enabled by default");
  assert.equal(typeof api.hooks.before_reset, "function", "selfImprovement before_reset hook should be registered by default");
  assert.deepEqual(
    Object.keys(api.toolFactories).sort(),
    manifest.contracts.tools.toSorted(),
    "contracts.tools should list every tool registered by the default plugin configuration",
  );
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const scheduledTimeouts = [];
  try {
    globalThis.setTimeout = (fn, delay = 0, ...args) => {
      scheduledTimeouts.push(Number(delay));
      return { fn, delay, args };
    };
    globalThis.clearTimeout = () => {};
    globalThis.setInterval = (fn, delay = 0, ...args) => ({ fn, delay, args });
    globalThis.clearInterval = () => {};
    await assert.doesNotReject(
      services[0].start(),
      "service start should schedule deferred startup work without throwing",
    );
    assert.ok(
      scheduledTimeouts.includes(15_000),
      "service start should defer startup health checks by 15 seconds",
    );
    assert.ok(
      !scheduledTimeouts.includes(0),
      "service start should no longer trigger startup health checks immediately",
    );
    await assert.doesNotReject(
      services[0].stop(),
      "service stop should tolerate deferred startup work handles",
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
  await assert.doesNotReject(
    services[0].stop(),
    "service stop should not throw when no access tracker is configured",
  );

  const sessionDefaultApi = createMockApi({
    dbPath: path.join(workDir, "db-session-default"),
    autoCapture: false,
    autoRecall: false,
    sessionMemory: {},
    embedding: {
      provider: "openai-compatible",
      apiKey: "dummy",
      model: "text-embedding-3-small",
      baseURL: "http://127.0.0.1:9/v1",
      dimensions: 1536,
    },
  });
  plugin.register(sessionDefaultApi);
  // selfImprovement registers before_reset by default, independent of sessionMemory config
  assert.equal(
    typeof sessionDefaultApi.hooks.before_reset,
    "function",
    "before_reset hook should be registered (selfImprovement default-on)",
  );

  const sessionEnabledApi = createMockApi({
    dbPath: path.join(workDir, "db-session-enabled"),
    autoCapture: false,
    autoRecall: false,
    sessionMemory: { enabled: true },
    embedding: {
      provider: "openai-compatible",
      apiKey: "dummy",
      model: "text-embedding-3-small",
      baseURL: "http://127.0.0.1:9/v1",
      dimensions: 1536,
    },
  });
  // Reset singleton so sessionMemory.enabled=true reinitializes config with systemSessionMemory strategy
  __resetSingletonForTesting__();
  plugin.register(sessionEnabledApi);
  assert.equal(
    typeof sessionEnabledApi.hooks.before_reset,
    "function",
    "sessionMemory.enabled=true should register the async before_reset hook",
  );
  // Reset singleton before subsequent registrations so chunking tests get fresh config
  __resetSingletonForTesting__();

  const longText = `${"Long embedding payload. ".repeat(420)}tail`;
  const threshold = 6000;
  const embeddingServer = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/embeddings") {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    embeddingRequests.push(payload);
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];

    if (inputs.some((input) => String(input).length > threshold)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "context length exceeded for mock embedding endpoint",
          type: "invalid_request_error",
        },
      }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: inputs.map((_, index) => ({
        object: "embedding",
        index,
        embedding: [0.5, 0.5, 0.5, 0.5],
      })),
      model: payload.model || "mock-embedding-model",
      usage: {
        prompt_tokens: 0,
        total_tokens: 0,
      },
    }));
  });

  await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
  const embeddingPort = embeddingServer.address().port;
  const embeddingBaseURL = `http://127.0.0.1:${embeddingPort}/v1`;

  try {
    const chunkingOffApi = createMockApi({
      dbPath: path.join(workDir, "db-chunking-off"),
      autoCapture: false,
      autoRecall: false,
      embedding: {
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "text-embedding-3-small",
        baseURL: embeddingBaseURL,
        dimensions: 4,
        chunking: false,
      },
    });
    __resetSingletonForTesting__();
    plugin.register(chunkingOffApi);
    const chunkingOffTool = chunkingOffApi.toolFactories.mymem_store({
      agentId: "main",
      sessionKey: "agent:main:test",
    });
    const chunkingOffResult = await chunkingOffTool.execute("tool-1", {
      text: longText,
      scope: "global",
    });
    assert.equal(
      chunkingOffResult.details.error,
      "store_failed",
      "embedding.chunking=false should let long-document embedding fail",
    );

    const chunkingOnApi = createMockApi({
      dbPath: path.join(workDir, "db-chunking-on"),
      autoCapture: false,
      autoRecall: false,
      embedding: {
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "text-embedding-3-small",
        baseURL: embeddingBaseURL,
        dimensions: 4,
        chunking: true,
      },
    });
    __resetSingletonForTesting__();
    plugin.register(chunkingOnApi);
    const chunkingOnTool = chunkingOnApi.toolFactories.mymem_store({
      agentId: "main",
      sessionKey: "agent:main:test",
    });
    const chunkingOnResult = await chunkingOnTool.execute("tool-2", {
      text: longText,
      scope: "global",
    });
    assert.equal(
      chunkingOnResult.details.action,
      "created",
      "embedding.chunking=true should recover from long-document embedding errors",
    );

    const withDimensionsApi = createMockApi({
      dbPath: path.join(workDir, "db-with-dimensions"),
      autoCapture: false,
      autoRecall: false,
      embedding: {
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "text-embedding-3-small",
        baseURL: embeddingBaseURL,
        dimensions: 4,
      },
    });
    __resetSingletonForTesting__();
    plugin.register(withDimensionsApi);
    const withDimensionsTool = withDimensionsApi.toolFactories.mymem_store({
      agentId: "main",
      sessionKey: "agent:main:test",
    });
    const requestCountBeforeWithDimensions = embeddingRequests.length;
    await withDimensionsTool.execute("tool-3", {
      text: "dimensions should be sent by default",
      scope: "global",
    });
    const withDimensionsRequest = embeddingRequests.at(requestCountBeforeWithDimensions);
    assert.equal(
      withDimensionsRequest?.dimensions,
      4,
      "embedding.dimensions should be forwarded by default",
    );

    const omitDimensionsApi = createMockApi({
      dbPath: path.join(workDir, "db-omit-dimensions"),
      autoCapture: false,
      autoRecall: false,
      embedding: {
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "text-embedding-3-small",
        baseURL: embeddingBaseURL,
        dimensions: 4,
        omitDimensions: true,
      },
    });
    __resetSingletonForTesting__();
    plugin.register(omitDimensionsApi);
    const omitDimensionsTool = omitDimensionsApi.toolFactories.mymem_store({
      agentId: "main",
      sessionKey: "agent:main:test",
    });
    const requestCountBeforeOmitDimensions = embeddingRequests.length;
    await omitDimensionsTool.execute("tool-4", {
      text: "dimensions should be omitted when configured",
      scope: "global",
    });
    const omitDimensionsRequest = embeddingRequests.at(requestCountBeforeOmitDimensions);
    assert.equal(
      Object.prototype.hasOwnProperty.call(omitDimensionsRequest, "dimensions"),
      false,
      "embedding.omitDimensions=true should omit dimensions from embedding requests",
    );
  } finally {
    await new Promise((resolve) => embeddingServer.close(resolve));
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log("OK: plugin manifest regression test passed");
