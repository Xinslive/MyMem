import type { Logger } from "./logger.js";
import type { MemoryStore } from "./store.js";
import type { LearningMemoryConfig } from "./plugin-types.js";
import type { RetrievalResult } from "./retriever-types.js";
import type { LearningScoreBreakdown } from "./retriever-types.js";
import {
  parseSmartMetadata,
  type SmartMemoryMetadata,
} from "./smart-metadata.js";
import type { MemoryCategory } from "./memory-categories.js";

export type NormalizedLearningMemoryConfig = Required<LearningMemoryConfig> & {
  utilityLearning: Required<NonNullable<LearningMemoryConfig["utilityLearning"]>>;
  exploration: Required<NonNullable<LearningMemoryConfig["exploration"]>>;
};

export interface LearningMemoryResult extends RetrievalResult {
  sources: RetrievalResult["sources"] & {
    learning?: LearningScoreBreakdown;
  };
}

export interface LearningMaintenanceResult {
  scanned: number;
  utilitySmoothed: number;
}

type LearningStore = Pick<MemoryStore, "list"> &
  Partial<Pick<MemoryStore, "patchMetadataBatch">>;

const DEFAULT_CONFIG: NormalizedLearningMemoryConfig = {
  enabled: true,
  utilityLearning: {
    enabled: true,
    positiveReward: 0.12,
    negativeReward: 0.18,
    smoothing: 0.25,
  },
  exploration: {
    enabled: true,
    weight: 0.08,
    minTrialsBeforeDecay: 3,
  },
  cooldownHours: 4,
  maxMemoriesToScan: 300,
};

function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function normalizeLearningMemoryConfig(
  config?: LearningMemoryConfig,
): NormalizedLearningMemoryConfig {
  return {
    enabled: config?.enabled !== false,
    utilityLearning: {
      enabled: config?.utilityLearning?.enabled !== false,
      positiveReward: clamp01(config?.utilityLearning?.positiveReward, DEFAULT_CONFIG.utilityLearning.positiveReward),
      negativeReward: clamp01(config?.utilityLearning?.negativeReward, DEFAULT_CONFIG.utilityLearning.negativeReward),
      smoothing: Math.max(0.01, clamp01(config?.utilityLearning?.smoothing, DEFAULT_CONFIG.utilityLearning.smoothing)),
    },
    exploration: {
      enabled: config?.exploration?.enabled !== false,
      weight: Math.min(0.5, clamp01(config?.exploration?.weight, DEFAULT_CONFIG.exploration.weight)),
      minTrialsBeforeDecay: positiveInt(config?.exploration?.minTrialsBeforeDecay, DEFAULT_CONFIG.exploration.minTrialsBeforeDecay, 0, 50),
    },
    cooldownHours: positiveInt(config?.cooldownHours, DEFAULT_CONFIG.cooldownHours, 1, 168),
    maxMemoriesToScan: positiveInt(config?.maxMemoriesToScan, DEFAULT_CONFIG.maxMemoriesToScan, 20, 2000),
  };
}

export function applyLearningPolicy(
  results: RetrievalResult[],
  config?: LearningMemoryConfig,
): LearningMemoryResult[] {
  const cfg = normalizeLearningMemoryConfig(config);
  if (!cfg.enabled) return results as LearningMemoryResult[];

  const logTrials = Math.log1p(results.length);

  return results
    .map((result) => {
      const meta = result.entry._parsedMeta ?? parseSmartMetadata(result.entry.metadata, result.entry);
      const utility = clamp01(meta.utility_score, 0.5);
      const trialCount = Math.max(0, Number(meta.utility_trial_count || 0));
      const badRecallCount = Math.max(0, Number(meta.bad_recall_count || 0));
      const utilityBoost = cfg.utilityLearning.enabled ? (utility - 0.5) * 0.24 : 0;
      const explorationBoost = cfg.exploration.enabled
        ? cfg.exploration.weight * Math.sqrt(logTrials / Math.max(1, trialCount + 1))
        : 0;
      const badRecallPenalty = Math.min(0.35, badRecallCount * 0.08);
      const finalScore = Math.max(0, result.score + utilityBoost + explorationBoost - badRecallPenalty);
      const breakdown: LearningScoreBreakdown = {
        originalScore: result.score,
        utility,
        utilityBoost,
        explorationBoost,
        badRecallPenalty,
        finalScore,
      };
      return {
        ...result,
        score: finalScore,
        sources: {
          ...result.sources,
          learning: breakdown,
        },
      } as LearningMemoryResult;
    })
    .sort((a, b) => b.score - a.score);
}

