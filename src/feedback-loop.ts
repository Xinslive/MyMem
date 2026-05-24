/**
 * Feedback Loop — connects runtime error evidence and admission rejections
 * back into admission prior tuning and preventive lessons.
 *
 * Two loops:
 * 1. Error/correction patterns → preventive lesson memories
 * 2. Admission rejection rates → AdmissionController type priors (adapt over time)
 */

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { AdmissionController, AdmissionTypePriors, AdmissionControlConfig, AdmissionRejectionAuditEntry } from "./admission-control.js";
import { MEMORY_CATEGORIES } from "./memory-categories.js";
import { resolveRejectedAuditFilePath } from "./admission-control.js";
import type { MemoryEntry } from "./store.js";
import type { LlmClient } from "./llm-client.js";
import { buildSmartMetadata, parseSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";
import { buildReasoningStrategyFields } from "./reasoning-strategy.js";
import { buildLessonWorthinessPrompt } from "./extraction-prompts.js";

// ============================================================================
// Types
// ============================================================================

export interface PriorAdaptationConfig {
  enabled: boolean;
  adaptationIntervalMs: number;
  minObservations: number;
  learningRate: number;
  maxAdjustment: number;
  observationWindowMs: number;
  maxRejectionAudits: number;
}

export interface PreventiveLessonLearningConfig {
  enabled: boolean;
  fromErrors: boolean;
  fromCorrections: boolean;
  minEvidenceToConfirm: number;
  pendingConfidence: number;
  confirmedConfidence: number;
  maxLearnPerScan: number;
}

export interface FeedbackLoopConfig {
  enabled: boolean;
  priorAdaptation: PriorAdaptationConfig;
  preventiveLessons: PreventiveLessonLearningConfig;
}

export interface FeedbackLoopRuntimeContext {
  dbPath?: string;
  admissionConfig?: AdmissionControlConfig;
}

export type PreventiveLessonSource =
  | "tool_error"
  | "tool_output"
  | "test_failure"
  | "user_correction";

export interface PreventiveLessonEvidence {
  summary: string;
  details?: string;
  area?: string;
  source: PreventiveLessonSource;
  sessionKey?: string;
  scope?: string;
  scopeFilter?: string[];
  toolName?: string;
  signatureHash?: string;
  prevention?: string;
}

export interface FeedbackLoopStatus {
  enabled: boolean;
  disposed: boolean;
  priorAdaptation: {
    enabled: boolean;
    observedAdmitted: number;
    cycles: number;
    lastAdaptedAt: number | null;
    lastAdaptiveTypePriors: AdmissionTypePriors | null;
  };
  preventiveLessons: {
    enabled: boolean;
    bufferedEvidence: number;
    learned: number;
    updated: number;
    promoted: number;
    skipped: number;
    failed: number;
    drainCycles: number;
    lastDrainedAt: number | null;
  };
  runtime: {
    hasDbPath: boolean;
    hasAdmissionConfig: boolean;
  };
}

const FEEDBACK_DRAIN_INTERVAL_MS = 300_000; // 5 minutes

export const DEFAULT_PRIOR_ADAPTATION_CONFIG: PriorAdaptationConfig = {
  enabled: true,
  adaptationIntervalMs: 600_000, // 10 minutes
  minObservations: 10,
  learningRate: 0.1,
  maxAdjustment: 0.15,
  observationWindowMs: 86_400_000, // 24 hours
  maxRejectionAudits: 1_000,
};

export const DEFAULT_PREVENTIVE_LESSON_CONFIG: PreventiveLessonLearningConfig = {
  enabled: true,
  fromErrors: false,
  fromCorrections: true,
  minEvidenceToConfirm: 2,
  pendingConfidence: 0.45,
  confirmedConfidence: 0.72,
  maxLearnPerScan: 3,
};

export const DEFAULT_FEEDBACK_LOOP_CONFIG: FeedbackLoopConfig = {
  enabled: true,
  priorAdaptation: DEFAULT_PRIOR_ADAPTATION_CONFIG,
  preventiveLessons: DEFAULT_PREVENTIVE_LESSON_CONFIG,
};

type LessonStore = {
  list(scopeFilter?: string[], category?: string, limit?: number, offset?: number): Promise<MemoryEntry[]>;
  update(id: string, updates: { metadata?: string }, scopeFilter?: string[]): Promise<MemoryEntry | null>;
  store(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<MemoryEntry>;
};
const MAX_LESSON_TEXT_CHARS = 900;

function clip(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function normalizeLessonText(text: string): string {
  return text.toLowerCase()
    .normalize("NFKC")
    .replace(/\/[^ \n\r\t]+/g, "<path>")
    .replace(/[a-z]:\\[^ \n\r\t]+/gi, "<path>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function classifyPreventiveLessonSource(evidence: PreventiveLessonEvidence): PreventiveLessonSource {
  const combined = `${evidence.source} ${evidence.area ?? ""} ${evidence.summary} ${evidence.details ?? ""}`.toLowerCase();
  if (/\b(test|assert|expect|suite|node --test|npm test|pytest|vitest|jest|tsc|eslint)\b|测试|断言|没通过/.test(combined)) {
    return "test_failure";
  }
  return evidence.source;
}

function buildPreventionText(evidence: PreventiveLessonEvidence): string {
  if (typeof evidence.prevention === "string" && evidence.prevention.trim()) {
    return clip(evidence.prevention, 360);
  }
  const source = classifyPreventiveLessonSource(evidence);
  const toolPart = evidence.toolName ? ` in ${evidence.toolName}` : "";
  switch (source) {
    case "user_correction":
      return "Treat the user correction as the source of truth, update or suppress conflicting memory, and avoid repeating the corrected behavior.";
    case "test_failure":
      return "Before broadening the fix, rerun the focused failing check, inspect the first concrete assertion or error, and store the verified prevention once it recurs.";
    case "tool_error":
    case "tool_output":
      return `After a tool failure${toolPart}, inspect the exact error text, retry only the narrow failing step, and verify the fix before continuing.`;
  }
}

export function buildPreventiveLessonText(evidence: PreventiveLessonEvidence): string {
  const source = classifyPreventiveLessonSource(evidence);
  const summary = clip(evidence.summary, 260);
  const details = evidence.details ? clip(evidence.details, 260) : "";
  const prevention = buildPreventionText(evidence);
  const sourceLabel = source.replace(/_/g, " ");
  const detailPart = details && details !== summary ? ` Cause: ${details}` : "";
  return clip(`Pitfall: ${summary}${detailPart} Prevention: ${prevention} Source: ${sourceLabel}.`, MAX_LESSON_TEXT_CHARS);
}

function canonicalLessonId(evidence: PreventiveLessonEvidence): string {
  if (evidence.signatureHash) return `preventive:${classifyPreventiveLessonSource(evidence)}:${evidence.signatureHash}`;
  const key = normalizeLessonText(`${evidence.summary}\n${evidence.details ?? ""}`).slice(0, 240);
  return `preventive:${classifyPreventiveLessonSource(evidence)}:${hashText(key).slice(0, 16)}`;
}

const MAX_REJECTION_AUDIT_TAIL_BYTES = 8 * 1024 * 1024;

async function readTailText(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (stats.size <= 0) return "";
    const bytesToRead = Math.min(Math.max(1, maxBytes), stats.size);
    const start = Math.max(0, stats.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, start);
    let text = buffer.toString("utf-8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text;
  } finally {
    await handle.close();
  }
}

async function readRecentRejectionAudits(
  filePath: string,
  options: {
    maxEntries: number;
    since?: number;
  },
): Promise<AdmissionRejectionAuditEntry[]> {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries));
  const content = await readTailText(filePath, MAX_REJECTION_AUDIT_TAIL_BYTES);
  if (!content.trim()) return [];

  const entries: AdmissionRejectionAuditEntry[] = [];
  const lines = content.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && entries.length < maxEntries; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!isRejectedAuditEntry(parsed)) continue;
    if (options.since !== undefined && parsed.rejected_at < options.since) continue;
    entries.push(parsed);
  }

  return entries.reverse();
}

