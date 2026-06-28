import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  handleContextualize,
  handleContradict,
  handleProfileMerge,
  handleSupersede,
  mapToStoreCategory,
  storeCandidate,
} = jiti("../src/smart-extractor-handlers.ts");
const { buildSmartMetadata, stringifySmartMetadata } = jiti("../src/smart-metadata.ts");

const SECRET = "hunter2-please-rotate-q1-2026";

function makeCandidate(overrides = {}) {
  return {
    category: "events",
    abstract: `数据库密码：${SECRET}`,
    content: `用户提到数据库密码：${SECRET}，需要轮换。`,
    worth_storing: true,
    ...overrides,
  };
}

function makeContext(existing = null) {
  const stored = [];
  const updates = [];
  const logs = [];
  const existingEntry = existing ?? {
    id: "01234567-89ab-cdef-0123-456789abcdef",
    text: "旧事件记忆",
    vector: [0.5, 0.5, 0.5, 0.5],
    category: "decision",
    scope: "global",
    importance: 0.6,
    timestamp: Date.now(),
    metadata: stringifySmartMetadata(buildSmartMetadata(
      { text: "旧事件记忆", category: "decision" },
      { summary: "旧事件记忆", content: "旧内容", memory_category: "events" },
    )),
  };

  return {
    stored,
    updates,
    ctx: {
      store: {
        async getById() {
          return existingEntry;
        },
        async vectorSearch() {
          return [];
        },
        async store(entry) {
          const created = { id: "11111111-2222-3333-4444-555555555555", ...entry };
          stored.push(created);
          return created;
        },
        async update(id, patch, scopeFilter) {
          updates.push({ id, patch, scopeFilter });
          return { ...existingEntry, ...patch };
        },
      },
      embedder: {
        async embed() {
          return [0.1, 0.2, 0.3, 0.4];
        },
      },
      llm: {
        async completeJson() {
          return null;
        },
      },
      log: {
        warn(message) { logs.push(String(message)); },
        info(message) { logs.push(String(message)); },
      },
      admissionController: null,
      persistAdmissionAudit: true,
      mapToStoreCategory,
      getDefaultImportance() {
        return 0.7;
      },
      async recordRejectedAdmission() {},
    },
    logs,
  };
}

function assertStoredEntryRedacted(entry) {
  assert.ok(entry, "expected a stored entry");
  assert.ok(!entry.text.includes(SECRET), "stored text must not contain the secret");
  assert.ok(entry.text.includes("[REDACTED]"), "stored text should keep a redaction marker");

  const metadata = JSON.parse(entry.metadata);
  assert.ok(!metadata.summary.includes(SECRET), "metadata summary must not contain the secret");
  assert.ok(!metadata.content.includes(SECRET), "metadata content must not contain the secret");
  assert.ok(metadata.summary.includes("[REDACTED]"));
  assert.ok(metadata.content.includes("[REDACTED]"));
}

describe("smart-extractor handler redaction", () => {
  it("redacts new-memory log previews", async () => {
    const { ctx, logs } = makeContext();
    await storeCandidate(
      ctx,
      makeCandidate(),
      [0.1, 0.2, 0.3, 0.4],
      "session-1",
      "global",
    );

    const serializedLogs = logs.join("\n");
    assert.doesNotMatch(serializedLogs, new RegExp(SECRET));
    assert.match(serializedLogs, /\[REDACTED\]/);
  });

  it("redacts profile admission rejection log previews", async () => {
    const { ctx, logs } = makeContext();
    ctx.admissionController = {
      async evaluate() {
        return {
          decision: "reject",
          audit: {
            decision: "reject",
            reason: "low utility",
          },
        };
      },
    };

    const result = await handleProfileMerge(
      ctx,
      makeCandidate({ category: "profile" }),
      "conversation",
      "session-1",
      "global",
      ["global"],
    );

    assert.equal(result, "rejected");
    const serializedLogs = logs.join("\n");
    assert.doesNotMatch(serializedLogs, new RegExp(SECRET));
    assert.match(serializedLogs, /\[REDACTED\]/);
  });

  it("redacts supersede entries before storing text and metadata", async () => {
    const { ctx, stored } = makeContext();
    await handleSupersede(
      ctx,
      makeCandidate(),
      [0.1, 0.2, 0.3, 0.4],
      "01234567-89ab-cdef-0123-456789abcdef",
      "session-1",
      "global",
      ["global"],
    );

    assertStoredEntryRedacted(stored[0]);
  });

  it("redacts contextualized entries before storing text and metadata", async () => {
    const { ctx, stored } = makeContext();
    await handleContextualize(
      ctx,
      makeCandidate(),
      [0.1, 0.2, 0.3, 0.4],
      "01234567-89ab-cdef-0123-456789abcdef",
      "session-1",
      "global",
      ["global"],
      "project",
    );

    assertStoredEntryRedacted(stored[0]);
  });

  it("redacts contradicting entries before storing text and metadata", async () => {
    const { ctx, stored } = makeContext();
    await handleContradict(
      ctx,
      makeCandidate(),
      [0.1, 0.2, 0.3, 0.4],
      "01234567-89ab-cdef-0123-456789abcdef",
      "session-1",
      "global",
      ["global"],
      "project",
    );

    assertStoredEntryRedacted(stored[0]);
  });
});
