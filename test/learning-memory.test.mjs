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
  formatSceneExpandedLine,
  pickHighValueSceneMembers,
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

  it("round-trips scene and pattern metadata", () => {
    const built = buildSmartMetadata({ text: "scene", category: "other", timestamp: 1 }, {
      memory_kind: "pattern",
      memory_category: "patterns",
      utility_score: 0.8,
      case_trigger_axes: ["generated file", "completion report"],
      case_steps: ["inspect path", "run focused check"],
      scene_member_ids: ["m1", "m2"],
    });
    const parsed = parseSmartMetadata(stringifySmartMetadata(built), { text: "scene", category: "other", timestamp: 1 });
    assert.equal(parsed.memory_kind, "pattern");
    assert.equal(parsed.utility_score, 0.8);
    assert.deepEqual(parsed.case_trigger_axes, ["generated file", "completion report"]);
    assert.deepEqual(parsed.case_steps, ["inspect path", "run focused check"]);
    assert.deepEqual(parsed.scene_member_ids, ["m1", "m2"]);
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

describe("scene and pattern maintenance", () => {
  it("treats legacy skill metadata as ordinary memory", () => {
    const parsed = parseSmartMetadata(JSON.stringify({
      memory_kind: "skill",
      memory_category: "patterns",
      skill_enabled: true,
    }), { text: "legacy skill", category: "other", timestamp: 1 });
    assert.equal(parsed.memory_kind, "memory");
    assert.equal(parsed.skill_enabled, undefined);
  });

  it("expands scene memories with high-value member memories", () => {
    const sceneMeta = buildSmartMetadata({ text: "scene", category: "other", timestamp: 1 }, {
      memory_kind: "scene",
      scene_title: "Verification scene",
      scene_member_ids: ["low", "high", "archived"],
      memory_category: "patterns",
    });
    const high = entry("high", "Always verify generated file paths", {
      summary: "Verify generated file paths",
      utility_score: 0.9,
      state: "confirmed",
      memory_layer: "working",
    });
    const low = entry("low", "Mentioned a file path once", {
      summary: "Mentioned a file path once",
      utility_score: 0.2,
      state: "confirmed",
      memory_layer: "working",
    });
    const archived = entry("archived", "Old archived detail", {
      summary: "Old archived detail",
      utility_score: 1,
      state: "archived",
      memory_layer: "archive",
    });
    const members = pickHighValueSceneMembers(
      parseSmartMetadata(stringifySmartMetadata(sceneMeta), { text: "scene", category: "other", timestamp: 1 }),
      new Map([[high.id, high], [low.id, low], [archived.id, archived]]),
      2,
    );

    assert.deepEqual(members.map((member) => member.id), ["high", "low"]);
    const line = formatSceneExpandedLine(entry("scene", "scene", sceneMeta), members, 500);
    assert.match(line, /\[scene:global\]/);
    assert.match(line, /member: Verify generated file paths/);
    assert.doesNotMatch(line, /Old archived detail/);
  });

  it("creates scene and pattern memories from existing cases", async () => {
    const stored = [];
    const updated = [];
    const caseMeta = (text) => stringifySmartMetadata(buildSmartMetadata({ text, category: "fact", timestamp: 1 }, {
      memory_kind: "case",
      memory_category: "cases",
      summary: text,
      content: text,
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
    });

    assert.equal(result.scanned, 2);
    assert.equal(result.scenesCreated, 1);
    assert.equal(result.patternsCreated, 1);
    assert.equal(result.skillsCreated, undefined);
    assert.equal(stored.length, 2);
    const metas = stored.map((memory) => parseSmartMetadata(memory.metadata, memory));
    assert.ok(metas.some((meta) => meta.memory_kind === "scene"));
    assert.ok(metas.some((meta) => meta.memory_kind === "pattern"));
    assert.ok(!metas.some((meta) => meta.memory_kind === "skill"));
    assert.equal(updated.length, 0);
  });

  it("creates independent patterns without skill generation", async () => {
    const stored = [];
    const rows = [
      entry("case-1", "Case: deploy rollback required dry run", {
        memory_kind: "case",
        memory_category: "cases",
        summary: "Deploy rollback required dry run",
        state: "confirmed",
        memory_layer: "working",
      }),
      entry("case-2", "Case: deploy rollback should verify dry run first", {
        memory_kind: "case",
        memory_category: "cases",
        summary: "Deploy rollback should verify dry run first",
        state: "confirmed",
        memory_layer: "working",
      }),
    ];
    const result = await runLearningMemoryMaintenance({
      store: {
        async list() { return rows; },
        async store(memory) {
          stored.push(memory);
          return { ...memory, id: `stored-${stored.length}`, timestamp: Date.now() };
        },
        async update() { return null; },
      },
      embedder: { async embedPassage() { return [0.1, 0.2, 0.3]; } },
      llm: null,
      logger: { info() {}, warn() {}, debug() {} },
    }, {
      enabled: true,
      sceneMemory: { enabled: false },
      casePatternDistillation: { enabled: true, minCaseClusterSize: 2, maxPatternsPerRun: 1 },
    });

    assert.equal(result.patternsCreated, 1);
    assert.equal(result.skillsCreated, undefined);
    assert.equal(stored.length, 1);
    assert.equal(parseSmartMetadata(stored[0].metadata, stored[0]).memory_kind, "pattern");
  });

  it("uses LLM multi-axis scene clustering when available", async () => {
    const stored = [];
    const rows = [
      entry("a", "Project Atlas deploy workflow failed in April", {
        memory_kind: "case",
        memory_category: "cases",
        summary: "Project Atlas deploy workflow failed in April",
        state: "confirmed",
        memory_layer: "working",
      }),
      entry("b", "Project Atlas deploy workflow needs rollback checklist", {
        memory_kind: "case",
        memory_category: "cases",
        summary: "Project Atlas deploy workflow needs rollback checklist",
        state: "confirmed",
        memory_layer: "working",
      }),
    ];
    const llm = {
      async completeJson(_prompt, label) {
        if (label === "learning-memory-scene-cluster") {
          return {
            scenes: [{
              key: "project-atlas-deploy-april",
              title: "Atlas deploy workflow",
              summary: "- Deployment and rollback checklist for Atlas",
              member_ids: ["a", "b"],
            }],
          };
        }
        return null;
      },
      getLastError() { return null; },
    };

    const result = await runLearningMemoryMaintenance({
      store: {
        async list() { return rows; },
        async store(memory) {
          stored.push(memory);
          return { ...memory, id: `stored-${stored.length}`, timestamp: Date.now() };
        },
        async update() { return null; },
      },
      embedder: { async embedPassage() { return [0.1, 0.2, 0.3]; } },
      llm,
      logger: { info() {}, warn() {}, debug() {} },
    }, {
      enabled: true,
      sceneMemory: { enabled: true, maxScenesPerRun: 1, maxSceneMembers: 4 },
      casePatternDistillation: { enabled: false },
    });

    assert.equal(result.scenesCreated, 1);
    const scene = stored.find((memory) => parseSmartMetadata(memory.metadata, memory).memory_kind === "scene");
    assert.ok(scene);
    const meta = parseSmartMetadata(scene.metadata, scene);
    assert.equal(meta.scene_title, "Atlas deploy workflow");
    assert.deepEqual(meta.scene_member_ids, ["a", "b"]);
  });
});