function isRejectedAuditEntry(value: unknown): value is AdmissionRejectionAuditEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<AdmissionRejectionAuditEntry>;
  return entry.version === "amac-v1" && entry.audit?.decision === "reject";
}

// ============================================================================
// Feedback Loop
// ============================================================================

export class FeedbackLoop {
  private admissionController: AdmissionController | null;
  private lessonStore: LessonStore | null;
  private llm: LlmClient | null;
  private config: FeedbackLoopConfig;
  private debugLog: (msg: string) => void;
  private runtimeContext: FeedbackLoopRuntimeContext;

  private preventiveLessonBuffer: PreventiveLessonEvidence[] = [];
  private admittedTimestampsByCategory: Record<string, number[]> = {};
  private learnedPreventiveLessons = 0;
  private updatedPreventiveLessons = 0;
  private promotedPreventiveLessons = 0;
  private skippedPreventiveLessons = 0;
  private failedPreventiveLessons = 0;
  private drainCycles = 0;
  private adaptationCycles = 0;
  private lastDrainedAt: number | null = null;
  private lastAdaptedAt: number | null = null;
  private lastAdaptiveTypePriors: AdmissionTypePriors | null = null;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private adaptationTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(opts: {
    admissionController: AdmissionController | null;
    store?: LessonStore | null;
    llm?: LlmClient | null;
    config: FeedbackLoopConfig;
    debugLog?: (msg: string) => void;
    runtimeContext?: FeedbackLoopRuntimeContext;
  }) {
    this.admissionController = opts.admissionController;
    this.lessonStore = opts.store ?? null;
    this.llm = opts.llm ?? null;
    this.config = {
      ...opts.config,
      priorAdaptation: opts.config.priorAdaptation ?? DEFAULT_PRIOR_ADAPTATION_CONFIG,
      preventiveLessons: opts.config.preventiveLessons ?? DEFAULT_PREVENTIVE_LESSON_CONFIG,
    };
    this.debugLog = opts.debugLog ?? (() => {});
    this.runtimeContext = {};
    this.rememberRuntimeContext(opts.runtimeContext);
  }

