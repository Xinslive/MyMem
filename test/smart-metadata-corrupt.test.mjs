/**
 * Smart Metadata Parse Tests (audit #2)
 *
 * Covers: parseSmartMetadata should surface corrupt JSON instead of silently
 * downgrading important memories to "legacy" category.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  parseSmartMetadata,
  getCorruptMetadataStats,
  resetCorruptMetadataStats,
} = jiti("../src/smart-metadata.ts");

beforeEach(() => {
  resetCorruptMetadataStats();
});

describe("parseSmartMetadata: corrupt observability (audit #2)", () => {
  it("records an entry into the module-level corrupt counter on JSON.parse failure", () => {
    const before = getCorruptMetadataStats();
    parseSmartMetadata("{not valid json", { text: "hello" });
    const after = getCorruptMetadataStats();
    assert.strictEqual(after.count, before.count + 1, "corrupt counter should increment by 1");
    assert.ok(after.lastError, "lastError should be set");
    assert.ok(after.lastError.message.length > 0, "lastError message should be non-empty");
    assert.ok(after.lastError.rawPreview.includes("not valid json"), "rawPreview should include the bad payload");
  });

  it("records a corruption when the JSON is valid but not an object", () => {
    const before = getCorruptMetadataStats();
    parseSmartMetadata("42", { text: "hello" });
    const after = getCorruptMetadataStats();
    assert.strictEqual(after.count, before.count + 1, "non-object JSON should also count as corrupt");
  });

  it("does NOT count well-formed metadata as corrupt", () => {
    const before = getCorruptMetadataStats();
    parseSmartMetadata(JSON.stringify({ summary: "hi", content: "world" }), { text: "fallback" });
    const after = getCorruptMetadataStats();
    assert.strictEqual(after.count, before.count, "valid JSON must not bump the corrupt counter");
  });

  it("flags the parsed object with __corrupt so downstream consumers can detect it", () => {
    const parsed = parseSmartMetadata("{ broken", { text: "x" });
    // The function returns a normalized metadata object; we expect the
    // surface flag to be present so dashboards and the recall pipeline can
    // see that the row was repaired from a broken payload.
    assert.strictEqual(parsed.__corrupt, true, "__corrupt flag should be set on the returned object");
    assert.ok(parsed.__corrupt_raw, "__corrupt_raw should retain the original payload (truncated to 4KB)");
  });

  it("calls a custom onCorrupt callback when supplied", () => {
    let captured = null;
    parseSmartMetadata(
      "this is not json",
      { text: "x" },
      { onCorrupt: (raw, err) => { captured = { raw, error: err }; } },
    );
    assert.ok(captured, "onCorrupt should have been invoked");
    assert.strictEqual(captured.raw, "this is not json");
    assert.ok(captured.error instanceof Error);
  });

  it("does not call onCorrupt for well-formed JSON", () => {
    let called = false;
    parseSmartMetadata(
      JSON.stringify({ summary: "x", content: "y" }),
      { text: "fallback" },
      { onCorrupt: () => { called = true; } },
    );
    assert.strictEqual(called, false, "onCorrupt should not fire on valid JSON");
  });

  it("truncates __corrupt_raw to 4KB so a multi-MB bad payload does not bloat memory", () => {
    const hugeRaw = "x".repeat(20_000);
    const parsed = parseSmartMetadata(hugeRaw, { text: "x" });
    assert.ok(parsed.__corrupt_raw);
    assert.ok(parsed.__corrupt_raw.length < 8_000, "preview should be truncated");
    assert.ok(parsed.__corrupt_raw.endsWith("…"), "truncation should be marked");
  });
});
