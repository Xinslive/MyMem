/**
 * Unit tests for src/feedback-loop.ts
 *
 * Run: node --test test/feedback-loop.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  FeedbackLoop,
  normalizeFeedbackLoopConfig,
  DEFAULT_FEEDBACK_LOOP_CONFIG,
  DEFAULT_NOISE_LEARNING_CONFIG,
  DEFAULT_PRIOR_ADAPTATION_CONFIG,
} = jiti("../src/feedback-loop.ts");

// ============================================================================
// Helpers
// ============================================================================

function tmpDir() {
  const dir = join(tmpdir(), `feedback-loop-test-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeAdmissionConfig() {
  return {
    rejectThreshold: 0.45,
    typePriors: {
      profile: 0.95,
      preferences: 0.9,
      entities: 0.75,
      events: 0.45,
      cases: 0.8,
      patterns: 0.85,
    },
  };
}

function makeRejectedAudit(category, rejectedAt, score = 0.2) {
  return {
    version: "amac-v1",
    rejected_at: rejectedAt,
    session_key: "test",
    target_scope: "global",
    scope_filter: ["global"],
    candidate: {
      category,
      abstract: `${category} rejected candidate`,
      overview: "",
      content: `${category} rejected candidate content`,
    },
    audit: {
      version: "amac-v1",
      decision: "reject",
      score,
      reason: "test rejection",
      thresholds: { reject: 0.45, admit: 0.6 },
      weights: {},
      feature_scores: {},
      matched_existing_memory_ids: [],
      compared_existing_memory_ids: [],
      max_similarity: 0,
      evaluated_at: rejectedAt,
    },
    conversation_excerpt: "test conversation",
  };
}

function writeRejectedAudits(dbPath, entries) {
  const auditDir = join(dbPath, "..", "admission-audit");
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(
    join(auditDir, "rejections.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf-8",
  );
}

// ============================================================================
// Config Normalization Tests
// ============================================================================

it("normalizeFeedbackLoopConfig: enabled defaults to true for empty/no config", () => {
  assert.equal(normalizeFeedbackLoopConfig(null).enabled, true);
  assert.equal(normalizeFeedbackLoopConfig(undefined).enabled, true);
  assert.equal(normalizeFeedbackLoopConfig({}).enabled, true);
  // null/undefined also equal the full DEFAULT_FEEDBACK_LOOP_CONFIG
  assert.equal(normalizeFeedbackLoopConfig(null).noiseLearning.maxLearnPerScan, DEFAULT_NOISE_LEARNING_CONFIG.maxLearnPerScan);
});

it("normalizeFeedbackLoopConfig: enabled=true", () => {
  const result = normalizeFeedbackLoopConfig({ enabled: true });
  assert.equal(result.enabled, true);
  assert.deepStrictEqual(result.noiseLearning, DEFAULT_NOISE_LEARNING_CONFIG);
  assert.deepStrictEqual(result.priorAdaptation, DEFAULT_PRIOR_ADAPTATION_CONFIG);
});

it("normalizeFeedbackLoopConfig: enabled=false when explicitly set", () => {
  const result = normalizeFeedbackLoopConfig({ enabled: false });
  assert.equal(result.enabled, false);
});

it("normalizeFeedbackLoopConfig: noiseLearning sub-fields", () => {
  const result = normalizeFeedbackLoopConfig({
    enabled: true,
    noiseLearning: {
      fromErrors: false,
      fromRejections: false,
      minRejectionsForScan: 10,
      scanIntervalMs: 600_000,
      maxLearnPerScan: 5,
      relearnCooldownMs: 3_600_000,
      errorAreas: ["extraction"],
    },
  });
  assert.equal(result.noiseLearning.fromErrors, false);
  assert.equal(result.noiseLearning.fromRejections, false);
  assert.equal(result.noiseLearning.minRejectionsForScan, 10);
  assert.equal(result.noiseLearning.scanIntervalMs, 600_000);
  assert.equal(result.noiseLearning.maxLearnPerScan, 5);
  assert.equal(result.noiseLearning.relearnCooldownMs, 3_600_000);
  assert.deepStrictEqual(result.noiseLearning.errorAreas, ["extraction"]);
});

it("normalizeFeedbackLoopConfig: priorAdaptation sub-fields", () => {
  const result = normalizeFeedbackLoopConfig({
    enabled: true,
    priorAdaptation: {
      enabled: false,
      adaptationIntervalMs: 300_000,
      minObservations: 5,
      learningRate: 0.2,
      maxAdjustment: 0.1,
      observationWindowMs: 3_600_000,
      maxRejectionAudits: 50,
    },
  });
  assert.equal(result.priorAdaptation.enabled, false);
  assert.equal(result.priorAdaptation.adaptationIntervalMs, 300_000);
  assert.equal(result.priorAdaptation.minObservations, 5);
  assert.equal(result.priorAdaptation.learningRate, 0.2);
  assert.equal(result.priorAdaptation.maxAdjustment, 0.1);
  assert.equal(result.priorAdaptation.observationWindowMs, 3_600_000);
  assert.equal(result.priorAdaptation.maxRejectionAudits, 50);
});

it("normalizeFeedbackLoopConfig: clamps out-of-range values", () => {
  const result = normalizeFeedbackLoopConfig({
    enabled: true,
    noiseLearning: {
      minRejectionsForScan: 0, // below minimum, should use default
      scanIntervalMs: 30_000,  // below minimum (60000), should use default
      maxLearnPerScan: 100,    // above maximum (10), should use default
      relearnCooldownMs: -1, // below minimum, should use default
      errorAreas: 123,         // invalid, should use default
    },
    priorAdaptation: {
      learningRate: 5,    // above max (0.5), should use default
      maxAdjustment: 0,  // below min (0.01), should use default
      observationWindowMs: 1_000, // below minimum, should use default
      maxRejectionAudits: 1, // below minimum, should use default
    },
  });
  assert.equal(result.noiseLearning.minRejectionsForScan, DEFAULT_NOISE_LEARNING_CONFIG.minRejectionsForScan);
  assert.equal(result.noiseLearning.scanIntervalMs, DEFAULT_NOISE_LEARNING_CONFIG.scanIntervalMs);
  assert.equal(result.noiseLearning.maxLearnPerScan, DEFAULT_NOISE_LEARNING_CONFIG.maxLearnPerScan);
  assert.equal(result.noiseLearning.relearnCooldownMs, DEFAULT_NOISE_LEARNING_CONFIG.relearnCooldownMs);
  assert.deepStrictEqual(result.noiseLearning.errorAreas, DEFAULT_NOISE_LEARNING_CONFIG.errorAreas);
  assert.equal(result.priorAdaptation.learningRate, DEFAULT_PRIOR_ADAPTATION_CONFIG.learningRate);
  assert.equal(result.priorAdaptation.maxAdjustment, DEFAULT_PRIOR_ADAPTATION_CONFIG.maxAdjustment);
  assert.equal(result.priorAdaptation.observationWindowMs, DEFAULT_PRIOR_ADAPTATION_CONFIG.observationWindowMs);
  assert.equal(result.priorAdaptation.maxRejectionAudits, DEFAULT_PRIOR_ADAPTATION_CONFIG.maxRejectionAudits);
});

// ============================================================================
// FeedbackLoop Lifecycle Tests
// ============================================================================

it("FeedbackLoop: start/dispose when disabled does nothing", () => {
  const loop = new FeedbackLoop({
    noiseBank: null,
    embedder: { embed: async () => [] },
    admissionController: null,
    config: { enabled: false, noiseLearning: DEFAULT_NOISE_LEARNING_CONFIG, priorAdaptation: DEFAULT_PRIOR_ADAPTATION_CONFIG },
  });
  loop.start();
  loop.dispose(); // Should not throw
});

it("FeedbackLoop: dispose clears timers", () => {
  const loop = new FeedbackLoop({
    noiseBank: null,
    embedder: { embed: async () => [] },
    admissionController: null,
    config: {
      enabled: true,
      noiseLearning: { ...DEFAULT_NOISE_LEARNING_CONFIG, scanIntervalMs: 10 },
      priorAdaptation: { ...DEFAULT_PRIOR_ADAPTATION_CONFIG, adaptationIntervalMs: 10 },
    },
  });
  loop.start();
  loop.dispose(); // Should not throw
});

it("FeedbackLoop: onAdmissionRejected buffers entry when enabled", () => {
  const loop = new FeedbackLoop({
    noiseBank: null,
    embedder: { embed: async () => [] },
    admissionController: null,
    config: {
      enabled: true,
      noiseLearning: { ...DEFAULT_NOISE_LEARNING_CONFIG, fromRejections: true, scanIntervalMs: 999_999 },
      priorAdaptation: DEFAULT_PRIOR_ADAPTATION_CONFIG,
    },
  });
  loop.onAdmissionRejected({
    version: "amac-v1",
    rejected_at: Date.now(),
    session_key: "test",
    target_scope: "global",
    scope_filter: [],
    candidate: { category: "preferences", abstract: "test", overview: "", content: "" },
    audit: {
      version: "amac-v1",
      decision: "reject",
      score: 0.3,
      reason: "test",
      thresholds: { reject: 0.45, admit: 0.6 },
      weights: {},
      feature_scores: {},
      matched_existing_memory_ids: [],
      compared_existing_memory_ids: [],
      max_similarity: 0,
      evaluated_at: Date.now(),
    },
    conversation_excerpt: "test conversation",
  });
  loop.dispose();
});

it("FeedbackLoop: periodic scan timer calls file and rejection scanners when runtime context is known", async () => {
  let errorScanCount = 0;
  let rejectionScanCount = 0;

  const loop = new FeedbackLoop({
    noiseBank: null,
    embedder: { embed: async () => [] },
    admissionController: null,
    config: {
      enabled: true,
      noiseLearning: {
        ...DEFAULT_NOISE_LEARNING_CONFIG,
        fromErrors: true,
        fromRejections: true,
        scanIntervalMs: 10,
      },
      priorAdaptation: {
        ...DEFAULT_PRIOR_ADAPTATION_CONFIG,
        enabled: false,
      },
    },
    runtimeContext: {
      workspaceDir: "/tmp/workspace",
      dbPath: "/tmp/db",
      admissionConfig: { rejectThreshold: 0.45 },
    },
  });

  loop.scanErrorFile = async () => {
    errorScanCount++;
  };
  loop.scanRejectionAudits = async () => {
    rejectionScanCount++;
  };

  try {
    loop.start();
    await new Promise((resolve) => setTimeout(resolve, 35));
  } finally {
    loop.dispose();
  }

  assert.ok(errorScanCount >= 1, `expected periodic error scans, got ${errorScanCount}`);
  assert.ok(rejectionScanCount >= 1, `expected periodic rejection scans, got ${rejectionScanCount}`);
});

it("FeedbackLoop: prior adaptation timer calls forceAdaptationCycle when enabled", async () => {
  let adaptationCount = 0;

  const loop = new FeedbackLoop({
    noiseBank: null,
    embedder: { embed: async () => [] },
    admissionController: {},
    config: {
      enabled: true,
      noiseLearning: {
        ...DEFAULT_NOISE_LEARNING_CONFIG,
        fromErrors: false,
        fromRejections: false,
      },
      priorAdaptation: {
        ...DEFAULT_PRIOR_ADAPTATION_CONFIG,
        enabled: true,
        adaptationIntervalMs: 10,
      },
    },
    runtimeContext: {
      dbPath: "/tmp/db",
      admissionConfig: { rejectThreshold: 0.45 },
    },
  });

  loop.forceAdaptationCycle = async () => {
    adaptationCount++;
  };

  try {
    loop.start();
    await new Promise((resolve) => setTimeout(resolve, 35));
  } finally {
    loop.dispose();
  }

  assert.ok(adaptationCount >= 1, `expected periodic prior adaptation, got ${adaptationCount}`);
});

// ============================================================================
// Error File Parsing Tests
// ============================================================================

it("parseErrorsFile: extracts id, area, summary, details", () => {
  // Access the private function via jiti's live module — use FeedbackLoop internals indirectly
  const { FeedbackLoop } = jiti("../src/feedback-loop.ts");
  const loop = new FeedbackLoop({
    noiseBank: null,
    embedder: { embed: async () => [] },
    admissionController: null,
    config: DEFAULT_FEEDBACK_LOOP_CONFIG,
  });
  // Test getAdaptiveTypePriors as a proxy for config normalization
  const base = { profile: 0.95, preferences: 0.9, entities: 0.75, events: 0.45, cases: 0.8, patterns: 0.85 };
  const stats = {
    preferences: { admitted: 90, rejected: 10 },
    entities: { admitted: 30, rejected: 70 },
  };
  const adaptive = loop.getAdaptiveTypePriors(base, stats);
  assert.ok(adaptive.preferences >= base.preferences, "preferences prior should increase with high admit rate");
  assert.ok(adaptive.entities <= base.entities, "entities prior should decrease with high reject rate");
  loop.dispose();
});

it("parseErrorsFile: getAdaptiveTypePriors respects maxAdjustment", () => {
  const loop = new FeedbackLoop({
    noiseBank: null,
    embedder: { embed: async () => [] },
    admissionController: null,
    config: {
      enabled: true,
      noiseLearning: DEFAULT_NOISE_LEARNING_CONFIG,
      priorAdaptation: {
        enabled: true,
        adaptationIntervalMs: 600_000,
        minObservations: 1,
        learningRate: 1.0,  // Max learning rate
        maxAdjustment: 0.05, // Tight clamp
      },
    },
  });

  const base = { profile: 0.95, preferences: 0.9, entities: 0.75, events: 0.45, cases: 0.8, patterns: 0.85 };
  const stats = {
    preferences: { admitted: 100, rejected: 0 },  // 100% admit rate
    entities: { admitted: 0, rejected: 100 },  // 0% admit rate
  };

  const adaptive = loop.getAdaptiveTypePriors(base, stats);

  // With 100% admit rate: delta = 1.0 * (1.0 - 0.5) = 0.5
  // clamped to base ± maxAdjustment = 0.9 ± 0.05
  assert.ok(
    adaptive.preferences <= base.preferences + 0.05 + 0.0001,
    `preferences=${adaptive.preferences} should be clamped within maxAdjustment=0.05 of base=${base.preferences}`,
  );
  // With 0% admit rate: delta = 1.0 * (0 - 0.5) = -0.5
  // clamped to base ± maxAdjustment = 0.75 ± 0.05
  assert.ok(
    adaptive.entities >= base.entities - 0.05 - 0.0001,
    `entities=${adaptive.entities} should be clamped within maxAdjustment=0.05 of base=${base.entities}`,
  );
  loop.dispose();
});

it("getAdaptiveTypePriors: ignores categories below minObservations", () => {
  const loop = new FeedbackLoop({
    noiseBank: null,
    embedder: { embed: async () => [] },
    admissionController: null,
    config: {
      enabled: true,
      noiseLearning: DEFAULT_NOISE_LEARNING_CONFIG,
      priorAdaptation: {
        ...DEFAULT_PRIOR_ADAPTATION_CONFIG,
        minObservations: 50,
      },
    },
  });

  const base = { profile: 0.95, preferences: 0.9, entities: 0.75, events: 0.45, cases: 0.8, patterns: 0.85 };
  const stats = {
    preferences: { admitted: 5, rejected: 5 },  // total=10, below minObservations=50
  };

  const adaptive = loop.getAdaptiveTypePriors(base, stats);
  assert.equal(adaptive.preferences, base.preferences, "Should use base when below minObservations");
  loop.dispose();
});

it("getAdaptiveTypePriors: clamps to [0, 1]", () => {
  const loop = new FeedbackLoop({
    noiseBank: null,
    embedder: { embed: async () => [] },
    admissionController: null,
    config: DEFAULT_FEEDBACK_LOOP_CONFIG,
  });

  const base = { profile: 0.01, preferences: 0.99, entities: 0.5, events: 0.5, cases: 0.5, patterns: 0.5 };
  const stats = {
    profile: { admitted: 100, rejected: 0 },      // Would push to 1.0+
    preferences: { admitted: 0, rejected: 100 },  // Would push to 0.0-
  };

  const adaptive = loop.getAdaptiveTypePriors(base, stats);
  assert.ok(adaptive.profile <= 1.0, "profile should be clamped to 1.0");
  assert.ok(adaptive.preferences >= 0.0, "preferences should be clamped to 0.0");
  loop.dispose();
});

it("forceAdaptationCycle: ignores rejected audits outside observationWindowMs", async () => {
  const now = Date.now();
  const originalNow = Date.now;
  Date.now = () => now;

  let adaptivePriors = null;
  const loop = new FeedbackLoop({
    noiseBank: null,
    embedder: { embed: async () => [] },
    admissionController: {
      setAdaptiveTypePriors: (priors) => {
        adaptivePriors = priors;
      },
    },
    config: {
      enabled: true,
      noiseLearning: DEFAULT_NOISE_LEARNING_CONFIG,
      priorAdaptation: {
        ...DEFAULT_PRIOR_ADAPTATION_CONFIG,
        minObservations: 3,
        learningRate: 0.2,
        observationWindowMs: 60_000,
        maxRejectionAudits: 100,
      },
    },
  });

  const dir = tmpDir();
  const dbPath = join(dir, "db");
  const admissionConfig = makeAdmissionConfig();

  try {
    mkdirSync(dbPath, { recursive: true });
    writeRejectedAudits(dbPath, [
      makeRejectedAudit("events", now - 120_000),
      makeRejectedAudit("events", now - 110_000),
      makeRejectedAudit("events", now - 100_000),
    ]);

    await loop.forceAdaptationCycle(dbPath, admissionConfig);

    assert.ok(adaptivePriors, "adaptation should set type priors");
    assert.equal(
      adaptivePriors.events,
      admissionConfig.typePriors.events,
      "old-only rejections should not lower the events prior",
    );
  } finally {
    Date.now = originalNow;
    rmSync(dir, { recursive: true, force: true });
    loop.dispose();
  }
});

it("forceAdaptationCycle: limits prior adaptation to the recent audit tail", async () => {
  const now = Date.now();
  const originalNow = Date.now;
  Date.now = () => now;

  let adaptivePriors = null;
  const loop = new FeedbackLoop({
    noiseBank: null,
    embedder: { embed: async () => [] },
    admissionController: {
      setAdaptiveTypePriors: (priors) => {
        adaptivePriors = priors;
      },
    },
    config: {
      enabled: true,
      noiseLearning: DEFAULT_NOISE_LEARNING_CONFIG,
      priorAdaptation: {
        ...DEFAULT_PRIOR_ADAPTATION_CONFIG,
        minObservations: 3,
        learningRate: 0.2,
        observationWindowMs: 60 * 60_000,
        maxRejectionAudits: 10,
      },
    },
  });

  const dir = tmpDir();
  const dbPath = join(dir, "db");
  const admissionConfig = makeAdmissionConfig();
  const oldRejectedPreferences = Array.from({ length: 20 }, (_, index) =>
    makeRejectedAudit("preferences", now - 30_000 + index, 0.1),
  );
  const recentRejectedEvents = Array.from({ length: 10 }, (_, index) =>
    makeRejectedAudit("events", now - 10_000 + index, 0.1),
  );

  try {
    mkdirSync(dbPath, { recursive: true });
    writeRejectedAudits(dbPath, [
      ...oldRejectedPreferences,
      ...recentRejectedEvents,
    ]);

    await loop.forceAdaptationCycle(dbPath, admissionConfig);

    assert.ok(adaptivePriors, "adaptation should set type priors");
    assert.equal(
      adaptivePriors.preferences,
      admissionConfig.typePriors.preferences,
      "older rows outside the maxRejectionAudits tail should not affect preferences",
    );
    assert.ok(
      adaptivePriors.events < admissionConfig.typePriors.events,
      "recent tail rejections should lower the events prior",
    );
  } finally {
    Date.now = originalNow;
    rmSync(dir, { recursive: true, force: true });
    loop.dispose();
  }
});

// ============================================================================
// End-to-end Rejection Audit Noise Learning
// ============================================================================

it("scanRejectionAudits: learns each rejection cluster once during cooldown", async () => {
  const now = Date.now();
  const originalNow = Date.now;
  Date.now = () => now;

  let embedCallCount = 0;
  let learnCallCount = 0;
  const embedder = {
    embed: async () => {
      embedCallCount++;
      return [0.1, 0.2, 0.3];
    },
  };
  const noiseBank = {
    initialized: true,
    learn: () => {
      learnCallCount++;
    },
  };
  const loop = new FeedbackLoop({
    noiseBank,
    embedder,
    admissionController: null,
    config: {
      enabled: true,
      noiseLearning: {
        ...DEFAULT_NOISE_LEARNING_CONFIG,
        minRejectionsForScan: 2,
        maxLearnPerScan: 10,
        relearnCooldownMs: 60_000,
      },
      priorAdaptation: DEFAULT_PRIOR_ADAPTATION_CONFIG,
    },
  });
  const dir = tmpDir();
  const dbPath = join(dir, "db");
  const admissionConfig = makeAdmissionConfig();

  try {
    mkdirSync(dbPath, { recursive: true });
    writeRejectedAudits(dbPath, [
      makeRejectedAudit("events", now - 2_000, 0.1),
      makeRejectedAudit("events", now - 1_000, 0.1),
    ]);

    await loop.scanRejectionAudits(dbPath, admissionConfig);
    await loop.scanRejectionAudits(dbPath, admissionConfig);

    assert.equal(embedCallCount, 1, "repeat scans should not re-embed the same learned rejection cluster");
    assert.equal(learnCallCount, 1, "repeat scans should not relearn the same rejection cluster during cooldown");
  } finally {
    Date.now = originalNow;
    rmSync(dir, { recursive: true, force: true });
    loop.dispose();
  }
});

it("scanRejectionAudits: relearns an updated cluster after cooldown", async () => {
  const baseNow = Date.now();
  const originalNow = Date.now;
  let fakeNow = baseNow;
  Date.now = () => fakeNow;

  let learnCallCount = 0;
  const embedder = { embed: async () => [0.1, 0.2, 0.3] };
  const noiseBank = {
    initialized: true,
    learn: () => {
      learnCallCount++;
    },
  };
  const loop = new FeedbackLoop({
    noiseBank,
    embedder,
    admissionController: null,
    config: {
      enabled: true,
      noiseLearning: {
        ...DEFAULT_NOISE_LEARNING_CONFIG,
        minRejectionsForScan: 2,
        maxLearnPerScan: 10,
        relearnCooldownMs: 60_000,
      },
      priorAdaptation: DEFAULT_PRIOR_ADAPTATION_CONFIG,
    },
  });
  const dir = tmpDir();
  const dbPath = join(dir, "db");
  const admissionConfig = makeAdmissionConfig();

  try {
    mkdirSync(dbPath, { recursive: true });
    writeRejectedAudits(dbPath, [
      makeRejectedAudit("events", baseNow - 2_000, 0.1),
      makeRejectedAudit("events", baseNow - 1_000, 0.1),
    ]);

    await loop.scanRejectionAudits(dbPath, admissionConfig);

    fakeNow = baseNow + 61_000;
    writeRejectedAudits(dbPath, [
      makeRejectedAudit("events", baseNow - 2_000, 0.1),
      makeRejectedAudit("events", baseNow - 1_000, 0.1),
      makeRejectedAudit("events", fakeNow - 1_000, 0.1),
    ]);

    await loop.scanRejectionAudits(dbPath, admissionConfig);

    assert.equal(learnCallCount, 2, "updated clusters should be eligible again after cooldown");
  } finally {
    Date.now = originalNow;
    rmSync(dir, { recursive: true, force: true });
    loop.dispose();
  }
});

// ============================================================================
// End-to-end Error File Scanning
// ============================================================================

it("scanErrorFile: reads errors and calls embed", async () => {
  let embedCallCount = 0;
  let embedText = "";
  const embedder = {
    embed: async (text) => {
      embedCallCount++;
      embedText = text;
      return [0.1, 0.2, 0.3];
    },
  };

  const noiseBank = {
    initialized: true,
    learn: () => {},
  };

  const loop = new FeedbackLoop({
    noiseBank,
    embedder,
    admissionController: null,
    config: {
      enabled: true,
      noiseLearning: {
        ...DEFAULT_NOISE_LEARNING_CONFIG,
        errorAreas: ["extraction"],
        maxLearnPerScan: 1,
      },
      priorAdaptation: DEFAULT_PRIOR_ADAPTATION_CONFIG,
    },
  });

  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".learnings"), { recursive: true });
    writeFileSync(join(dir, ".learnings", "ERRORS.md"), `## [ERR-20260419-001] extraction

### Summary
Test error summary text here

### Details
Test error details
`, "utf-8");

    await loop.scanErrorFile(dir);

    assert.equal(embedCallCount, 1, "embed should be called once");
    assert.ok(embedText.includes("Test error summary"), "should embed the summary text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  loop.dispose();
});

it("scanErrorFile: skips already-processed errors", async () => {
  let embedCallCount = 0;
  const embedder = { embed: async () => { embedCallCount++; return [0.1]; } };
  const noiseBank = { initialized: true, learn: () => {} };

  const loop = new FeedbackLoop({
    noiseBank,
    embedder,
    admissionController: null,
    config: {
      enabled: true,
      noiseLearning: { ...DEFAULT_NOISE_LEARNING_CONFIG, errorAreas: ["extraction"], maxLearnPerScan: 10 },
      priorAdaptation: DEFAULT_PRIOR_ADAPTATION_CONFIG,
    },
  });

  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".learnings"), { recursive: true });
    writeFileSync(join(dir, ".learnings", "ERRORS.md"), `## [ERR-20260419-001] extraction

### Summary
Test
`, "utf-8");

    // First scan
    await loop.scanErrorFile(dir);
    assert.equal(embedCallCount, 1);

    // Second scan — should skip already processed
    await loop.scanErrorFile(dir);
    assert.equal(embedCallCount, 1, "second scan should not re-embed same error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  loop.dispose();
});

it("scanErrorFile: skips non-matching area", async () => {
  let embedCallCount = 0;
  const embedder = { embed: async () => { embedCallCount++; return [0.1]; } };
  const noiseBank = { initialized: true, learn: () => {} };

  const loop = new FeedbackLoop({
    noiseBank,
    embedder,
    admissionController: null,
    config: {
      enabled: true,
      noiseLearning: { ...DEFAULT_NOISE_LEARNING_CONFIG, errorAreas: ["extraction"], maxLearnPerScan: 10 },
      priorAdaptation: DEFAULT_PRIOR_ADAPTATION_CONFIG,
    },
  });

  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".learnings"), { recursive: true });
    writeFileSync(join(dir, ".learnings", "ERRORS.md"), `## [ERR-20260419-001] ui-bug

### Summary
UI related error
`, "utf-8");

    await loop.scanErrorFile(dir);
    assert.equal(embedCallCount, 0, "should not embed non-matching area");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  loop.dispose();
});

it("scanErrorFile: handles missing file gracefully", async () => {
  const loop = new FeedbackLoop({
    noiseBank: null,
    embedder: { embed: async () => [] },
    admissionController: null,
    config: DEFAULT_FEEDBACK_LOOP_CONFIG,
  });

  await loop.scanErrorFile("/nonexistent/path"); // Should not throw
  loop.dispose();
});
