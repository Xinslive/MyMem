import assert from "node:assert/strict";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { buildSmartMetadata, parseSmartMetadata, toLifecycleMemory } = jiti("../src/smart-metadata.ts");
const { createDecayEngine, DEFAULT_DECAY_CONFIG } = jiti("../src/decay-engine.ts");
const { createTierManager, DEFAULT_TIER_CONFIG } = jiti("../src/tier-manager.ts");
const { createRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");
const { runLifecycleMaintenance } = jiti("../src/lifecycle-maintainer.ts");

const now = Date.now();

const legacyEntry = {
  id: "legacy-1",
  text: "My preferred editor is Neovim and I use it every day.",
  category: "preference",
  scope: "global",
  importance: 0.8,
  timestamp: now - 10 * 86_400_000,
  metadata: "{}",
};

const normalized = parseSmartMetadata(legacyEntry.metadata, legacyEntry);
assert.equal(normalized.memory_category, "preferences");
assert.equal(normalized.tier, "working");
assert.equal(normalized.access_count, 0);
assert.equal(normalized.l0_abstract, legacyEntry.text);

const strongEntry = {
  id: "strong-1",
  text: "Use PostgreSQL for the billing service architecture decision.",
  vector: [1, 0],
  category: "decision",
  scope: "global",
  importance: 0.95,
  timestamp: now - 45 * 86_400_000,
  metadata: JSON.stringify(
    buildSmartMetadata(
      {
        text: "Use PostgreSQL for the billing service architecture decision.",
        category: "decision",
        importance: 0.95,
        timestamp: now - 45 * 86_400_000,
      },
      {
        memory_category: "events",
        tier: "working",
        confidence: 0.95,
        access_count: 12,
        last_accessed_at: now - 1 * 86_400_000,
      },
    ),
  ),
};

const staleEntry = {
  id: "stale-1",
  text: "Temporary note about a deprecated staging host.",
  vector: [0, 1],
  category: "other",
  scope: "global",
  importance: 0.2,
  timestamp: now - 120 * 86_400_000,
  metadata: JSON.stringify(
    buildSmartMetadata(
      {
        text: "Temporary note about a deprecated staging host.",
        category: "other",
        importance: 0.2,
        timestamp: now - 120 * 86_400_000,
      },
      {
        memory_category: "patterns",
        tier: "working",
        confidence: 0.4,
        access_count: 0,
        last_accessed_at: now - 120 * 86_400_000,
      },
    ),
  ),
};

const decayEngine = createDecayEngine(DEFAULT_DECAY_CONFIG);
const tierManager = createTierManager(DEFAULT_TIER_CONFIG);

const memories = [
  toLifecycleMemory(strongEntry.id, strongEntry),
  toLifecycleMemory(staleEntry.id, staleEntry),
];
const scores = decayEngine.scoreAll(memories, now);
const transitions = tierManager.evaluateAll(memories, scores, now);

assert.ok(
  transitions.some((t) => t.memoryId === strongEntry.id && t.toTier === "core"),
  "high-access high-importance memory should promote to core",
);
assert.ok(
  transitions.some((t) => t.memoryId === staleEntry.id && t.toTier === "peripheral"),
  "stale low-value working memory should demote to peripheral",
);

const fakeStore = {
  hasFtsSupport: true,
  async vectorSearch() {
    return [
      { entry: staleEntry, score: 0.72 },
      { entry: strongEntry, score: 0.72 },
    ];
  },
  async bm25Search() {
    return [
      { entry: staleEntry, score: 0.82 },
      { entry: strongEntry, score: 0.82 },
    ];
  },
  async hasId() {
    return true;
  },
  async update() {
    return null;
  },
};

const fakeEmbedder = {
  async embedQuery() {
    return [1, 0];
  },
};

const retriever = createRetriever(
  fakeStore,
  fakeEmbedder,
  {
    ...DEFAULT_RETRIEVAL_CONFIG,
    filterNoise: false,
    rerank: "none",
    minScore: 0.1,
    hardMinScore: 0.1,
  },
  { decayEngine },
);

const results = await retriever.retrieve({
  query: "billing service architecture",
  limit: 5,
  scopeFilter: ["global"],
});

assert.equal(results.length, 2);
assert.equal(
  results[0].entry.id,
  strongEntry.id,
  "decay-aware retrieval should rank reinforced memory above stale memory",
);

const freshWorkingEntry = {
  id: "fresh-working-1",
  text: "Work scope secret is beta-work-852.",
  vector: [1, 0],
  category: "fact",
  scope: "agent:work",
  importance: 0.93,
  timestamp: now,
  metadata: JSON.stringify(
    buildSmartMetadata(
      {
        text: "Work scope secret is beta-work-852.",
        category: "fact",
        importance: 0.93,
        timestamp: now,
      },
      {
        memory_category: "facts",
        tier: "working",
        confidence: 1,
        access_count: 0,
        last_accessed_at: now,
      },
    ),
  ),
};

const freshStore = {
  hasFtsSupport: true,
  async vectorSearch() {
    return [{ entry: freshWorkingEntry, score: 0.6924 }];
  },
  async bm25Search() {
    return [{ entry: freshWorkingEntry, score: 0.5163 }];
  },
  async hasId() {
    return true;
  },
  async update() {
    return null;
  },
};

const freshRetriever = createRetriever(
  freshStore,
  fakeEmbedder,
  {
    ...DEFAULT_RETRIEVAL_CONFIG,
    filterNoise: false,
    rerank: "none",
    minScore: 0.6,
    hardMinScore: 0.62,
  },
  { decayEngine },
);

const freshResults = await freshRetriever.retrieve({
  query: "beta-work-852",
  limit: 5,
  scopeFilter: ["agent:work"],
});

assert.equal(
  freshResults.length,
  1,
  "fresh working-tier memories should survive decay + hardMinScore filtering",
);

const expiredEntry = {
  id: "expired-1",
  text: "Temporary launch code expires after the January rehearsal.",
  vector: [0, 1],
  category: "decision",
  scope: "global",
  importance: 0.2,
  timestamp: now - 90 * 86_400_000,
  metadata: JSON.stringify(
    buildSmartMetadata(
      {
        text: "Temporary launch code expires after the January rehearsal.",
        category: "decision",
        importance: 0.2,
        timestamp: now - 90 * 86_400_000,
      },
      {
        memory_category: "events",
        tier: "peripheral",
        confidence: 0.4,
        access_count: 0,
        last_accessed_at: now - 90 * 86_400_000,
        valid_until: now - 1_000,
      },
    ),
  ),
};

const promoteEntry = {
  ...strongEntry,
  id: "promote-1",
};

const lifecycleUpdates = new Map();
const lifecycleDeletes = [];
const lifecycleStore = {
  async list() {
    return [expiredEntry, promoteEntry];
  },
  async update(id, patch) {
    lifecycleUpdates.set(id, patch);
    return { id, ...patch };
  },
  async delete(id) {
    lifecycleDeletes.push(id);
    return true;
  },
};

const lifecycleResult = await runLifecycleMaintenance(
  { store: lifecycleStore, decayEngine, tierManager },
  { enabled: true, maxMemoriesToScan: 10, cooldownHours: 1, archiveThreshold: 0.2, dryRun: false },
);

assert.equal(lifecycleResult.scanned, 2);
assert.equal(lifecycleResult.archived, 1);
assert.equal(lifecycleResult.deleted, 0);
assert.equal(lifecycleResult.promoted, 1);

const archivedMeta = parseSmartMetadata(lifecycleUpdates.get(expiredEntry.id).metadata, expiredEntry);
assert.equal(archivedMeta.state, "archived");
assert.equal(archivedMeta.memory_layer, "archive");
assert.equal(archivedMeta.archive_reason, "expired");

const promotedMeta = parseSmartMetadata(lifecycleUpdates.get(promoteEntry.id).metadata, promoteEntry);
assert.equal(promotedMeta.tier, "core");

const deleteOnlyStore = {
  async list() {
    return [expiredEntry];
  },
  async update() {
    throw new Error("delete mode should not archive expired memories");
  },
  async delete(id) {
    lifecycleDeletes.push(`delete-mode:${id}`);
    return true;
  },
};

const deleteResult = await runLifecycleMaintenance(
  { store: deleteOnlyStore, decayEngine, tierManager },
  { enabled: true, maxMemoriesToScan: 10, cooldownHours: 1, archiveThreshold: 0.2, dryRun: false, deleteMode: "delete" },
);

assert.equal(deleteResult.scanned, 1);
assert.equal(deleteResult.deleted, 1);
assert.equal(deleteResult.archived, 0);
assert.equal(deleteResult.deleteReasons.expired, 1);
assert.ok(lifecycleDeletes.includes(`delete-mode:${expiredEntry.id}`));

const oldPreference = {
  id: "pref-old",
  text: "Use multiple agents by default.",
  vector: [0.2, 0.4],
  category: "other",
  scope: "global",
  importance: 0.75,
  timestamp: now - 60 * 86_400_000,
  metadata: JSON.stringify(
    buildSmartMetadata(
      {
        text: "Use multiple agents by default.",
        category: "other",
        importance: 0.75,
        timestamp: now - 60 * 86_400_000,
      },
      {
        memory_category: "patterns",
        confidence: 0.7,
        canonical_id: "workflow:single-agent-opposite",
      },
    ),
  ),
};

const newPreference = {
  id: "pref-new",
  text: "Do not use multiple agents unless the user explicitly asks for delegation.",
  vector: [0.2, 0.5],
  category: "other",
  scope: "global",
  importance: 0.82,
  timestamp: now - 5 * 86_400_000,
  metadata: JSON.stringify(
    buildSmartMetadata(
      {
        text: "Do not use multiple agents unless the user explicitly asks for delegation.",
        category: "other",
        importance: 0.82,
        timestamp: now - 5 * 86_400_000,
      },
      {
        memory_category: "patterns",
        confidence: 0.92,
        canonical_id: "workflow:single-agent",
      },
    ),
  ),
};

const contradictionUpdates = new Map();
const contradictionStore = {
  async list() {
    return [oldPreference, newPreference];
  },
  async update(id, patch) {
    contradictionUpdates.set(id, patch);
    return { id, ...patch };
  },
  async delete() {
    throw new Error("contradiction pruning should archive, not delete, by default");
  },
};

const contradictionResult = await runLifecycleMaintenance(
  { store: contradictionStore, decayEngine, tierManager },
  { enabled: true, maxMemoriesToScan: 10, cooldownHours: 1, archiveThreshold: 0.2, dryRun: false, phase: "prune" },
);

assert.equal(contradictionResult.archived, 1);
const contradictedMeta = parseSmartMetadata(contradictionUpdates.get(oldPreference.id).metadata, oldPreference);
assert.equal(contradictedMeta.state, "archived");
assert.equal(contradictedMeta.prune_reason, "contradiction_newer_version");
assert.equal(contradictedMeta.superseded_by, newPreference.id);

console.log("OK: smart memory lifecycle test passed");