  // --- Lifecycle ---

  start(): void {
    if (this.disposed || !this.config.enabled) return;
    if (this.drainTimer || this.adaptationTimer) return;

    if (
      this.config.preventiveLessons.enabled &&
      (this.config.preventiveLessons.fromErrors || this.config.preventiveLessons.fromCorrections) &&
      this.lessonStore
    ) {
      this.drainTimer = setInterval(
        () => void this.runFeedbackDrainCycle().catch(() => {}),
        FEEDBACK_DRAIN_INTERVAL_MS,
      );
    }
    if (this.config.priorAdaptation.enabled && this.admissionController) {
      this.adaptationTimer = setInterval(
        () => void this.runPriorAdaptationCycle().catch(() => {}),
        this.config.priorAdaptation.adaptationIntervalMs,
      );
    }

    this.debugLog("feedback-loop: started");
  }

  dispose(): void {
    this.disposed = true;
    if (this.drainTimer) { clearInterval(this.drainTimer); this.drainTimer = null; }
    if (this.adaptationTimer) { clearInterval(this.adaptationTimer); this.adaptationTimer = null; }
    this.debugLog("feedback-loop: disposed");
  }

  setRuntimeContext(context: FeedbackLoopRuntimeContext): void {
    this.rememberRuntimeContext(context);
  }

  getStatus(): FeedbackLoopStatus {
    const now = Date.now();
    this.pruneAdmittedTimestamps(now);
    const observedAdmitted = Object.values(this.admittedTimestampsByCategory)
      .reduce((sum, timestamps) => sum + timestamps.length, 0);

    return {
      enabled: this.config.enabled,
      disposed: this.disposed,
      priorAdaptation: {
        enabled: this.config.priorAdaptation.enabled && Boolean(this.admissionController),
        observedAdmitted,
        cycles: this.adaptationCycles,
        lastAdaptedAt: this.lastAdaptedAt,
        lastAdaptiveTypePriors: this.lastAdaptiveTypePriors ? { ...this.lastAdaptiveTypePriors } : null,
      },
      preventiveLessons: {
        enabled: this.config.preventiveLessons.enabled && Boolean(this.lessonStore),
        bufferedEvidence: this.preventiveLessonBuffer.length,
        learned: this.learnedPreventiveLessons,
        updated: this.updatedPreventiveLessons,
        promoted: this.promotedPreventiveLessons,
        skipped: this.skippedPreventiveLessons,
        failed: this.failedPreventiveLessons,
        drainCycles: this.drainCycles,
        lastDrainedAt: this.lastDrainedAt,
      },
      runtime: {
        hasDbPath: Boolean(this.runtimeContext.dbPath),
        hasAdmissionConfig: Boolean(this.runtimeContext.admissionConfig),
      },
    };
  }

