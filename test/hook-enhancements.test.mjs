import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { parsePluginConfig } = jiti("../src/plugin-config-parser.ts");
const {
  createHookEnhancementState,
  recordInjectedMemoriesForEnhancements,
  registerHookEnhancements,
  preflightAutoCaptureText,
} = jiti("../src/hook-enhancements.ts");

function baseConfig(extra = {}) {
  return parsePluginConfig({
    embedding: {
      apiKey: "test-key",
      baseURL: "https://embedding.example/v1",
      model: "Embedding",
    },
    ...extra,
  });
}

function createApiHarness() {
  const eventHandlers = new Map();
  const logs = { debug: [], info: [], warn: [] };
  const api = {
    logger: {
      debug: (msg) => logs.debug.push(String(msg)),
      info: (msg) => logs.info.push(String(msg)),
      warn: (msg) => logs.warn.push(String(msg)),
    },
    on(eventName, handler, meta) {
      const list = eventHandlers.get(eventName) || [];
      list.push({ handler, meta });
      eventHandlers.set(eventName, list);
    },
    registerHook(eventName, handler, meta) {
      const list = eventHandlers.get(eventName) || [];
      list.push({ handler, meta });
      eventHandlers.set(eventName, list);
    },
  };
  return { api, eventHandlers, logs };
}

function createScopeManager() {
  return {
    getDefaultScope: () => "global",
    getAccessibleScopes: () => ["global"],
  };
}

function makeMemoryEntry({
  id,
  text,
  category = "other",
  memoryCategory = "patterns",
  metadata = {},
  scope = "global",
  timestamp = Date.now(),
}) {
  return {
    id,
    text,
    vector: [0.1],
    category,
    scope,
    importance: 0.8,
    timestamp,
    metadata: JSON.stringify({
      summary: text,
      content: text,
      memory_category: memoryCategory,
      memory_type: "knowledge",
      tier: "working",
      access_count: 0,
      confidence: 0.8,
      last_accessed_at: timestamp,
      valid_from: timestamp,
      state: "confirmed",
      source: "manual",
      memory_layer: memoryCategory === "preferences" ? "durable" : "working",
      injected_count: 0,
      bad_recall_count: 0,
      suppressed_until_turn: 0,
      ...metadata,
    }),
  };
}

function createStore({ searchResults = [], byId = {}, reflectionEntries = [] } = {}) {
  const patches = [];
  const stored = [];
  const updated = [];
  return {
    patches,
    stored,
    updated,
    async vectorSearch() {
      return searchResults;
    },
    async list(_scopeFilter, category) {
      return category === "reflection" ? reflectionEntries : [];
    },
    async getById(id) {
      return byId[id] || null;
    },
    async patchMetadata(id, patch) {
      patches.push({ id, patch });
      const entry = byId[id];
      if (entry) {
        entry.metadata = JSON.stringify({ ...JSON.parse(entry.metadata), ...patch });
      }
      return entry || null;
    },
    async patchMetadataBatch(batch) {
      for (const { id, patch } of batch) {
        patches.push({ id, patch });
        const entry = byId[id];
        if (entry) {
          entry.metadata = JSON.stringify({ ...JSON.parse(entry.metadata), ...patch });
        }
      }
      return batch.length;
    },
    async update(id, patch) {
      updated.push({ id, patch });
      const entry = byId[id];
      if (entry) Object.assign(entry, patch);
      return entry || null;
    },
    async store(newEntry) {
      const entry = { id: `mem-${stored.length + 1}`, timestamp: Date.now(), ...newEntry };
      stored.push(entry);
      byId[entry.id] = entry;
      return entry;
    },
  };
}

