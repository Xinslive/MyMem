import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { runPreferenceDistiller } = jiti("../src/preference-distiller.ts");
const { buildSmartMetadata, parseSmartMetadata, stringifySmartMetadata } = jiti("../src/smart-metadata.ts");

function makeEntry({
  id,
  text,
  category = "preference",
  memoryCategory = "preferences",
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
        source: "manual",
        state: "confirmed",
        memory_layer: memoryCategory === "preferences" ? "durable" : "working",
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

describe("preference distiller", () => {
  it("distills repeated preferences into a single stable rule", async () => {
    const now = Date.now();
    const rows = [
      makeEntry({
        id: "pref-1",
        text: "Keep responses concise and direct.",
        timestamp: now - 10_000,
        metadata: { source_session: "sess-1", source_reason: "self_correction" },
      }),
      makeEntry({
        id: "pref-2",
        text: "Keep responses concise and direct.",
        timestamp: now - 5_000,
        metadata: { source_session: "sess-2" },
      }),
    ];
    const store = createStore(rows);

    const result = await runPreferenceDistiller(
      { store },
      { enabled: true, maxRulesPerRun: 5, minEvidenceCount: 2, minStabilityScore: 0.6, maxSessions: 12, gatewayBackfill: true, cooldownHours: 6 },
    );

    assert.equal(result.updated, 1);
    assert.equal(store.stored.length, 0);
    const patched = store.updates[0];
    const meta = parseSmartMetadata(patched.patch.metadata, rows[1]);
    assert.equal(meta.source_reason, "preference_distiller");
    assert.equal(meta.evidence_count, 2);
    assert.equal(meta.memory_category, "preferences");
  });

  it("supersedes conflicting older rules instead of leaving both active", async () => {
    const now = Date.now();
    const rows = [
      makeEntry({
        id: "old-1",
        text: "Use multiple agents by default.",
        category: "other",
        memoryCategory: "patterns",
        timestamp: now - 20_000,
        metadata: { source_session: "sess-1", canonical_id: "workflow:single-agent-opposite", confidence: 0.65 },
      }),
      makeEntry({
        id: "new-evidence-1",
        text: "Do not use multiple agents unless the user explicitly asks for delegation.",
        category: "other",
        memoryCategory: "patterns",
        timestamp: now - 10_000,
        metadata: { source_session: "sess-2", source_reason: "self_correction" },
      }),
      makeEntry({
        id: "new-evidence-2",
        text: "Do not use multiple agents unless the user explicitly asks for delegation.",
        category: "other",
        memoryCategory: "patterns",
        timestamp: now - 5_000,
        metadata: { source_session: "sess-3" },
      }),
    ];
    const store = createStore(rows);

    const result = await runPreferenceDistiller(
      { store },
      { enabled: true, maxRulesPerRun: 5, minEvidenceCount: 2, minStabilityScore: 0.6, maxSessions: 12, gatewayBackfill: true, cooldownHours: 6 },
    );

    assert.equal(result.updated, 1);
    assert.equal(result.superseded, 1);
    assert.equal(store.stored.length, 0);
    assert.equal(store.updates.some((item) => item.id === "old-1"), true);
  });
});
