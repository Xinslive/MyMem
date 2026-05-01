/**
 * MMR-inspired diversity filter for retrieval results.
 */

import type { RetrievalResult } from "./retriever-types.js";

// Module-level WeakMap cache for Arrow Vector → plain array + norm conversions.
// Keyed by the original vector object reference, so repeated queries on the
// same LanceDB row (same Arrow Vector object) skip Array.from() + sqrt().
const vectorConversionCache = new WeakMap<object, { arr: number[]; norm: number }>();

function getOrConvertVector(vec: unknown): { arr: number[]; norm: number } | null {
  if (!vec) return null;
  const ref = vec as object;
  const cached = vectorConversionCache.get(ref);
  if (cached) return cached;
  const arr = Array.from(vec as Iterable<number>);
  let normSq = 0;
  for (let i = 0; i < arr.length; i++) normSq += arr[i] * arr[i];
  const result = { arr, norm: Math.sqrt(normSq) };
  vectorConversionCache.set(ref, result);
  return result;
}

/**
 * MMR-inspired diversity filter: greedily select results that are both
 * relevant (high score) and diverse (low similarity to already-selected).
 *
 * Uses cosine similarity between memory vectors. If two memories have
 * cosine similarity > threshold (default 0.92), the lower-scored one
 * is demoted to the end rather than removed entirely.
 *
 * This prevents top-k from being filled with near-identical entries
 * (e.g. 3 similar "SVG style" memories) while keeping them available
 * if the pool is small.
 */
export function applyMMRDiversity(
  results: RetrievalResult[],
  similarityThreshold = 0.85,
): RetrievalResult[] {
  if (results.length <= 1) return results;

  // Pre-convert Arrow Vector objects to plain arrays and pre-compute norms once,
  // avoiding repeated Array.from() and sqrt() on every pairwise cosine comparison.
  const vectorCache = new Map<string, number[]>();
  const normCache = new Map<string, number>();
  for (const r of results) {
    const converted = getOrConvertVector(r.entry.vector);
    if (converted) {
      vectorCache.set(r.entry.id, converted.arr);
      normCache.set(r.entry.id, converted.norm);
    }
  }

  const selected: RetrievalResult[] = [];
  const deferred: RetrievalResult[] = [];

  for (const candidate of results) {
    const cArr = vectorCache.get(candidate.entry.id);
    const cNorm = normCache.get(candidate.entry.id);
    // Check if this candidate is too similar to any already-selected result.
    // Use explicit loop with early exit instead of .some() for better performance.
    let tooSimilar = false;
    if (cArr && cNorm) {
      for (const s of selected) {
        const sArr = vectorCache.get(s.entry.id);
        const sNorm = normCache.get(s.entry.id);
        if (sArr && sNorm) {
          const denom = sNorm * cNorm;
          if (denom > 0) {
            let dot = 0;
            for (let i = 0; i < sArr.length; i++) dot += sArr[i] * cArr[i];
            if (dot / denom > similarityThreshold) {
              tooSimilar = true;
              break;
            }
          }
        }
      }
    }

    if (tooSimilar) {
      deferred.push(candidate);
    } else {
      selected.push(candidate);
    }
  }
  // Append deferred results at the end (available but deprioritized)
  return [...selected, ...deferred];
}
