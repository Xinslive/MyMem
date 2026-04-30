/**
 * MMR-inspired diversity filter for retrieval results.
 */

import type { RetrievalResult } from "./retriever-types.js";
import { cosineSimilarity } from "./utils.js";

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
    const vec = r.entry.vector;
    if (vec?.length) {
      const arr = Array.from(vec as Iterable<number>);
      let norm = 0;
      for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
      vectorCache.set(r.entry.id, arr);
      normCache.set(r.entry.id, Math.sqrt(norm));
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
