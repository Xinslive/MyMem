import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  normalizeAutoCaptureText,
  stripAutoCaptureInjectedPrefix,
} = jiti("../src/auto-capture-cleanup.ts");
const { registerAutoCaptureHook } = jiti("../src/auto-capture-hook.ts");

function createAutoCaptureHarness() {
  const eventHandlers = new Map();
  const api = {
    logger: {
      debug() {},
      info() {},
      warn() {},
    },
    on(eventName, handler) {
      const list = eventHandlers.get(eventName) || [];
      list.push({ handler });
      eventHandlers.set(eventName, list);
    },
  };
  return { api, eventHandlers };
}

describe("auto-capture cleanup", () => {
  it("preserves real content when wrapper lines are mixed with facts in the same payload", () => {
    const input = [
      "[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester.",
      "[Subagent Task] Reply with a brief acknowledgment only. Facts for automatic memory extraction quality test: 1) Shen prefers concise blunt status updates. 2) Project Orion deploy window is Friday 21:00 Asia/Shanghai. 3) If a database migration touches billing tables, require a dry run first. Do not use any memory tools.",
    ].join("\n");

    const result = normalizeAutoCaptureText("user", input);
    assert.equal(
      result,
      "Facts for automatic memory extraction quality test: 1) Shen prefers concise blunt status updates. 2) Project Orion deploy window is Friday 21:00 Asia/Shanghai. 3) If a database migration touches billing tables, require a dry run first.",
    );
  });

  it("drops wrapper-only payloads", () => {
    const input = [
      "[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester.",
      "[Subagent Task] Reply with a brief acknowledgment only.",
    ].join("\n");

    assert.equal(normalizeAutoCaptureText("user", input), null);
  });

  it("strips inbound metadata before preserving the remaining content", () => {
    const input = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id":"om_123","sender_id":"ou_456"}',
      "```",
      "",
      "[Subagent Task] Reply with a brief acknowledgment only. Actual user content starts here.",
    ].join("\n");

    assert.equal(
      stripAutoCaptureInjectedPrefix("user", input),
      "Actual user content starts here.",
    );
  });

  it("keeps configured assistant text in the current turn when pending ingress text exists", async () => {
    const { api, eventHandlers } = createAutoCaptureHarness();
    let capturedConversationText = "";

    registerAutoCaptureHook({
      api,
      config: {
        extractMinMessages: 1,
        captureAssistantAgents: ["main"],
        scopes: { default: "global" },
      },
      store: {},
      embedder: {},
      smartExtractor: {
        async filterNoiseByEmbedding(texts) {
          return texts;
        },
        async extractAndPersist(conversationText) {
          capturedConversationText = conversationText;
          return { created: 1, merged: 0, skipped: 0, boundarySkipped: 0 };
        },
      },
      extractionRateLimiter: {
        isRateLimited() {
          return false;
        },
        getRecentCount() {
          return 0;
        },
        recordExtraction() {},
      },
      scopeManager: {
        getAccessibleScopes() {
          return ["global"];
        },
        getDefaultScope() {
          return "global";
        },
      },
      autoCaptureSeenTextCount: new Map(),
      autoCapturePendingIngressTexts: new Map([
        ["channel-1:conversation-1", ["User asked for terse status updates."]],
      ]),
      autoCaptureRecentTexts: new Map(),
      mdMirror: null,
      isCliMode: () => false,
    });

    const [{ handler: agentEndHook }] = eventHandlers.get("agent_end") || [];
    assert.ok(agentEndHook, "expected agent_end hook to be registered");

    agentEndHook(
      {
        success: true,
        messages: [
          { role: "user", content: "User asked for terse status updates." },
          { role: "assistant", content: "I will keep updates terse and factual." },
        ],
      },
      {
        agentId: "main",
        sessionKey: "agent:main:channel-1:conversation-1",
      },
    );

    await agentEndHook.__lastRun;

    assert.equal(
      capturedConversationText,
      [
        "User asked for terse status updates.",
        "I will keep updates terse and factual.",
      ].join("\n"),
    );
  });

  it("does not keep non-main assistant text by default", async () => {
    const { api, eventHandlers } = createAutoCaptureHarness();
    let capturedConversationText = "";

    registerAutoCaptureHook({
      api,
      config: {
        extractMinMessages: 1,
        scopes: { default: "global" },
      },
      store: {},
      embedder: {},
      smartExtractor: {
        async filterNoiseByEmbedding(texts) {
          return texts;
        },
        async extractAndPersist(conversationText) {
          capturedConversationText = conversationText;
          return { created: 1, merged: 0, skipped: 0, boundarySkipped: 0 };
        },
      },
      extractionRateLimiter: {
        isRateLimited() {
          return false;
        },
        getRecentCount() {
          return 0;
        },
        recordExtraction() {},
      },
      scopeManager: {
        getAccessibleScopes() {
          return ["global"];
        },
        getDefaultScope() {
          return "global";
        },
      },
      autoCaptureSeenTextCount: new Map(),
      autoCapturePendingIngressTexts: new Map(),
      autoCaptureRecentTexts: new Map(),
      mdMirror: null,
      isCliMode: () => false,
    });

    const [{ handler: agentEndHook }] = eventHandlers.get("agent_end") || [];
    assert.ok(agentEndHook, "expected agent_end hook to be registered");

    agentEndHook(
      {
        success: true,
        messages: [
          { role: "user", content: "User asked for terse status updates." },
          { role: "assistant", content: "I will keep updates terse and factual." },
        ],
      },
      {
        agentId: "life",
        sessionKey: "agent:life:channel-1:conversation-1",
      },
    );

    await agentEndHook.__lastRun;

    assert.equal(capturedConversationText, "User asked for terse status updates.");
  });

  it("keeps main assistant text by default", async () => {
    const { api, eventHandlers } = createAutoCaptureHarness();
    let capturedConversationText = "";

    registerAutoCaptureHook({
      api,
      config: {
        extractMinMessages: 1,
        scopes: { default: "global" },
      },
      store: {},
      embedder: {},
      smartExtractor: {
        async filterNoiseByEmbedding(texts) {
          return texts;
        },
        async extractAndPersist(conversationText) {
          capturedConversationText = conversationText;
          return { created: 1, merged: 0, skipped: 0, boundarySkipped: 0 };
        },
      },
      extractionRateLimiter: {
        isRateLimited() {
          return false;
        },
        getRecentCount() {
          return 0;
        },
        recordExtraction() {},
      },
      scopeManager: {
        getAccessibleScopes() {
          return ["global"];
        },
        getDefaultScope() {
          return "global";
        },
      },
      autoCaptureSeenTextCount: new Map(),
      autoCapturePendingIngressTexts: new Map(),
      autoCaptureRecentTexts: new Map(),
      mdMirror: null,
      isCliMode: () => false,
    });

    const [{ handler: agentEndHook }] = eventHandlers.get("agent_end") || [];
    assert.ok(agentEndHook, "expected agent_end hook to be registered");

    agentEndHook(
      {
        success: true,
        messages: [
          { role: "user", content: "User prefers terse status updates." },
          { role: "assistant", content: "I will keep updates terse and factual." },
        ],
      },
      {
        agentId: "main",
        sessionKey: "agent:main:channel-1:conversation-1",
      },
    );

    await agentEndHook.__lastRun;

    assert.equal(
      capturedConversationText,
      [
        "User prefers terse status updates.",
        "I will keep updates terse and factual.",
      ].join("\n"),
    );
  });

  it("skips low-value conversations before smart extraction by default", async () => {
    const { api, eventHandlers } = createAutoCaptureHarness();
    let extractionRuns = 0;

    registerAutoCaptureHook({
      api,
      config: {
        extractMinMessages: 1,
        sessionCompression: { enabled: true, minScoreToKeep: 0.3 },
        extractionThrottle: { skipLowValue: true, maxExtractionsPerHour: 0 },
        scopes: { default: "global" },
      },
      store: {},
      embedder: {},
      smartExtractor: {
        async filterNoiseByEmbedding(texts) {
          return texts;
        },
        async extractAndPersist() {
          extractionRuns++;
          return { created: 1, merged: 0, skipped: 0, boundarySkipped: 0 };
        },
      },
      extractionRateLimiter: {
        isRateLimited() {
          return false;
        },
        getRecentCount() {
          return 0;
        },
        recordExtraction() {},
      },
      scopeManager: {
        getAccessibleScopes() {
          return ["global"];
        },
        getDefaultScope() {
          return "global";
        },
      },
      autoCaptureSeenTextCount: new Map(),
      autoCapturePendingIngressTexts: new Map(),
      autoCaptureRecentTexts: new Map(),
      mdMirror: null,
      isCliMode: () => false,
    });

    const [{ handler: agentEndHook }] = eventHandlers.get("agent_end") || [];
    assert.ok(agentEndHook, "expected agent_end hook to be registered");

    agentEndHook(
      {
        success: true,
        messages: [
          { role: "user", content: "ok" },
          { role: "user", content: "sure" },
          { role: "user", content: "thanks" },
        ],
      },
      {
        agentId: "main",
        sessionKey: "agent:main:channel-1:conversation-1",
      },
    );

    await agentEndHook.__lastRun;

    assert.equal(extractionRuns, 0);
  });

  it("cleans auto-capture session state on session_end", () => {
    const { api, eventHandlers } = createAutoCaptureHarness();
    const autoCaptureSeenTextCount = new Map([
      ["agent:main:channel-1:conversation-1", 2],
    ]);
    const autoCapturePendingIngressTexts = new Map([
      ["channel-1:conversation-1", ["pending"]],
    ]);
    const autoCaptureRecentTexts = new Map([
      ["agent:main:channel-1:conversation-1", ["recent"]],
    ]);

    registerAutoCaptureHook({
      api,
      config: {
        scopes: { default: "global" },
      },
      store: {},
      embedder: {},
      smartExtractor: null,
      extractionRateLimiter: {
        isRateLimited() {
          return false;
        },
        getRecentCount() {
          return 0;
        },
        recordExtraction() {},
      },
      scopeManager: {
        getAccessibleScopes() {
          return ["global"];
        },
        getDefaultScope() {
          return "global";
        },
      },
      autoCaptureSeenTextCount,
      autoCapturePendingIngressTexts,
      autoCaptureRecentTexts,
      mdMirror: null,
      isCliMode: () => false,
    });

    const [{ handler: sessionEndHook }] = eventHandlers.get("session_end") || [];
    assert.ok(sessionEndHook, "expected session_end hook to be registered");

    sessionEndHook(
      {},
      {
        sessionKey: "agent:main:channel-1:conversation-1",
      },
    );

    assert.equal(autoCaptureSeenTextCount.size, 0);
    assert.equal(autoCapturePendingIngressTexts.size, 0);
    assert.equal(autoCaptureRecentTexts.size, 0);
  });
});
