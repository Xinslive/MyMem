import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { registerMemoryStoreTool } = jiti("../src/tools.ts");
const { runImportMarkdown } = jiti("../src/cli/import-markdown.ts");

function createTool(registerTool, context) {
  let creator = null;
  const api = {
    registerTool(factory) {
      creator = factory;
    },
    logger: { info() {}, warn() {}, debug() {} },
  };
  registerTool(api, context);
  assert.equal(typeof creator, "function");
  return creator({});
}

function createContext(overrides = {}) {
  const stored = [];
  const mirrored = [];
  const embeddedTexts = [];
  return {
    stored,
    mirrored,
    embeddedTexts,
    context: {
      agentId: "main",
      workspaceDir: "/tmp",
      mdMirror: async (entry) => {
        mirrored.push(entry);
      },
      scopeManager: {
        getAccessibleScopes: () => ["global"],
        isAccessible: () => true,
        getDefaultScope: () => "global",
      },
      retriever: {
        async retrieve() {
          return [];
        },
        getConfig() {
          return { mode: "hybrid" };
        },
      },
      store: {
        async vectorSearch() {
          return [];
        },
        async store(entry) {
          const storedEntry = {
            id: `stored-${stored.length + 1}`,
            timestamp: Date.now(),
            ...entry,
          };
          stored.push(storedEntry);
          return storedEntry;
        },
        async patchMetadata() {
          return null;
        },
      },
      embedder: {
        async embedPassage(text) {
          embeddedTexts.push(text);
          return [0.1, 0.2, 0.3];
        },
      },
      ...overrides,
    },
  };
}

describe("manual memory write redaction", () => {
  it("redacts secrets before mymem_store embedding, storage, metadata, and mdMirror writes", async () => {
    const harness = createContext();
    const tool = createTool(registerMemoryStoreTool, harness.context);

    const result = await tool.execute(null, {
      text: "Store this API key sk-1234567890abcdefghijklmnop as a lesson",
      category: "patterns",
    });

    assert.equal(result.details.action, "created");
    assert.equal(harness.stored.length, 1);
    assert.equal(harness.mirrored.length, 1);
    assert.equal(harness.embeddedTexts.length, 1);

    const serializedStore = JSON.stringify(harness.stored);
    assert.doesNotMatch(serializedStore, /sk-1234567890abcdefghijklmnop/);
    assert.doesNotMatch(JSON.stringify(harness.mirrored), /sk-1234567890abcdefghijklmnop/);
    assert.doesNotMatch(harness.embeddedTexts[0], /sk-1234567890abcdefghijklmnop/);
    assert.match(serializedStore, /\[REDACTED\]/);
  });

  it("redacts rejected envelope-only mymem_store details", async () => {
    const harness = createContext();
    const tool = createTool(registerMemoryStoreTool, harness.context);

    const result = await tool.execute(null, {
      text: "System: [0] X[y] password:hunter2",
      category: "patterns",
    });

    assert.equal(result.details.action, "envelope_metadata_rejected");
    assert.doesNotMatch(JSON.stringify(result.details), /hunter2/);
    assert.equal(harness.embeddedTexts.length, 0);
    assert.equal(harness.stored.length, 0);
  });

  it("redacts secrets during Markdown import before embedding and storage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mymem-import-redaction-"));
    try {
      const workspace = join(dir, "workspace", "agent-a");
      await mkdir(workspace, { recursive: true });
      await writeFile(
        join(workspace, "MEMORY.md"),
        "- Imported secret token sk-1234567890abcdefghijklmnop should be scrubbed\n",
        "utf8",
      );

      const stored = [];
      const embeddedTexts = [];
      const ctx = {
        embedder: {
          async embedPassage(text) {
            embeddedTexts.push(text);
            return [0.1, 0.2, 0.3];
          },
        },
        store: {
          async store(entry) {
            stored.push(entry);
          },
          async bm25Search() {
            return [];
          },
        },
      };

      const result = await runImportMarkdown(ctx, "agent-a", {
        openclawHome: dir,
        minTextLength: "5",
      });

      assert.equal(result.imported, 1);
      assert.equal(stored.length, 1);
      assert.equal(embeddedTexts.length, 1);
      assert.doesNotMatch(JSON.stringify(stored), /sk-1234567890abcdefghijklmnop/);
      assert.doesNotMatch(embeddedTexts[0], /sk-1234567890abcdefghijklmnop/);
      assert.match(JSON.stringify(stored), /\[REDACTED\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
