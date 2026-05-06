import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const {
  applyLearningPolicy,
  buildUtilitySmoothingPatch,
  buildUtilityPatch,
  runLearningMemoryMaintenance,
} = jiti("../src/learning-memory.ts");
const {
  buildSmartMetadata,
  parseSmartMetadata,
  stringifySmartMetadata,
} = jiti("../src/smart-metadata.ts");

function entry(id, text, metadata = {}) {
  return {
    id,
    text,
    vector: [0.1, 0.2, 0.3],
    category: "other",
    scope: "global",
    importance: 0.8,
    timestamp: 1700000000000,
    metadata: JSON.stringify(metadata),
  };
}

function result(id, score, metadata = {}) {
  return {
    entry: entry(id, `memory ${id}`, metadata),
    score,
    sources: { vector: { score, rank: 1 } },
  };
}

describe("learning memory metadata", () => {
  it("defaults new learning fields for legacy metadata", () => {
    const meta = parseSmartMetadata("{}", { text: "legacy memory", category: "other", timestamp: 1 });
    assert.equal(meta.memory_kind, "memory");
    assert.equal(meta.utility_score, 0.5);
    assert.equal(meta.utility_success_count, 0);
    assert.equal(meta.utility_failure_count, 0);
    assert.equal(meta.utility_trial_count, 0);
  });

  it("round-trips pattern metadata", () => {
    const built = buildSmartMetadata({ text: "pattern", category: "other", timestamp: 1 }, {
      memory_kind: "pattern",
      memory_category: "patterns",
      utility_score: 0.8,
      case_trigger_axes: ["generated file", "completion report"],
      case_steps: ["inspect path", "run focused check"],
    });
    const parsed = parseSmartMetadata(stringifySmartMetadata(built), { text: "pattern", category: "other", timestamp: 1 });
    assert.equal(parsed.memory_kind, "pattern");
    assert.equal(parsed.utility_score, 0.8);
    assert.deepEqual(parsed.case_trigger_axes, ["generated file", "completion report"]);
    assert.deepEqual(parsed.case_steps, ["inspect path", "run focused check"]);
    assert.equal(parsed.skill_enabled, undefined);
  });
});

describe("learning policy", () => {
  it("boosts useful memories and penalizes bad recall", () => {
    const useful = result("useful", 0.7, {
      utility_score: 0.9,
      utility_trial_count: 10,
      utility_success_count: 8,
    });
    const bad = result("bad", 0.72, {
      utility_score: 0.2,
      utility_trial_count: 10,
      bad_recall_count: 3,
    });

    const ranked = applyLearningPolicy([bad, useful], {
      enabled: true,
      exploration: { enabled: false },
    });
    assert.equal(ranked[0].entry.id, "useful");
    assert.ok(ranked[0].sources.learning);
    assert.ok(ranked[1].sources.learning.badRecallPenalty > 0);
  });

  it("does not amplify exploration boost from unrelated historical trials", () => {
    const lowTrial = result("low-trial", 0.5, {
      utility_trial_count: 0,
    });
    const highTrial = result("high-trial", 0.5, {
      utility_trial_count: 1_000,
    });

    const ranked = applyLearningPolicy([lowTrial, highTrial], {
      enabled: true,
      exploration: { enabled: true, weight: 0.08 },
      utilityLearning: { enabled: false },
    });

    const boost = ranked.find((item) => item.entry.id === "low-trial").sources.learning.explorationBoost;
    assert.ok(boost <= 0.08 * Math.sqrt(Math.log1p(2)));
  });

  it("builds positive and negative utility patches", () => {
    const meta = parseSmartMetadata("{}", { text: "memory", category: "other", timestamp: 1 });
    const positive = buildUtilityPatch(meta, "positive", undefined, 123);
    assert.ok(positive.utility_score > meta.utility_score);
    assert.equal(positive.utility_success_count, 1);
    assert.equal(positive.utility_trial_count, 1);
    assert.equal(positive.last_utility_update_at, 123);

    const negative = buildUtilityPatch(meta, "negative", undefined, 456);
    assert.ok(negative.utility_score < meta.utility_score);
    assert.equal(negative.utility_failure_count, 1);
    assert.equal(negative.last_utility_update_at, 456);
  });

  it("builds smoothing patches from accumulated success and failure counts", () => {
    const meta = parseSmartMetadata(JSON.stringify({
      utility_score: 0.9,
      utility_success_count: 1,
      utility_failure_count: 3,
      utility_trial_count: 4,
    }), { text: "memory", category: "other", timestamp: 1 });
    const patch = buildUtilitySmoothingPatch(meta, {
      enabled: true,
      utilityLearning: { enabled: true, smoothing: 0.5 },
    }, 789);
    assert.equal(patch.utility_score, 0.575);
    assert.equal(patch.utility_trial_count, 4);
    assert.equal(patch.last_utility_update_at, 789);
  });
});

describe("learning memory maintenance", () => {
  it("treats legacy skill metadata as ordinary memory", () => {
    const parsed = parseSmartMetadata(JSON.stringify({
      memory_kind: "skill",
      memory_category: "patterns",
      skill_enabled: true,
    }), { text: "legacy skill", category: "other", timestamp: 1 });
    assert.equal(parsed.memory_kind, "memory");
    assert.equal(parsed.skill_enabled, undefined);
  });

  it("smooths utility metadata without creating scene or pattern memories", async () => {
    const patched = [];
    const rows = [
      entry("case-1", "Generated file path: verification failed before reporting success", {
        memory_kind: "case",
        memory_category: "cases",
        summary: "Generated file path verification failed",
        utility_score: 0.8,
        utility_success_count: 1,
        utility_failure_count: 3,
        utility_trial_count: 4,
        state: "confirmed",
        memory_layer: "working",
      }),
      entry("case-2", "Generated file path: verify path before reporting success", {
        memory_kind: "case",
        memory_category: "cases",
        summary: "Generated file path verification failed again",
        state: "confirmed",
        memory_layer: "working",
      }),
    ];
    const store = {
      async list() {
        return rows;
      },
      async patchMetadataBatch(patches) {
        patched.push(...patches);
        return patches.length;
      },
    };

    const result = await runLearningMemoryMaintenance({
      store,
      logger: { info() {}, warn() {}, debug() {} },
    }, {
      enabled: true,
      utilityLearning: { enabled: true, smoothing: 0.5 },
    });

    assert.equal(result.scanned, 2);
    assert.equal(result.utilitySmoothed, 1);
    assert.equal(result.skillsCreated, undefined);
    assert.equal(patched.length, 1);
    assert.equal(patched[0].id, "case-1");
    assert.ok(patched[0].patch.utility_score < 0.8);
  });
});
