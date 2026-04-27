/**
 * Config Utils Test
 *
 * Run: node --test test/config-utils.test.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  resolveEnvVars,
  parsePositiveInt,
  clampInt,
  pruneMapIfOver,
  resolveSourceFromSessionKey,
} = jiti("../src/config-utils.ts");

describe("resolveEnvVars", () => {
  it("resolves simple variable", () => {
    process.env.TEST_VAR = "test-value";
    try {
      assert.strictEqual(resolveEnvVars("${TEST_VAR}"), "test-value");
    } finally {
      delete process.env.TEST_VAR;
    }
  });

  it("resolves multiple variables", () => {
    process.env.FOO = "foo";
    process.env.BAR = "bar";
    try {
      assert.strictEqual(resolveEnvVars("${FOO}-${BAR}"), "foo-bar");
    } finally {
      delete process.env.FOO;
      delete process.env.BAR;
    }
  });

  it("throws for missing variable", () => {
    delete process.env.MISSING_VAR;
    assert.throws(() => resolveEnvVars("${MISSING_VAR}"), /Environment variable MISSING_VAR is not set/);
  });
});

describe("parsePositiveInt", () => {
  it("parses positive number", () => {
    assert.strictEqual(parsePositiveInt(42), 42);
  });

  it("parses positive string", () => {
    assert.strictEqual(parsePositiveInt("100"), 100);
  });

  it("returns undefined for zero", () => {
    assert.strictEqual(parsePositiveInt(0), undefined);
    assert.strictEqual(parsePositiveInt("0"), undefined);
  });

  it("returns undefined for negative", () => {
    assert.strictEqual(parsePositiveInt(-5), undefined);
  });

  it("returns undefined for non-numeric string", () => {
    assert.strictEqual(parsePositiveInt("abc"), undefined);
  });

  it("returns undefined for empty string", () => {
    assert.strictEqual(parsePositiveInt(""), undefined);
  });

  it("floors decimal values", () => {
    assert.strictEqual(parsePositiveInt(3.7), 3);
  });
});

describe("clampInt", () => {
  it("returns value within range", () => {
    assert.strictEqual(clampInt(5, 0, 10), 5);
  });

  it("clamps to minimum", () => {
    assert.strictEqual(clampInt(-5, 0, 10), 0);
  });

  it("clamps to maximum", () => {
    assert.strictEqual(clampInt(15, 0, 10), 10);
  });

  it("floors non-integer values", () => {
    assert.strictEqual(clampInt(5.7, 0, 10), 5);
  });

  it("returns minimum for non-finite values", () => {
    assert.strictEqual(clampInt(NaN, 0, 10), 0);
    assert.strictEqual(clampInt(Infinity, 0, 10), 0);
  });
});

describe("pruneMapIfOver", () => {
  it("does nothing when under limit", () => {
    const map = new Map([["a", 1], ["b", 2]]);
    pruneMapIfOver(map, 10);
    assert.strictEqual(map.size, 2);
  });

  it("prunes to exactly maxEntries", () => {
    const map = new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4]]);
    pruneMapIfOver(map, 2);
    assert.strictEqual(map.size, 2);
  });

  it("keeps newest entries", () => {
    const map = new Map([["a", 1], ["b", 2], ["c", 3]]);
    pruneMapIfOver(map, 2);
    assert.ok(map.has("b"));
    assert.ok(map.has("c"));
  });
});

describe("resolveSourceFromSessionKey", () => {
  it("extracts source from session key", () => {
    assert.strictEqual(resolveSourceFromSessionKey("agent:main:cli:session123"), "cli");
  });

  it("handles undefined", () => {
    assert.strictEqual(resolveSourceFromSessionKey(undefined), "unknown");
  });

  it("handles empty string", () => {
    assert.strictEqual(resolveSourceFromSessionKey(""), "unknown");
  });

  it("handles short session key", () => {
    assert.strictEqual(resolveSourceFromSessionKey("agent:main"), "unknown");
  });
});
