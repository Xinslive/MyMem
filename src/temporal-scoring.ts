/**
 * Temporal and scoring functions for retrieval result post-processing.
 */

import type { RetrievalResult } from "./retriever-types.js";
import type { DecayEngine } from "./decay-engine.js";
import type { RecencyEngine, RecencyEntry } from "./recency-engine.js";
import {
  accessMetadataFromParsed,
  computeEffectiveHalfLife,
} from "./access-tracker.js";
import {
  parseSmartMetadata,
  toLifecycleMemory,
} from "./smart-metadata.js";
import { clamp01 } from "./retriever-utils.js";

// ============================================================================
// Recency Boost
// ============================================================================

/**
 * Apply recency boost: newer memories get a small score bonus.
 * This ensures corrections/updates naturally outrank older entries
 * when semantic similarity is close.
 * Formula: boost = exp(-ageDays / halfLife) * weight
 */
export function applyRecencyBoost(
  results: RetrievalResult[],
  config: { recencyHalfLifeDays: number; recencyWeight: number },
): RetrievalResult[] {
  const { recencyHalfLifeDays, recencyWeight } = config;
  if (!recencyHalfLifeDays || recencyHalfLifeDays <= 0 || !recencyWeight) {
    return results;
  }

  const now = Date.now();
  const boosted = results.map((r) => {
    const ts =
      r.entry.timestamp && r.entry.timestamp > 0 ? r.entry.timestamp : now;
    const ageDays = (now - ts) / 86_400_000;
    const boost = Math.exp(-ageDays / recencyHalfLifeDays) * recencyWeight;
    return {
      ...r,
      score: clamp01(r.score + boost, r.score),
    };
  });

  return boosted;
}

// ============================================================================
// Importance Weight
// ============================================================================

/**
 * Apply importance weighting: memories with higher importance get a score boost.
 * This ensures critical memories (importance=1.0) outrank casual ones (importance=0.5)
 * when semantic similarity is close.
 * Formula: score *= (baseWeight + (1 - baseWeight) * importance)
 * With baseWeight=0.7: importance=1.0 → ×1.0, importance=0.5 → ×0.85, importance=0.0 → ×0.7
 */
export function applyImportanceWeight(results: RetrievalResult[]): RetrievalResult[] {
  const baseWeight = 0.7;
  const weighted = results.map((r) => {
    const importance = r.entry.importance ?? 0.7;
    const factor = baseWeight + (1 - baseWeight) * importance;
    return {
      ...r,
      score: clamp01(r.score * factor, r.score * baseWeight),
    };
  });
  return weighted;
}

// ============================================================================
// Recency Composite (RecencyEngine)
// ============================================================================

export function applyRecencyComposite(
  results: RetrievalResult[],
  recencyEngine: RecencyEngine | null,
): RetrievalResult[] {
  if (!recencyEngine || results.length === 0) return results;
  const byId = new Map(results.map((result) => [result.entry.id, result]));
  return recencyEngine
    .apply(results.map((result) => ({ entry: result.entry as RecencyEntry, score: result.score })))
    .map((ranked) => {
      const rankedEntry = ranked.entry as RecencyEntry & { id?: string };
      const original = rankedEntry.id ? byId.get(rankedEntry.id) : undefined;
      return original
        ? { ...original, score: ranked.score }
        : ({ entry: ranked.entry, score: ranked.score, sources: {} } as RetrievalResult);
    });
}

// ============================================================================
// Decay Boost
// ============================================================================

export function applyDecayBoost(
  results: RetrievalResult[],
  decayEngine: DecayEngine | null,
): RetrievalResult[] {
  if (!decayEngine || results.length === 0) return results;

  const scored = results.map((result) => ({
    memory: toLifecycleMemory(result.entry.id, result.entry),
    score: result.score,
  }));

  decayEngine.applySearchBoost(scored);

  const reranked = results.map((result, index) => ({
    ...result,
    score: clamp01(scored[index].score, result.score * 0.3),
  }));

  return reranked;
}

// ============================================================================
// Length Normalization
// ============================================================================

/**
 * Length normalization: penalize long entries that dominate search results
 * via sheer keyword density and broad semantic coverage.
 * Short, focused entries (< anchor) get a slight boost.
 * Long, sprawling entries (> anchor) get penalized.
 * Formula: score *= 1 / (1 + log2(charLen / anchor))
 */
