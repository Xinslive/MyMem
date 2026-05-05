import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  registerMemoryArchiveTool,
  registerMemoryCompactTool,
  registerMemoryExplainRankTool,
  registerMemoryListTool,
  registerMemoryPromoteTool,
  registerMemoryUpdateTool,
} = jiti("../src/tools.ts");
const {
  buildSmartMetadata,
  parseSmartMetadata,
  stringifySmartMetadata,
} = jiti("../src/smart-metadata.ts");

function createToolSet(context) {
  const creators = new Map();
  const api = {
    registerTool(factory, meta) {
      creators.set(meta.name, factory);
    },
    logger: { info() {}, warn() {}, debug() {} },
  };
  registerMemoryPromoteTool(api, context);
  registerMemoryArchiveTool(api, context);
  registerMemoryCompactTool(api, context);
  registerMemoryExplainRankTool(api, context);
  registerMemoryListTool(api, context);
  registerMemoryUpdateTool(api, context);
  return {
    get(name) {
      const factory = creators.get(name);
      assert.ok(factory, `tool ${name} should be registered`);
      return factory({});
    },
  };
}

describe("memory governance tools", () => {
  it("promotes and archives memory entries", async () => {
    const entries = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        text: "remember coffee preference",
        category: "fact",
        scope: "global",
        importance: 0.7,
        timestamp: Date.now(),
        metadata: JSON.stringify({ summary: "remember coffee preference", state: "pending", source: "auto-capture", memory_layer: "working" }),
      },
    ];

    const patchCalls = [];
    const context = {
      agentId: "main",
      workspaceDir: "/tmp",
      mdMirror: null,
      scopeManager: {
        getAccessibleScopes: () => ["global"],
        isAccessible: () => true,
        getDefaultScope: () => "global",
      },
      retriever: {
        async retrieve({ query, limit }) {
          if (query.includes("coffee")) {
            return [
              {
                entry: entries[0],
                score: 0.9,
                sources: { vector: { score: 0.9, rank: 1 } },
              },
            ].slice(0, limit);
          }
          return [];
        },
        getConfig() {
          return { mode: "hybrid" };
        },
      },
      store: {
        async patchMetadata(id, patch) {
          patchCalls.push({ id, patch });
          return entries.find((e) => e.id === id) ?? null;
        },
        async patchMetadataBatch(batch) {
          for (const { id, patch } of batch) patchCalls.push({ id, patch });
          return batch.length;
        },
        async getById(id) {
          return entries.find((e) => e.id === id) ?? null;
        },
        async list() {
          return entries;
        },
      },
      embedder: { async embedPassage() { return [0.1, 0.2, 0.3]; } },
    };

    const tools = createToolSet(context);
    const promote = tools.get("mymem_promote");
    const archive = tools.get("mymem_archive");

    const promoteRes = await promote.execute(null, { query: "coffee" });
    assert.match(promoteRes.content[0].text, /Promoted memory/);

    const archiveRes = await archive.execute(null, { query: "coffee", reason: "stale" });
    assert.match(archiveRes.content[0].text, /Archived memory/);

    assert.equal(patchCalls.length, 2);
    assert.equal(patchCalls[0].patch.state, "confirmed");
    assert.equal(patchCalls[0].patch.memory_layer, "durable");
    assert.ok(patchCalls[0].patch.utility_score > 0.5);
    assert.equal(patchCalls[1].patch.state, "archived");
    assert.equal(patchCalls[1].patch.memory_layer, "archive");
  });

  it("provides compaction preview and rank explanation", async () => {
    const now = Date.now();
    const entries = [
      {
        id: "a1111111-1111-4111-8111-111111111111",
        text: "Use tavily first",
        category: "fact",
        scope: "global",
        importance: 0.7,
        timestamp: now,
        metadata: JSON.stringify({ summary: "Use tavily first", memory_category: "cases", state: "confirmed", source: "manual", memory_layer: "working" }),
      },
      {
        id: "b2222222-2222-4222-8222-222222222222",
        text: "Use tavily first",
        category: "fact",
        scope: "global",
        importance: 0.6,
        timestamp: now - 1000,
        metadata: JSON.stringify({ summary: "Use tavily first", memory_category: "cases", state: "confirmed", source: "manual", memory_layer: "working" }),
      },
    ];

    const context = {
      agentId: "main",
      workspaceDir: "/tmp",
      mdMirror: null,
      scopeManager: {
        getAccessibleScopes: () => ["global"],
        isAccessible: () => true,
        getDefaultScope: () => "global",
      },
      retriever: {
        async retrieve() {
          return [
            {
              entry: entries[0],
              score: 0.88,
              sources: {
                vector: { score: 0.88, rank: 1 },
                bm25: { score: 0.73, rank: 2 },
              },
            },
          ];
        },
        getConfig() {
          return { mode: "hybrid" };
        },
      },
      store: {
        async patchMetadata() { return entries[0]; },
        async getById(id) { return entries.find((e) => e.id === id) ?? null; },
        async list() { return entries; },
      },
      embedder: { async embedPassage() { return [0.1, 0.2, 0.3]; } },
    };

    const tools = createToolSet(context);
    const compact = tools.get("mymem_compact");
    const explain = tools.get("mymem_explain_rank");

    const compactRes = await compact.execute(null, { dryRun: true });
    assert.match(compactRes.content[0].text, /Compaction preview/);
    assert.equal(compactRes.details.duplicates, 1);

    const explainRes = await explain.execute(null, { query: "tavily", limit: 3 });
    assert.match(explainRes.content[0].text, /state=confirmed/);
    assert.match(explainRes.content[0].text, /layer=working/);
  });

  it("lists by smart memory_category and rejects legacy list categories", async () => {
    const entries = [
      {
        id: "p1111111-1111-4111-8111-111111111111",
        text: "Prefer concise answers",
        category: "preference",
        scope: "global",
        importance: 0.8,
        timestamp: Date.now(),
        metadata: JSON.stringify({ summary: "Prefer concise answers", memory_category: "preferences" }),
      },
      {
        id: "c2222222-2222-4222-8222-222222222222",
        text: "Debugged the cache issue",
        category: "fact",
        scope: "global",
        importance: 0.7,
        timestamp: Date.now() - 1000,
        metadata: JSON.stringify({ summary: "Debugged the cache issue", memory_category: "cases" }),
      },
    ];

    const context = {
      agentId: "main",
      workspaceDir: "/tmp",
      mdMirror: null,
      scopeManager: {
        getAccessibleScopes: () => ["global"],
        isAccessible: () => true,
        getDefaultScope: () => "global",
      },
      retriever: {
        async retrieve() { return []; },
        getConfig() { return { mode: "hybrid" }; },
      },
      store: {
        async list() { return entries; },
      },
      embedder: { async embedPassage() { return [0.1, 0.2, 0.3]; } },
    };

    const list = createToolSet(context).get("mymem_list");
    const filtered = await list.execute(null, { category: "preferences" });
    assert.equal(filtered.details.count, 1);
    assert.equal(filtered.details.memories[0].id, entries[0].id);
    assert.equal(filtered.details.memories[0].category, "preferences:global");

    const rejected = await list.execute(null, { category: "preference" });
    assert.equal(rejected.details.error, "invalid_category");
  });

  it("updates smart memory_category while deriving the storage category", async () => {
    const entry = {
      id: "11111111-2222-4333-8444-555555555555",
      text: "Use tavily first",
      vector: [0.1, 0.2, 0.3],
      category: "fact",
      scope: "global",
      importance: 0.7,
      timestamp: Date.now(),
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          { text: "Use tavily first", category: "fact", importance: 0.7 },
          {
            summary: "Use tavily first",
            content: "Use tavily first",
            memory_category: "cases",
          },
        ),
      ),
    };

    const context = {
      agentId: "main",
      workspaceDir: "/tmp",
      mdMirror: null,
      scopeManager: {
        getAccessibleScopes: () => ["global"],
        isAccessible: () => true,
        getDefaultScope: () => "global",
      },
      retriever: {
        async retrieve() { return []; },
        getConfig() { return { mode: "hybrid" }; },
      },
      store: {
        async count() { return 1; },
        async getById() { return entry; },
        async update(_id, updates) {
          Object.assign(entry, updates);
          return entry;
        },
      },
      embedder: { async embedPassage() { return [0.1, 0.2, 0.3]; } },
    };

    const update = createToolSet(context).get("mymem_update");
    const updated = await update.execute(null, { memoryId: entry.id, category: "patterns" });
    assert.equal(updated.details.action, "updated");
    assert.equal(updated.details.category, "other");
    assert.equal(parseSmartMetadata(entry.metadata, entry).memory_category, "patterns");

    const rejected = await update.execute(null, { memoryId: entry.id, category: "other" });
    assert.equal(rejected.details.error, "invalid_category");
  });
});
