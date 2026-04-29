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

  // Pre-convert Arrow Vector objects to plain arrays once, avoiding repeated
  // Array.from() calls on every pairwise cosine comparison.
  const vectorCache = new Map<string, number[]>();
  for (const r of results) {
    const vec = r.entry.vector;
    if (vec?.length) {
      vectorCache.set(r.entry.id, Array.from(vec as Iterable<number>));
    }
  }

  const selected: RetrievalResult[] = [];
  const deferred: RetrievalResult[] = [];

  for (const candidate of results) {
    const cArr = vectorCache.get(candidate.entry.id);
    // Check if this candidate is too similar to any already-selected result
    const tooSimilar = cArr && selected.some((s) => {
      const sArr = vectorCache.get(s.entry.id);
      if (!sArr) return false;
      return cosineSimilarity(sArr, cArr) > similarityThreshold;
    });

    if (tooSimilar) {
      deferred.push(candidate);
    } else {
      selected.push(candidate);
    }
  }
  // Append deferred results at the end (available but deprioritized)
  return [...selected, ...deferred];
}
