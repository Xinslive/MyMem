/**
 * Unit tests for src/feedback-loop.ts
 *
 * Run: node --test test/feedback-loop.test.mjs
 */

import { it } from "node:test";
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
  DEFAULT_PRIOR_ADAPTATION_CONFIG,
  DEFAULT_PREVENTIVE_LESSON_CONFIG,
} = jiti("../src/feedback-loop.ts");
const { parseSmartMetadata } = jiti("../src/smart-metadata.ts");

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

function makeLessonStore() {
  const entries = new Map();
  return {
    entries,
    async list(scopeFilter, category, limit = 20, offset = 0) {
      const rows = [...entries.values()]
        .filter((entry) => !scopeFilter || scopeFilter.includes(entry.scope))
        .filter((entry) => !category || entry.category === category);
      return rows.slice(offset, offset + limit);
    },
    async store(entry) {
      const id = `lesson-${entries.size + 1}`;
      const full = { ...entry, id, timestamp: Date.now() };
      entries.set(id, full);
      return full;
    },
    async update(id, updates) {
      const entry = entries.get(id);
      if (!entry) return null;
      const next = { ...entry, ...updates };
      entries.set(id, next);
      return next;
    },
  };
}

it("normalizeFeedbackLoopConfig: enabled defaults to true for empty/no config", () => {
  assert.equal(normalizeFeedbackLoopConfig(null).enabled, true);
  assert.equal(normalizeFeedbackLoopConfig(undefined).enabled, true);
  assert.equal(normalizeFeedbackLoopConfig({}).enabled, true);
  assert.deepStrictEqual(normalizeFeedbackLoopConfig(null), DEFAULT_FEEDBACK_LOOP_CONFIG);
});

it("normalizeFeedbackLoopConfig: enabled=true", () => {
  const result = normalizeFeedbackLoopConfig({ enabled: true });
  assert.equal(result.enabled, true);
  assert.deepStrictEqual(result.priorAdaptation, DEFAULT_PRIOR_ADAPTATION_CONFIG);
  assert.deepStrictEqual(result.preventiveLessons, DEFAULT_PREVENTIVE_LESSON_CONFIG);
  assert.equal("noiseLearning" in result, false);
});

it("normalizeFeedbackLoopConfig: enabled=false when explicitly set", () => {
  const result = normalizeFeedbackLoopConfig({ enabled: false });
  assert.equal(result.enabled, false);
});