  // --- Hot-path callbacks (no I/O) ---

  onAdmissionRejected(entry: AdmissionRejectionAuditEntry): void {
    void entry;
    if (this.disposed || !this.config.enabled) return;
    this.debugLog("feedback-loop: onAdmissionRejected called (intentional no-op; prior adaptation uses timer-based audit scan)");
  }

  /** Record an admitted memory by category for prior adaptation. */
  onAdmissionAdmitted(category: string): void {
    if (this.disposed || !this.config.enabled) return;
    const now = Date.now();
    const timestamps = this.admittedTimestampsByCategory[category] ?? [];
    timestamps.push(now);
    this.admittedTimestampsByCategory[category] = timestamps;
    this.pruneAdmittedTimestamps(now);
  }

  onPreventiveLessonEvidence(evidence: PreventiveLessonEvidence): void {
    if (this.disposed || !this.config.enabled || !this.config.preventiveLessons.enabled) return;
    if (!this.lessonStore) return;
    if (evidence.source === "user_correction" && !this.config.preventiveLessons.fromCorrections) return;
    if (evidence.source !== "user_correction" && !this.config.preventiveLessons.fromErrors) return;
    if (!evidence.summary.trim()) return;
    this.preventiveLessonBuffer.push(evidence);
    const maxBuffered = Math.max(this.config.preventiveLessons.maxLearnPerScan * 10, 20);
    if (this.preventiveLessonBuffer.length > maxBuffered) {
      this.preventiveLessonBuffer.splice(0, this.preventiveLessonBuffer.length - maxBuffered);
    }
  }

  async drainPreventiveLessonBuffer(): Promise<void> {
    if (!this.lessonStore || !this.config.preventiveLessons.enabled) return;

    let learned = 0;
    while (this.preventiveLessonBuffer.length > 0 && learned < this.config.preventiveLessons.maxLearnPerScan) {
      const evidence = this.preventiveLessonBuffer.shift()!;
      try {
        await this.learnPreventiveLesson(evidence);
        learned++;
      } catch (err) {
        this.failedPreventiveLessons++;
        this.debugLog(`feedback-loop: preventive lesson learn failed: ${String(err)}`);
      }
    }
    this.drainCycles++;
    this.lastDrainedAt = Date.now();
  }

