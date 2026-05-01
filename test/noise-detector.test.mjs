/**
 * Unit tests for src/noise-detector.ts
 *
 * Run: node --test test/noise-detector.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  HybridNoiseDetector,
  NoisePrototypeBank,
} = jiti("../src/noise-detector.ts");

// Get the noise-filter's isNoise function for comparison tests
const { isNoise: isNoiseFromFilter } = jiti("../src/noise-filter.ts");

// ============================================================================
// Regex-only Detection Tests
// ============================================================================

describe("HybridNoiseDetector - Regex Detection", () => {
  describe("isNoiseRegex (from noise-filter)", () => {
    it("detects denial patterns", () => {
      assert.equal(isNoiseFromFilter("I don't have any information about that"), true);
      assert.equal(isNoiseFromFilter("I'm not sure about that"), true);
      assert.equal(isNoiseFromFilter("I don't recall"), true);
      assert.equal(isNoiseFromFilter("I don't remember"), true);
      assert.equal(isNoiseFromFilter("It looks like I don't have that"), true);
      assert.equal(isNoiseFromFilter("No relevant memories found"), true);
    });

    it("detects meta-question patterns", () => {
      assert.equal(isNoiseFromFilter("Do you remember what I told you?"), true);
      assert.equal(isNoiseFromFilter("Can you recall my preferences?"), true);
      assert.equal(isNoiseFromFilter("Did I tell you about that?"), true);
      assert.equal(isNoiseFromFilter("Have I mentioned this before?"), true);
      assert.equal(isNoiseFromFilter("What did I say about that?"), true);
      // Chinese patterns
      assert.equal(isNoiseFromFilter("你还记得我喜欢什么吗"), true);
      assert.equal(isNoiseFromFilter("记不记得我说过的话"), true);
      assert.equal(isNoiseFromFilter("还记得吗"), true);
    });

    it("detects boilerplate patterns", () => {
      assert.equal(isNoiseFromFilter("Hello, how are you?"), true);
      assert.equal(isNoiseFromFilter("Hi there!"), true);
      assert.equal(isNoiseFromFilter("Good morning!"), true);
      assert.equal(isNoiseFromFilter("Hey"), true);
      assert.equal(isNoiseFromFilter("Fresh session"), true);
      assert.equal(isNoiseFromFilter("New session"), true);
      assert.equal(isNoiseFromFilter("HEARTBEAT"), true);
    });

    it("detects diagnostic artifact patterns", () => {
      assert.equal(isNoiseFromFilter("query -> none"), true);
      assert.equal(isNoiseFromFilter("user asked for no explicit solution"), true);
    });

    it("allows valid memory content", () => {
      assert.equal(isNoiseFromFilter("User prefers dark mode theme"), false);
      assert.equal(isNoiseFromFilter("The project uses TypeScript for type safety"), false);
      assert.equal(isNoiseFromFilter("I like coffee in the morning"), false);
      assert.equal(isNoiseFromFilter("Remember to review the PR before merging"), false);
    });

    it("rejects very short texts", () => {
      assert.equal(isNoiseFromFilter("Hi"), true);
      assert.equal(isNoiseFromFilter("Yes"), true);
      assert.equal(isNoiseFromFilter("Ok"), true);
      assert.equal(isNoiseFromFilter("Done"), true);
    });
  });
});

// ============================================================================
// HybridNoiseDetector Instance Tests
// ============================================================================

describe("HybridNoiseDetector - Instance", () => {
  it("creates with embedder for full capabilities", () => {
    // No embedder = regex-only mode
    const detector = new HybridNoiseDetector(null, undefined, {
      learnFromRegex: false,
    });
    assert.equal(detector.hasEmbeddingSupport, false);
  });

  it("hasEmbeddingSupport returns false without initialization", () => {
    const detector = new HybridNoiseDetector(null, undefined);
    assert.equal(detector.hasEmbeddingSupport, false);
  });

  it("isEnvelopeNoise detects envelope patterns", () => {
    const detector = new HybridNoiseDetector(null, undefined);
    assert.equal(detector.isEnvelopeNoise("<<<EXTERNAL_UNTRUSTED_CONTENT\nsome content"), true);
    assert.equal(detector.isEnvelopeNoise("Sender (untrusted metadata): John"), true);
    assert.equal(detector.isEnvelopeNoise("Normal memory content"), false);
  });

  it("check() returns detailed result for regex noise", async () => {
    const detector = new HybridNoiseDetector(null, undefined, {
      learnFromRegex: false, // Disable learning for this test
    });

    const result = await detector.check("I don't have any information about that");
    assert.equal(result.isNoise, true);
    assert.ok(result.detectionMethods.includes("regex"));
    assert.equal(result.regexMatch, "denial");
  });

  it("check() returns clean result for valid content", async () => {
    const detector = new HybridNoiseDetector(null, undefined, {
      learnFromRegex: false,
    });

    const result = await detector.check("User prefers dark mode theme");
    assert.equal(result.isNoise, false);
    assert.equal(result.detectionMethods.length, 0);
  });

  it("checkBatch() processes multiple texts", async () => {
    const detector = new HybridNoiseDetector(null, undefined, {
      learnFromRegex: false,
    });

    const results = await detector.checkBatch([
      "I don't remember anything",
      "User likes coffee",
      "Do you recall my preferences?",
    ]);

    assert.equal(results.length, 3);
    assert.equal(results[0].isNoise, true);
    assert.equal(results[1].isNoise, false);
    assert.equal(results[2].isNoise, true);
  });

  it("checkBatch() uses batch embeddings for non-regex texts", async () => {
    const calls = [];
    const embedder = {
      embed: async () => {
        throw new Error("single embed should not be used for batch checks");
      },
      embedBatch: async (texts) => {
        calls.push(texts);
        return texts.map((_, index) => [index + 1, 0, 0]);
      },
    };
    const noiseBank = {
      initialized: true,
      isNoise: (vector) => vector[0] === 2,
      learn: () => {},
    };
    const detector = new HybridNoiseDetector(embedder, noiseBank, {
      learnFromRegex: false,
    });

    const results = await detector.checkBatch([
      "User likes coffee",
      "Project uses TypeScript",
    ]);

    assert.deepEqual(calls, [["User likes coffee", "Project uses TypeScript"]]);
    assert.equal(results[0].isNoise, false);
    assert.equal(results[1].isNoise, true);
    assert.deepEqual(results[1].detectionMethods, ["embedding"]);
  });

  it("checkBatch() learns duplicate regex hits once through batch embeddings", async () => {
    const embedBatchCalls = [];
    const learned = [];
    const embedder = {
      embed: async () => {
        throw new Error("single embed should not be used for batch regex learning");
      },
      embedBatch: async (texts) => {
        embedBatchCalls.push(texts);
        return texts.map(() => [1, 0, 0]);
      },
    };
    const noiseBank = {
      initialized: true,
      size: 5,
      isNoise: () => false,
      maxSimilarity: () => 0.1,
      learn: (vector) => {
        learned.push(vector);
      },
    };
    const detector = new HybridNoiseDetector(embedder, noiseBank, {
      regexLearningTtlMs: 600_000,
    });

    const results = await detector.checkBatch([
      "I don't remember anything",
      "I don't remember anything",
    ]);

    assert.equal(results[0].isNoise, true);
    assert.equal(results[1].isNoise, true);
    assert.deepEqual(embedBatchCalls, [["I don't remember anything"]]);
    assert.equal(learned.length, 1);
  });

  it("checkBatch() gates low-similarity regex learning when the bank is established", async () => {
    const learned = [];
    const embedder = {
      embed: async () => [0, 1, 0],
      embedBatch: async (texts) => texts.map(() => [0, 1, 0]),
    };
    const noiseBank = {
      initialized: true,
      size: 25,
      isNoise: () => false,
      maxSimilarity: () => 0.2,
      learn: (vector) => {
        learned.push(vector);
      },
    };
    const detector = new HybridNoiseDetector(embedder, noiseBank);

    const results = await detector.checkBatch(["Do you remember what I told you?"]);

    assert.equal(results[0].isNoise, true);
    assert.deepEqual(results[0].detectionMethods, ["regex"]);
    assert.equal(learned.length, 0);
  });

  it("checkBatch() still returns regex detections when regex learning embeddings fail", async () => {
    const debugLogs = [];
    const embedder = {
      embed: async () => {
        throw new Error("single embed should not be used");
      },
      embedBatch: async () => {
        throw new Error("embedding outage");
      },
    };
    const noiseBank = {
      initialized: true,
      size: 5,
      isNoise: () => false,
      maxSimilarity: () => 1,
      learn: () => {
        throw new Error("learn should not be called after embed failure");
      },
    };
    const detector = new HybridNoiseDetector(embedder, noiseBank, {
      debugLog: (message) => debugLogs.push(message),
    });

    const results = await detector.checkBatch([
      "I don't have any information about that",
      "Do you remember my preference?",
    ]);

    assert.deepEqual(results.map((result) => result.isNoise), [true, true]);
    assert.ok(debugLogs.some((line) => line.includes("failed to learn regex noise batch")));
  });

  it("filter() removes noise items from array", async () => {
    const detector = new HybridNoiseDetector(null, undefined, {
      learnFromRegex: false,
    });

    const items = [
      { id: 1, text: "I don't have any memory" },
      { id: 2, text: "User prefers dark mode" },
      { id: 3, text: "Do you remember?" },
      { id: 4, text: "Project uses TypeScript" },
    ];

    const filtered = await detector.filter(items, (item) => item.text);

    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].id, 2);
    assert.equal(filtered[1].id, 4);
  });

  it("filter() handles empty array", async () => {
    const detector = new HybridNoiseDetector(null, undefined);
    const filtered = await detector.filter([], (item) => item.text);
    assert.equal(filtered.length, 0);
  });

  it("learnNoise() is available for manual learning", async () => {
    const detector = new HybridNoiseDetector(null, undefined);
    // Should not throw even without embedder
    await detector.learnNoise("Test noise text");
  });

  it("NoisePrototypeBank init is shared across concurrent callers", async () => {
    let embedCalls = 0;
    const embedder = {
      async embed(_text) {
        embedCalls++;
        await new Promise((resolve) => setTimeout(resolve, 1));
        const vector = Array(32).fill(0);
        vector[(embedCalls - 1) % vector.length] = 1;
        return vector;
      },
    };
    const bank = new NoisePrototypeBank();

    await Promise.all([
      bank.init(embedder),
      bank.init(embedder),
      bank.init(embedder),
    ]);

    assert.equal(bank.initialized, true);
    assert.equal(embedCalls, bank.size);
  });
});