it("normalizeFeedbackLoopConfig: ignores removed noiseLearning config", () => {
  const result = normalizeFeedbackLoopConfig({
    enabled: true,
    noiseLearning: {
      fromErrors: true,
      fromRejections: true,
      minRejectionsForScan: 10,
      scanIntervalMs: 600_000,
      maxLearnPerScan: 5,
      relearnCooldownMs: 3_600_000,
      errorAreas: ["extraction"],
    },
  });
  assert.equal("noiseLearning" in result, false);
  assert.deepStrictEqual(result.priorAdaptation, DEFAULT_PRIOR_ADAPTATION_CONFIG);
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

it("normalizeFeedbackLoopConfig: preventiveLessons sub-fields", () => {
  const result = normalizeFeedbackLoopConfig({
    enabled: true,
    preventiveLessons: {
      enabled: false,
      fromErrors: false,
      fromCorrections: false,
      minEvidenceToConfirm: 3,
      pendingConfidence: 0.35,
      confirmedConfidence: 0.8,
      maxLearnPerScan: 4,
    },
  });
  assert.deepStrictEqual(result.preventiveLessons, {
    enabled: false,
    fromErrors: false,
    fromCorrections: false,
    minEvidenceToConfirm: 3,
    pendingConfidence: 0.35,
    confirmedConfidence: 0.8,
    maxLearnPerScan: 4,
  });
});

it("normalizeFeedbackLoopConfig: clamps out-of-range values", () => {
  const result = normalizeFeedbackLoopConfig({
    enabled: true,
    priorAdaptation: {
      learningRate: 5,
      maxAdjustment: 0,
      observationWindowMs: 1_000,
      maxRejectionAudits: 1,
    },
    preventiveLessons: {
      minEvidenceToConfirm: 100,
      pendingConfidence: 2,
    },
  });
  assert.equal(result.priorAdaptation.learningRate, DEFAULT_PRIOR_ADAPTATION_CONFIG.learningRate);
  assert.equal(result.priorAdaptation.maxAdjustment, DEFAULT_PRIOR_ADAPTATION_CONFIG.maxAdjustment);
  assert.equal(result.priorAdaptation.observationWindowMs, DEFAULT_PRIOR_ADAPTATION_CONFIG.observationWindowMs);
  assert.equal(result.priorAdaptation.maxRejectionAudits, DEFAULT_PRIOR_ADAPTATION_CONFIG.maxRejectionAudits);
  assert.equal(result.preventiveLessons.minEvidenceToConfirm, DEFAULT_PREVENTIVE_LESSON_CONFIG.minEvidenceToConfirm);
  assert.equal(result.preventiveLessons.pendingConfidence, DEFAULT_PREVENTIVE_LESSON_CONFIG.pendingConfidence);
});

it("FeedbackLoop: start/dispose when disabled does nothing", () => {
  const loop = new FeedbackLoop({
    admissionController: null,
    config: { enabled: false, priorAdaptation: DEFAULT_PRIOR_ADAPTATION_CONFIG },
  });
  loop.start();
  loop.dispose();
});

it("FeedbackLoop: dispose clears timers", () => {
  const loop = new FeedbackLoop({
    admissionController: { setAdaptiveTypePriors: () => {} },
    store: makeLessonStore(),
    config: {
      enabled: true,
      priorAdaptation: { ...DEFAULT_PRIOR_ADAPTATION_CONFIG, adaptationIntervalMs: 10 },
      preventiveLessons: DEFAULT_PREVENTIVE_LESSON_CONFIG,
    },
    runtimeContext: {
      workspaceDir: "/tmp/workspace",
      dbPath: "/tmp/db",
      admissionConfig: { rejectThreshold: 0.45 },
    },
  });
  loop.start();
  loop.dispose();
});

it("FeedbackLoop: onAdmissionRejected is accepted but no longer buffers noise samples", () => {
  const loop = new FeedbackLoop({
    admissionController: null,
    config: {
      enabled: true,
      priorAdaptation: DEFAULT_PRIOR_ADAPTATION_CONFIG,
    },
  });
  loop.onAdmissionRejected(makeRejectedAudit("preferences", Date.now(), 0.2));
  const status = loop.getStatus();
  assert.equal("noiseLearning" in status, false);
  loop.dispose();
});

it("FeedbackLoop: getStatus exposes runtime context, lessons, and admitted counts", () => {
  const lessonStore = makeLessonStore();
  const loop = new FeedbackLoop({
    admissionController: { setAdaptiveTypePriors: () => {} },
    store: lessonStore,
    config: {
      enabled: true,
      priorAdaptation: { ...DEFAULT_PRIOR_ADAPTATION_CONFIG, enabled: true },
      preventiveLessons: DEFAULT_PREVENTIVE_LESSON_CONFIG,
    },
    runtimeContext: {
      workspaceDir: "/tmp/workspace",
      dbPath: "/tmp/db",
      admissionConfig: makeAdmissionConfig(),
    },
  });

  loop.onAdmissionRejected(makeRejectedAudit("preferences", Date.now(), 0.2));
  loop.onSelfImprovementError({ area: "extraction", summary: "extractor returned no useful candidate" });
  loop.onPreventiveLessonEvidence({ source: "user_correction", summary: "Don't use stale recall.", scope: "global" });
  loop.onAdmissionAdmitted("preferences");

  const status = loop.getStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.disposed, false);
  assert.equal("noiseLearning" in status, false);
  assert.equal(status.preventiveLessons.bufferedEvidence, 2);
  assert.equal(status.priorAdaptation.enabled, true);
  assert.equal(status.priorAdaptation.observedAdmitted, 1);
  assert.deepStrictEqual(status.runtime, {
    hasWorkspaceDir: true,
    hasDbPath: true,
    hasAdmissionConfig: true,
  });

  loop.dispose();
});

it("FeedbackLoop: prior adaptation timer calls forceAdaptationCycle when enabled", async () => {
  let adaptationCount = 0;

  const loop = new FeedbackLoop({
    admissionController: {},
    config: {
      enabled: true,
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

it("FeedbackLoop: preventive lesson evidence without an existing lesson is skipped", async () => {
  const lessonStore = makeLessonStore();
  const loop = new FeedbackLoop({
    admissionController: null,
    store: lessonStore,
    config: {
      enabled: true,
      priorAdaptation: DEFAULT_PRIOR_ADAPTATION_CONFIG,
      preventiveLessons: DEFAULT_PREVENTIVE_LESSON_CONFIG,
    },
  });

  loop.onPreventiveLessonEvidence({
    summary: "node --test failed because parser fixtures were stale",
    details: "AssertionError: expected normalized cron expression",
    source: "test_failure",
    sessionKey: "agent:main:session:test",
    scope: "global",
    signatureHash: "same-failure",
  });
  await loop.drainPreventiveLessonBuffer();

  assert.equal(lessonStore.entries.size, 0);
  assert.equal(loop.getStatus().preventiveLessons.skipped, 1);
  loop.dispose();
});

it("FeedbackLoop: repeated preventive evidence promotes lesson to confirmed", async () => {
  const lessonStore = makeLessonStore();
  const existing = await lessonStore.store({
    text: "Prevent timeout while reading large logs",
    vector: [0.1, 0.2],
    importance: 0.72,
    category: "other",
    scope: "global",
    metadata: JSON.stringify({
      l0_abstract: "Prevent timeout while reading large logs",
      l1_overview: "- Prevent timeout while reading large logs",
      l2_content: "Prevent timeout while reading large logs",
      memory_category: "patterns",
      reasoning_strategy: true,
      strategy_kind: "preventive",
      canonical_id: "preventive:tool_error:timeout-large-logs",
      state: "pending",
      evidence_count: 1,
      confidence: 0.4,
    }),
  });
  const loop = new FeedbackLoop({
    admissionController: null,
    store: lessonStore,
    config: {
      enabled: true,
      priorAdaptation: DEFAULT_PRIOR_ADAPTATION_CONFIG,
      preventiveLessons: {
        ...DEFAULT_PREVENTIVE_LESSON_CONFIG,
        minEvidenceToConfirm: 2,
        pendingConfidence: 0.4,
        confirmedConfidence: 0.75,
      },
    },
  });

  const evidence = {
    summary: "Tool failed with timeout while reading large logs",
    details: "Error: timeout after 20000ms",
    source: "tool_error",
    sessionKey: "agent:main:session:test",
    scopeFilter: ["global"],
    toolName: "exec_command",
    signatureHash: "timeout-large-logs",
  };
  loop.onPreventiveLessonEvidence(evidence);
  await loop.drainPreventiveLessonBuffer();

  assert.equal(lessonStore.entries.size, 1, "repeated evidence should update the same canonical lesson");
  const entry = lessonStore.entries.get(existing.id);
  const meta = parseSmartMetadata(entry.metadata, entry);
  assert.equal(meta.state, "confirmed");
  assert.equal(meta.evidence_count, 2);
  assert.equal(meta.confidence, 0.75);
  assert.ok(meta.last_confirmed_use_at);
  assert.equal(loop.getStatus().preventiveLessons.promoted, 1);
  loop.dispose();
});

it("getAdaptiveTypePriors: increases and decreases category priors from observations", () => {
  const loop = new FeedbackLoop({
    admissionController: null,
    config: DEFAULT_FEEDBACK_LOOP_CONFIG,
  });
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

it("getAdaptiveTypePriors: respects maxAdjustment", () => {
  const loop = new FeedbackLoop({
    admissionController: null,
    config: {
      enabled: true,
      priorAdaptation: {
        enabled: true,
        adaptationIntervalMs: 600_000,
        minObservations: 1,
        learningRate: 1.0,
        maxAdjustment: 0.05,
      },
    },
  });

  const base = { profile: 0.95, preferences: 0.9, entities: 0.75, events: 0.45, cases: 0.8, patterns: 0.85 };
  const stats = {
    preferences: { admitted: 100, rejected: 0 },
    entities: { admitted: 0, rejected: 100 },
  };

  const adaptive = loop.getAdaptiveTypePriors(base, stats);
  assert.ok(adaptive.preferences <= base.preferences + 0.05 + 0.0001);
  assert.ok(adaptive.entities >= base.entities - 0.05 - 0.0001);
  loop.dispose();
});

it("getAdaptiveTypePriors: ignores categories below minObservations", () => {
  const loop = new FeedbackLoop({
    admissionController: null,
    config: {
      enabled: true,
      priorAdaptation: {
        ...DEFAULT_PRIOR_ADAPTATION_CONFIG,
        minObservations: 50,
      },
    },
  });

  const base = { profile: 0.95, preferences: 0.9, entities: 0.75, events: 0.45, cases: 0.8, patterns: 0.85 };
  const stats = {
    preferences: { admitted: 5, rejected: 5 },
  };

  const adaptive = loop.getAdaptiveTypePriors(base, stats);
  assert.equal(adaptive.preferences, base.preferences);
  loop.dispose();
});

it("getAdaptiveTypePriors: clamps to [0, 1]", () => {
  const loop = new FeedbackLoop({
    admissionController: null,
    config: DEFAULT_FEEDBACK_LOOP_CONFIG,
  });

  const base = { profile: 0.01, preferences: 0.99, entities: 0.5, events: 0.5, cases: 0.5, patterns: 0.5 };
  const stats = {
    profile: { admitted: 100, rejected: 0 },
    preferences: { admitted: 0, rejected: 100 },
  };

  const adaptive = loop.getAdaptiveTypePriors(base, stats);
  assert.ok(adaptive.profile <= 1.0);
  assert.ok(adaptive.preferences >= 0.0);
  loop.dispose();
});

it("forceAdaptationCycle: ignores rejected audits outside observationWindowMs", async () => {
  const now = Date.now();
  const originalNow = Date.now;
  Date.now = () => now;

  let adaptivePriors = null;
  const loop = new FeedbackLoop({
    admissionController: {
      setAdaptiveTypePriors: (priors) => {
        adaptivePriors = priors;
      },
    },
    config: {
      enabled: true,
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
    assert.equal(adaptivePriors.events, admissionConfig.typePriors.events);
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
    admissionController: {
      setAdaptiveTypePriors: (priors) => {
        adaptivePriors = priors;
      },
    },
    config: {
      enabled: true,
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
    assert.equal(adaptivePriors.preferences, admissionConfig.typePriors.preferences);
    assert.ok(adaptivePriors.events < admissionConfig.typePriors.events);
  } finally {
    Date.now = originalNow;
    rmSync(dir, { recursive: true, force: true });
    loop.dispose();
  }
});

it("scanErrorFile: reads matching errors as preventive evidence without embedding", async () => {
  const lessonStore = makeLessonStore();
  const existing = await lessonStore.store({
    text: "Prevent extractor stale fixture failures",
    vector: [0.1, 0.2],
    importance: 0.72,
    category: "other",
    scope: "global",
    metadata: JSON.stringify({
      l0_abstract: "Prevent extractor stale fixture failures",
      l1_overview: "- Prevent extractor stale fixture failures",
      l2_content: "Prevent extractor stale fixture failures",
      memory_category: "patterns",
      reasoning_strategy: true,
      strategy_kind: "preventive",
      canonical_id: "preventive:test_failure:ERR-20260419-001",
      state: "pending",
      evidence_count: 1,
      confidence: 0.4,
    }),
  });
  const loop = new FeedbackLoop({
    admissionController: null,
    store: lessonStore,
    config: {
      enabled: true,
      priorAdaptation: DEFAULT_PRIOR_ADAPTATION_CONFIG,
      preventiveLessons: DEFAULT_PREVENTIVE_LESSON_CONFIG,
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

    const entry = lessonStore.entries.get(existing.id);
    const meta = parseSmartMetadata(entry.metadata, entry);
    assert.equal(meta.evidence_count, 2);
    assert.equal(loop.getStatus().preventiveLessons.updated, 1);
    assert.equal(loop.getStatus().preventiveLessons.scanCycles, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    loop.dispose();
  }
});

it("scanErrorFile: skips already-processed errors", async () => {
  const lessonStore = makeLessonStore();
  await lessonStore.store({
    text: "Prevent extractor stale fixture failures",
    vector: [0.1, 0.2],
    importance: 0.72,
    category: "other",
    scope: "global",
    metadata: JSON.stringify({
      l0_abstract: "Prevent extractor stale fixture failures",
      l1_overview: "- Prevent extractor stale fixture failures",
      l2_content: "Prevent extractor stale fixture failures",
      memory_category: "patterns",
      reasoning_strategy: true,
      strategy_kind: "preventive",
      canonical_id: "preventive:test_failure:ERR-20260419-001",
      state: "pending",
      evidence_count: 1,
      confidence: 0.4,
    }),
  });
  const loop = new FeedbackLoop({
    admissionController: null,
    store: lessonStore,
    config: DEFAULT_FEEDBACK_LOOP_CONFIG,
  });

  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".learnings"), { recursive: true });
    writeFileSync(join(dir, ".learnings", "ERRORS.md"), `## [ERR-20260419-001] extraction

### Summary
Test
`, "utf-8");

    await loop.scanErrorFile(dir);
    await loop.scanErrorFile(dir);

    assert.equal(loop.getStatus().preventiveLessons.updated, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    loop.dispose();
  }
});

it("scanErrorFile: skips non-matching area", async () => {
  const lessonStore = makeLessonStore();
  const loop = new FeedbackLoop({
    admissionController: null,
    store: lessonStore,
    config: DEFAULT_FEEDBACK_LOOP_CONFIG,
  });

  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".learnings"), { recursive: true });
    writeFileSync(join(dir, ".learnings", "ERRORS.md"), `## [ERR-20260419-001] ui-bug

### Summary
UI related error
`, "utf-8");

    await loop.scanErrorFile(dir);
    assert.equal(loop.getStatus().preventiveLessons.bufferedEvidence, 0);
    assert.equal(loop.getStatus().preventiveLessons.skipped, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    loop.dispose();
  }
});

it("scanErrorFile: handles missing file gracefully", async () => {
  const loop = new FeedbackLoop({
    admissionController: null,
    store: makeLessonStore(),
    config: DEFAULT_FEEDBACK_LOOP_CONFIG,
  });

  await loop.scanErrorFile("/nonexistent/path");
  loop.dispose();
});