  private async learnPreventiveLesson(evidence: PreventiveLessonEvidence): Promise<void> {
    if (!this.lessonStore) return;
    const text = buildPreventiveLessonText(evidence);
    if (!text.trim()) {
      this.skippedPreventiveLessons++;
      return;
    }

    const canonicalId = canonicalLessonId(evidence);
    const scopeFilter = evidence.scopeFilter;
    const existingRows = await this.lessonStore.list(scopeFilter, undefined, 200, 0);
    const existing = existingRows.find((entry) => {
      const meta = parseSmartMetadata(entry.metadata, entry);
      return meta.state !== "archived" &&
        meta.memory_category === "patterns" &&
        meta.reasoning_strategy === true &&
        meta.strategy_kind === "preventive" &&
        meta.canonical_id === canonicalId;
    });

    const now = Date.now();
    const prevention = buildPreventionText(evidence);
    const strategyFields = buildReasoningStrategyFields({
      kind: "preventive",
      outcome: "failure",
      title: text,
      steps: text,
      description: "Low-confidence preventive lesson inferred from feedback-loop evidence.",
      failureMode: [evidence.summary, evidence.details].filter(Boolean).join("\n"),
      prevention,
    });

    if (existing) {
      const meta = parseSmartMetadata(existing.metadata, existing);
      const evidenceCount = Math.max(1, Number(meta.evidence_count || 1) + 1);
      const shouldConfirm = evidenceCount >= this.config.preventiveLessons.minEvidenceToConfirm;
      await this.lessonStore.update(existing.id, {
        metadata: stringifySmartMetadata(buildSmartMetadata(existing, {
          ...strategyFields,
          canonical_id: canonicalId,
          source_reason: "feedback_loop_preventive_lesson",
          evidence_count: evidenceCount,
          last_evidence_at: now,
          last_evidence_source: evidence.source,
          confidence: shouldConfirm
            ? Math.max(Number(meta.confidence || 0), this.config.preventiveLessons.confirmedConfidence)
            : Math.max(Number(meta.confidence || 0), this.config.preventiveLessons.pendingConfidence),
          state: shouldConfirm ? "confirmed" : "pending",
          memory_layer: "working",
          last_confirmed_use_at: shouldConfirm ? now : meta.last_confirmed_use_at,
        })),
      }, scopeFilter);
      this.updatedPreventiveLessons++;
      if (shouldConfirm && meta.state !== "confirmed") this.promotedPreventiveLessons++;
      return;
    }

    // No existing lesson found — ask LLM whether to create a new one
    const shouldCreate = await this.evaluateLessonWorthiness(evidence);
    if (!shouldCreate) {
      this.skippedPreventiveLessons++;
      return;
    }

    // Create new preventive lesson memory
    try {
      const scope = evidence.scope ?? scopeFilter?.[0] ?? "global";
      const newEntry = await this.lessonStore.store({
        text,
        vector: [],
        category: "other",
        scope,
        importance: this.config.preventiveLessons.pendingConfidence,
        metadata: stringifySmartMetadata(buildSmartMetadata(
          { text, category: "other", importance: this.config.preventiveLessons.pendingConfidence, timestamp: now } as MemoryEntry,
          {
            ...strategyFields,
            memory_category: "patterns",
            canonical_id: canonicalId,
            source_reason: "feedback_loop_preventive_lesson",
            evidence_count: 1,
            last_evidence_at: now,
            last_evidence_source: evidence.source,
            confidence: this.config.preventiveLessons.pendingConfidence,
            state: "pending",
            memory_layer: "working",
          },
        )),
      });
      this.learnedPreventiveLessons++;
      this.debugLog(`feedback-loop: created new preventive lesson ${newEntry.id} (canonical=${canonicalId})`);
    } catch (err) {
      this.failedPreventiveLessons++;
      this.debugLog(`feedback-loop: failed to create preventive lesson: ${String(err)}`);
    }
  }

  /**
   * Ask LLM whether a piece of evidence is worth creating a new preventive lesson.
   * Returns true if worth storing, false otherwise. Defaults to true on failure
   * (err on the side of remembering, not forgetting).
   */
  private async evaluateLessonWorthiness(evidence: PreventiveLessonEvidence): Promise<boolean> {
    if (!this.llm) return true; // No LLM available — default to creating

    try {
      const existingLessonsCount = this.lessonStore
        ? (await this.lessonStore.list(evidence.scopeFilter, undefined, 200, 0)).length
        : 0;

      const prompt = buildLessonWorthinessPrompt({
        summary: evidence.summary,
        details: evidence.details,
        source: evidence.source,
        prevention: evidence.prevention,
        existingLessonsCount,
      });

      const result = await this.llm.completeJson<{ worth_storing?: boolean; reason?: string }>(
        prompt,
        "lesson-worthiness",
      );

      if (!result || typeof result.worth_storing !== "boolean") {
        this.debugLog("feedback-loop: lesson worthiness LLM returned invalid response, defaulting to create");
        return true;
      }

      this.debugLog(
        `feedback-loop: lesson worthiness judgment: worth_storing=${result.worth_storing} reason=${result.reason ?? "n/a"}`,
      );
      return result.worth_storing;
    } catch (err) {
      this.debugLog(`feedback-loop: lesson worthiness LLM call failed, defaulting to create: ${String(err)}`);
      return true;
    }
  }

  // --- Prior Adaptation ---

  getAdaptiveTypePriors(
    basePriors: AdmissionTypePriors,
    stats: Record<string, { admitted: number; rejected: number }>,
  ): AdmissionTypePriors {
    const { learningRate, maxAdjustment, minObservations } = this.config.priorAdaptation;
    const adaptive: AdmissionTypePriors = { ...basePriors };

    for (const cat of MEMORY_CATEGORIES) {
      const s = stats[cat];
      const base = basePriors[cat];
      if (!s || s.admitted + s.rejected < minObservations) {
        adaptive[cat] = base;
        continue;
      }

      const total = s.admitted + s.rejected;
      const observedRate = s.admitted / total;
      const delta = learningRate * (observedRate - 0.5);
      const unclamped = base + delta;
      const lower = Math.max(base - maxAdjustment, 0);
      const upper = Math.min(base + maxAdjustment, 1);
      adaptive[cat] = Math.max(lower, Math.min(upper, unclamped));
    }

    return adaptive;
  }