export function buildUtilityPatch(
  metadata: SmartMemoryMetadata,
  signal: "positive" | "negative",
  config?: LearningMemoryConfig,
  at = Date.now(),
): Record<string, unknown> {
  const cfg = normalizeLearningMemoryConfig(config);
  const current = clamp01(metadata.utility_score, 0.5);
  const success = Math.max(0, Number(metadata.utility_success_count || 0));
  const failure = Math.max(0, Number(metadata.utility_failure_count || 0));
  const reward = signal === "positive" ? cfg.utilityLearning.positiveReward : -cfg.utilityLearning.negativeReward;
  const target = signal === "positive" ? 1 : 0;
  const moved = current * (1 - cfg.utilityLearning.smoothing) + target * cfg.utilityLearning.smoothing;
  const adjusted = clamp01(moved + reward * 0.25, current);
  return {
    utility_score: adjusted,
    utility_success_count: signal === "positive" ? success + 1 : success,
    utility_failure_count: signal === "negative" ? failure + 1 : failure,
    utility_trial_count: Math.max(0, Number(metadata.utility_trial_count || 0)) + 1,
    last_utility_update_at: at,
  };
}

export function buildUtilitySmoothingPatch(
  metadata: SmartMemoryMetadata,
  config?: LearningMemoryConfig,
  at = Date.now(),
): Record<string, unknown> {
  const cfg = normalizeLearningMemoryConfig(config);
  const success = Math.max(0, Number(metadata.utility_success_count || 0));
  const failure = Math.max(0, Number(metadata.utility_failure_count || 0));
  const trials = success + failure;
  if (trials === 0) return {};
  const observed = success / trials;
  const current = clamp01(metadata.utility_score, 0.5);
  const adjusted = clamp01(
    current * (1 - cfg.utilityLearning.smoothing) + observed * cfg.utilityLearning.smoothing,
    current,
  );
  return {
    utility_score: adjusted,
    utility_trial_count: Math.max(Number(metadata.utility_trial_count || 0), trials),
    last_utility_update_at: at,
  };
}

export function buildPositiveUtilityMetadataPatch(
  metadata: SmartMemoryMetadata,
  config?: LearningMemoryConfig,
  at = Date.now(),
): Record<string, unknown> {
  if (config?.enabled === false) return {};
  return {
    last_confirmed_use_at: at,
    bad_recall_count: 0,
    suppressed_until_turn: 0,
    ...buildUtilityPatch(metadata, "positive", config, at),
  };
}

function memoryKindForCategory(category: MemoryCategory): SmartMemoryMetadata["memory_kind"] {
  if (category === "cases") return "case";
  if (category === "patterns") return "pattern";
  return "memory";
}

export function defaultLearningKindPatch(category: MemoryCategory): Record<string, unknown> {
  return {
    memory_kind: memoryKindForCategory(category),
    utility_score: 0.5,
    utility_success_count: 0,
    utility_failure_count: 0,
    utility_trial_count: 0,
  };
}

export async function runLearningMemoryMaintenance(
  deps: {
    store: LearningStore;
    logger?: Pick<Logger, "info" | "warn" | "debug">;
  },
  config?: LearningMemoryConfig,
  scopeFilter?: string[],
): Promise<LearningMaintenanceResult> {
  const cfg = normalizeLearningMemoryConfig(config);
  const result: LearningMaintenanceResult = {
    scanned: 0,
    utilitySmoothed: 0,
  };
  if (!cfg.enabled) return result;

  const rows = await deps.store.list(scopeFilter, undefined, cfg.maxMemoriesToScan, 0);
  result.scanned = rows.length;
  const active = rows.filter((entry) => {
    const meta = parseSmartMetadata(entry.metadata, entry);
    return meta.state !== "archived" && meta.memory_layer !== "archive" && meta.source !== "session-summary";
  });

  if (cfg.utilityLearning.enabled && deps.store.patchMetadataBatch) {
    const now = Date.now();
    const smoothingPatches = active.flatMap((entry) => {
      const meta = parseSmartMetadata(entry.metadata, entry);
      const patch = buildUtilitySmoothingPatch(meta, cfg, now);
      return Object.keys(patch).length > 0 ? [{ id: entry.id, patch }] : [];
    });
    if (smoothingPatches.length > 0) {
      result.utilitySmoothed = await deps.store.patchMetadataBatch(smoothingPatches, scopeFilter);
    }
  }

  deps.logger?.info?.(
    `学习记忆维护：扫描=${result.scanned} 效用平滑=${result.utilitySmoothed}`,
  );
  return result;
}
