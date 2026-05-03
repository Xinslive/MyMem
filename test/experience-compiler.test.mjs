import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { runExperienceCompiler } = jiti("../src/experience-compiler.ts");
const { buildSmartMetadata, parseSmartMetadata, stringifySmartMetadata } = jiti("../src/smart-metadata.ts");

function makeEntry({
  id,
  text,
  category = "decision",
  memoryCategory = "cases",
  timestamp,
  scope = "global",
  metadata = {},
}) {
  return {
    id,
    text,
    vector: [0.1],
    category,
    scope,
    importance: 0.8,
    timestamp,
    metadata: stringifySmartMetadata(buildSmartMetadata(
      { text, category, importance: 0.8, timestamp },
      {
        l0_abstract: text,
        l1_overview: `- ${text}`,
        l2_content: text,
        memory_category: memoryCategory,
        confidence: 0.8,
        source: "auto-capture",
        state: "confirmed",
        memory_layer: "working",
        ...metadata,
      },
    )),
  };
}

function createStore(rows) {
  const stored = [];
  const updates = [];
  return {
    stored,
    updates,
    async list() {
      return rows;
    },
    async update(id, patch) {
      updates.push({ id, patch });
      return { id, ...patch };
    },
  };
}

describe("experience compiler", () => {
  it("skips new strategy memories when no existing compiled strategy exists", async () => {
    const now = Date.now();
    const rows = [
      makeEntry({
        id: "case-1",
        text: "Run the failing test first, then patch the parser, then verify with the focused suite.",
        memoryCategory: "cases",
        timestamp: now - 10_000,
        metadata: { source_session: "sess-compiler" },
      }),
      makeEntry({
        id: "event-1",
        text: "The fix is working and the targeted regression test passed.",
        memoryCategory: "events",
        timestamp: now - 5_000,
        metadata: { source_session: "sess-compiler" },
      }),
    ];
    const store = createStore(rows);

    const result = await runExperienceCompiler(
      { store },
      { enabled: true, gatewayBackfill: true, cooldownHours: 6, maxStrategiesPerRun: 3 },
      {
        sessionKey: "sess-compiler",
        conversation: "assistant: Run the failing test first. assistant: Patch the parser. assistant: Verify the focused suite. assistant: The fix is working and passed.",
      },
    );

    assert.equal(result.created, 0);
    assert.equal(result.skipped, 1);
    assert.equal(store.stored.length, 0);
    assert.equal(store.updates.length, 0);
  });

  it("does not create contrastive strategies when failure is recovered in the same session", async () => {
    const now = Date.now();
    const rows = [
      makeEntry({
        id: "case-1",
        text: "The first test failed with a timeout. Rerun with verbose logs, patch the abort guard, then verify the focused suite passed.",
        memoryCategory: "cases",
        timestamp: now - 10_000,
        metadata: { source_session: "sess-mixed" },
      }),
    ];
    const store = createStore(rows);

    const result = await runExperienceCompiler(
      { store },
      { enabled: true, gatewayBackfill: true, cooldownHours: 6, maxStrategiesPerRun: 3 },
      {
        sessionKey: "sess-mixed",
        conversation: "assistant: The first test failed with a timeout. assistant: Rerun with verbose logs. assistant: Patch the abort guard. assistant: Recovered after rerun and the focused suite passed.",
      },
    );

    assert.equal(result.created, 0);
    assert.equal(result.skipped, 1);
    assert.equal(store.stored.length, 0);
  });

  it("does not create preventive reasoning strategies from failure experiences", async () => {
    const now = Date.now();
    const rows = [
      makeEntry({
        id: "case-1",
        text: "The test failed because the hook skipped the retry. Check the abort path and verify the focused regression.",
        memoryCategory: "cases",
        timestamp: now - 10_000,
        metadata: { source_session: "sess-failure" },
      }),
    ];
    const store = createStore(rows);

    const result = await runExperienceCompiler(
      { store },
      { enabled: true, gatewayBackfill: true, cooldownHours: 6, maxStrategiesPerRun: 3 },
      {
        sessionKey: "sess-failure",
        conversation: "assistant: The test failed with a timeout. assistant: Check the abort path. assistant: Verify the focused regression before retrying.",
      },
    );

    assert.equal(result.created, 0);
    assert.equal(result.skipped, 1);
    assert.equal(store.stored.length, 0);
  });

  it("skips compilation when the session ends with strong negative feedback", async () => {
    const now = Date.now();
    const rows = [
      makeEntry({
        id: "case-1",
        text: "Run the failing test first, then patch the parser.",
        memoryCategory: "cases",
        timestamp: now - 10_000,
        metadata: { source_session: "sess-negative" },
      }),
    ];
    const store = createStore(rows);

    const result = await runExperienceCompiler(
      { store },
      { enabled: true, gatewayBackfill: true, cooldownHours: 6, maxStrategiesPerRun: 3 },
      {
        sessionKey: "sess-negative",
        conversation: "user: 这不是我想要的，方向错了。",
      },
    );

    assert.equal(result.created, 0);
    assert.equal(store.stored.length, 0);
  });
});