  async forceAdaptationCycle(dbPath: string, admissionConfig: AdmissionControlConfig): Promise<void> {
    this.rememberRuntimeContext({ dbPath, admissionConfig });
    if (this.disposed || !this.config.priorAdaptation.enabled || !this.admissionController) return;

    try {
      const now = Date.now();
      this.pruneAdmittedTimestamps(now);
      const since = this.getObservationWindowStart(now);
      const filePath = resolveRejectedAuditFilePath(dbPath, admissionConfig);
      const rejectedEntries = await readRecentRejectionAudits(filePath, {
        maxEntries: this.config.priorAdaptation.maxRejectionAudits,
        since,
      }).catch(() => []);

      const stats: Record<string, { admitted: number; rejected: number }> = {};
      for (const cat of MEMORY_CATEGORIES) {
        stats[cat] = {
          admitted: this.getAdmittedCount(cat, now),
          rejected: 0,
        };
      }

      for (const entry of rejectedEntries) {
        const cat = String(entry.candidate?.category ?? "other");
        if (cat in stats) {
          stats[cat].rejected++;
        }
      }

      const adaptivePriors = this.getAdaptiveTypePriors(admissionConfig.typePriors, stats);
      this.admissionController.setAdaptiveTypePriors(adaptivePriors);
      this.adaptationCycles++;
      this.lastAdaptedAt = Date.now();
      this.lastAdaptiveTypePriors = { ...adaptivePriors };

      this.debugLog(
        `feedback-loop: adapted type priors — ${MEMORY_CATEGORIES.map((c) => `${c}: ${adaptivePriors[c].toFixed(3)}`).join(", ")}`,
      );
    } catch (err) {
      this.debugLog(`feedback-loop: prior adaptation failed: ${String(err)}`);
    }
  }

  // --- Internal Cycle Runners ---

  private async runFeedbackDrainCycle(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.drainPreventiveLessonBuffer();
    } catch {
      // Non-critical: swallow
    }
  }

  private async runPriorAdaptationCycle(): Promise<void> {
    if (this.disposed || !this.config.priorAdaptation.enabled || !this.admissionController) return;
    const dbPath = this.runtimeContext.dbPath;
    const admissionConfig = this.runtimeContext.admissionConfig;
    if (!dbPath || !admissionConfig) return;

    try {
      await this.forceAdaptationCycle(dbPath, admissionConfig);
    } catch {
      // Non-critical: swallow
    }
  }

  private rememberRuntimeContext(context?: FeedbackLoopRuntimeContext): void {
    if (!context) return;
    if (typeof context.dbPath === "string" && context.dbPath.trim().length > 0) {
      this.runtimeContext.dbPath = context.dbPath.trim();
    }
    if (context.admissionConfig) {
      this.runtimeContext.admissionConfig = context.admissionConfig;
    }
  }

  private getObservationWindowStart(now: number): number | undefined {
    const windowMs = this.config.priorAdaptation.observationWindowMs;
    if (!Number.isFinite(windowMs) || windowMs <= 0) return undefined;
    return now - windowMs;
  }

  private pruneAdmittedTimestamps(now: number): void {
    const since = this.getObservationWindowStart(now);
    const maxPerCategory = Math.max(
      this.config.priorAdaptation.minObservations,
      this.config.priorAdaptation.maxRejectionAudits,
    );

    for (const category of Object.keys(this.admittedTimestampsByCategory)) {
      const timestamps = this.admittedTimestampsByCategory[category];
      const filtered = since === undefined
        ? timestamps
        : timestamps.filter((timestamp) => timestamp >= since);
      if (filtered.length > maxPerCategory) {
        filtered.splice(0, filtered.length - maxPerCategory);
      }
      if (filtered.length === 0) {
        delete this.admittedTimestampsByCategory[category];
      } else {
        this.admittedTimestampsByCategory[category] = filtered;
      }
    }
  }

  private getAdmittedCount(category: string, now: number): number {
    this.pruneAdmittedTimestamps(now);
    return this.admittedTimestampsByCategory[category]?.length ?? 0;
  }

}

