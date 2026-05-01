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
const {
  resolveAutoRecallSessionStateKey,
  truncateAutoRecallQuery,
} = jiti("../src/auto-recall-hook.ts");

function baseConfig() {
  return {
    embedding: {
      apiKey: "test-api-key",
      baseURL: "https://embedding.example/v1",
      model: "Embedding",
    },
  };
}

describe("autoRecallTimeoutMs", () => {
  it("defaults to 20000 as an interactive auto-recall safety valve", () => {
    const parsed = parsePluginConfig(baseConfig());
    assert.equal(parsed.autoRecallTimeoutMs, 20000);
  });

  it("preserves explicit timeout values", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallTimeoutMs: 5000,
    });
    assert.equal(parsed.autoRecallTimeoutMs, 5000);
  });
});

describe("autoRecallMaxQueryLength", () => {
  it("defaults to 2000 when not specified", () => {
    const parsed = parsePluginConfig(baseConfig());
    assert.equal(parsed.autoRecallMaxQueryLength, 2000);
  });

  it("clamps values below minimum (100) to 100", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallMaxQueryLength: 50,
    });
    assert.equal(parsed.autoRecallMaxQueryLength, 100);
  });

  it("clamps values above maximum (10000) to 10000", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallMaxQueryLength: 20000,
    });
    assert.equal(parsed.autoRecallMaxQueryLength, 10000);
  });

  it("accepts value within valid range", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallMaxQueryLength: 5000,
    });
    assert.equal(parsed.autoRecallMaxQueryLength, 5000);
  });

  it("clamps boundary minimum (exactly 100) to 100", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallMaxQueryLength: 100,
    });
    assert.equal(parsed.autoRecallMaxQueryLength, 100);
  });

  it("clamps boundary maximum (exactly 10000) to 10000", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallMaxQueryLength: 10000,
    });
    assert.equal(parsed.autoRecallMaxQueryLength, 10000);
  });

  it("handles non-integer values by flooring and clamping", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallMaxQueryLength: 150.7,
    });
    assert.equal(parsed.autoRecallMaxQueryLength, 150);
  });

  it("treats negative values as missing (use default 2000)", () => {
    // parsePositiveInt returns undefined for non-positive values,
    // so -500 falls through to the ?? 2000 default, which is within range
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallMaxQueryLength: -500,
    });
    assert.equal(parsed.autoRecallMaxQueryLength, 2000);
  });
});

describe("autoRecallCandidatePoolSize", () => {
  it("defaults to 12 for low-latency auto-recall", () => {
    const parsed = parsePluginConfig(baseConfig());
    assert.equal(parsed.autoRecallCandidatePoolSize, 12);
  });

  it("clamps values below minimum (4) to 4", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallCandidatePoolSize: 2,
    });
    assert.equal(parsed.autoRecallCandidatePoolSize, 4);
  });

  it("clamps values above maximum (30) to 30", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallCandidatePoolSize: 100,
    });
    assert.equal(parsed.autoRecallCandidatePoolSize, 30);
  });
});

// Unit test: verify truncation logic behaves correctly
describe("autoRecallMaxQueryLength truncation behavior", () => {
  it("keeps both beginning and latest context when truncating", () => {
    const input = "START-" + "a".repeat(180) + "-LATEST-USER-REQUEST";
    const truncated = truncateAutoRecallQuery(input, 120);
    assert.equal(truncated.length, 120);
    assert.ok(truncated.startsWith("START-"));
    assert.ok(truncated.endsWith("-LATEST-USER-REQUEST"));
    assert.match(truncated, /keeping latest context/);
  });

  it("does not truncate when string is shorter than maxQueryLen", () => {
    const maxQueryLen = 2000;
    const input = "a".repeat(100);
    const truncated = truncateAutoRecallQuery(input, maxQueryLen);
    assert.equal(truncated.length, 100);
  });

  it("exact boundary: 2000-char string stays unchanged when maxQueryLen=2000", () => {
    const maxQueryLen = 2000;
    const input = "b".repeat(2000);
    const truncated = truncateAutoRecallQuery(input, maxQueryLen);
    assert.equal(truncated.length, 2000);
  });
});

describe("auto-recall session state key", () => {
  it("prefers sessionId when available", () => {
    assert.equal(
      resolveAutoRecallSessionStateKey({
        sessionId: "sid-1",
        sessionKey: "agent:main:discord:channel:1",
        channelId: "discord",
        conversationId: "channel:1",
      }),
      "session:sid-1",
    );
  });

  it("falls back to sessionKey before conversation identifiers", () => {
    assert.equal(
      resolveAutoRecallSessionStateKey({
        sessionKey: "agent:main:discord:channel:1",
        channelId: "discord",
        conversationId: "channel:1",
      }),
      "sessionKey:agent:main:discord:channel:1",
    );
  });

  it("uses conversation key when session identifiers are absent", () => {
    assert.equal(
      resolveAutoRecallSessionStateKey({
        channelId: "discord",
        conversationId: "channel:1",
      }),
      "conversation:discord:channel:1",
    );
  });
});
