/**
 * RecencyEngine — Unified lightweight temporal scoring
 *
 * Provides a single entry point for temporal scoring when the full DecayEngine
 * (Weibull + frequency + intrinsic) is not configured.
 *
 * Composite = recencyFactor * importanceFactor * timeDecayFactor
 *
 * - recencyFactor:      exponential decay from timestamp, additive boost
 * - importanceFactor:   importance × 0.3 + 0.7 multiplier
 * - timeDecayFactor:    reinforcement-aware half-life decay, multiplicative
 */

import { parseSmartMetadata, type SmartMemoryMetadata } from "./smart-metadata.js";
import { computeEffectiveHalfLife } from "./access-tracker.js";

// ============================================================================
// Types
// ============================================================================

export interface RecencyConfig {
  /** Half-life for recency scoring (days). Default: 30 */
  halfLifeDays: number;
  /** Reinforcement factor [0, 1]. Default: 0.5 */
  reinforcementFactor: number;
  /** Maximum half-life multiplier from reinforcement. Default: 3 */
  maxHalfLifeMultiplier: number;
  /** Base weight for importance factor. Default: 0.7 */
  importanceBaseWeight: number;
}

export const DEFAULT_RECENCY_CONFIG: RecencyConfig = {
  halfLifeDays: 30,
  reinforcementFactor: 0.5,
  maxHalfLifeMultiplier: 3,
  importanceBaseWeight: 0.7,
};

export interface RecencyScore {
  /** Recency factor [0, 1]: 1=fresh, 0=ancient */
  recency: number;
  /** Importance factor [0.7, 1.0] */
  importanceFactor: number;
  /** Time decay factor [0.5, 1.0] */
  timeDecayFactor: number;
  /** Combined multiplier for score */
  composite: number;
  /** Age in days since last active */
  ageDays: number;
}

// ============================================================================
// Entry helpers
// ============================================================================

const MS_PER_DAY = 86_400_000;

/** Minimal fields needed for recency scoring. */
export interface RecencyEntry {
  timestamp: number;
  metadata?: string;
  importance?: number;
  /** Pre-parsed metadata cache from store-row-mappers. Avoids repeated JSON.parse. */
  _parsedMeta?: SmartMemoryMetadata;
}

function parseEntry(entry: RecencyEntry): {
  now: number;
  createdAt: number;
  lastActive: number;
  ageDays: number;
  accessCount: number;
  lastAccessedAt: number;
  temporalType: "static" | "dynamic" | undefined;
  importance: number;
} {
  const now = Date.now();
  const createdAt = entry.timestamp > 0 ? entry.timestamp : now;
  const meta = entry._parsedMeta ?? parseSmartMetadata(entry.metadata, entry);
  const lastActive =
    meta.access_count > 0 ? meta.last_accessed_at : createdAt;
  const ageDays = Math.max(0, (now - lastActive) / MS_PER_DAY);
  return {
    now,
    createdAt,
    lastActive,
    ageDays,
    accessCount: meta.access_count,
    lastAccessedAt: meta.last_accessed_at,
    temporalType: meta.memory_temporal_type,
    importance: entry.importance ?? 0.7,
  };
}

// ============================================================================
// Engine
// ============================================================================

export class RecencyEngine {
  private readonly config: RecencyConfig;

  constructor(config: Partial<RecencyConfig> = {}) {
    this.config = { ...DEFAULT_RECENCY_CONFIG, ...config };
  }

  /**
   * Calculate recency score for a single entry.
   */
  score(entry: RecencyEntry): RecencyScore {
    const { now: _now, ageDays, accessCount, lastAccessedAt, temporalType, importance } =
      parseEntry(entry);

    // Recency: simple exponential decay from timestamp
    const recency = ageDays <= 0
      ? 1
      : Math.exp((-Math.LN2 / this.config.halfLifeDays) * ageDays);

    // Importance factor: importance=1.0 → 1.0, importance=0.0 → 0.7
    const importanceFactor =
      this.config.importanceBaseWeight +
      (1 - this.config.importanceBaseWeight) * Math.max(0, Math.min(1, importance));

    // Time decay with access reinforcement
    const timeDecayFactor = this.computeTimeDecay(
      ageDays,
      accessCount,
      lastAccessedAt,
      temporalType,
    );

    // Composite multiplier (multiplicative, like DecayEngine)
    const composite = recency * importanceFactor * timeDecayFactor;

    return { recency, importanceFactor, timeDecayFactor, composite, ageDays };
  }

  /**
   * Calculate recency gap score (for admission control).
   * Returns high score when gap is large (candidate adds new info).
   * gap=0 → 0, gap=∞ → 1
   */
  scoreGap(gapDays: number): number {
    if (gapDays <= 0) return 0;
    const lambda = Math.LN2 / this.config.halfLifeDays;
    return 1 - Math.exp(-lambda * gapDays);
  }

  /**
   * Apply recency scoring to a batch of results.
   * Mutates and returns sorted results (highest composite first).
   */
  apply<T extends { entry: RecencyEntry; score: number }>(results: T[]): T[] {
    const scored = results.map((r) => ({
      item: r,
      composite: this.score(r.entry).composite,
    }));

    // Sort by composite descending, then by original score for ties
    scored.sort((a, b) => {
      if (Math.abs(b.composite - a.composite) > 1e-9) {
        return b.composite - a.composite;
      }
      return b.item.score - a.item.score;
    });

    return scored.map(({ item, composite }) => ({
      ...item,
      score: Math.max(0, Math.min(1, item.score * composite)),
    }));
  }

  private computeTimeDecay(
    ageDays: number,
    accessCount: number,
    lastAccessedAt: number,
    temporalType: "static" | "dynamic" | undefined,
  ): number {
    if (ageDays <= 0) return 1;

    // Dynamic memories decay 3x faster
    const baseHL = temporalType === "dynamic"
      ? this.config.halfLifeDays / 3
      : this.config.halfLifeDays;

    const effectiveHL = computeEffectiveHalfLife(
      baseHL,
      accessCount,
      lastAccessedAt,
      this.config.reinforcementFactor,
      this.config.maxHalfLifeMultiplier,
    );

    // Floor at 0.5: never penalize more than half
    return 0.5 + 0.5 * Math.exp(-ageDays / effectiveHL);
  }
}