export function applyLengthNormalization(
  results: RetrievalResult[],
  lengthNormAnchor: number,
): RetrievalResult[] {
  if (!lengthNormAnchor || lengthNormAnchor <= 0) return results;

  const normalized = results.map((r) => {
    const charLen = r.entry.text.length;
    const ratio = charLen / lengthNormAnchor;
    // No penalty for entries at or below anchor length.
    // Gentle logarithmic decay for longer entries:
    //   anchor (500) → 1.0, 800 → 0.75, 1000 → 0.67, 1500 → 0.56, 2000 → 0.50
    // This prevents long, keyword-rich entries from dominating top-k
    // while keeping their scores reasonable.
    const logRatio = Math.log2(Math.max(ratio, 1)); // no boost for short entries
    const factor = 1 / (1 + 0.5 * logRatio);
    return {
      ...r,
      score: clamp01(r.score * factor, r.score * 0.3),
    };
  });

  return normalized;
}

// ============================================================================
// Time Decay
// ============================================================================

/**
 * Time decay: multiplicative penalty for old entries.
 * Unlike recencyBoost (additive bonus for new entries), this actively
 * penalizes stale information so recent knowledge wins ties.
 * Formula: score *= 0.5 + 0.5 * exp(-ageDays / halfLife)
 * At 0 days: 1.0x (no penalty)
 * At halfLife: ~0.68x
 * At 2*halfLife: ~0.59x
 * Floor at 0.5x (never penalize more than half)
 */
export function applyTimeDecay(
  results: RetrievalResult[],
  config: {
    timeDecayHalfLifeDays: number;
    reinforcementFactor: number;
    maxHalfLifeMultiplier: number;
  },
): RetrievalResult[] {
  const halfLife = config.timeDecayHalfLifeDays;
  if (!halfLife || halfLife <= 0) return results;

  const now = Date.now();
  const decayed = results.map((r) => {
    const ts =
      r.entry.timestamp && r.entry.timestamp > 0 ? r.entry.timestamp : now;
    const ageDays = (now - ts) / 86_400_000;

    // Access reinforcement: frequently recalled memories decay slower
    // Use pre-parsed metadata when available to avoid redundant JSON.parse
    const meta = r.entry._parsedMeta ?? parseSmartMetadata(r.entry.metadata, r.entry);
    const { accessCount, lastAccessedAt } = accessMetadataFromParsed(meta);

    // Dynamic memories decay 3x faster than static ones
    const baseHL = meta.memory_temporal_type === "dynamic" ? halfLife / 3 : halfLife;

    const effectiveHL = computeEffectiveHalfLife(
      baseHL,
      accessCount,
      lastAccessedAt,
      config.reinforcementFactor,
      config.maxHalfLifeMultiplier,
    );

    // floor at 0.5: even very old entries keep at least 50% of their score
    const factor = 0.5 + 0.5 * Math.exp(-ageDays / effectiveHL);
    return {
      ...r,
      score: clamp01(r.score * factor, r.score * 0.5),
    };
  });

  return decayed;
}

// ============================================================================
// Lifecycle Boost
// ============================================================================

/**
 * Unified fallback scoring when neither DecayEngine nor RecencyEngine is configured.
 *
 * Replaces the three-step pipeline (applyRecencyBoost + applyImportanceWeight +
 * applyTimeDecay) with a single multiplicative pass. The old pipeline applied
 * recency as an additive boost AND time decay as a multiplicative penalty,
 * causing double-counting of temporal signals.
 *
 * - recencyFactor: 0.5~1.0 (exponential decay, floor at 0.5)
 * - importanceFactor: 0.7~1.0 (linear from importance)
 */
export function applyFallbackScoring(
  results: RetrievalResult[],
  config: { recencyHalfLifeDays: number; recencyWeight: number },
): RetrievalResult[] {
  if (!config.recencyHalfLifeDays || config.recencyHalfLifeDays <= 0) return results;

  const now = Date.now();
  const halfLife = config.recencyHalfLifeDays;

  return results.map(r => {
    const ts = r.entry.timestamp > 0 ? r.entry.timestamp : now;
    const ageDays = (now - ts) / 86_400_000;
    // Recency: exponential decay with floor at 0.5
    const recencyFactor = 0.5 + 0.5 * Math.exp(-ageDays / halfLife);
    // Importance: 0.7~1.0
    const importance = r.entry.importance ?? 0.7;
    const importanceFactor = 0.7 + 0.3 * importance;
    // Combined multiplicative adjustment
    const combined = recencyFactor * importanceFactor;
    return {
      ...r,
      score: clamp01(r.score * combined, r.score * 0.35),
    };
  });
}
