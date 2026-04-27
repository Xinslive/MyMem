/**
 * Capture Detection Module Test
 *
 * Run: node --test test/capture-detection.test.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { shouldCapture, detectCategory, sanitizeForContext, summarizeTextPreview } = jiti("../src/capture-detection.ts");

describe("shouldCapture", () => {
  it("captures messages with memory triggers", () => {
    assert.ok(shouldCapture("Remember that I prefer dark mode"));
    assert.ok(shouldCapture("we decided to use TypeScript"));
    assert.ok(shouldCapture("我的名字是小明"));
    assert.ok(shouldCapture("记住我的邮箱是 test@example.com"));
  });

  it("skips short messages", () => {
    assert.ok(!shouldCapture("hi"));
    assert.ok(!shouldCapture("ok"));
  });

  it("skips memory management commands", () => {
    assert.ok(!shouldCapture("mymem: forget my old preferences"));
    assert.ok(!shouldCapture("delete all memories"));
    assert.ok(!shouldCapture("清除记忆"));
  });

  it("skips injected memory context", () => {
    const text = "Some text <relevant-memories>injected context</relevant-memories>";
    assert.ok(!shouldCapture(text));
  });

  it("skips system-generated content", () => {
    assert.ok(!shouldCapture("<system>Generated content</system>"));
  });

  it("skips emoji-heavy responses", () => {
    assert.ok(!shouldCapture("👍🎉🔥✨ Great job! 🎊🎉🎉"));
  });
});

describe("detectCategory", () => {
  it("detects preference patterns", () => {
    assert.strictEqual(detectCategory("I prefer dark mode"), "preference");
    assert.strictEqual(detectCategory("我喜欢喝咖啡"), "preference");
  });

  it("detects decision patterns", () => {
    assert.strictEqual(detectCategory("we decided to use React"), "decision");
    assert.strictEqual(detectCategory("我们决定用Python"), "decision");
  });

  it("detects entity patterns", () => {
    assert.strictEqual(detectCategory("my email is test@example.com"), "entity");
    assert.strictEqual(detectCategory("我的名字是小明"), "entity");
  });

  it("detects fact patterns", () => {
    assert.strictEqual(detectCategory("the server is running"), "fact");
    assert.strictEqual(detectCategory("it always has issues"), "fact");
  });

  it("defaults to other", () => {
    assert.strictEqual(detectCategory("hello world"), "other");
  });
});

describe("sanitizeForContext", () => {
  it("escapes newlines", () => {
    assert.strictEqual(sanitizeForContext("line1\nline2"), "line1\\nline2");
  });

  it("strips HTML tags", () => {
    assert.strictEqual(sanitizeForContext("text <b>bold</b>"), "text bold");
  });

  it("replaces angle brackets", () => {
    assert.strictEqual(sanitizeForContext("a < b"), "a \uff1c b");
  });

  it("trims and limits length", () => {
    const long = "a".repeat(500);
    const result = sanitizeForContext(long);
    assert.ok(result.length <= 300);
  });
});
