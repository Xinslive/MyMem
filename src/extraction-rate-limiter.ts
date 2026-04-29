/**
 * Extraction Rate Limiter (Feature 7: Adaptive Extraction Throttling)
 */

const ONE_HOUR_MS = 60 * 60 * 1000;

export interface ExtractionRateLimiterOptions {
  /** Maximum number of extractions allowed per hour (default: 0 = disabled) */
  maxExtractionsPerHour?: number;
}

export interface ExtractionRateLimiter {
  /** Check whether the current rate would exceed the limit */
  isRateLimited(): boolean;
  /** Record a new extraction timestamp */
  recordExtraction(): void;
  /** Get the number of extractions in the current window */
  getRecentCount(): number;
}

/**
 * Create an extraction rate limiter that tracks timestamps in a sliding
 * one-hour window.
 */
export function createExtractionRateLimiter(
  options: ExtractionRateLimiterOptions = {},
): ExtractionRateLimiter {
  const rawMaxPerHour = options.maxExtractionsPerHour;
  const maxPerHour =
    typeof rawMaxPerHour === "number" && Number.isFinite(rawMaxPerHour)
      ? Math.max(0, Math.floor(rawMaxPerHour))
      : 0;
  const disabled = maxPerHour <= 0;
  const timestamps: number[] = [];

  function pruneOld(): void {
    const cutoff = Date.now() - ONE_HOUR_MS;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
  }

  return {
    isRateLimited(): boolean {
      if (disabled) return false;
      pruneOld();
      return timestamps.length >= maxPerHour;
    },

    recordExtraction(): void {
      if (disabled) return;
      pruneOld();
      timestamps.push(Date.now());
    },

    getRecentCount(): number {
      if (disabled) return 0;
      pruneOld();
      return timestamps.length;
    },
  };
}
