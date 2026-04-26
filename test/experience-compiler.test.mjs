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
    async store(entry) {
      const created = { id: `compiled-${stored.length + 1}`, timestamp: Date.now(), ...entry };
      stored.push(created);
      return created;
    },
    async update(id, patch) {
      updates.push({ id, patch });
      return { id, ...patch };
    },
  };
}

describe("experience compiler", () => {
  it("creates strategy-pattern memories only for successful closed loops", async () => {
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
      { store, embedder: { embedPassage: async () => [0.1] } },
      { enabled: true, gatewayBackfill: true, cooldownHours: 6, maxStrategiesPerRun: 3 },
      {
        sessionKey: "sess-compiler",
        conversation: "assistant: Run the failing test first. assistant: Patch the parser. assistant: Verify the focused suite. assistant: The fix is working and passed.",
      },
    );

    assert.equal(result.created, 1);
    const meta = parseSmartMetadata(store.stored[0].metadata, store.stored[0]);
    assert.equal(meta.compiled_strategy, true);
    assert.equal(meta.memory_category, "patterns");
    assert.deepEqual(meta.compiled_from_case_ids, ["case-1", "event-1"]);
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
      { store, embedder: { embedPassage: async () => [0.1] } },
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
