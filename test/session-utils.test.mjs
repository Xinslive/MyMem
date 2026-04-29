/**
 * Session Utils Test
 *
 * Run: node --test test/session-utils.test.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  extractTextContent,
  shouldSkipReflectionMessage,
  containsErrorSignal,
  summarizeErrorText,
  normalizeErrorSignature,
  extractTextFromToolResult,
  isExplicitRememberCommand,
  redactSecrets,
} = jiti("../src/session-utils.ts");

describe("extractTextContent", () => {
  it("extracts string content", () => {
    assert.strictEqual(extractTextContent("hello world"), "hello world");
  });

  it("extracts from array content", () => {
    const content = [{ type: "text", text: "hello" }, { type: "text", text: "world" }];
    assert.strictEqual(extractTextContent(content), "hello");
  });

  it("returns null for null/undefined", () => {
    assert.strictEqual(extractTextContent(null), null);
  });
});

describe("shouldSkipReflectionMessage", () => {
  it("skips empty messages", () => {
    assert.ok(shouldSkipReflectionMessage("user", ""));
  });

  it("skips slash commands", () => {
    assert.ok(shouldSkipReflectionMessage("user", "/remember something"));
  });

  it("skips user messages with memory injection", () => {
    assert.ok(shouldSkipReflectionMessage("user", "hello <relevant-memories>...</relevant-memories>"));
  });

  it("skips UNTRUSTED DATA blocks", () => {
    assert.ok(shouldSkipReflectionMessage("user", "UNTRUSTED DATA some content END UNTRUSTED DATA"));
  });

  it("accepts valid messages", () => {
    assert.ok(!shouldSkipReflectionMessage("user", "I prefer dark mode for my editor"));
  });
});

describe("containsErrorSignal", () => {
  it("detects [error] bracket format", () => {
    assert.ok(containsErrorSignal("[error] something went wrong"));
  });

  it("detects error: format", () => {
    assert.ok(containsErrorSignal("error: something went wrong"));
  });

  it("detects TypeError", () => {
    assert.ok(containsErrorSignal("TypeError: Cannot read property"));
  });

  it("returns false for normal text", () => {
    assert.ok(!containsErrorSignal("The server is running fine"));
  });
});

describe("normalizeErrorSignature", () => {
  it("normalizes long numbers", () => {
    const result = normalizeErrorSignature("error at line 1234567890");
    assert.ok(!result.includes("1234567890"));
  });

  it("normalizes hex addresses", () => {
    const result = normalizeErrorSignature("0x7f8a9b0c1d2e");
    assert.ok(!result.includes("0x7f8a9b0c1d2e"));
  });
});

describe("isExplicitRememberCommand", () => {
  it("detects 请记住", () => {
    assert.ok(isExplicitRememberCommand("请记住"));
  });

  it("detects 记住 with period", () => {
    assert.ok(isExplicitRememberCommand("记住。"));
  });

  it("detects 别忘了", () => {
    assert.ok(isExplicitRememberCommand("别忘了"));
  });

  it("returns false for normal text", () => {
    assert.ok(!isExplicitRememberCommand("I want to remember this"));
  });
});

describe("redactSecrets", () => {
  it("redacts sk- API keys", () => {
    const result = redactSecrets("apiKey: sk-1234567890abcdefghijklmnop");
    assert.ok(result.includes("[REDACTED]"));
    assert.ok(!result.includes("sk-1234567890"));
  });

  it("redacts long Bearer tokens", () => {
    const result = redactSecrets("Authorization: Bearer abc123xyz789123456789123456789123456789");
    assert.ok(result.includes("[REDACTED]"));
  });

  it("keeps normal text", () => {
    const result = redactSecrets("hello world");
    assert.strictEqual(result, "hello world");
  });
});