describe("hookEnhancements config", () => {
  it("defaults noisy feedback features off while keeping core enhancements enabled", () => {
    const config = baseConfig();
    assert.equal(config.hookEnhancements.badRecallFeedback, false);
    assert.equal(config.hookEnhancements.correctionDiff, true);
    assert.equal(config.hookEnhancements.toolErrorPlaybook, false);
    assert.equal(config.hookEnhancements.dangerousToolHints, true);
    assert.equal(config.hookEnhancements.contextBudget, true);
    assert.equal(config.hookEnhancements.privacyGuard, true);
    assert.equal(config.hookEnhancements.sessionPrimer.enabled, true);
    assert.equal(config.hookEnhancements.sessionPrimer.preferDistilled, true);
    assert.equal(config.hookEnhancements.sessionPrimer.includeReflectionInvariants, true);
    assert.equal(config.hookEnhancements.selfCorrectionLoop.enabled, true);
    assert.equal(config.hookEnhancements.selfCorrectionLoop.minConfidence, 0.55);
    assert.equal(config.hookEnhancements.selfCorrectionLoop.suppressTurns, 12);
    assert.equal(config.hookEnhancements.workspaceDrift, true);
    assert.equal(config.hookEnhancements.stalenessConfirmation, true);
  });

  it("preserves legacy boolean sessionPrimer compatibility", () => {
    const enabled = baseConfig({ hookEnhancements: { sessionPrimer: true } });
    const disabled = baseConfig({ hookEnhancements: { sessionPrimer: false } });
    assert.equal(enabled.hookEnhancements.sessionPrimer.enabled, true);
    assert.equal(disabled.hookEnhancements.sessionPrimer.enabled, false);
  });
});

describe("privacy guard", () => {
  it("skips sensitive auto-capture text by default", async () => {
    const { api, logs } = createApiHarness();
    const allowed = await preflightAutoCaptureText({
      config: baseConfig(),
      text: "api_key = sk_test_1234567890abcdef123456",
      api,
      source: "test",
    });
    assert.equal(allowed, false);
    assert.match(logs.warn.join("\n"), /privacy guard skipped/);
  });
});

