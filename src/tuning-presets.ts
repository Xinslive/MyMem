import type { PluginConfig } from "./plugin-types.js";

export const TUNING_PRESETS = [
  "balanced",
  "low-latency",
  "high-recall",
  "high-precision",
] as const;

export type TuningPreset = (typeof TUNING_PRESETS)[number];

type RawObject = Record<string, unknown>;

type PresetOverlay = Pick<
  PluginConfig,
  | "autoRecallMaxItems"
  | "autoRecallMaxChars"
  | "autoRecallPerItemMaxChars"
  | "autoRecallCandidatePoolSize"
  | "extractMinMessages"
  | "extractMaxChars"
> & {
  retrieval?: NonNullable<PluginConfig["retrieval"]>;
  memoryCompaction?: NonNullable<PluginConfig["memoryCompaction"]>;
  lifecycleMaintenance?: NonNullable<PluginConfig["lifecycleMaintenance"]>;
  preferenceDistiller?: NonNullable<PluginConfig["preferenceDistiller"]>;
};

const PRESET_OVERLAYS: Record<TuningPreset, PresetOverlay> = {
  balanced: {
    autoRecallMaxItems: 6,
    autoRecallMaxChars: 800,
    autoRecallPerItemMaxChars: 200,
    autoRecallCandidatePoolSize: 12,
    extractMinMessages: 8,
    extractMaxChars: 8000,
    retrieval: {
      mode: "hybrid",
      vectorWeight: 0.7,
      bm25Weight: 0.3,
      queryExpansion: true,
      minScore: 0.5,
      rerank: "cross-encoder",
      candidatePoolSize: 12,
      recencyHalfLifeDays: 14,
      recencyWeight: 0.15,
      filterNoise: true,
      rerankProvider: "jina",
      rerankTimeoutMs: 5000,
      lengthNormAnchor: 500,
      hardMinScore: 0.55,
      timeDecayHalfLifeDays: 60,
      reinforcementFactor: 0.5,
      maxHalfLifeMultiplier: 3,
      tagPrefixes: ["proj", "env", "team", "scope"],
    },
    memoryCompaction: {
      enabled: true,
      minAgeDays: 7,
      similarityThreshold: 0.88,
      minClusterSize: 2,
      maxMemoriesToScan: 200,
      cooldownHours: 4,
      mergeMode: "llm",
      deleteSourceMemories: true,
      dryRun: false,
      maxLlmClustersPerRun: 10,
    },
    lifecycleMaintenance: {
      enabled: true,
      cooldownHours: 4,
      maxMemoriesToScan: 300,
      archiveThreshold: 0.15,
      dryRun: false,
      deleteMode: "archive",
      deleteReasons: ["expired", "superseded", "bad_recall", "stale_unaccessed"],
      hardDeleteReasons: ["duplicate_cluster_source", "noise", "superseded_fragment"],
    },
    preferenceDistiller: {
      enabled: true,
      gatewayBackfill: true,
      cooldownHours: 4,
      maxSessions: 12,
      minEvidenceCount: 2,
      minStabilityScore: 0.6,
      maxRulesPerRun: 5,
    },
  },
  "low-latency": {
    autoRecallMaxItems: 4,
    autoRecallMaxChars: 420,
    autoRecallPerItemMaxChars: 140,
    autoRecallCandidatePoolSize: 6,
    extractMinMessages: 8,
    extractMaxChars: 5000,
    retrieval: {
      mode: "hybrid",
      vectorWeight: 0.72,
      bm25Weight: 0.28,
      queryExpansion: false,
      minScore: 0.55,
      rerank: "none",
      candidatePoolSize: 8,
      recencyHalfLifeDays: 10,
      recencyWeight: 0.12,
      filterNoise: true,
      rerankProvider: "jina",
      rerankTimeoutMs: 4000,
      lengthNormAnchor: 500,
      hardMinScore: 0.6,
      timeDecayHalfLifeDays: 45,
      reinforcementFactor: 0.35,
      maxHalfLifeMultiplier: 2.5,
      tagPrefixes: ["proj", "env", "team", "scope"],
    },
    memoryCompaction: {
      enabled: true,
      minAgeDays: 10,
      similarityThreshold: 0.9,
      minClusterSize: 2,
      maxMemoriesToScan: 120,
      cooldownHours: 12,
      mergeMode: "deterministic",
      deleteSourceMemories: true,
      dryRun: false,
      maxLlmClustersPerRun: 4,
    },
    lifecycleMaintenance: {
      enabled: true,
      cooldownHours: 12,
      maxMemoriesToScan: 180,
      archiveThreshold: 0.18,
      dryRun: false,
      deleteMode: "archive",
      deleteReasons: ["expired", "superseded", "bad_recall", "stale_unaccessed"],
      hardDeleteReasons: ["duplicate_cluster_source", "noise", "superseded_fragment"],
    },
    preferenceDistiller: {
      enabled: true,
      gatewayBackfill: true,
      cooldownHours: 12,
      maxSessions: 8,
      minEvidenceCount: 2,
      minStabilityScore: 0.65,
      maxRulesPerRun: 4,
    },
  },
  "high-recall": {
    autoRecallMaxItems: 7,
    autoRecallMaxChars: 900,
    autoRecallPerItemMaxChars: 220,
    autoRecallCandidatePoolSize: 12,
    extractMinMessages: 2,
    extractMaxChars: 12000,
    retrieval: {
      mode: "hybrid",
      vectorWeight: 0.65,
      bm25Weight: 0.35,
      queryExpansion: true,
      minScore: 0.42,
      rerank: "none",
      candidatePoolSize: 18,
      recencyHalfLifeDays: 21,
      recencyWeight: 0.18,
      filterNoise: true,
      rerankProvider: "jina",
      rerankTimeoutMs: 5000,
      lengthNormAnchor: 500,
      hardMinScore: 0.48,
      timeDecayHalfLifeDays: 90,
      reinforcementFactor: 0.65,
      maxHalfLifeMultiplier: 4,
      tagPrefixes: ["proj", "env", "team", "scope"],
    },
    memoryCompaction: {
      enabled: true,
      minAgeDays: 5,
      similarityThreshold: 0.86,
      minClusterSize: 2,
      maxMemoriesToScan: 320,
      cooldownHours: 4,
      mergeMode: "llm",
      deleteSourceMemories: true,
      dryRun: false,
      maxLlmClustersPerRun: 14,
    },
    lifecycleMaintenance: {
      enabled: true,
      cooldownHours: 4,
      maxMemoriesToScan: 420,
      archiveThreshold: 0.12,
      dryRun: false,
      deleteMode: "archive",
      deleteReasons: ["expired", "superseded", "bad_recall", "stale_unaccessed"],
      hardDeleteReasons: ["duplicate_cluster_source", "noise", "superseded_fragment"],
    },
    preferenceDistiller: {
      enabled: true,
      gatewayBackfill: true,
      cooldownHours: 4,
      maxSessions: 16,
      minEvidenceCount: 2,
      minStabilityScore: 0.55,
      maxRulesPerRun: 6,
    },
  },
  "high-precision": {
    autoRecallMaxItems: 4,
    autoRecallMaxChars: 520,
    autoRecallPerItemMaxChars: 150,
    autoRecallCandidatePoolSize: 8,
    extractMinMessages: 10,
    extractMaxChars: 7000,
    retrieval: {
      mode: "hybrid",
      vectorWeight: 0.75,
      bm25Weight: 0.25,
      queryExpansion: true,
      minScore: 0.58,
      rerank: "none",
      candidatePoolSize: 10,
      recencyHalfLifeDays: 10,
      recencyWeight: 0.1,
      filterNoise: true,
      rerankProvider: "jina",
      rerankTimeoutMs: 5000,
      lengthNormAnchor: 450,
      hardMinScore: 0.64,
      timeDecayHalfLifeDays: 45,
      reinforcementFactor: 0.4,
      maxHalfLifeMultiplier: 2.5,
      tagPrefixes: ["proj", "env", "team", "scope"],
    },
    memoryCompaction: {
      enabled: true,
      minAgeDays: 10,
      similarityThreshold: 0.91,
      minClusterSize: 2,
      maxMemoriesToScan: 180,
      cooldownHours: 8,
      mergeMode: "llm",
      deleteSourceMemories: true,
      dryRun: false,
      maxLlmClustersPerRun: 8,
    },
    lifecycleMaintenance: {
      enabled: true,
      cooldownHours: 8,
      maxMemoriesToScan: 240,
      archiveThreshold: 0.2,
      dryRun: false,
      deleteMode: "archive",
      deleteReasons: ["expired", "superseded", "bad_recall", "stale_unaccessed"],
      hardDeleteReasons: ["duplicate_cluster_source", "noise", "superseded_fragment"],
    },
    preferenceDistiller: {
      enabled: true,
      gatewayBackfill: true,
      cooldownHours: 8,
      maxSessions: 10,
      minEvidenceCount: 3,
      minStabilityScore: 0.7,
      maxRulesPerRun: 4,
    },
  },
};

const PRESET_OBJECT_KEYS = [
  "retrieval",
  "memoryCompaction",
  "lifecycleMaintenance",
  "preferenceDistiller",
] as const;

export function isTuningPreset(value: unknown): value is TuningPreset {
  return typeof value === "string" && (TUNING_PRESETS as readonly string[]).includes(value);
}

export function resolveTuningPreset(value: unknown): TuningPreset {
  return isTuningPreset(value) ? value : "balanced";
}

export function getTuningPresetOverlay(preset: TuningPreset): PresetOverlay {
  return PRESET_OVERLAYS[preset];
}

export function applyTuningPreset(
  rawConfig: Record<string, unknown>,
  preset: TuningPreset,
): Record<string, unknown> {
  const overlay = PRESET_OVERLAYS[preset];
  const merged: RawObject = { ...overlay, ...rawConfig };

  for (const key of PRESET_OBJECT_KEYS) {
    const overlayValue = overlay[key];
    const rawValue = rawConfig[key];
    if (overlayValue && typeof overlayValue === "object" && !Array.isArray(overlayValue)) {
      merged[key] = {
        ...(overlayValue as RawObject),
        ...(rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
          ? (rawValue as RawObject)
          : {}),
      };
    }
  }

  return merged;
}
