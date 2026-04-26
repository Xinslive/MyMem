/**
 * Common utility functions for mymem
 */

/**
 * Clamp a value to be within [min, max] and convert to integer.
 * Returns min if value is not a finite number.
 */
export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Clamp a value to be within [0, 1] with an optional fallback.
 */
export function clamp01(value: number, fallback: number = 0): number {
  if (!Number.isFinite(value)) return Number.isFinite(fallback) ? fallback : 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Clamp a value to be within [min, max] with an optional fallback.
 */
export function clamp(value: number, min: number, max: number, fallback: number = min): number {
  if (!Number.isFinite(value)) return Number.isFinite(fallback) ? fallback : min;
  return Math.min(max, Math.max(min, value));
}
