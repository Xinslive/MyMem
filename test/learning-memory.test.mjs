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
  buildUtilityPatch,
  formatLearnedSkillLine,
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

  it("round-trips scene and skill metadata", () => {
    const built = buildSmartMetadata({ text: "scene", category: "other", timestamp: 1 }, {
      memory_kind: "skill",
      memory_category: "patterns",
      utility_score: 0.8,
      skill_name: "Verify generated files",
      skill_enabled: true,
      skill_activation_conditions: ["generated file", "completion report"],
      skill_source_ids: ["case-1", "case-2"],
      scene_member_ids: ["m1", "m2"],
    });
    const parsed = parseSmartMetadata(stringifySmartMetadata(built), { text: "scene", category: "other", timestamp: 1 });
    assert.equal(parsed.memory_kind, "skill");
    assert.equal(parsed.utility_score, 0.8);
    assert.equal(parsed.skill_enabled, true);
    assert.deepEqual(parsed.skill_activation_conditions, ["generated file", "completion report"]);
    assert.deepEqual(parsed.skill_source_ids, ["case-1", "case-2"]);
    assert.deepEqual(parsed.scene_member_ids, ["m1", "m2"]);
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
});

describe("learned skills and maintenance", () => {
  it("formats learned skills for auto-recall injection", () => {
    const meta = buildSmartMetadata({ text: "skill", category: "other", timestamp: 1 }, {
      memory_kind: "skill",
      memory_category: "patterns",
      skill_name: "Verify generated files",
      skill_enabled: true,
      skill_activation_conditions: ["after codegen"],
      case_steps: ["inspect path", "run focused check"],
    });
    const line = formatLearnedSkillLine(entry("skill-1", "skill", meta), 200);
    assert.match(line, /\[skill:global\]/);
    assert.match(line, /Verify generated files/);
    assert.match(line, /inspect path/);
  });

  it("creates scene and skill memories from existing cases", async () => {
    const stored = [];
    const updated = [];
    const caseMeta = (text) => stringifySmartMetadata(buildSmartMetadata({ text, category: "fact", timestamp: 1 }, {
      memory_kind: "case",
      memory_category: "cases",
      l0_abstract: text,
      l1_overview: `- ${text}`,
      l2_content: text,
      state: "confirmed",
      memory_layer: "working",
    }));
    const rows = [
      entry("case-1", "Generated file path: verification failed before reporting success", JSON.parse(caseMeta("Generated file path verification failed"))),
      entry("case-2", "Generated file path: verify path before reporting success", JSON.parse(caseMeta("Generated file path verification failed again"))),
    ];
    const store = {
      async list() {
        return rows;
      },
      async store(memory) {
        stored.push(memory);
        return { ...memory, id: `stored-${stored.length}`, timestamp: Date.now() };
      },
      async update(id, patch) {
        updated.push({ id, patch });
        return null;
      },
    };
    const embedder = {
      async embedPassage() {
        return [0.1, 0.2, 0.3];
      },
    };

    const result = await runLearningMemoryMaintenance({
      store,
      embedder,
      llm: null,
      logger: { info() {}, warn() {}, debug() {} },
    }, {
      enabled: true,
      sceneMemory: { enabled: true, maxScenesPerRun: 2, maxSceneMembers: 4 },
      casePatternDistillation: { enabled: true, minCaseClusterSize: 2, maxPatternsPerRun: 2 },
      autoSkills: { enabled: true },
    });

    assert.equal(result.scanned, 2);
    assert.equal(result.scenesCreated, 1);
    assert.equal(result.skillsCreated, 1);
    assert.equal(stored.length, 2);
    const metas = stored.map((memory) => parseSmartMetadata(memory.metadata, memory));
    assert.ok(metas.some((meta) => meta.memory_kind === "scene"));
    assert.ok(metas.some((meta) => meta.memory_kind === "skill" && meta.skill_enabled === true));
    assert.equal(updated.length, 0);
  });
});
