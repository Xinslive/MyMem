/**
 * Feedback Loop — connects self-improvement errors and admission rejections
 * back into noise detection and admission prior tuning.
 *
 * Two loops:
 * 1. Error/rejection patterns → NoisePrototypeBank (learn noise from repeated failures)
 * 2. Admission rejection rates → AdmissionController type priors (adapt over time)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NoisePrototypeBank } from "./noise-prototypes.js";
import type { Embedder } from "./embedder.js";
import type { AdmissionController, AdmissionTypePriors, AdmissionControlConfig, AdmissionRejectionAuditEntry } from "./admission-control.js";
import { MEMORY_CATEGORIES, type MemoryCategory } from "./memory-categories.js";
import { resolveRejectedAuditFilePath } from "./admission-control.js";

// ============================================================================
// Types
// ============================================================================

export interface NoiseLearningConfig {
  fromErrors: boolean;
  fromRejections: boolean;
  minRejectionsForScan: number;
  scanIntervalMs: number;
  maxLearnPerScan: number;
  errorAreas: string[];
}

export interface PriorAdaptationConfig {
  enabled: boolean;
  adaptationIntervalMs: number;
  minObservations: number;
  learningRate: number;
  maxAdjustment: number;
}

export interface FeedbackLoopConfig {
  enabled: boolean;
  noiseLearning: NoiseLearningConfig;
  priorAdaptation: PriorAdaptationConfig;
}

export interface FeedbackLoopRuntimeContext {
  workspaceDir?: string;
  dbPath?: string;
  admissionConfig?: AdmissionControlConfig;
}

export const DEFAULT_NOISE_LEARNING_CONFIG: NoiseLearningConfig = {
  fromErrors: true,
  fromRejections: true,
  minRejectionsForScan: 5,
  scanIntervalMs: 300_000, // 5 minutes
  maxLearnPerScan: 3,
  errorAreas: ["extraction", "admission"],
};

export const DEFAULT_PRIOR_ADAPTATION_CONFIG: PriorAdaptationConfig = {
  enabled: true,
  adaptationIntervalMs: 600_000, // 10 minutes
  minObservations: 10,
  learningRate: 0.1,
  maxAdjustment: 0.15,
};

export const DEFAULT_FEEDBACK_LOOP_CONFIG: FeedbackLoopConfig = {
  enabled: true,
  noiseLearning: DEFAULT_NOISE_LEARNING_CONFIG,
  priorAdaptation: DEFAULT_PRIOR_ADAPTATION_CONFIG,
};

// ============================================================================
// Error File Parser
// ============================================================================

const ERR_HEADING_RE = /^##\s+\[(ERR-\d{8}-\d{3})\]\s*(.+)$/;

interface ParsedErrorEntry {
  id: string;
  area: string;
  summary: string;
  details: string;
}

function parseErrorsFile(content: string): ParsedErrorEntry[] {
  const entries: ParsedErrorEntry[] = [];
  const lines = content.split("\n");
  let current: ParsedErrorEntry | null = null;
  let section: "summary" | "details" | null = null;

  for (const line of lines) {
    const headingMatch = ERR_HEADING_RE.exec(line);
    if (headingMatch) {
      if (current) entries.push(current);
      current = { id: headingMatch[1], area: headingMatch[2].trim(), summary: "", details: "" };
      section = null;
      continue;
    }
    if (!current) continue;

    if (line.startsWith("### Summary")) { section = "summary"; continue; }
    if (line.startsWith("### Details")) { section = "details"; continue; }
    if (line.startsWith("### ")) { section = null; continue; }

    if (section === "summary") current.summary += (current.summary ? "\n" : "") + line.trim();
    if (section === "details") current.details += (current.details ? "\n" : "") + line.trim();
  }
  if (current) entries.push(current);
  return entries;
}

// ============================================================================
// Rejection Audit Clustering
// ============================================================================

interface RejectionCluster {
  category: string;
  count: number;
  avgScore: number;
  representativeText: string;
}

function clusterRejections(
  entries: AdmissionRejectionAuditEntry[],
  minClusterSize: number,
  rejectThreshold: number,
): RejectionCluster[] {
  const clusters = new Map<string, { count: number; totalScore: number; texts: string[]; cat: string }>();

  for (const entry of entries) {
    if (entry.audit.score > rejectThreshold - 0.1) continue;

    const cat = String(entry.candidate?.category ?? "other");
    const key = `${cat}::${tokenKey(entry.conversation_excerpt ?? entry.candidate?.abstract ?? "")}`;
    const existing = clusters.get(key);
    if (existing) {
      existing.count++;
      existing.totalScore += entry.audit.score;
      existing.texts.push(entry.candidate?.abstract ?? "");
    } else {
      clusters.set(key, { count: 1, totalScore: entry.audit.score, texts: [entry.candidate?.abstract ?? ""], cat });
    }
  }

  const result: RejectionCluster[] = [];
  for (const [, cluster] of clusters) {
    if (cluster.count < minClusterSize) continue;
    result.push({
      category: cluster.cat,
      count: cluster.count,
      avgScore: cluster.totalScore / cluster.count,
      representativeText: cluster.texts[cluster.texts.length - 1] ?? cluster.texts[0] ?? "",
    });
  }
  return result;
}

function tokenKey(text: string): string {
  const tokens = text.toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0, 5);
  tokens.sort();
  return tokens.join(" ");
}

// ============================================================================
// Processed Error Tracker (in-memory dedup)
// ============================================================================

class ProcessedErrorTracker {
  private processed = new Set<string>();

  has(id: string): boolean {
    return this.processed.has(id);
  }

  add(id: string): void {
    this.processed.add(id);
  }
}

// ============================================================================
// Feedback Loop
// ============================================================================

export class FeedbackLoop {
  private noiseBank: NoisePrototypeBank | null;
  private embedder: Embedder;
  private admissionController: AdmissionController | null;
  private config: FeedbackLoopConfig;
  private debugLog: (msg: string) => void;
  private runtimeContext: FeedbackLoopRuntimeContext;

  private processedErrors = new ProcessedErrorTracker();
  private rejectionBuffer: AdmissionRejectionAuditEntry[] = [];
  private errorBuffer: { summary: string; details?: string; area?: string }[] = [];
  private admittedCounts: Record<string, number> = {};
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private adaptationTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(opts: {
    noiseBank: NoisePrototypeBank | null;
    embedder: Embedder;
    admissionController: AdmissionController | null;
    config: FeedbackLoopConfig;
    debugLog?: (msg: string) => void;
    runtimeContext?: FeedbackLoopRuntimeContext;
  }) {
    this.noiseBank = opts.noiseBank;
    this.embedder = opts.embedder;
    this.admissionController = opts.admissionController;
    this.config = opts.config;
    this.debugLog = opts.debugLog ?? (() => {});
    this.runtimeContext = {};
    this.rememberRuntimeContext(opts.runtimeContext);
  }

  // --- Lifecycle ---

  start(): void {
    if (this.disposed || !this.config.enabled) return;
    if (this.scanTimer || this.adaptationTimer) return;

    if (this.config.noiseLearning.fromErrors || this.config.noiseLearning.fromRejections) {
      this.scanTimer = setInterval(
        () => void this.runNoiseScanCycle().catch(() => {}),
        this.config.noiseLearning.scanIntervalMs,
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
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    if (this.adaptationTimer) { clearInterval(this.adaptationTimer); this.adaptationTimer = null; }
    this.debugLog("feedback-loop: disposed");
  }

  setRuntimeContext(context: FeedbackLoopRuntimeContext): void {
    this.rememberRuntimeContext(context);
  }

  // --- Hot-path callbacks (no I/O) ---

  onAdmissionRejected(entry: AdmissionRejectionAuditEntry): void {
    if (this.disposed || !this.config.enabled) return;
    if (this.config.noiseLearning.fromRejections) {
      this.rejectionBuffer.push(entry);
    }
  }

  /** Record an admitted memory by category for prior adaptation. */
  onAdmissionAdmitted(category: string): void {
    if (this.disposed || !this.config.enabled) return;
    this.admittedCounts[category] = (this.admittedCounts[category] ?? 0) + 1;
  }

  onSelfImprovementError(params: { summary: string; details?: string; area?: string }): void {
    if (this.disposed || !this.config.enabled) return;
    if (this.config.noiseLearning.fromErrors && this.config.noiseLearning.errorAreas.includes(params.area ?? "")) {
      this.errorBuffer.push(params);
    }
  }

  // --- Error File Scanning ---

  async scanErrorFile(baseDir: string): Promise<void> {
    this.rememberRuntimeContext({ workspaceDir: baseDir });
    if (this.disposed || !this.config.noiseLearning.fromErrors || !this.noiseBank?.initialized) return;

    try {
      const filePath = join(baseDir, ".learnings", "ERRORS.md");
      const content = await readFile(filePath, "utf-8");
      const entries = parseErrorsFile(content);

      let learned = 0;
      for (const entry of entries) {
        if (learned >= this.config.noiseLearning.maxLearnPerScan) break;
        if (this.processedErrors.has(entry.id)) continue;
        if (!this.config.noiseLearning.errorAreas.some((a) => entry.area.toLowerCase().includes(a))) continue;

        const text = (entry.summary + (entry.details ? "\n" + entry.details : "")).slice(0, 300);
        if (!text.trim()) continue;

        try {
          const vector = await this.embedder.embed(text);
          if (vector && vector.length > 0) {
            this.noiseBank.learn(vector);
            this.processedErrors.add(entry.id);
            learned++;
            this.debugLog(`feedback-loop: learned noise from error ${entry.id}`);
          }
        } catch {
          this.debugLog(`feedback-loop: failed to embed error ${entry.id}, skipping`);
        }
      }
    } catch {
      // File doesn't exist yet — not an error
    }

    await this.drainErrorBuffer();
  }

  private async drainErrorBuffer(): Promise<void> {
    if (!this.noiseBank?.initialized) return;

    let learned = 0;
    while (this.errorBuffer.length > 0 && learned < this.config.noiseLearning.maxLearnPerScan) {
      const entry = this.errorBuffer.shift()!;
      const text = (entry.summary + (entry.details ? "\n" + entry.details : "")).slice(0, 300);
      if (!text.trim()) continue;

      try {
        const vector = await this.embedder.embed(text);
        if (vector && vector.length > 0) {
          this.noiseBank.learn(vector);
          learned++;
        }
      } catch {
        // Skip failed embeddings
      }
    }
  }

  // --- Rejection Audit Scanning ---

  async scanRejectionAudits(dbPath: string, admissionConfig: AdmissionControlConfig): Promise<void> {
    this.rememberRuntimeContext({ dbPath, admissionConfig });
    if (this.disposed || !this.config.noiseLearning.fromRejections || !this.noiseBank?.initialized) return;

    const filePath = resolveRejectedAuditFilePath(dbPath, admissionConfig);
    try {
      const content = await readFile(filePath, "utf-8");
      const entries: AdmissionRejectionAuditEntry[] = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter((e): e is AdmissionRejectionAuditEntry => e !== null && e.version === "amac-v1" && e.audit?.decision === "reject");

      const clusters = clusterRejections(entries, this.config.noiseLearning.minRejectionsForScan, admissionConfig.rejectThreshold);

      let learned = 0;
      for (const cluster of clusters) {
        if (learned >= this.config.noiseLearning.maxLearnPerScan) break;
        const text = cluster.representativeText.slice(0, 300);
        if (!text.trim()) continue;

        try {
          const vector = await this.embedder.embed(text);
          if (vector && vector.length > 0) {
            this.noiseBank.learn(vector);
            learned++;
            this.debugLog(`feedback-loop: learned noise from rejection cluster (count=${cluster.count}, avgScore=${cluster.avgScore.toFixed(3)})`);
          }
        } catch {
          // Skip failed embeddings
        }
      }
    } catch {
      // File doesn't exist yet
    }

    await this.drainRejectionBuffer(admissionConfig.rejectThreshold);
  }

  private async drainRejectionBuffer(rejectThreshold: number): Promise<void> {
    if (!this.noiseBank?.initialized || this.rejectionBuffer.length < this.config.noiseLearning.minRejectionsForScan) return;

    const clusters = clusterRejections(this.rejectionBuffer, this.config.noiseLearning.minRejectionsForScan, rejectThreshold);
    this.rejectionBuffer = [];

    let learned = 0;
    for (const cluster of clusters) {
      if (learned >= this.config.noiseLearning.maxLearnPerScan) break;
      const text = cluster.representativeText.slice(0, 300);
      if (!text.trim()) continue;

      try {
        const vector = await this.embedder.embed(text);
        if (vector && vector.length > 0) {
          this.noiseBank.learn(vector);
          learned++;
        }
      } catch {
        // Skip
      }
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
      const filePath = resolveRejectedAuditFilePath(dbPath, admissionConfig);
      const content = await readFile(filePath, "utf-8").catch(() => "");
      const rejectedEntries: AdmissionRejectionAuditEntry[] = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter((e): e is AdmissionRejectionAuditEntry => e !== null && e.version === "amac-v1" && e.audit?.decision === "reject");

      const stats: Record<string, { admitted: number; rejected: number }> = {};
      for (const cat of MEMORY_CATEGORIES) {
        stats[cat] = {
          admitted: this.admittedCounts[cat] ?? 0,
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

      this.debugLog(
        `feedback-loop: adapted type priors — ${MEMORY_CATEGORIES.map((c) => `${c}: ${adaptivePriors[c].toFixed(3)}`).join(", ")}`,
      );
    } catch (err) {
      this.debugLog(`feedback-loop: prior adaptation failed: ${String(err)}`);
    }
  }

  // --- Internal Cycle Runners ---

  private async runNoiseScanCycle(): Promise<void> {
    if (this.disposed) return;
    const workspaceDir = this.runtimeContext.workspaceDir;
    const dbPath = this.runtimeContext.dbPath;
    const admissionConfig = this.runtimeContext.admissionConfig;
    try {
      if (this.config.noiseLearning.fromErrors) {
        if (workspaceDir) {
          await this.scanErrorFile(workspaceDir);
        } else {
          await this.drainErrorBuffer();
        }
      }
      if (this.config.noiseLearning.fromRejections) {
        if (dbPath && admissionConfig) {
          await this.scanRejectionAudits(dbPath, admissionConfig);
        } else {
          await this.drainRejectionBuffer(admissionConfig?.rejectThreshold ?? 0.45);
        }
      }
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
    if (typeof context.workspaceDir === "string" && context.workspaceDir.trim().length > 0) {
      this.runtimeContext.workspaceDir = context.workspaceDir.trim();
    }
    if (typeof context.dbPath === "string" && context.dbPath.trim().length > 0) {
      this.runtimeContext.dbPath = context.dbPath.trim();
    }
    if (context.admissionConfig) {
      this.runtimeContext.admissionConfig = context.admissionConfig;
    }
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

  const nl = obj.noiseLearning && typeof obj.noiseLearning === "object"
    ? obj.noiseLearning as Record<string, unknown>
    : {};

  const pa = obj.priorAdaptation && typeof obj.priorAdaptation === "object"
    ? obj.priorAdaptation as Record<string, unknown>
    : {};

  return {
    enabled: obj.enabled !== false,
    noiseLearning: {
      fromErrors: nl.fromErrors !== false,
      fromRejections: nl.fromRejections !== false,
      minRejectionsForScan: typeof nl.minRejectionsForScan === "number" && nl.minRejectionsForScan >= 1
        ? Math.floor(nl.minRejectionsForScan) : DEFAULT_NOISE_LEARNING_CONFIG.minRejectionsForScan,
      scanIntervalMs: typeof nl.scanIntervalMs === "number" && nl.scanIntervalMs >= 60_000
        ? Math.floor(nl.scanIntervalMs) : DEFAULT_NOISE_LEARNING_CONFIG.scanIntervalMs,
      maxLearnPerScan: typeof nl.maxLearnPerScan === "number" && nl.maxLearnPerScan >= 1 && nl.maxLearnPerScan <= 10
        ? Math.floor(nl.maxLearnPerScan) : DEFAULT_NOISE_LEARNING_CONFIG.maxLearnPerScan,
      errorAreas: Array.isArray(nl.errorAreas) && nl.errorAreas.every((e: unknown) => typeof e === "string")
        ? (nl.errorAreas as string[]) : DEFAULT_NOISE_LEARNING_CONFIG.errorAreas,
    },
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
    },
  };
}
