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

/**
 * Min-max normalize an array of scores to [0, 1].
 * Returns 0.5 for all elements if all scores are equal.
 */
export function minMaxNormalize(scores: number[]): number[] {
  if (scores.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  if (max === min) return scores.map(() => 0.5);
  const range = max - min;
  return scores.map(s => (s - min) / range);
}

/**
 * Cosine similarity between two numeric vectors.
 * Returns 0 if dimensions mismatch or either vector is zero-length.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