// ============================================================================
// Config Normalization
// ============================================================================

export function normalizeFeedbackLoopConfig(raw: unknown): FeedbackLoopConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_FEEDBACK_LOOP_CONFIG };
  }

  const obj = raw as Record<string, unknown>;

  const pa = obj.priorAdaptation && typeof obj.priorAdaptation === "object"
    ? obj.priorAdaptation as Record<string, unknown>
    : {};
  const pl = obj.preventiveLessons && typeof obj.preventiveLessons === "object"
    ? obj.preventiveLessons as Record<string, unknown>
    : {};

  return {
    enabled: obj.enabled !== false,
    priorAdaptation: {
      enabled: pa.enabled !== false,
      adaptationIntervalMs: typeof pa.adaptationIntervalMs === "number" && pa.adaptationIntervalMs >= 300_000
        ? Math.floor(pa.adaptationIntervalMs) : DEFAULT_PRIOR_ADAPTATION_CONFIG.adaptationIntervalMs,
      minObservations: typeof pa.minObservations === "number" && pa.minObservations >= 3 && pa.minObservations <= 100
        ? Math.floor(pa.minObservations) : DEFAULT_PRIOR_ADAPTATION_CONFIG.minObservations,
      learningRate: typeof pa.learningRate === "number" && pa.learningRate >= 0.01 && pa.learningRate <= 0.5
        ? (pa.learningRate as number) : DEFAULT_PRIOR_ADAPTATION_CONFIG.learningRate,
      maxAdjustment: typeof pa.maxAdjustment === "number" && pa.maxAdjustment >= 0.01 && pa.maxAdjustment <= 0.3
        ? (pa.maxAdjustment as number) : DEFAULT_PRIOR_ADAPTATION_CONFIG.maxAdjustment,
      observationWindowMs: typeof pa.observationWindowMs === "number" && pa.observationWindowMs >= 60_000 && pa.observationWindowMs <= 30 * 86_400_000
        ? Math.floor(pa.observationWindowMs) : DEFAULT_PRIOR_ADAPTATION_CONFIG.observationWindowMs,
      maxRejectionAudits: typeof pa.maxRejectionAudits === "number" && pa.maxRejectionAudits >= 10 && pa.maxRejectionAudits <= 100_000
        ? Math.floor(pa.maxRejectionAudits) : DEFAULT_PRIOR_ADAPTATION_CONFIG.maxRejectionAudits,
    },
    preventiveLessons: {
      enabled: pl.enabled !== false,
      fromErrors: typeof pl.fromErrors === "boolean" ? pl.fromErrors : DEFAULT_PREVENTIVE_LESSON_CONFIG.fromErrors,
      fromCorrections: pl.fromCorrections !== false,
      minEvidenceToConfirm: typeof pl.minEvidenceToConfirm === "number" && pl.minEvidenceToConfirm >= 1 && pl.minEvidenceToConfirm <= 10
        ? Math.floor(pl.minEvidenceToConfirm) : DEFAULT_PREVENTIVE_LESSON_CONFIG.minEvidenceToConfirm,
      pendingConfidence: typeof pl.pendingConfidence === "number" && pl.pendingConfidence >= 0 && pl.pendingConfidence <= 1
        ? pl.pendingConfidence : DEFAULT_PREVENTIVE_LESSON_CONFIG.pendingConfidence,
      confirmedConfidence: typeof pl.confirmedConfidence === "number" && pl.confirmedConfidence >= 0 && pl.confirmedConfidence <= 1
        ? pl.confirmedConfidence : DEFAULT_PREVENTIVE_LESSON_CONFIG.confirmedConfidence,
      maxLearnPerScan: typeof pl.maxLearnPerScan === "number" && pl.maxLearnPerScan >= 1 && pl.maxLearnPerScan <= 10
        ? Math.floor(pl.maxLearnPerScan) : DEFAULT_PREVENTIVE_LESSON_CONFIG.maxLearnPerScan,
    },
  };
}