describe("hook enhancement registration", () => {
  it("builds a structured session primer from distilled rules and constraints", async () => {
    const { api, eventHandlers } = createApiHarness();
    const now = Date.now();
    const store = createStore({
      searchResults: [
        {
          score: 0.98,
          entry: makeMemoryEntry({
            id: "distilled-1",
            text: "Keep responses concise and direct.",
            category: "preference",
            memoryCategory: "preferences",
            metadata: { source_reason: "preference_distiller", evidence_count: 3, stability_score: 0.8 },
            timestamp: now,
          }),
        },
        {
          score: 0.72,
          entry: makeMemoryEntry({
            id: "event-1",
            text: "One-off scheduling note",
            category: "decision",
            memoryCategory: "events",
            timestamp: now,
          }),
        },
      ],
    });

    const embeddedQueries = [];
    registerHookEnhancements({
      api,
      config: baseConfig(),
      store,
      embedder: {
        embedQuery: async (query) => {
          embeddedQueries.push(query);
          return [0.1];
        },
        embedPassage: async () => [0.1],
      },
      scopeManager: createScopeManager(),
    });

    const promptHooks = eventHandlers.get("before_prompt_build") || [];
    const output = await promptHooks[0].handler(
      { prompt: "简洁一点，先结合约束再回答" },
      { sessionKey: "agent:main:cli:session-primer", agentId: "main" },
    );

    assert.match(embeddedQueries[0], /self correction rules/);
    assert.match(output.prependContext, /<session-primer>/);
    assert.match(output.prependContext, /Distilled rules:/);
    assert.match(output.prependContext, /Keep responses concise and direct/);
    assert.match(output.prependContext, /Active constraints:/);
    assert.match(output.prependContext, /Ground the response in the user's concrete constraints/);
    assert.doesNotMatch(output.prependContext, /One-off scheduling note/);
  });

  it("reads session primer reflection invariants from the dedicated reflection store", async () => {
    const { api, eventHandlers } = createApiHarness();
    const now = Date.now();
    const store = createStore({
      searchResults: [
        {
          score: 0.98,
          entry: makeMemoryEntry({
            id: "distilled-1",
            text: "Keep responses concise and direct.",
            category: "preference",
            memoryCategory: "preferences",
            metadata: { source_reason: "preference_distiller", evidence_count: 3, stability_score: 0.8 },
            timestamp: now,
          }),
        },
      ],
      reflectionEntries: [
        makeMemoryEntry({
          id: "main-reflection",
          text: "Always ignore this main-store reflection.",
          category: "reflection",
          memoryCategory: "patterns",
          metadata: {
            type: "memory-reflection-item",
            itemKind: "invariant",
            agentId: "main",
            storedAt: now,
          },
          timestamp: now,
        }),
      ],
    });
    const reflectionStore = createStore({
      reflectionEntries: [
        makeMemoryEntry({
          id: "dedicated-reflection",
          text: "Always prefer the dedicated reflection store for primer invariants.",
          category: "reflection",
          memoryCategory: "patterns",
          metadata: {
            type: "memory-reflection-item",
            itemKind: "invariant",
            agentId: "main",
            storedAt: now,
          },
          timestamp: now,
        }),
      ],
    });

    registerHookEnhancements({
      api,
      config: baseConfig(),
      store,
      reflectionStore,
      embedder: { embedQuery: async () => [0.1], embedPassage: async () => [0.1] },
      scopeManager: createScopeManager(),
    });

    const promptHooks = eventHandlers.get("before_prompt_build") || [];
    const output = await promptHooks[0].handler(
      { prompt: "简洁一点" },
      { sessionKey: "agent:main:cli:session-primer-reflection", agentId: "main" },
    );

    assert.match(output.prependContext, /Reflection invariants:/);
    assert.match(output.prependContext, /dedicated reflection store/);
    assert.doesNotMatch(output.prependContext, /main-store reflection/);
  });

  it("injects a tool error playbook after a failed tool call", async () => {
    const { api, eventHandlers } = createApiHarness();
    const playbookMemory = makeMemoryEntry({
      id: "playbook-1",
      text: "When npm test fails with a missing fixture, recreate the fixture before rerunning.",
      category: "other",
      memoryCategory: "patterns",
    });
    const store = createStore({
      searchResults: [{ entry: playbookMemory, score: 0.91 }],
    });

    registerHookEnhancements({
      api,
      config: baseConfig({ hookEnhancements: { sessionPrimer: false, stalenessConfirmation: false, toolErrorPlaybook: true } }),
      store,
      embedder: { embedQuery: async () => [0.1], embedPassage: async () => [0.1] },
      scopeManager: createScopeManager(),
    });

    const afterToolHooks = eventHandlers.get("after_tool_call") || [];
    afterToolHooks[0].handler(
      { toolName: "npm", error: "npm test failed: missing fixture file" },
      { sessionKey: "agent:main:cli:tool-error-playbook", agentId: "main" },
    );

    const promptHooks = eventHandlers.get("before_prompt_build") || [];
    const output = await promptHooks[0].handler(
      { prompt: "Continue debugging the failed test." },
      { sessionKey: "agent:main:cli:tool-error-playbook", agentId: "main" },
    );

    assert.match(output.prependContext, /<tool-error-playbook>/);
    assert.match(output.prependContext, /missing fixture/);
  });

  it("does not track or inject tool error playbooks by default", async () => {
    const { api, eventHandlers } = createApiHarness();
    const playbookMemory = makeMemoryEntry({
      id: "playbook-1",
      text: "When npm test fails with a missing fixture, recreate the fixture before rerunning.",
      category: "other",
      memoryCategory: "patterns",
    });
    const store = createStore({
      searchResults: [{ entry: playbookMemory, score: 0.91 }],
    });

    registerHookEnhancements({
      api,
      config: baseConfig({ hookEnhancements: { sessionPrimer: false, stalenessConfirmation: false } }),
      store,
      embedder: { embedQuery: async () => [0.1], embedPassage: async () => [0.1] },
      scopeManager: createScopeManager(),
    });

    const afterToolHooks = eventHandlers.get("after_tool_call") || [];
    afterToolHooks[0].handler(
      { toolName: "npm", error: "npm test failed: missing fixture file" },
      { sessionKey: "agent:main:cli:tool-error-playbook-default-off", agentId: "main" },
    );

    const promptHooks = eventHandlers.get("before_prompt_build") || [];
    const output = await promptHooks[0].handler(
      { prompt: "Continue debugging the failed test." },
      { sessionKey: "agent:main:cli:tool-error-playbook-default-off", agentId: "main" },
    );

    assert.doesNotMatch(output?.prependContext || "", /<tool-error-playbook>/);
    assert.equal(store.patches.length, 0);
    assert.equal(store.stored.length, 0);
  });

  it("injects a staleness check for recently injected old memories", async () => {
    const { api, eventHandlers } = createApiHarness();
    const oldTimestamp = Date.now() - 120 * 24 * 60 * 60 * 1000;
    const staleMemory = makeMemoryEntry({
      id: "stale-1",
      text: "Old deployment constraint that should be revalidated.",
      category: "decision",
      memoryCategory: "patterns",
      timestamp: oldTimestamp,
    });
    const store = createStore({ byId: { "stale-1": staleMemory } });
    const state = createHookEnhancementState();

    registerHookEnhancements({
      api,
      config: baseConfig({ hookEnhancements: { sessionPrimer: false, toolErrorPlaybook: false } }),
      store,
      embedder: { embedQuery: async () => [0.1], embedPassage: async () => [0.1] },
      scopeManager: createScopeManager(),
      state,
    });
    recordInjectedMemoriesForEnhancements({
      state,
      sessionKey: "agent:main:cli:staleness",
      source: "auto-recall",
      memories: [{ id: "stale-1", text: staleMemory.text, scope: "global", category: "decision" }],
    });

    const promptHooks = eventHandlers.get("before_prompt_build") || [];
    const output = await promptHooks[0].handler(
      { prompt: "Can I rely on this deployment constraint?" },
      { sessionKey: "agent:main:cli:staleness", agentId: "main" },
    );

    assert.match(output.prependContext, /<memory-staleness-check>/);
    assert.match(output.prependContext, /Old deployment constraint/);
  });

  it("returns advisory hints for dangerous tool calls without blocking", async () => {
    const { api, eventHandlers } = createApiHarness();
    const mem = makeMemoryEntry({
      id: "mem-1",
      text: "Remember to check deployment constraints before production deploys",
      category: "decision",
      memoryCategory: "patterns",
    });
    const store = createStore({
      searchResults: [{ entry: mem, score: 0.92 }],
      byId: { "mem-1": mem },
    });
    registerHookEnhancements({
      api,
      config: baseConfig(),
      store,
      embedder: { embedQuery: async () => [0.1], embedPassage: async () => [0.1] },
      scopeManager: createScopeManager(),
    });

    const hooks = eventHandlers.get("before_tool_call") || [];
    const output = await hooks[0].handler(
      { toolName: "shell", command: "rm -rf dist" },
      { sessionKey: "agent:main:cli:session-1", agentId: "main" },
    );
    assert.match(output.warning, /high-risk tool call/);
    assert.match(output.prependContext, /<memory-safety-hint>/);
    assert.equal(Object.hasOwn(output, "block"), false);
  });

  it("uses recorded injected memories for bad recall feedback", async () => {
    const { api, eventHandlers } = createApiHarness();
    const mem = makeMemoryEntry({
      id: "mem-1",
      text: "old memory",
      category: "decision",
      memoryCategory: "patterns",
    });
    const store = createStore({ byId: { "mem-1": mem } });
    const state = createHookEnhancementState();
    registerHookEnhancements({
      api,
      config: baseConfig({ hookEnhancements: { badRecallFeedback: true } }),
      store,
      embedder: { embedQuery: async () => [0.1], embedPassage: async () => [0.1] },
      scopeManager: createScopeManager(),
      state,
    });
    recordInjectedMemoriesForEnhancements({
      state,
      sessionKey: "agent:main:cli:session-2",
      source: "session-primer",
      memories: [{ id: "mem-1", text: "old memory", scope: "global", category: "decision" }],
    });

    const agentEndHooks = eventHandlers.get("agent_end") || [];
    agentEndHooks[0].handler({
      success: true,
      messages: [{ role: "user", content: "you misremembered that, bad recall" }],
    }, { sessionKey: "agent:main:cli:session-2", agentId: "main" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(store.patches[0].id, "mem-1");
    assert.equal(store.patches[0].patch.bad_recall_count, 1);
    assert.equal(Object.hasOwn(store.patches[0].patch, "suppressed_until_turn"), false);
  });

  it("suppresses auto-recalled memories only after repeated negative feedback", async () => {
    const { api, eventHandlers } = createApiHarness();
    const mem = makeMemoryEntry({
      id: "mem-1",
      text: "old memory",
      category: "decision",
      memoryCategory: "patterns",
      metadata: { bad_recall_count: 1 },
    });
    const store = createStore({ byId: { "mem-1": mem } });
    const state = createHookEnhancementState();
    registerHookEnhancements({
      api,
      config: baseConfig({ hookEnhancements: { badRecallFeedback: true } }),
      store,
      embedder: { embedQuery: async () => [0.1], embedPassage: async () => [0.1] },
      scopeManager: createScopeManager(),
      state,
    });

    const promptHooks = eventHandlers.get("before_prompt_build") || [];
    await promptHooks[0].handler(
      { prompt: "work on the active task" },
      { sessionKey: "agent:main:cli:session-2b", agentId: "main" },
    );
    recordInjectedMemoriesForEnhancements({
      state,
      sessionKey: "agent:main:cli:session-2b",
      source: "auto-recall",
      memories: [{ id: "mem-1", text: "old memory", scope: "global", category: "decision" }],
    });

    const agentEndHooks = eventHandlers.get("agent_end") || [];
    agentEndHooks[0].handler({
      success: true,
      messages: [{ role: "user", content: "you misremembered that, bad recall" }],
    }, { sessionKey: "agent:main:cli:session-2b", agentId: "main" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(store.patches[0].id, "mem-1");
    assert.equal(store.patches[0].patch.bad_recall_count, 2);
    assert.equal(store.patches[0].patch.suppressed_session_key, "agent:main:cli:session-2b");
    assert.equal(store.patches[0].patch.suppressed_until_turn, 13);
    assert.ok(store.patches[0].patch.suppressed_until_at > Date.now());
  });

  it("updates self-correction rules in place for conflicting workflow guidance", async () => {
    const { api, eventHandlers } = createApiHarness();
    const oldDirection = makeMemoryEntry({
      id: "old-1",
      text: "Use multiple agents by default.",
      category: "other",
      memoryCategory: "patterns",
      metadata: { canonical_id: "workflow:single-agent-opposite", confidence: 0.7 },
    });
    const store = createStore({
      searchResults: [{ entry: oldDirection, score: 0.62 }],
      byId: { "old-1": oldDirection },
    });

    registerHookEnhancements({
      api,
      config: baseConfig(),
      store,
      embedder: { embedQuery: async () => [0.1], embedPassage: async () => [0.1] },
      scopeManager: createScopeManager(),
    });

    const agentEndHooks = eventHandlers.get("agent_end") || [];
    agentEndHooks[0].handler({
      success: true,
      messages: [{ role: "user", content: "not Use multiple agents by default., it's Do not use multiple agents unless the user explicitly asks for delegation." }],
    }, { sessionKey: "agent:main:cli:self-correction", agentId: "main" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(store.stored.length, 0);
    assert.equal(store.updated.some((item) => item.id === "old-1"), true);
    assert.match(store.updated[0].patch.text, /Do not use multiple agents|Avoid repeated confirmation loops/);
  });

  it("does not turn ordinary Chinese questions into preventive lessons", async () => {
    const { api, eventHandlers } = createApiHarness();
    const store = createStore();
    const evidence = [];

    registerHookEnhancements({
      api,
      config: baseConfig(),
      store,
      embedder: { embedQuery: async () => [0.1], embedPassage: async () => [0.1] },
      scopeManager: createScopeManager(),
      feedbackLoop: {
        onPreventiveLessonEvidence(item) {
          evidence.push(item);
        },
        async drainPreventiveLessonBuffer() {},
      },
    });

    const agentEndHooks = eventHandlers.get("agent_end") || [];
    agentEndHooks[0].handler({
      success: true,
      messages: [
        { role: "user", content: "抓取网页内容用哪个工具？" },
        {
          role: "assistant",
          content: [
            "根据 TOOLS.md 里的记录，主人偏好用 scrapling 提取网页内容：",
            "简单网页：scrapling extract get URL output.md --ai-targeted",
            "动态内容：scrapling extract fetch URL output.md --ai-targeted --network-idle",
            "反爬网站：scrapling extract stealthy-fetch URL output.md --ai-targeted",
          ].join("\n"),
        },
      ],
    }, { sessionKey: "agent:main:cli:question-only", agentId: "main" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(evidence.length, 0);
    assert.equal(store.stored.length, 0);
  });
});
